// Host-owned universal browser regression gate. Generated code cannot modify this file.
// Checks core shopping behavior only; feature acceptance is assessed during the shopper retry.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const root = path.resolve(process.argv[2], 'dist');
const events: string[] = [];
const server = http.createServer((req, res) => {
  let pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) { let body = ''; req.on('data', (chunk) => body += chunk); req.on('end', () => { try { events.push(JSON.parse(body).type); } catch { /* Empty response request. */ } res.setHeader('Content-Type', 'application/json'); res.end('{}'); }); return; }
  pathname = pathname.replace(/^\/store-versions\/[^/]+\/[^/]+/, '');
  const file = path.resolve(root, '.' + (pathname === '/shop' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' } as Record<string, string>)[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Browser smoke server unavailable.');
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${address.port}/shop?session=smoke`, { waitUntil: 'networkidle' });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Tops', exact: true }).click();
  const product = page.getByRole('button', { name: /^View / }).first();
  await product.waitFor();
  await product.click();
  await page.locator('.mira-detail-info h1').waitFor();
  await page.locator('.mira-size-grid button').first().click();
  await page.getByRole('button', { name: /^Add to bag/ }).click();
  await page.getByRole('button', { name: /^Bag with/ }).click();
  await page.getByRole('button', { name: /^Continue to checkout/ }).click();
  for (const [label, value] of [['Email address', 'smoke@example.com'], ['First name', 'Test'], ['Last name', 'Shopper'], ['Address', '1 Demo Street'], ['City', 'Test City'], ['ZIP code', '10001']]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('button', { name: /^Place demo order/ }).click();
  await page.locator('.mira-complete-page').waitFor();
  if (!events.includes('checkout_completed')) throw new Error('Checkout completed telemetry was not preserved.');
  if (errors.length) throw new Error('Browser runtime errors: ' + errors.join('; '));
  console.log(JSON.stringify({ passed: true, checks: ['catalog', 'product', 'size selection', 'cart', 'checkout', 'checkout telemetry'] }));
} finally { await browser?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
