/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fixtureName = 'compact-ui-test-' + Date.now() + '.png';
const fixturePath = path.join(process.cwd(), 'public', fixtureName);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(os.tmpdir(), 'bulk-ui-check-tools/node_modules/playwright-core'));
require('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
async function main() {
  fs.writeFileSync(fixturePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCwAAAABJRU5ErkJggg==', 'base64'));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 }, httpCredentials: { username: 'local', password: process.env.APP_PASSWORD?.trim() || '' } });
    const mutations = [], errors = [], downloads = [];
    let failureCount = 1;
    const jobs = [0, 1, 2].map(index => ({ id: 'job-' + index, promptIndex: index, status: 'success', prompt: 'Test visual', files: [{ name: index + '.png', mimeType: 'image/png', url: '/' + fixtureName + '?index=' + index }] }));
    jobs.push({ id: 'failed', promptIndex: 3, status: 'error', prompt: 'Failed visual', files: [{ name: 'failed.png', mimeType: 'image/png', url: '/api/work/ui-test/file?index=3' }] });
    const status = { id: 'ui-test', kind: 'image', phase: 'done', jobs, total: 4, accountId: 'test', elapsedMs: 1000, remainingMs: 0, progress: { total: 4, completed: 4, succeeded: 3, failed: 1, inFlight: 0 } };
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') { mutations.push(url.pathname); return route.fulfill({ json: { ok: true } }); }
      if (url.pathname.endsWith('/accounts')) return route.fulfill({ json: { ok: true, accounts: url.pathname.includes('/vertex/') ? [{ id: 'test', label: 'Test Vertex', provider: 'vertex', limits: { imagePerMinute: 2, videoPerMinute: 1, imageConcurrency: 1, videoConcurrency: 1 } }] : [], problems: [] } });
      if (url.pathname === '/api/activity') return route.fulfill({ json: { ok: true, entries: [{ ...status, label: 'Test batch', href: '/activity?batch=ui-test', createdAt: Date.now(), done: 4, succeeded: 3, failed: failureCount }] } });
      if (url.pathname === '/api/work/ui-test') return route.fulfill({ json: { ok: true, status } });
      if (url.pathname === '/api/work/ui-test/file') {
        throw new Error('Failed job must not download');
      }
      return route.fulfill({ json: { ok: true, entries: [], accounts: [] } });
    });
    await context.addInitScript(() => {
      window.downloadLinks = [];
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { window.downloadLinks.push(this.href); return click.call(this); };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('download', download => downloads.push(download));
    await page.goto('http://localhost:3000/activity');
    const failures = page.getByText('1 failed or cancelled', { exact: true });
    await failures.waitFor();
    assert.ok(await failures.evaluate(node => node.classList.contains('text-red-400')));
    failureCount = 0;
    const noFailures = page.getByText('0 failed or cancelled', { exact: true });
    await noFailures.waitFor();
    assert.equal(await noFailures.evaluate(node => node.classList.contains('text-red-400')), false);
    await page.getByRole('button', { name: 'Download all', exact: true }).click({ timeout: 15000 }).catch(async error => { console.log((await page.locator('body').innerText()).slice(0, 1800), errors); throw error; });
    await page.getByRole('status').filter({ hasText: '3 downloads requested' }).waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes('Starting downloads...'));
    const transfers = await page.evaluate(() => window.downloadLinks);
    assert.equal(transfers.length, 3);
    await Promise.all(downloads.map(download => download.path()));
    assert.ok(transfers.every(query => query.includes('download=1')));
    assert.equal(downloads.length, 3);
    assert.deepEqual(downloads.map(download => download.suggestedFilename()), ['0.png', '1.png', '2.png']);
    for (const download of downloads) assert.equal(await download.failure(), null);
    assert.deepEqual(mutations, [], 'No aggregate download receipts or generation submissions');
    const help = page.getByRole('button', { name: 'Download help', exact: true });
    await help.hover();
    await page.getByRole('tooltip').filter({ hasText: 'allow multiple downloads' }).waitFor();
    await help.focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('tooltip').count(), 0);
    await page.goto('http://localhost:3000/');
    await page.getByRole('button', { name: /^videos$/i }).click();
    await page.locator('select').filter({ has: page.locator('option[value="vertex:test"]') }).selectOption('vertex:test');
    await page.getByRole('button', { name: 'Text to video', exact: true }).click();
    const prompt = page.getByLabel('Video prompts', { exact: true });
    await prompt.fill('#0-00 A valley.\n#0-04 A river.');
    assert.ok(await page.getByLabel('Model', { exact: true }).evaluate(node =>
      [...node.closest('section').querySelectorAll('button')].some(button => button.textContent.startsWith('Generate'))));
    const bounds = await prompt.boundingBox();
    for (const name of ['Model', 'Duration', 'Resolution', 'Ratio']) {
      const box = await page.getByLabel(name, { exact: true }).boundingBox();
      assert.ok(box.y + box.height <= bounds.y, name + ' above prompts');
    }
    await page.getByLabel('Duration', { exact: true }).selectOption('4');
    await page.getByLabel('Resolution', { exact: true }).selectOption('720p');
    await page.getByText('Estimated batch: $0.24', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(os.tmpdir(), 'bulk-compact-desktop.png') });
    await page.getByRole('button', { name: 'Image to video', exact: true }).click();
    await page.getByLabel('Batch duration', { exact: true }).selectOption('6');
    const settings = await page.getByLabel('Batch model', { exact: true }).boundingBox();
    const storyboard = await page.getByRole('heading', { name: 'Storyboard', exact: true }).boundingBox();
    assert.ok(settings.y + settings.height < storyboard.y);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Batch settings', exact: true }).click();
    const tip = await page.getByRole('tooltip').boundingBox();
    assert.ok(tip.x >= 0 && tip.x + tip.width <= 390, 'Mobile help fits viewport');
    await page.screenshot({ path: path.join(os.tmpdir(), 'bulk-compact-mobile.png') });
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.deepEqual(mutations, []);
    console.log('PASS: failure count red only above zero, settings share Generate toolbar, three separate native downloads, success-only files, per-file download URLs, no aggregate receipt; top video settings, live estimate, hover/focus/Escape/tap help, mobile tooltip; no paid calls.');
  } finally { await browser.close(); fs.unlinkSync(fixturePath); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
