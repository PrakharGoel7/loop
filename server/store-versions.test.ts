import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectStoreBuild, versionAssetBase, activateStoreVersion, readStoreVersionAsset } from './store-versions.js';

test('verified artifact inspector rejects missing referenced assets and symbolic links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-artifact-'));
  try {
    fs.writeFileSync(path.join(root, 'index.html'), '<script src="/store-versions/session/job/assets/main.js"></script>');
    assert.throws(() => inspectStoreBuild(root), /missing artifact/);
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'assets/main.js'), 'console.log(1)');
    assert.deepEqual(inspectStoreBuild(root).sort(), ['assets/main.js', 'index.html']);
    fs.symlinkSync('/etc/passwd', path.join(root, 'bad'));
    assert.throws(() => inspectStoreBuild(root), /regular files/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('version paths reject traversal and activation requires upload confirmation', async () => {
  assert.equal(versionAssetBase('study-1', 'job-2'), '/store-versions/study-1/job-2/');
  assert.throws(() => versionAssetBase('../x', 'v'), /Invalid/);
  assert.throws(() => activateStoreVersion('unuploaded-study', 'v'), /not finished upload/);
  await assert.rejects(readStoreVersionAsset('s', 'v', '../secret'), /Invalid/);
});

test('activation switches only one study pointer and reset keeps immutable versions', async () => {
  const { resolveStoreVersion, resetStoreVersion } = await import('./store-versions.js');
  const id = 'publication-test-' + Date.now();
  const other = id + '-other';
  const root = path.join(process.cwd(), 'data/store-versions');
  try {
    for (const [study, version] of [[id, 'one'], [id, 'two'], [other, 'one']]) {
      fs.mkdirSync(path.join(root, study, version), { recursive: true });
      fs.writeFileSync(path.join(root, study, version, '.ready'), 'ready');
      fs.writeFileSync(path.join(root, study, version, 'index.html'), version);
    }
    activateStoreVersion(id, 'one'); activateStoreVersion(other, 'one');
    activateStoreVersion(id, 'two');
    assert.equal(resolveStoreVersion(id), 'two');
    assert.equal(resolveStoreVersion(other), 'one');
    assert.equal((await readStoreVersionAsset(id, 'one', 'index.html')).toString(), 'one');
    resetStoreVersion(id);
    assert.equal(resolveStoreVersion(id), undefined);
    assert.equal(resolveStoreVersion(other), 'one');
    assert.equal((await readStoreVersionAsset(id, 'two', 'index.html')).toString(), 'two');
  } finally { fs.rmSync(path.join(root, id), { recursive: true, force: true }); fs.rmSync(path.join(root, other), { recursive: true, force: true }); }
});
