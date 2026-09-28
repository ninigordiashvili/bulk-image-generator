/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(path.join(os.tmpdir(), 'bulk-ui-check-tools/node_modules/playwright-core'));
require('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
async function main() {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ httpCredentials: { username: 'local', password: process.env.APP_PASSWORD?.trim() || '' } });
    let created, uploaded, started = false;
    const errors = [];
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      let body = { ok: true, accounts: [], problems: [], entries: [], files: [] };
      const status = () => ({ ...created, createdAt: Date.now(), execution: 'vertex-batch', providerState: 'JOB_STATE_PENDING', phase: started ? 'running' : 'uploading', jobs: uploaded ? [uploaded.job] : [], total: 1, uploaded: uploaded ? 1 : 0, elapsedMs: 0, remainingMs: null, estimatedFinishAt: null, progress: { total: 1, completed: 0, succeeded: 0, failed: 0, inFlight: 1 } });
      if (url.pathname === '/api/vertex/accounts') body.accounts = [{ id: 'fixture', label: 'Batch fixture', keyHint: 'Vertex', source: 'file', limits: { imagePerMinute: 2, imageConcurrency: 2, videoPerMinute: 1, videoConcurrency: 1 } }];
      if (url.pathname === '/api/work' && request.method() === 'POST') { created = request.postDataJSON(); body = { ok: true, status: status() }; }
      if (url.pathname.startsWith('/api/work/')) {
        if (request.method() === 'PUT') { uploaded = JSON.parse(request.postData()); body = { ok: true, received: Number(url.searchParams.get('total')) }; }
        else { if (request.method() === 'POST') started = true; body = { ok: true, status: status() }; }
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await context.addInitScript(() => {
      if (localStorage.getItem('batch-ui-seeded')) return;
      localStorage.setItem('batch-ui-seeded', '1');
      localStorage.setItem('bulk-image-generator', JSON.stringify({ version: 1, state: {
        settings: { provider: 'vertex', accountId: 'fixture', model: 'gemini-3.1-flash-lite-image', modelInputs: { 'gemini-3.1-flash-lite-image': { image_size: '1K', aspect_ratio: '16:9' } }, customModelId: '', customInputJson: '', imagesPerPrompt: 1, styleBible: '' },
        characters: [{ id: 1, label: 'Blue palette', base64: 'aGVsbG8=', mimeType: 'image/png', pinned: true }],
        promptText: 'Draw a mug using @1', queueConfig: { concurrency: 2, retries: 1 }, creditRates: {},
      } }));
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
    const mode = page.getByRole('combobox', { name: 'Image processing' });
    await mode.selectOption('batch');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await mode.inputValue(), 'batch');
    await page.getByText('Image output $0.0168', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Generate 1 images', exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Vertex batch: pending'));
    assert.equal(created.execution, 'vertex-batch'); assert.equal(created.accountId, 'fixture');
    assert.equal(uploaded.provider, 'vertex'); assert.equal(uploaded.request.referenceImages.length, 1);
    assert.match(uploaded.request.referenceImages[0].label, /Reference @1/);
    assert.equal(uploaded.request.input.image_size, '1K'); assert.deepEqual(errors, []);
    console.log('PASS: batch selector persists; cost and queued status render; prompt plus pinned/@1 reference reaches frozen Vertex batch upload');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
