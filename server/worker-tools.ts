import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const READ_LIMIT = 6_000;
export const TOTAL_READ_LIMIT = 30_000;
const MAX_FILE_BYTES = 256_000;
const MAX_EDIT_CHARS = 24_000;

/** One instance per coder invocation; every content-bearing read shares this budget. */
export class WorkerSourceTools {
  private readCharacters = 0;
  constructor(private readonly workspace: string) {}

  private async target(relative: string, allowMissing = false) {
    if (typeof relative !== 'string' || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Use a normalized relative src/store path.');
    if (!/^src\/store\/.+\.(tsx?|css)$/.test(relative)) throw new Error('Only src/store .ts, .tsx and .css files are allowed.');
    const root = await fs.realpath(this.workspace);
    let current = root;
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const stat = await fs.lstat(current).catch(error => {
        if (allowMissing && index === parts.length - 1 && error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return current;
      if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed.');
      if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error('Expected regular source files and directories.');
      if (index === parts.length - 1 && stat.size > MAX_FILE_BYTES) throw new Error('Source file exceeds supported size.');
    }
    return current;
  }

  private spend(value: string) {
    const remaining = TOTAL_READ_LIMIT - this.readCharacters;
    if (remaining <= 0) throw new Error('Source-read budget exhausted. Implement using the context already received.');
    const excerpt = value.slice(0, Math.min(READ_LIMIT, remaining));
    this.readCharacters += excerpt.length;
    return { excerpt, remainingReadCharacters: TOTAL_READ_LIMIT - this.readCharacters };
  }

  private async sourcePaths() {
    const root = await fs.realpath(this.workspace);
    for (const relative of ['src', 'src/store']) {
      const stat = await fs.lstat(path.join(root, relative));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Store root must be a real directory.');
    }
    const paths: string[] = [];
    const visit = async (relative: string) => {
      for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (paths.length >= 150) return;
        if (entry.isSymbolicLink()) continue;
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile() && /\.(tsx?|css)$/.test(child)) paths.push(child);
      }
    };
    await visit('src/store');
    return paths;
  }

  async listSources() {
    return this.spend((await this.sourcePaths()).join('\n'));
  }

  async readSource(relative: string, startLine = 1, maxChars = READ_LIMIT) {
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > READ_LIMIT) throw new Error('startLine must be positive; maxChars must be 1–6000.');
    if (this.readCharacters >= TOTAL_READ_LIMIT) throw new Error('Source-read budget exhausted.');
    const target = await this.target(relative);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const lines = (await handle.readFile('utf8')).split('\n');
      const raw = lines.slice(startLine - 1).join('\n');
      const value = this.spend(raw.slice(0, maxChars));
      return { path: relative, startLine, totalLines: lines.length, truncated: raw.length > value.excerpt.length, ...value };
    } finally { await handle.close(); }
  }

  async searchSource(query: string) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\r\n]/.test(query)) throw new Error('Use a nonempty literal single-line query of at most 200 characters.');
    if (this.readCharacters >= TOTAL_READ_LIMIT) throw new Error('Source-read budget exhausted.');
    const limit = Math.min(READ_LIMIT, TOTAL_READ_LIMIT - this.readCharacters);
    const matches: string[] = [];
    let characters = 0;
    let truncated = false;
    for (const relative of await this.sourcePaths()) {
      const target = await this.target(relative);
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      let source: string;
      try { source = await handle.readFile('utf8'); } finally { await handle.close(); }
      for (const [index, line] of source.split('\n').entries()) {
        const at = line.indexOf(query);
        if (at < 0) continue;
        // Show bounded context around the match even when a source line is very long.
        const start = Math.max(0, at - 100);
        const snippet = `${relative}:${index + 1}: ${start ? '…' : ''}${line.slice(start, start + 400)}${line.length > start + 400 ? '…' : ''}`;
        if (characters + snippet.length + (matches.length ? 1 : 0) > limit) { truncated = true; break; }
        matches.push(snippet);
        characters += snippet.length + (matches.length > 1 ? 1 : 0);
      }
      if (truncated) break;
    }
    return { ...this.spend(matches.join('\n')), truncated };
  }

  async replaceSource(relative: string, oldText: string, newText: string) {
    if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string' || oldText.length > MAX_EDIT_CHARS || newText.length > MAX_EDIT_CHARS) throw new Error('Supply one nonempty exact match and a replacement, each at most 24000 characters.');
    const target = await this.target(relative);
    const handle = await fs.open(target, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const source = await handle.readFile('utf8');
      const at = source.indexOf(oldText);
      if (at < 0 || source.indexOf(oldText, at + 1) >= 0) throw new Error('oldText must match exactly once. Read a small relevant section if needed.');
      const updated = source.slice(0, at) + newText + source.slice(at + oldText.length);
      if (Buffer.byteLength(updated) > MAX_FILE_BYTES) throw new Error('Result exceeds supported file size.');
      await handle.write(updated, 0, 'utf8');
      await handle.truncate(Buffer.byteLength(updated));
      return { path: relative, changed: updated !== source, bytes: Buffer.byteLength(updated) };
    } finally { await handle.close(); }
  }

  async reviewChanges() {
    if (this.readCharacters >= TOTAL_READ_LIMIT) throw new Error('Source-read budget exhausted.');
    const cwd = await fs.realpath(this.workspace);
    const options = { cwd, maxBuffer: 1_000_000, timeout: 5_000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat' } };
    const { stdout: gitRoot } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], options);
    if (await fs.realpath(gitRoot.trim()) !== cwd) throw new Error('Review requires an isolated workspace repository.');
    const { stdout: diff } = await execFileAsync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', 'src/store'], options);
    const { stdout: untracked } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src/store'], options);
    const output = diff + (untracked ? '\nNew files (read targeted sections if needed):\n' + untracked : '');
    const result = this.spend(output);
    return { ...result, truncated: output.length > result.excerpt.length };
  }

  async createSource(relative: string, content: string) {
    if (typeof content !== 'string' || content.length > MAX_EDIT_CHARS) throw new Error('New source must be at most 24000 characters.');
    const target = await this.target(relative, true);
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content); } finally { await handle.close(); }
    return { path: relative, created: true };
  }
}

const pathSchema = { type: 'string', description: 'Full workspace-relative path, e.g. src/store/ProductCard.tsx or src/store/components/SizeGuide.tsx. Bare filenames are invalid. Only .ts, .tsx and .css.' };
export async function startWorkerTools(workspace: string) {
  const source = new WorkerSourceTools(workspace);
  const server = new Server({ name: 'loop-source', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'list_sources', description: 'List store source paths. Shares the 30000-character total reading budget.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'read_source', description: 'Read raw source text suitable for exact replacement. Line metadata is separate; no line-number prefixes are inserted. Maximum 6000 characters per call, 30000 across this worker. Use supplied prompt context first.', inputSchema: { type: 'object', properties: { path: pathSchema, startLine: { type: 'integer', minimum: 1 }, maxChars: { type: 'integer', minimum: 1, maximum: READ_LIMIT } }, required: ['path'], additionalProperties: false } },
    { name: 'search_source', description: 'Find literal text across allowed store source files, for example ProductCard to find every caller before changing props. Returns path:line snippets (not exact-edit input), capped at 6000 characters and counted against the shared 30000 budget. Use read_source on relevant lines before editing.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['query'], additionalProperties: false } },
    { name: 'replace_source', description: 'Edit path such as src/store/ProductCard.tsx by replacing exactly one literal oldText with newText. Copy oldText from raw read_source excerpt, preserving whitespace and closing braces. Before changing shared props, use search_source to find and update every caller. Does not return source.', inputSchema: { type: 'object', properties: { path: pathSchema, oldText: { type: 'string', minLength: 1, maxLength: MAX_EDIT_CHARS }, newText: { type: 'string', maxLength: MAX_EDIT_CHARS } }, required: ['path', 'oldText', 'newText'], additionalProperties: false } },
    { name: 'review_changes', description: 'Review current store diff and new-file names. Maximum 6000 characters, counted against shared reading budget. No arbitrary commands.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'create_source', description: 'Create a new source file in an existing src/store directory. Fails if file exists. No dependency or configuration changes.', inputSchema: { type: 'object', properties: { path: pathSchema, content: { type: 'string', maxLength: MAX_EDIT_CHARS } }, required: ['path', 'content'], additionalProperties: false } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const args = params.arguments ?? {};
      let result: unknown;
      switch (params.name) {
        case 'list_sources': result = await source.listSources(); break;
        case 'read_source': result = await source.readSource(args.path as string, args.startLine as number | undefined, args.maxChars as number | undefined); break;
        case 'search_source': result = await source.searchSource(args.query as string); break;
        case 'replace_source': result = await source.replaceSource(args.path as string, args.oldText as string, args.newText as string); break;
        case 'review_changes': result = await source.reviewChanges(); break;
        case 'create_source': result = await source.createSource(args.path as string, args.content as string); break;
        default: throw new Error('Unknown source tool.');
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message.slice(0, 500) : 'Source tool failed.' }] };
    }
  });
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: worker-tools.ts <workspace>');
  await startWorkerTools(path.resolve(process.argv[2]));
}
