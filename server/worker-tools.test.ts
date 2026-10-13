import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerSourceTools, TOTAL_READ_LIMIT } from './worker-tools.js';

async function fixture(run: (tools: WorkerSourceTools, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-tools-test-'));
  try {
    await fs.mkdir(path.join(root, 'src/store'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/store/Product.tsx'), 'const title = "Blue top";\nconst size = "M";\n');
    await run(new WorkerSourceTools(root), root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('bounded reader returns raw copyable source without line numbers and rejects oversized reads', async () => fixture(async tools => {
  const result = await tools.readSource('src/store/Product.tsx', 2, 25);
  assert.equal(result.excerpt, 'const size = "M";\n');
  await assert.rejects(tools.readSource('src/store/Product.tsx', 1, 6001), /6000/);
}));

test('aggregate reading budget cannot be bypassed by repeated or concurrent reads', async () => fixture(async (tools, root) => {
  await fs.writeFile(path.join(root, 'src/store/Large.ts'), 'x'.repeat(40000));
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => tools.readSource('src/store/Large.ts')));
  const successes = results.filter(result => result.status === 'fulfilled');
  assert.equal(successes.reduce((sum, result) => sum + result.value.excerpt.length, 0), TOTAL_READ_LIMIT);
  assert.equal(results.filter(result => result.status === 'rejected').length, 5);
  await assert.rejects(tools.listSources(), /budget exhausted/);
}));

test('rejects traversal, configuration files and symlinks for reads and edits', async () => fixture(async (tools, root) => {
  for (const candidate of ['../secret.ts', '/tmp/test.ts', 'src/store/../index.ts', 'src/store/config.json', 'src\\store\\Product.tsx']) {
    await assert.rejects(tools.readSource(candidate));
    await assert.rejects(tools.replaceSource(candidate, 'a', 'b'));
    await assert.rejects(tools.createSource(candidate, 'b'));
  }
  await fs.writeFile(path.join(root, 'secret.ts'), 'secret');
  await fs.symlink(path.join(root, 'secret.ts'), path.join(root, 'src/store/Linked.ts'));
  await fs.symlink(root, path.join(root, 'src/store/dir'));
  await assert.rejects(tools.readSource('src/store/Linked.ts'), /Symlinks/);
  await assert.rejects(tools.replaceSource('src/store/Linked.ts', 'secret', 'oops'), /Symlinks/);
  await assert.rejects(tools.createSource('src/store/dir/New.ts', 'oops'), /Symlinks/);
  assert.equal(await fs.readFile(path.join(root, 'secret.ts'), 'utf8'), 'secret');
  assert.ok(!(await tools.listSources()).excerpt.includes('Linked'));
}));

test('exact edits require a unique match, preserve surrounding text, and truncate correctly', async () => fixture(async (tools, root) => {
  await tools.replaceSource('src/store/Product.tsx', 'Blue top', 'Top');
  assert.equal(await fs.readFile(path.join(root, 'src/store/Product.tsx'), 'utf8'), 'const title = "Top";\nconst size = "M";\n');
  await assert.rejects(tools.replaceSource('src/store/Product.tsx', 'const', 'let'), /exactly once/);
  await assert.rejects(tools.replaceSource('src/store/Product.tsx', 'missing', 'new'), /exactly once/);
  await tools.createSource('src/store/New.ts', 'export const enabled = true;');
  await assert.rejects(tools.createSource('src/store/New.ts', 'overwrite'));
}));

test('stdio MCP handshake exposes only bounded tools and executes targeted reads', async () => fixture(async (_tools, root) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('./worker-tools.ts', import.meta.url)), root],
    cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'loop-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['list_sources', 'read_source', 'search_source', 'replace_source', 'review_changes', 'create_source']);
    const result = await client.callTool({ name: 'read_source', arguments: { path: 'src/store/Product.tsx', maxChars: 40 } });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /Blue top/);
    const invalid = await client.callTool({ name: 'read_source', arguments: { path: '../../secret' } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
}));


test('diff review is bounded, includes new filenames and requires isolated repository', async () => fixture(async (tools, root) => {
  const { execFileSync } = await import('node:child_process');
  await assert.rejects(tools.reviewChanges());
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline'], { cwd: root });
  await tools.replaceSource('src/store/Product.tsx', 'Blue top', 'Favorite blue top');
  await tools.createSource('src/store/New.ts', 'export const example = true;');
  const diff = await tools.reviewChanges();
  assert.match(diff.excerpt, /Favorite blue top/);
  assert.match(diff.excerpt, /src\/store\/New.ts/);
  assert.ok(diff.excerpt.length <= 6000);
  assert.equal(diff.remainingReadCharacters, TOTAL_READ_LIMIT - diff.excerpt.length);
}));


test('literal search finds shared callers, skips symlinks, and shares reading budget', async () => fixture(async (tools, root) => {
  await fs.writeFile(path.join(root, 'src/store/Callers.tsx'), '<ProductCard product={product} />\n<ProductCard product={other} />\n');
  await fs.symlink(path.join(root, 'src/store/Callers.tsx'), path.join(root, 'src/store/Linked.tsx'));
  const result = await tools.searchSource('<ProductCard');
  assert.match(result.excerpt, /Callers.tsx:1:/);
  assert.match(result.excerpt, /Callers.tsx:2:/);
  assert.ok(!result.excerpt.includes('Linked'));
  assert.equal(result.remainingReadCharacters, TOTAL_READ_LIMIT - result.excerpt.length);
  const read = await tools.readSource('src/store/Callers.tsx', 1, 40);
  assert.ok(read.excerpt.startsWith('<ProductCard'));
  assert.equal(read.remainingReadCharacters, result.remainingReadCharacters - read.excerpt.length);
  await assert.rejects(tools.searchSource(''), /nonempty/);
  await assert.rejects(tools.readSource('Callers.tsx'), /src\/store/);
}));

test('search truncation stays within single and cumulative read limits', async () => fixture(async (tools, root) => {
  await fs.writeFile(path.join(root, 'src/store/Many.ts'), ('ProductCard ' + 'x'.repeat(500) + '\n').repeat(100));
  for (let i = 0; i < 6; i++) {
    const result = await tools.searchSource('ProductCard');
    assert.ok(result.excerpt.length <= 6000);
    assert.ok(result.remainingReadCharacters >= 0);
    assert.equal(result.truncated, true);
  }
}));
