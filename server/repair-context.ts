import fs from 'node:fs';
import path from 'node:path';
import type { StudyEvent } from './state.js';

export type ShopperStatementSnapshot = { eventId: string; at: string; speech: string };

// Conversation.respond app instructions can be echoed with role=user. They are
// not evidence of what the participant said, even if Tavus labels them user.
export function isShopperSpeechEvent(event: StudyEvent): boolean {
  const speech = event.detail.speech;
  return event.type === 'utterance' && event.detail.role === 'user'
    && typeof speech === 'string' && Boolean(speech.trim())
    && !/\[\s*Loop\b|not shopper speech|\[\s*(?:system|application|camera observation)\b/i.test(speech);
}

export function snapshotShopperStatements(events: readonly StudyEvent[], options: { at?: string; windowMs?: number; limit?: number } = {}): ShopperStatementSnapshot[] {
  const end = Date.parse(options.at ?? new Date().toISOString());
  const start = end - (options.windowMs ?? 180_000);
  return events.filter((event) => {
    const timestamp = Date.parse(event.at);
    return timestamp >= start && timestamp <= end && isShopperSpeechEvent(event);
  }).slice(-(options.limit ?? 5)).map((event) => ({
    eventId: event.id, at: event.at, speech: (event.detail.speech as string).trim().slice(0, 3000),
  }));
}

type SourceChunk = { file: string; start: number; end: number; text: string; score: number };
const stopWords = new Set('a an and are as at be but by can could do for from have i in is it like me my of on or our please should so that the their them then there these they this to want was we when with would you your'.split(' '));
function termsFor(text: string) {
  const words = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [];
  const terms = new Set(words.filter((word) => !stopWords.has(word)).map((word) => word.replace(/(?:ing|s)$/, '')));
  // Vocabulary mapping selects source, never an implementation or prepared fix.
  for (const [pattern, extra] of [
    [/siz|fit|measure/, 'size measurements selectedSize product'],
    [/favorit|heart|shortlist|sav/, 'product card header view navigation'],
    [/search|filter|colour|color/, 'query search listedProducts listing color'],
    [/ship|deliver|cost|price/, 'shipping subtotal price summary'],
  ] as const) if (pattern.test(text.toLowerCase())) for (const word of extra.toLowerCase().split(' ')) terms.add(word.replace(/(?:ing|s)$/, ''));
  return [...terms];
}

/** Host-side source selection; no model calls, shell discovery, or executable imports. */
export function buildRepairSourceContext(root: string, requestText: string, options: { maxChars?: number } = {}): string {
  const maxChars = Math.max(2000, Math.min(options.maxChars ?? 18_000, 40_000));
  const files: { file: string; lines: string[] }[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /\.(?:tsx?|css)$/.test(entry.name) && fs.statSync(absolute).size <= 300_000) {
        files.push({ file: path.relative(root, absolute).split(path.sep).join('/'), lines: fs.readFileSync(absolute, 'utf8').split('\n') });
      }
    }
  };
  visit(path.join(root, 'src/store'));
  const terms = termsFor(requestText);
  const chunks: SourceChunk[] = [];
  for (const { file, lines } of files) {
    // Short blocks also work for source that packs an entire component on one line.
    let text = ''; let start = 1;
    const append = (end: number) => {
      if (!text) return;
      const lower = text.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0)
        + (file.endsWith('.tsx') ? 0.25 : 0);
      chunks.push({ file, start, end, text, score }); text = '';
    };
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 1800) {
        append(i);
        for (let offset = 0; offset < lines[i].length; offset += 1600) {
          start = i + 1; text = lines[i].slice(offset, offset + 1600); append(i + 1);
        }
        start = i + 2;
      } else {
        if (!text) start = i + 1;
        text += `${lines[i]}\n`;
        if (i + 1 - start >= 15 || text.length >= 1600) append(i + 1);
      }
    }
    append(lines.length);
  }
  let output = 'CURRENT SOURCE MAP (excerpts may omit adjacent code; line numbers are advisory):\n'
    + files.map(({ file, lines }) => `${file} (${lines.length} lines)`).join('\n') + '\n';
  const used = new Set<SourceChunk>();
  const add = (chunk: SourceChunk) => {
    const block = `\n--- ${chunk.file}:${chunk.start}-${chunk.end} ---\n${chunk.text}\n`;
    if (output.length + block.length > maxChars) return false;
    output += block; used.add(chunk); return true;
  };
  // Types, actual existing measurement values, and one catalog sample avoid
  // fabricated product facts. Entry imports/state provide the integration map.
  for (const chunk of chunks.filter((chunk) => /\/catalog\.ts$/.test(chunk.file) && chunk.start <= 48)) add(chunk);
  for (const chunk of chunks.filter((chunk) => /\/StorePage\.tsx$/.test(chunk.file) && chunk.start <= 55)) add(chunk);
  const cssCounts = new Map<string, number>();
  for (const chunk of [...chunks].sort((a, b) => b.score - a.score)) {
    if (used.has(chunk) || chunk.score <= 0) continue;
    if (chunk.file.endsWith('.css') && (cssCounts.get(chunk.file) ?? 0) >= 2) continue;
    if (add(chunk) && chunk.file.endsWith('.css')) cssCounts.set(chunk.file, (cssCounts.get(chunk.file) ?? 0) + 1);
  }
  return output.slice(0, maxChars);
}
