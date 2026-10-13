export type ClipMoment = {
  id: string;
  observedAt: string;
  confirmedAt?: string;
  status: 'observed' | 'confirmed' | 'uploading' | 'ready' | 'failed' | 'dismissed';
};

type Tracks = { screen?: MediaStreamTrack | null; pal?: MediaStreamTrack | null; shopper?: MediaStreamTrack | null; palAudio?: MediaStreamTrack | null; shopperAudio?: MediaStreamTrack | null };
type Segment = { start: number; end: number; data: Blob };

const PRE_ROLL_MS = 12_000;
const SEGMENT_MS = 4_000;
const MAX_CLIP_MS = 45_000;

export class FrictionRecorder {
  private canvas = document.createElement('canvas');
  private context = this.canvas.getContext('2d');
  private videos = new Map<'screen' | 'pal' | 'shopper', HTMLVideoElement>();
  private audio = new AudioContext();
  private audioOutput = this.audio.createMediaStreamDestination();
  private audioSources: MediaStreamAudioSourceNode[] = [];
  private currentTracks: Tracks = {};
  private stream: MediaStream;
  private segments: Segment[] = [];
  private recorder: MediaRecorder | null = null;
  private segmentStartedAt = 0;
  private segmentTimer: number | null = null;
  private drawTimer: number | null = null;
  private checkTimer: number | null = null;
  private active = true;
  private moments = new Map<string, ClipMoment>();
  private uploads = new Set<string>();
  private mimeType: string;
  private onError: (message: string) => void;
  private sessionId: string;

  constructor(sessionId: string, onError: (message: string) => void) {
    this.sessionId = sessionId;
    this.onError = onError;
    this.canvas.width = 960;
    this.canvas.height = 540;
    if (!this.context || !this.canvas.captureStream || !window.MediaRecorder) throw new Error('This browser cannot capture friction clips.');
    this.mimeType = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((type) => MediaRecorder.isTypeSupported(type)) || '';
    if (!this.mimeType) throw new Error('This browser does not support a clip video format.');
    const video = this.canvas.captureStream(12).getVideoTracks()[0];
    this.stream = new MediaStream([video, ...this.audioOutput.stream.getAudioTracks()]);
    this.drawTimer = window.setInterval(() => this.draw(), 1000 / 12);
    this.checkTimer = window.setInterval(() => this.checkMoments(), 700);
    this.startSegment();
  }

  setTracks(next: Tracks) {
    for (const kind of ['screen', 'pal', 'shopper'] as const) {
      const old = this.currentTracks[kind];
      const track = next[kind];
      if (old === track) continue;
      const video = this.videos.get(kind) ?? document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      this.videos.set(kind, video);
      video.srcObject = track && track.readyState === 'live' ? new MediaStream([track]) : null;
      if (video.srcObject) void video.play().catch(() => undefined);
    }
    if (this.currentTracks.palAudio !== next.palAudio || this.currentTracks.shopperAudio !== next.shopperAudio) {
      for (const source of this.audioSources) source.disconnect();
      this.audioSources = [];
      for (const track of [next.palAudio, next.shopperAudio]) {
        if (!track || track.readyState !== 'live') continue;
        const source = this.audio.createMediaStreamSource(new MediaStream([track]));
        source.connect(this.audioOutput);
        this.audioSources.push(source);
      }
      void this.audio.resume().catch(() => undefined);
    }
    this.currentTracks = next;
  }

  updateMoments(clips: ClipMoment[]) {
    for (const clip of clips) this.moments.set(clip.id, clip);
    this.prune();
    this.checkMoments();
  }

  private drawVideo(video: HTMLVideoElement | undefined, x: number, y: number, width: number, height: number) {
    if (!video || video.readyState < 2 || !video.videoWidth || !this.context) return false;
    const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
    const drawnWidth = video.videoWidth * scale;
    const drawnHeight = video.videoHeight * scale;
    this.context.save();
    this.context.beginPath();
    this.context.rect(x, y, width, height);
    this.context.clip();
    this.context.drawImage(video, x - (drawnWidth - width) / 2, y - (drawnHeight - height) / 2, drawnWidth, drawnHeight);
    this.context.restore();
    return true;
  }

  private draw() {
    if (!this.context) return;
    const ctx = this.context;
    ctx.fillStyle = '#141b26';
    ctx.fillRect(0, 0, 960, 540);
    const screen = this.videos.get('screen');
    const pal = this.videos.get('pal');
    const shopper = this.videos.get('shopper');
    const hasScreen = Boolean(screen?.srcObject && this.drawVideo(screen, 0, 0, 960, 540));
    if (!hasScreen) this.drawVideo(pal, 0, 0, 960, 540);
    const pipWidth = 205;
    const pipHeight = 116;
    const x = 960 - pipWidth - 18;
    const y = 18;
    ctx.fillStyle = '#0b111b';
    ctx.fillRect(x - 3, y - 3, pipWidth + 6, pipHeight + 6);
    this.drawVideo(hasScreen ? pal : shopper, x, y, pipWidth, pipHeight);
    if (hasScreen) {
      ctx.fillStyle = '#0b111b';
      ctx.fillRect(x - 3, y + pipHeight + 9, pipWidth + 6, pipHeight + 6);
      this.drawVideo(shopper, x, y + pipHeight + 12, pipWidth, pipHeight);
    }
  }

  private startSegment() {
    if (!this.active) return;
    const recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType, videoBitsPerSecond: 800_000, audioBitsPerSecond: 96_000 });
    this.recorder = recorder;
    this.segmentStartedAt = Date.now();
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.segments.push({ start: this.segmentStartedAt, end: Date.now(), data: event.data });
    };
    recorder.onerror = () => this.onError('Clip capture stopped unexpectedly. The interview can continue, but video evidence may be incomplete.');
    recorder.onstop = () => {
      this.recorder = null;
      this.prune();
      this.checkMoments();
      if (this.active) this.startSegment();
    };
    recorder.start();
    this.segmentTimer = window.setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, SEGMENT_MS);
  }

  private prune() {
    const now = Date.now();
    const earliestCandidate = [...this.moments.values()]
      .filter((clip) => ['observed', 'confirmed'].includes(clip.status) && now - Date.parse(clip.observedAt) < 90_000)
      .reduce((earliest, clip) => Math.min(earliest, Date.parse(clip.observedAt) - PRE_ROLL_MS), now - PRE_ROLL_MS - SEGMENT_MS);
    const keepAfter = Math.min(now - PRE_ROLL_MS - SEGMENT_MS, earliestCandidate);
    this.segments = this.segments.filter((segment) => segment.end >= keepAfter);
  }

  private checkMoments() {
    for (const clip of this.moments.values()) {
      if (clip.status !== 'confirmed' || this.uploads.has(clip.id)) continue;
      const observed = Date.parse(clip.observedAt);
      const confirmed = Date.parse(clip.confirmedAt || clip.observedAt);
      const end = Math.min(observed + MAX_CLIP_MS, Math.max(observed + 18_000, confirmed + 8_000));
      if (this.active && Date.now() < end + SEGMENT_MS) continue;
      const start = Math.max(observed - PRE_ROLL_MS, end - MAX_CLIP_MS);
      const parts = this.segments.filter((segment) => segment.end > start && segment.start < end);
      this.uploads.add(clip.id);
      if (!parts.length) {
        void this.failClip(clip.id, 'The browser had no camera or screen media around this friction moment.');
      } else {
        void this.upload(clip.id, parts);
      }
    }
  }

  private async failClip(id: string, message: string) {
    await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/clips/${encodeURIComponent(id)}/fail`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: message }),
    }).catch(() => undefined);
    this.moments.delete(id);
    this.uploads.delete(id);
    this.onError(message);
  }

  private async upload(id: string, segments: Segment[]) {
    const base = `/api/sessions/${encodeURIComponent(this.sessionId)}/clips/${encodeURIComponent(id)}`;
    const format = this.mimeType.split(';')[0];
    try {
      for (let index = 0; index < segments.length; index += 1) {
        const response = await fetch(`${base}/segments/${index}`, { method: 'POST', headers: { 'Content-Type': format }, body: segments[index].data });
        if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || 'The clip upload failed.');
      }
      const response = await fetch(`${base}/finish`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || 'The clip could not be prepared.');
      this.moments.delete(id);
      this.prune();
    } catch (error) {
      await this.failClip(id, error instanceof Error ? error.message : 'The clip could not be saved.');
    } finally {
      this.uploads.delete(id);
    }
  }

  async finish() {
    if (!this.active) return;
    this.active = false;
    if (this.segmentTimer !== null) window.clearTimeout(this.segmentTimer);
    if (this.drawTimer !== null) window.clearInterval(this.drawTimer);
    if (this.checkTimer !== null) window.clearInterval(this.checkTimer);
    await new Promise<void>((resolve) => {
      const recorder = this.recorder;
      if (!recorder || recorder.state === 'inactive') return resolve();
      const prior = recorder.onstop;
      recorder.onstop = (event) => { prior?.call(recorder, event); resolve(); };
      recorder.stop();
    });
    this.checkMoments();
    const pending = [...this.moments.values()].filter((clip) => clip.status === 'confirmed');
    for (const clip of pending) {
      while (this.uploads.has(clip.id) && this.moments.has(clip.id)) await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    this.stream.getTracks().forEach((track) => track.stop());
    for (const video of this.videos.values()) video.srcObject = null;
    for (const source of this.audioSources) source.disconnect();
    await this.audio.close();
    this.segments = [];
  }
}
