/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const url = process.env.TEST_APP_URL || 'http://127.0.0.1:3001';
assert.equal(new URL(url).port, '3001', 'Run only against the isolated test server');
const credentials = { username: 'test', password: 'background-ui-test' };
const errors = [];
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  let renderId;
  try {
    const first = await browser.newContext({ httpCredentials: credentials });
    const page = await first.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(url + '/sound');
    await page.getByLabel('Even out volume', { exact: true }).check();
    await page.getByLabel('Shorten long pauses', { exact: true }).uncheck();
    await page.reload();
    assert.equal(await page.getByLabel('Even out volume', { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel('Shorten long pauses', { exact: true }).isChecked(), false);
    assert.equal(await page.locator('input[type=range]').first().isDisabled(), true);
    console.log('PASS: voice controls render, persist after refresh, and disable pause adjustment in volume-only mode');

    // Deliberately nonexistent account: validates browser-close survival without any billed calls.
    const batchId = randomUUID();
    const create = await first.request.post(url + '/api/work', { data: { id: batchId, kind: 'image', accountId: 'ui-test-nonexistent-account', total: 3, concurrency: 1 } });
    assert.equal((await create.json()).ok, true);
    for (let index = 0; index < 3; index++) {
      const data = Buffer.from(JSON.stringify({ provider: 'kie', request: { accountId: 'ui-test-nonexistent-account', model: 'google/imagen4-fast', prompt: 'UI test' },
        job: { id: 'test-' + index, promptId: 'p' + index, prompt: 'UI test', promptIndex: index, copyIndex: 0, tag: null, referencedCharacterIds: [], status: 'queued', attempts: 0 } }));
      const response = await first.request.put(`${url}/api/work/${batchId}?index=${index}&offset=0&total=${data.length}`, { data, headers: { 'Content-Type': 'application/octet-stream' } });
      assert.equal((await response.json()).ok, true);
    }
    await page.evaluate(async id => {
      const result = await fetch('/api/work/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!result.ok) throw new Error('Start failed');
    }, batchId);
    await first.close();
    const second = await browser.newContext({ httpCredentials: credentials });
    const recovered = await second.newPage(); recovered.on('pageerror', error => errors.push(error.message));
    await recovered.goto(`${url}/activity?batch=${batchId}`);
    await recovered.getByRole('heading', { name: /Image batch/ }).waitFor();
    await recovered.getByText('UI test', { exact: true }).first().waitFor();
    for (let n = 0; n < 40; n++) {
      const { status } = await (await second.request.get(`${url}/api/work/${batchId}`)).json();
      if (status.phase === 'done') { assert.equal(status.progress.failed, 3); break; }
      if (n === 39) throw new Error('Batch did not finish after browser closed');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    await recovered.reload();
    await recovered.getByRole('button', { name: 'Retry failed / cancelled items' }).waitFor();
    console.log('PASS: batch continues after submitting browser closes; another browser opens saved progress and errors');

    // Actual FFmpeg export via HTTP: source is generated locally, no provider used.
    const image = execFileSync(require('ffmpeg-static'), ['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=30','-frames:v','1','-threads','1','-f','image2pipe','-c:v','png','-'], { windowsHide: true });
    const created = await (await second.request.post(url + '/api/editor/job')).json(); renderId = created.id;
    const uploaded = await (await second.request.post(`${url}/api/editor/job/${renderId}/upload?kind=image&name=test.png&offset=0`, { data: image, headers: { 'Content-Type': 'application/octet-stream' } })).json();
    const startRender = await second.request.post(`${url}/api/editor/job/${renderId}/render`, { data: {
      clips: [{ file: uploaded.stored, kind: 'still', start: 0, end: 5, zoom: 'in', film: true }],
      audio: null, total: 5, settings: { width: 1280, height: 720, fps: 30, film: 'medium', zoomAmount: 0.08, encoder: 'libx264' }, moments: [], shapes: [],
    } });
    assert.equal((await startRender.json()).ok, true);
    const premature = await second.request.get(`${url}/api/editor/job/${renderId}/output`);
    assert.equal(premature.status(), 409, 'unfinished exports must not download');
    await second.close();
    const third = await browser.newContext({ httpCredentials: credentials });
    const exportPage = await third.newPage(); exportPage.on('pageerror', error => errors.push(error.message));
    await exportPage.goto(`${url}/activity?render=${renderId}`);
    await exportPage.getByRole('heading', { name: 'Video export', exact: true }).waitFor();
    for (let n = 0; n < 100; n++) {
      const { status } = await (await third.request.get(`${url}/api/editor/job/${renderId}`)).json();
      if (status.phase === 'done') break;
      assert.notEqual(status.phase, 'error', status.error);
      if (n === 99) throw new Error('Render timed out');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    await exportPage.locator('video').waitFor();
    await exportPage.locator('video').evaluate(element => element.load());
    await exportPage.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
    const media = await exportPage.locator('video').evaluate(element => ({ duration: element.duration, error: element.error?.message }));
    assert.ok(Math.abs(media.duration - 5) < 0.1); assert.equal(media.error, undefined);
    await exportPage.screenshot({ path: path.join(__dirname, '..', 'activity-check.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await third.request.delete(`${url}/api/editor/job/${renderId}`); renderId = undefined;
    console.log('PASS: actual export survives browser closure, recovers via Activity, blocks incomplete download and plays complete MP4; no browser runtime errors');
  } finally {
    if (renderId) { const request = await browser.newContext({ httpCredentials: credentials }); await request.request.delete(`${url}/api/editor/job/${renderId}`).catch(() => {}); }
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
