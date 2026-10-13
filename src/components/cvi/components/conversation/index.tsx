import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
	DailyAudioTrack,
	DailyVideo,
	useDevices,
	useDaily,
	useAudioLevelObserver,
	useLocalSessionId,
	useMeetingState,
	useVideoTrack,
} from '@daily-co/daily-react';
import { MicSelectBtn, CameraSelectBtn, ScreenShareButton } from '../device-select';
import { ClosedCaptions, ClosedCaptionsButton, ClosedCaptionsProvider } from '../closed-captions';
import { ChatButton, ChatPanel, ChatProvider } from '../chat';
import { ConnectingState, LeavingState } from '../conversation-status';
import { useLocalScreenshare } from '../../hooks/use-local-screenshare';
import { useReplicaIDs } from '../../hooks/use-replica-ids';
import { useCVICall } from '../../hooks/use-cvi-call';
import { AudioWave } from '../audio-wave';

import styles from './conversation.module.css';

interface ConversationProps {
	onLeave: () => void;
	conversationUrl: string;
	onCallDiagnostic?: (type: string, detail?: string) => void;
}

const VideoPreview = React.memo(({ id }: { id: string }) => {
	const videoState = useVideoTrack(id);

	return (
		<div
			className={`${styles.previewVideoContainer} ${videoState.isOff ? styles.previewVideoContainerHidden : ''}`}
		>
			<DailyVideo
				automirror
				sessionId={id}
				type="video"
				fit="cover"
				className={`${styles.previewVideo} ${videoState.isOff ? styles.previewVideoHidden : ''}`}
			/>
			<div className={styles.audioWaveContainer}>
				<AudioWave id={id} />
			</div>
		</div>
	);
});

const PreviewVideos = React.memo(() => {
	const localId = useLocalSessionId();
	const { isScreenSharing } = useLocalScreenshare();

	return (
		<>
			{isScreenSharing && (
				<div className={styles.previewVideoContainer}>
					<DailyVideo sessionId={localId} type="screenVideo" fit="contain" className={styles.previewVideo} />
				</div>
			)}
			<VideoPreview id={localId} />
		</>
	);
});

const SelfView = React.memo(() => (
	<div className={styles.selfViewContainer}>
		<PreviewVideos />
	</div>
));

const MainVideo = React.memo(({ videoRef }: { videoRef: React.RefObject<HTMLDivElement | null> }) => {
	const replicaIds = useReplicaIDs();
	const videoState = useVideoTrack(replicaIds[0]);
	const meetingState = useMeetingState();
	const replicaId = replicaIds[0];
	const [hasReplicaConnected, setHasReplicaConnected] = useState(false);

	useEffect(() => {
		if (replicaId && videoState.state === 'playable') {
			setHasReplicaConnected(true);
		}
	}, [replicaId, videoState.state]);

	if (meetingState === 'left-meeting' || meetingState === 'error') {
		return <LeavingState />;
	}

	if (!hasReplicaConnected) {
		return <ConnectingState />;
	}

	if (!replicaId) {
		return <ConnectingState />;
	}

	return (
		<div ref={videoRef} className={styles.mainVideoContainer}>
			<DailyVideo
				automirror
				sessionId={replicaId}
				type="video"
				className={`${styles.mainVideo} ${videoState.isOff ? styles.mainVideoHidden : ''}`}
			/>
			<DailyAudioTrack sessionId={replicaId} />
		</div>
	);
});

const MoreMenu = memo(() => {
	const [isOpen, setIsOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const handlePointerDown = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setIsOpen(false);
			}
		};
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setIsOpen(false);
			}
		};
		document.addEventListener('pointerdown', handlePointerDown);
		document.addEventListener('keydown', handleKey);
		return () => {
			document.removeEventListener('pointerdown', handlePointerDown);
			document.removeEventListener('keydown', handleKey);
		};
	}, [isOpen]);

	return (
		<div ref={ref} className={styles.moreMenu}>
			<button
				type="button"
				onClick={() => setIsOpen((v) => !v)}
				aria-pressed={isOpen}
				aria-label={isOpen ? 'Close more controls' : 'More controls'}
				aria-haspopup="true"
				aria-expanded={isOpen}
				className={`${styles.moreButton} ${isOpen ? styles.moreButtonActive : ''}`}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					aria-hidden="true"
					focusable="false"
				>
					<circle cx="5" cy="12" r="1.75" fill="currentColor" />
					<circle cx="12" cy="12" r="1.75" fill="currentColor" />
					<circle cx="19" cy="12" r="1.75" fill="currentColor" />
				</svg>
			</button>
			{isOpen && (
				<div className={styles.morePopover} role="menu">
					<ScreenShareButton />
					<ClosedCaptionsButton />
				</div>
			)}
		</div>
	);
});

MoreMenu.displayName = 'MoreMenu';

type DocumentPictureInPicture = {
	requestWindow: (options: { width: number; height: number }) => Promise<Window>;
};

function documentPictureInPicture() {
	return (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
}

const floatingFacesStyle = `
	* { box-sizing: border-box; }
	body { margin: 0; background: #101827; color: white; font-family: system-ui, sans-serif; }
	.loop-pip-faces { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; width: 100vw; height: 100vh; padding: 4px; }
	.loop-pip-face { position: relative; min-width: 0; overflow: hidden; border-radius: 10px; background: #263448; }
	.loop-pip-face video { width: 100%; height: 100%; object-fit: cover; }
	.loop-pip-face--self video { transform: scaleX(-1); }
	.loop-pip-label { position: absolute; bottom: 8px; left: 8px; padding: 3px 8px; border-radius: 5px; background: rgba(0, 0, 0, .65); font-size: 12px; font-weight: 600; }
`;

const FloatingFaceVideo = React.memo(({ track }: { track?: MediaStreamTrack | null }) => {
	const videoRef = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		video.srcObject = track && track.readyState === 'live' ? new MediaStream([track]) : null;
		if (video.srcObject) void video.play().catch(() => undefined);
		return () => { video.srcObject = null; };
	}, [track]);
	return <video ref={videoRef} autoPlay playsInline muted />;
});

const FloatingFaces = React.memo(({ target, shopperTrack, miraTrack }: { target: Window; shopperTrack?: MediaStreamTrack | null; miraTrack?: MediaStreamTrack | null }) =>
	createPortal(
		<div className="loop-pip-faces">
			<div className="loop-pip-face">
				<FloatingFaceVideo track={miraTrack} />
				<span className="loop-pip-label">Mira</span>
			</div>
			<div className="loop-pip-face loop-pip-face--self">
				<FloatingFaceVideo track={shopperTrack} />
				<span className="loop-pip-label">You</span>
			</div>
		</div>,
		target.document.body,
	),
);

export const Conversation = React.memo(({ onLeave, conversationUrl, onCallDiagnostic }: ConversationProps) => {
	const { joinCall, leaveCall } = useCVICall();
	const meetingState = useMeetingState();
	const { hasMicError } = useDevices();
	const { isScreenSharing } = useLocalScreenshare();
	const localId = useLocalSessionId();
	const replicaId = useReplicaIDs()[0];
	const daily = useDaily();
	const micPeak = useRef(0);
	useAudioLevelObserver(localId, useCallback((level: number) => {
		micPeak.current = Math.max(micPeak.current, level);
	}, []));
	useEffect(() => {
		if (meetingState !== 'joined-meeting' || !daily) return;
		let samples = 0;
		const timer = window.setInterval(() => {
			const audio = daily.participants().local?.tracks.audio;
			const track = audio?.persistentTrack;
			onCallDiagnostic?.('microphone_input', JSON.stringify({
				enabled: daily.localAudio(), state: audio?.state,
				trackState: track?.readyState, trackMuted: track?.muted,
				device: track?.label, peakLevel: Number(micPeak.current.toFixed(4)),
			}));
			micPeak.current = 0;
			if (++samples >= 3) window.clearInterval(timer);
		}, 10000);
		return () => window.clearInterval(timer);
	}, [meetingState, daily, onCallDiagnostic]);

	const shopperTrack = useVideoTrack(localId).track;
	const miraTrack = useVideoTrack(replicaId).track;
	const miraVideoRef = useRef<HTMLDivElement>(null);
	const [isMiraFloating, setIsMiraFloating] = useState(false);
	const [floatingWindow, setFloatingWindow] = useState<Window | null>(null);
	const floatingWindowRef = useRef<Window | null>(null);
	const openingWindowRef = useRef(false);
	const autoOpenedRef = useRef(false);
	const wasSharingRef = useRef(isScreenSharing);
	const sharingRef = useRef(isScreenSharing);
	const autoFloatTimer = useRef<number | null>(null);
	const [floatError, setFloatError] = useState('');

	useEffect(() => {
		const onEnter = () => setIsMiraFloating(true);
		const onLeavePictureInPicture = () => setIsMiraFloating(false);
		document.addEventListener('enterpictureinpicture', onEnter, true);
		document.addEventListener('leavepictureinpicture', onLeavePictureInPicture, true);
		return () => {
			document.removeEventListener('enterpictureinpicture', onEnter, true);
			document.removeEventListener('leavepictureinpicture', onLeavePictureInPicture, true);
		};
	}, []);

	const toggleMiraFloating = useCallback(async () => {
		setFloatError('');
		if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) {
			setFloatError('Floating video is unavailable in this browser.');
			return;
		}
		try {
			const video = miraVideoRef.current?.querySelector('video');
			if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
				setFloatError('Mira’s video is still connecting. Try again in a moment.');
				return;
			}
			if (document.pictureInPictureElement === video) {
				await document.exitPictureInPicture();
				setIsMiraFloating(false);
				return;
			}
			await video.requestPictureInPicture();
			setIsMiraFloating(true);
		} catch {
			setFloatError('Could not float Mira’s video. Please try again.');
		}
	}, []);

	const closeFloatingFaces = useCallback(() => {
		floatingWindowRef.current?.close();
		floatingWindowRef.current = null;
		setFloatingWindow(null);
	}, []);

	const openFloatingFaces = useCallback(async (automatic = false) => {
		const api = documentPictureInPicture();
		if (!api) {
			if (automatic) setFloatError('This browser cannot float both faces. Chrome supports the two-person view.');
			return;
		}
		if (openingWindowRef.current || floatingWindowRef.current || !localId || !replicaId) return;
		openingWindowRef.current = true;
		setFloatError('');
		onCallDiagnostic?.('float_requested', automatic ? 'automatic' : 'manual');
		try {
			const pip = await api.requestWindow({ width: 520, height: 310 });
			if (automatic && !sharingRef.current) {
				pip.close();
				return;
			}
			const style = pip.document.createElement('style');
			style.textContent = floatingFacesStyle;
			pip.document.head.appendChild(style);
			pip.addEventListener('pagehide', () => {
				if (floatingWindowRef.current === pip) {
					floatingWindowRef.current = null;
					setFloatingWindow(null);
				}
			});
			floatingWindowRef.current = pip;
			setFloatingWindow(pip);
			onCallDiagnostic?.('float_opened', automatic ? 'automatic' : 'manual');
		} catch {
			onCallDiagnostic?.('float_failed', automatic ? 'automatic' : 'manual');
			setFloatError(automatic
				? 'Your browser needs a click to float both faces. Press Float faces in the call controls.'
				: 'Could not float both faces in this browser.');
		} finally {
			openingWindowRef.current = false;
		}
	}, [localId, replicaId, onCallDiagnostic]);

	useEffect(() => {
		sharingRef.current = isScreenSharing;
		if (isScreenSharing && !wasSharingRef.current && !floatingWindowRef.current) {
			autoOpenedRef.current = true;
			autoFloatTimer.current = window.setTimeout(() => {
				autoFloatTimer.current = null;
				if (sharingRef.current && meetingState === 'joined-meeting') void openFloatingFaces(true);
			}, 900);
		} else if (!isScreenSharing && wasSharingRef.current && autoOpenedRef.current) {
			if (autoFloatTimer.current !== null) window.clearTimeout(autoFloatTimer.current);
			autoFloatTimer.current = null;
			closeFloatingFaces();
			autoOpenedRef.current = false;
		}
		wasSharingRef.current = isScreenSharing;
	}, [isScreenSharing, meetingState, openFloatingFaces, closeFloatingFaces]);

	useEffect(() => () => {
		if (autoFloatTimer.current !== null) window.clearTimeout(autoFloatTimer.current);
		floatingWindowRef.current?.close();
	}, []);

	const toggleFloatingFaces = useCallback(() => {
		if (!documentPictureInPicture()) {
			void toggleMiraFloating();
			return;
		}
		if (floatingWindowRef.current) {
			closeFloatingFaces();
			autoOpenedRef.current = false;
			return;
		}
		autoOpenedRef.current = false;
		void openFloatingFaces();
	}, [closeFloatingFaces, openFloatingFaces, toggleMiraFloating]);

	useEffect(() => {
		joinCall({ url: conversationUrl });
		// Release the singleton call on unmount: otherwise the next mount's join()
		// is rejected ("already joined meeting") and the stale room's death ends
		// the new conversation via onLeave above. Also StrictMode-safe.
		return () => {
			leaveCall();
		};
	}, [joinCall, leaveCall, conversationUrl]);

	const handleLeave = useCallback(() => {
		leaveCall();
		onLeave();
	}, [leaveCall, onLeave]);

	return (
		<ClosedCaptionsProvider>
			<ChatProvider>
				<div className={styles.containerWrapper}>
					<div className={styles.container}>
						<div className={styles.videoContainer}>
							{hasMicError && (
								<div className={styles.errorContainer}>
									<p>
										Camera or microphone access denied. Please check your settings and try again.
									</p>
								</div>
							)}
							{meetingState === 'error' && (
								<div className={styles.errorContainer} role="alert">
									The video connection was interrupted. Reload this interview tab to reconnect, or use the call controls to end the study.
								</div>
							)}

							<div className={styles.mainVideoContainer}>
								<MainVideo videoRef={miraVideoRef} />
							</div>

							<SelfView />

							<ClosedCaptions />
						</div>

						<ChatPanel />

						<div
							className={`${styles.footer} ${meetingState === 'left-meeting' ? styles.footerLeaving : ''}`}
							aria-hidden={meetingState === 'left-meeting'}
						>
							<div className={styles.footerControls}>
								<MicSelectBtn />
								<CameraSelectBtn />
								<button type="button" className={styles.floatButton} onClick={toggleFloatingFaces} aria-pressed={Boolean(floatingWindow) || isMiraFloating} title={floatingWindow ? 'Return both faces to the call window' : 'Keep both faces visible over the store'}>
									<span aria-hidden="true">▣</span> {floatingWindow || isMiraFloating ? 'Dock faces' : documentPictureInPicture() ? 'Float faces' : 'Float Mira'}
								</button>
								<MoreMenu />
								<ChatButton />
								<button type="button" className={styles.leaveButton} onClick={handleLeave}>
									<span className={styles.leaveButtonIcon}>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											width="24"
											height="24"
											viewBox="0 0 24 24"
											fill="none"
											role="img"
											aria-label="Leave Call"
										>
											<path
												d="M18 6L6 18M6 6L18 18"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									</span>
								</button>
							</div>
							{floatingWindow && <FloatingFaces target={floatingWindow} shopperTrack={shopperTrack} miraTrack={miraTrack} />}
							{floatError && <div className={styles.floatError} role="status">{floatError}</div>}
						</div>
					</div>
				</div>
			</ChatProvider>
		</ClosedCaptionsProvider>
	);
});
