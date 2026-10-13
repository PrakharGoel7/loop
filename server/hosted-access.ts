import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

type Visitor = { id: string; role: 'admin' | 'participant'; expires: number };
const cookieName = 'loop_access';
export const isHosted = () => process.env.LOOP_HOSTED === '1';
const equal = (a: string, b: string) => Boolean(b) && crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
const secret = () => process.env.LOOP_COOKIE_SECRET || '';
export function signVisitor(visitor: Visitor) {
  if (secret().length < 32) throw new Error('Hosted cookie secret is not configured.');
  const payload = Buffer.from(JSON.stringify(visitor)).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret()).update(payload).digest('base64url')}`;
}
export function readVisitor(token: string): Visitor | null {
  try {
    if (secret().length < 32) return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !equal(signature, crypto.createHmac('sha256', secret()).update(payload).digest('base64url'))) return null;
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Visitor;
    return typeof value.id === 'string' && ['admin', 'participant'].includes(value.role) && value.expires > Date.now() ? value : null;
  } catch { return null; }
}
function visitor(req: express.Request) {
  const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='));
  return readVisitor(cookie?.slice(cookieName.length + 1) || '');
}
const ownersFile = () => path.join(process.cwd(), 'data', 'access-owners.json');
function owners(): Record<string, string> {
  return fs.existsSync(ownersFile()) ? JSON.parse(fs.readFileSync(ownersFile(), 'utf8')) : {};
}
export function claimSession(req: express.Request, id: string) {
  if (!isHosted()) return;
  const who = visitor(req); if (!who) throw new Error('Sign in first.');
  const data = owners(); data[id] = who.id;
  fs.mkdirSync(path.dirname(ownersFile()), { recursive: true });
  fs.writeFileSync(ownersFile() + '.tmp', JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(ownersFile() + '.tmp', ownersFile());
}
export function requireSessionOwner(req: express.Request, res: express.Response, id: string) {
  if (!isHosted()) return true;
  const who = visitor(req);
  if (who && owners()[id] === who.id) return true;
  res.status(404).json({ error: 'Study not found or not accessible.' }); return false;
}
// Hosted configuration is managed on the server, never through browser credentials.
export function isAdmin(_req: express.Request) { return !isHosted(); }
export function installHostedAccess(app: express.Express) {
  // Public synthetic demo data only; no session records or credentials.
  app.get('/knowledge-base/past-user-issues.csv', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/csv').sendFile(path.join(process.cwd(), 'knowledge-base/past-user-issues.csv'));
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  if (!isHosted()) return;
  if (!process.env.LOOP_PUBLIC_ORIGIN || secret().length < 32) throw new Error('Hosted access configuration is incomplete.');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== process.env.LOOP_PUBLIC_ORIGIN) {
      res.status(403).json({ error: 'Use the hosted website to make this request.' }); return;
    }
    next();
  });
  app.get('/access', (_req, res) => res.redirect(302, '/'));
  app.post('/access', (_req, res) => res.sendStatus(404));
  app.use((req, res, next) => {
    if (!visitor(req)) {
      // Give public visitors a private identity so study ownership still applies.
      const token = signVisitor({ id: crypto.randomUUID(), role: 'participant', expires: Date.now() + 7 * 86400000 });
      res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
      req.headers.cookie = `${cookieName}=${token}`;
    }
    if (req.path === '/api/setup' && !isAdmin(req)) { res.status(403).json({ error: 'Tavus configuration is managed on the server.' }); return; }
    next();
  });
}
