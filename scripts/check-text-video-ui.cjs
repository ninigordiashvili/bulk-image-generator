/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(os.tmpdir(), 'bulk-ui-check-tools/node_modules/playwright-core'));
require('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
async function main() {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ httpCredentials: { username: 'local', password: process.env.APP_PASSWORD?.trim() || '' } });
    const accounts = ['A', 'B', 'C'].map(id => ({ id, label: 'Test Vertex ' + id, provider: 'vertex', limits: { imagePerMinute: 2, videoPerMinute: 1, imageConcurrency: 1, videoConcurrency: 1 } }));
    const batches = new Map(), inputs = [], errors = [];
    // The browser can read app assets, but every generation submission is intercepted.
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const reply = data => route.fulfill({ json: data });
      if (url.pathname.endsWith('/accounts')) return reply({ ok: true, accounts: url.pathname.includes('/vertex/') ? accounts : [], problems: [] });
      if (url.pathname === '/api/activity') return reply({ ok: true, entries: [] });
      if (url.pathname === '/api/work' && request.method() === 'POST') {
        const body = request.postDataJSON();
        const status = { ...body, phase: 'uploading', uploaded: 0, jobs: [], elapsedMs: 0, remainingMs: null, progress: { total: body.total, completed: 0, succeeded: 0, failed: 0, inFlight: 0 } };
        batches.set(body.id, status); return reply({ ok: true, status });
      }
      if (url.pathname.startsWith('/api/work/')) {
        const status = batches.get(url.pathname.split('/')[3]);
        if (request.method() === 'PUT') {
          const input = JSON.parse(request.postDataBuffer().toString()); inputs.push(input);
          status.jobs.push(input.job); status.uploaded++;
          return reply({ ok: true, received: Number(url.searchParams.get('total')) });
        }
        if (request.method() === 'POST') status.phase = 'running';
        return reply({ ok: true, status });
      }
      if (request.method() !== 'GET') return route.abort();
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto('http://localhost:3000/');
    await page.getByRole('button', { name: /^videos$/i }).click();
    await page.locator('select').filter({ has: page.locator('option[value="vertex:B"]') }).selectOption('vertex:B');
    const box = page.getByLabel('Video prompts', { exact: true });
    await box.fill('#0-00\nA valley.\nCamera moves.\n\n#0:04 A river.');
    await page.getByLabel('Duration', { exact: true }).selectOption('4');
    await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
    assert.ok(await page.getByText('Audio off.', { exact: false }).textContent().then(text => text.includes('$0.03/second') && text.includes('$0.24')));
    await page.getByText('Preview 2 prompts and filenames', { exact: true }).click();
    assert.equal(await page.getByText('0-00.mp4', { exact: true }).count(), 1);
    assert.equal(await page.getByText('0-04.mp4', { exact: true }).count(), 1);
    await page.getByLabel('Resolution', { exact: true }).selectOption('1080p');
    assert.ok((await page.getByText('Audio off.', { exact: false }).textContent()).includes('$0.40'));
    await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
    await page.getByRole('button', { name: 'Generate 2 videos', exact: true }).click();
    await page.getByText('You can close this browser once generation has started.', { exact: false }).waitFor();
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs.map(input => input.job.tag), ['0-00', '0-04']);
    assert.ok(inputs.every(input => input.request.accountId === 'B' && !('image' in input.request)));
    await page.getByRole('button', { name: /^images$/i }).click();
    await page.locator('select').filter({ has: page.locator('option[value="vertex:C"]') }).selectOption('vertex:C');
    await page.getByRole('button', { name: /^videos/i }).click();
    assert.equal(await page.locator('select').filter({ has: page.locator('option[value="vertex:B"]') }).inputValue(), 'vertex:B');
    assert.equal(await box.inputValue(), '#0-00\nA valley.\nCamera moves.\n\n#0:04 A river.');
    const popupPromise = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Open another batch' }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await popup.getByRole('button', { name: /^videos$/i }).click();
    await popup.locator('select').filter({ has: popup.locator('option[value="vertex:C"]') }).selectOption('vertex:C');
    assert.equal(await page.locator('select').filter({ has: page.locator('option[value="vertex:B"]') }).inputValue(), 'vertex:B');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: live UI form, filenames, silent 720p/1080p estimates, intercepted text-only submission, independent image/video selections and additional browser tab; no paid calls');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
