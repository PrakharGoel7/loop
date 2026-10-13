import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signVisitor, readVisitor } from './hosted-access.js';
test('hosted session cookies reject tampering and expiry', () => {
  process.env.LOOP_COOKIE_SECRET = 'unit-test-only-secret-with-32-characters';
  const value = { id: 'v1', role: 'participant' as const, expires: Date.now() + 60000 };
  const token = signVisitor(value);
  assert.deepEqual(readVisitor(token), value);
  assert.equal(readVisitor(token.replace(token[0], token[0] === 'A' ? 'B' : 'A')), null);
  assert.equal(readVisitor(signVisitor({ ...value, expires: Date.now() - 1 })), null);
  assert.equal(readVisitor('malformed'), null);
  delete process.env.LOOP_COOKIE_SECRET;
});

test('hosted access isolates study owners and disables browser admin access', async () => {
  const { default: express } = await import('express');
  const { installHostedAccess, claimSession, requireSessionOwner } = await import('./hosted-access.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const old = { ...process.env }; const cwd = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-auth-')); process.chdir(temp);
  Object.assign(process.env, { LOOP_HOSTED: '1', LOOP_PUBLIC_ORIGIN: 'https://test.invalid', LOOP_ADMIN_TOKEN: 'admin-test', LOOP_INVITE_TOKEN: 'invite-test', LOOP_COOKIE_SECRET: 'test-cookie-secret-that-is-long-enough' });
  const app = express(); installHostedAccess(app);
  app.get('/', (_req, res) => res.send('Loop'));
  app.post('/api/setup', (_req, res) => res.json({ ok: true }));
  app.post('/api/create/:id', (req, res) => { claimSession(req, String(req.params.id)); res.json({ ok: true }); });
  app.get('/api/study/:id', (req, res) => { if (requireSessionOwner(req, res, String(req.params.id))) res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  try {
    const enter = async () => {
      const response = await fetch(base + '/', { redirect: 'manual' });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Lax/);
      return response.headers.get('set-cookie')!.split(';')[0];
    };
    assert.equal((await fetch(base + '/api/study/s1')).status, 404);
    const cookie = await enter(); const other = await enter(); const admin = 'loop_access=' + signVisitor({ id: 'old-admin', role: 'admin', expires: Date.now() + 60000 });
    assert.notEqual(cookie, other);
    const oldPage = await fetch(base + '/access', { redirect: 'manual' });
    assert.equal(oldPage.status, 302);
    assert.equal(oldPage.headers.get('location'), '/');
    assert.equal((await fetch(base + '/access', { method: 'POST', headers: { origin: 'https://test.invalid' } })).status, 404);
    const returning = await fetch(base + '/', { headers: { cookie } });
    assert.equal(returning.headers.get('set-cookie'), null);
    assert.equal((await fetch(base + '/api/setup', { method: 'POST', headers: { cookie, origin: 'https://test.invalid' } })).status, 403);
    assert.equal((await fetch(base + '/api/setup', { method: 'POST', headers: { cookie: admin, origin: 'https://test.invalid' } })).status, 403);
    assert.equal((await fetch(base + '/api/create/s1', { method: 'POST', headers: { cookie, origin: 'https://test.invalid' } })).status, 200);
    assert.equal((await fetch(base + '/api/create/s2', { method: 'POST', headers: { cookie, origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await fetch(base + '/api/study/s1', { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + '/api/study/s1', { headers: { cookie: other } })).status, 404);
    assert.equal((await fetch(base + '/api/study/s1', { headers: { cookie: admin } })).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); process.chdir(cwd); process.env = old; fs.rmSync(temp, { recursive: true, force: true });
  }
});
