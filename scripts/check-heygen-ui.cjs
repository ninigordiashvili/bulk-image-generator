/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict'), path = require('node:path'), os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(os.tmpdir(), 'bulk-ui-check-tools/node_modules/playwright-core'));
require('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
function wav(seconds = 6) {
  const rate = 24000, bytes = Buffer.alloc(44 + rate * seconds * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let n = 0; n < rate * seconds; n++) bytes.writeInt16LE(Math.round(Math.sin(n * 0.1) * 2000), 44 + n * 2);
  return bytes;
}
async function main() {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ httpCredentials: { username: 'local', password: process.env.APP_PASSWORD?.trim() || '' }, viewport: { width: 1440, height: 1100 } });
    const batches = new Map(), inputs = [], errors = [];
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const reply = data => route.fulfill({ json: data });
      if (url.pathname.endsWith('/accounts')) return reply({ ok: true, accounts: url.pathname.includes('/vertex/') ? [] : [{ id: 'test', label: 'Test Kie', provider: 'kie' }], problems: [] });
      if (url.pathname.endsWith('/credits')) return reply({ ok: true, credits: 100 });
      if (url.pathname === '/api/heygen/account') return reply({ ok: true, wallet: { remaining_balance: 5 } });
      if (url.pathname === '/api/heygen/avatars') return reply({ ok: true, data: [{ id: 'saved', name: 'Test character', avatar_type: 'photo_avatar', supported_api_engines: ['avatar_iii', 'avatar_iv', 'avatar_v'] }], has_more: false });
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
      // No real API traffic, including accidental paid endpoints.
      return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto('http://localhost:3000/');
    await page.getByRole('button', { name: /^videos$/i }).click();
    await page.locator('select').filter({ has: page.locator('option[value="heygen:main"]') }).selectOption('heygen:main');
    const defaults = page.locator('section').filter({ has: page.getByRole('heading', { name: 'HeyGen batch defaults' }) });
    assert.equal(await defaults.getByLabel('HeyGen aspect ratio', { exact: true }).inputValue(), 'auto');
    assert.equal(await defaults.getByLabel('HeyGen quality', { exact: true }).inputValue(), '1080p');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=', 'base64');
    await page.locator('input[type=file][accept="image/*"]').setInputFiles([{ name: 'portrait-a.png', mimeType: 'image/png', buffer: image }, { name: 'portrait-b.png', mimeType: 'image/png', buffer: image }]);
    const rows = page.locator('li').filter({ has: page.getByLabel('HeyGen character source') });
    await rows.nth(1).waitFor();
    for (let index = 0; index < 2; index++) {
      assert.equal(await rows.nth(index).getByLabel('HeyGen quality', { exact: true }).isVisible(), false);
      assert.equal(await rows.nth(index).locator('textarea').isVisible(), false);
      await rows.nth(index).getByText('HeyGen Settings', { exact: true }).click();
      assert.equal(await rows.nth(index).getByLabel('HeyGen quality', { exact: true }).isVisible(), true);
    }
    await page.locator('input[type=file][accept^="audio/"]').setInputFiles({ name: 'test-voice.wav', mimeType: 'audio/wav', buffer: wav() });
    await page.getByRole('button', { name: /all rows/ }).click();
    for (let index = 0; index < 2; index++) {
      await rows.nth(index).getByTitle('Change the cut', { exact: true }).click();
      await page.getByLabel('Start', { exact: true }).fill(index ? '2' : '0.5');
      await page.getByLabel('Start', { exact: true }).press('Enter');
      await page.getByLabel('Length', { exact: true }).fill(index ? '2.3' : '1.2');
      await page.getByRole('button', { name: 'Use this cut', exact: true }).click();
    }
    await rows.nth(0).getByLabel('HeyGen aspect ratio', { exact: true }).selectOption('9:16');
    await rows.nth(0).locator('textarea').fill('Gentle head movement');
    await rows.nth(1).locator('select').filter({ has: page.locator('option[value="heygen:avatar_iii"]') }).selectOption('heygen:avatar_iii');
    assert.equal(await rows.nth(1).getByLabel('HeyGen character source', { exact: true }).inputValue(), 'photo');
    assert.equal(await rows.nth(1).locator('textarea').isDisabled(), true);
    await rows.nth(1).getByLabel('HeyGen character source', { exact: true }).selectOption('avatar');
    await rows.nth(1).getByLabel('HeyGen avatar', { exact: true }).selectOption('saved');
    assert.ok((await page.getByText('for 2 videos', { exact: false }).textContent()).includes('$0.06'));
    await page.screenshot({ path: '.local/heygen-ui.png', fullPage: true });
    await page.getByRole('button', { name: 'Generate 2 videos', exact: true }).click();
    await page.getByText('You can close this browser once generation has started.', { exact: false }).waitFor();
    assert.equal(inputs.length, 2);
    assert.notEqual(inputs[0].job.id, inputs[1].job.id);
    assert.ok(inputs.every(input => input.provider === 'heygen' && input.request.accountId === 'main'));
    assert.deepEqual(inputs.map(input => input.request.audio.seconds), [1.2, 2.3]);
    assert.deepEqual(inputs.map(input => input.request.aspectRatio), ['9:16', 'auto']);
    assert.equal(inputs[1].request.heygen.avatarId, 'saved');
    assert.equal(inputs[0].request.prompt, 'Gentle head movement');
    await page.getByRole('button', { name: /^images$/i }).click();
    assert.equal(await page.locator('option[value="heygen:main"]').count(), 0, 'HeyGen must not become an image account');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: two-image batch, independent audio trims, saved avatar selection, engine controls, $1/min estimate, manual/auto ratios, unique row IDs, provider isolation. All submissions intercepted; no paid calls.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
