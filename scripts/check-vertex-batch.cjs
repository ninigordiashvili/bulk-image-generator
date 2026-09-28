/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-vertex-batch-check-'));
process.env.WORK_ROOT = path.join(scratch, 'work');
process.env.VERTEX_USAGE_FILE = path.join(scratch, 'usage.jsonl');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(name, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name, ...rest); };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
const account = id => ({ id, label: id, projectId: `project-${id}`, credentials: 'adc', location: 'global', spendCapUsd: 100 });
const load = Module._load;
Module._load = function(name, ...rest) {
  if (name === './workProvider') return { performWork: () => { throw Error('Batch must never use live generation'); } };
  if (name === './vertexAccounts') return { findVertexAccount: async id => account(id) };
  if (name === 'node:timers/promises') return { setTimeout: () => new Promise(r => setTimeout(r, 5)) };
  return load.call(this, name, ...rest);
};
const batch = require('../src/server/vertexBatch.ts');
const usage = require('../src/server/vertexUsage.ts');
const vertex = require('../src/server/vertex.ts');
let work = require('../src/server/work.ts');
const objects = new Map(), jobs = new Map(), submitted = new Map(), getCalls = new Map(), cancelled = new Set();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
batch.VertexBatchCloud.prototype.ensureBucket = async function() {};
batch.VertexBatchCloud.prototype.upload = async function(bucket, name, bytes) { objects.set(`${bucket}/${name}`, Buffer.from(bytes)); return `gs://${bucket}/${name}`; };
batch.VertexBatchCloud.prototype.submit = async function(state) {
  const id = this.account.id;
  submitted.set(id, (submitted.get(id) || 0) + 1);
  if (id === 'rejected') throw new batch.CloudError('Billing is disabled', 403);
  const job = { name: `projects/${this.account.projectId}/locations/global/batchPredictionJobs/${state.attempt}`, state: 'JOB_STATE_RUNNING', outputInfo: { gcsOutputDirectory: `gs://${state.bucket}/${state.prefix}/output/` } };
  jobs.set(state.prefix, job);
  const requests = objects.get(`${state.bucket}/${state.prefix}/input.jsonl`).toString().trim().split('\n').map(line => JSON.parse(line).request);
  for (const req of requests) { assert.deepEqual(req.generationConfig.responseModalities, ['IMAGE']); assert.equal(req.generationConfig.imageConfig.imageSize, '1K'); }
  const rows = requests.map((request, i) => ({ request, ...(i === 2 ? { status: 'SAFETY: image declined' } : { response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }], usageMetadata: { promptTokenCount: 1130, candidatesTokenCount: 1120, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }] } } }) }));
  objects.set(`${state.bucket}/${state.prefix}/output/predictions.jsonl`, Buffer.from(rows.reverse().map(row => JSON.stringify(row)).join('\n')));
  if (id === 'lost' || id === 'uncertain') throw Error('Connection lost after acceptance');
  return job;
};
let allowRecovery = false;
batch.VertexBatchCloud.prototype.recover = async function(prefix) { return this.account.id === 'uncertain' && !allowRecovery ? undefined : jobs.get(prefix); };
batch.VertexBatchCloud.prototype.get = async function(name) {
  const job = [...jobs.values()].find(job => job.name === name);
  const count = (getCalls.get(name) || 0) + 1; getCalls.set(name, count);
  if (this.account.id === 'hold' && !allowRecovery && !cancelled.has(name)) return { ...job, state: 'JOB_STATE_RUNNING' };
  return { ...job, state: cancelled.has(name) ? 'JOB_STATE_CANCELLED' : count > 1 ? 'JOB_STATE_SUCCEEDED' : 'JOB_STATE_RUNNING' };
};
batch.VertexBatchCloud.prototype.cancel = async function(name) { cancelled.add(name); };
batch.VertexBatchCloud.prototype.list = async (bucket, prefix) => [...objects.keys()].filter(key => key.startsWith(`${bucket}/${prefix}`)).map(key => ({ name: key.slice(bucket.length + 1) }));
batch.VertexBatchCloud.prototype.download = async (bucket, name) => new Response(objects.get(`${bucket}/${name}`));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 500; i++) { if (await fn()) return; await pause(10); } throw Error('Timed out'); }
async function make(accountId, total = 1) {
  const id = randomUUID();
  await work.createWork({ id, kind: 'image', accountId, total, concurrency: 2, execution: 'vertex-batch', vertexBatches: [{ attempted: true }] });
  for (let i = 0; i < total; i++) {
    const input = { provider: 'vertex', request: { accountId, model: 'gemini-3.1-flash-lite-image', prompt: i === 2 ? 'blocked' : 'same prompt', styleBible: 'same style', input: { image_size: '1K', aspect_ratio: '16:9' }, referenceImages: [{ label: 'Reference @1', base64: png.toString('base64'), mimeType: 'image/png' }] }, job: { id: `j${i}`, promptId: `p${i}`, prompt: 'same prompt', promptIndex: i, copyIndex: 0, referencedCharacterIds: [1], status: 'queued', attempts: 0 } };
    const bytes = Buffer.from(JSON.stringify(input)); await work.uploadWork(id, i, 0, bytes.length, bytes);
  }
  return id;
}
async function done(id, phase = 'done') { await until(async () => (await work.workStatus(id)).phase === phase); }
async function main() {
  try {
    const id = await make('normal', 3);
    await Promise.all([work.startWork(id), work.startWork(id)]); await done(id);
    const status = await work.workStatus(id);
    assert.equal(submitted.get('normal'), 1); assert.equal(status.progress.succeeded, 2); assert.equal(status.progress.failed, 1);
    assert.match(status.jobs[2].error, /SAFETY/); assert.equal((await work.workResult(id, 0)).images[0].width, 1);
    const savedPath = path.join(work.workDir(id), 'status.json');
    const data = JSON.parse(fs.readFileSync(savedPath)); const state = data.vertexBatches[0];
    assert.equal(state.indices.length, 3); assert.equal(state.imported.length, 3);
    assert.equal([...objects.keys()].filter(key => key.startsWith(`${state.bucket}/${state.prefix}/references/`)).length, 1);
    assert.equal(usage.readUsage().entries.length, 2); assert.equal(usage.reservedBatchUsd('normal'), 0);
    console.log('PASS: reference deduplication, image-only payload, out-of-order duplicate prompts, partial safety failure, saved results and usage');

    // Simulate a process ending after importing outputs but before the final checkpoint.
    data.phase = 'running'; state.terminal = false; state.imported = [];
    fs.writeFileSync(savedPath, JSON.stringify(data)); delete global.__backgroundWork; delete require.cache[require.resolve('../src/server/work.ts')]; work = require('../src/server/work.ts');
    await work.listWork(); await done(id);
    assert.equal(submitted.get('normal'), 1); assert.equal(usage.readUsage().entries.length, 2);
    console.log('PASS: restart resumes accepted job and usage accounting stays idempotent');

    const lost = await make('lost'); await work.startWork(lost); await done(lost); assert.equal(submitted.get('lost'), 1);
    const uncertain = await make('uncertain'); await work.startWork(uncertain); await done(uncertain, 'interrupted');
    await assert.rejects(work.deleteWorkHistory(uncertain), /still be processing/);
    await assert.rejects(work.withIdleAccount('vertex', 'uncertain', () => {}), /active work/);
    allowRecovery = true; await work.startWork(uncertain, true); await done(uncertain); assert.equal(submitted.get('uncertain'), 1);
    console.log('PASS: lost POST response is recovered without re-submission; uncertain jobs retain IDs and protect account removal');

    const reject = await make('rejected'); await work.startWork(reject); await done(reject);
    assert.match((await work.workStatus(reject)).jobs[0].error, /Billing is disabled/); assert.equal(usage.reservedBatchUsd('rejected'), 0);
    allowRecovery = false; const hold = await make('hold'); await work.startWork(hold);
    await until(async () => (await work.workStatus(hold)).providerJobName);
    assert.ok(usage.reservedBatchUsd('hold') > 0);
    assert.throws(() => vertex.guardSpend({ ...account('hold'), spendCapUsd: 0.02 }, 0.01), /past its cap/);
    await work.cancelWork(hold); await done(hold, 'cancelled'); assert.equal(cancelled.size, 1); assert.equal(usage.reservedBatchUsd('hold'), 0);
    console.log('PASS: clear submission rejection, pending batch spend reservation, provider cancellation and completed-output collection');

    assert.throws(() => batch.validateBatchInput({ provider: 'vertex', request: { accountId: 'B', model: 'gemini-3.1-flash-lite-image' } }, 'A'), /selected Vertex account/);
    const a = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };
    const b = { contents: [{ role: 'user', parts: [{ text: 'hello', fileData: null, inlineData: null }] }] };
    assert.equal(batch.batchRequestHash(a), batch.batchRequestHash(b));
    console.log('PASS: account isolation, output normalization and no live-image fallback');
  } finally {
    await pause(30);
    assert.equal(path.dirname(scratch), os.tmpdir()); assert.ok(path.basename(scratch).startsWith('bulk-vertex-batch-check-'));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
