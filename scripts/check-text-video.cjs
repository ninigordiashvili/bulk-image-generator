/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'text-video-check-'));
process.env.WORK_ROOT = scratch;
process.env.VERTEX_QPM = '60000';
const resolve = Module._resolveFilename;
Module._resolveFilename = function(name, ...args) { return resolve.call(this, name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name, ...args); };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, file);
const storage = new Map(), saved = new Map(), calls = [];
global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const timer = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => timer(fn, Math.min(ms, 10), ...args);
let releaseImages;
const imageGate = new Promise(resolve => { releaseImages = resolve; });
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === '@/lib/galleryDb') return { loadVideos: async () => [], loadImages: async () => [], putVideo: async item => saved.set(item.id, item), putImage: async item => saved.set(item.id, item) };
  if (name === '@/server/vertexAccounts') return { VertexAccountError: class extends Error {}, findVertexAccount: async id => ({ id, projectId: 'project-' + id, credentials: 'fake-' + id, imageConcurrency: 1, videoConcurrency: 1, imageRequestsPerMinute: 60000, videoRequestsPerMinute: 60000 }) };
  if (name === '@google/genai') return { GoogleGenAI: class {
    constructor(options) {
      this.models = {
        generateContent: async request => {
          calls.push({ kind: 'image', options, request }); await imageGate;
          return { candidates: [{ content: { parts: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }] } }] };
        },
        generateVideos: async request => {
          calls.push({ kind: 'video', options, request });
          return { done: true, response: { generatedVideos: [{ video: { videoBytes: Buffer.from(request.prompt).toString('base64'), mimeType: 'video/mp4' } }] } };
        },
      };
    }
  } };
  return load.call(this, name, ...args);
};
global.fetch = async (url, options = {}) => {
  assert.ok(url.startsWith('/api/work'), 'No real network requests: ' + url);
  const request = new Request('http://test' + url, options);
  if (url === '/api/work') return require('../src/app/api/work/route.ts')[options.method || 'GET'](request);
  const id = url.split('/')[3].split('?')[0];
  const route = url.includes('/file?') ? '../src/app/api/work/[id]/file/route.ts' : '../src/app/api/work/[id]/route.ts';
  return require(route)[options.method || 'GET'](request, { params: Promise.resolve({ id }) });
};
async function until(test) { for (let i = 0; i < 1500; i++) { if (test()) return; await new Promise(resolve => timer(resolve, 5)); } throw Error('Timed out'); }
async function main() {
  const { parseVideoPrompts } = require('../src/lib/videoPrompts.ts');
  assert.deepEqual(parseVideoPrompts('#0-00\nA valley.\nCamera moves.\n\n#0:04 A river.').map(p => [p.tag, p.raw]), [['0-00', 'A valley.\nCamera moves.'], ['0-04', 'A river.']]);
  assert.deepEqual(parseVideoPrompts('First scene\nwith a continuation\n\nSecond scene').map(p => p.raw), ['First scene\nwith a continuation', 'Second scene']);
  assert.equal(parseVideoPrompts('First\nSecond').length, 2);
  const { videoRate } = require('../src/lib/vertexPricing.ts');
  const { estimateVideos } = require('../src/lib/vertexEstimate.ts');
  const model = 'veo-3.1-lite-generate-001';
  assert.equal(videoRate(model, false, '720p').usd, 0.03);
  assert.equal(videoRate(model, true, '720p').usd, 0.05);
  assert.equal(videoRate(model, false, '1080p').usd, 0.05);
  assert.equal(estimateVideos([4, 4], model, 1, 1, false, ['720p', '1080p']).usd, 0.32);
  const images = require('../src/store/generationStore.ts').useGenerationStore;
  images.setState({ refreshCredits: async () => {}, promptText: '#0-00\nImage one\n\n#0-04\nImage two', settings: { ...images.getState().settings, provider: 'vertex', accountId: 'images-A', model: 'gemini-3.1-flash-lite-image', imagesPerPrompt: 1 } });
  images.getState().startGeneration();
  await until(() => calls.some(c => c.kind === 'image'));
  const videoA = require('../src/store/videoStore.ts').useVideoStore;
  delete require.cache[require.resolve('../src/store/videoStore.ts')];
  const videoB = require('../src/store/videoStore.ts').useVideoStore;
  const originalNow = Date.now;
  Date.now = () => 1234567890; // Two tabs starting at exactly the same instant must not overwrite results.
  for (const [store, accountId] of [[videoA, 'videos-B'], [videoB, 'videos-C']]) {
    store.getState().setAccount({ provider: 'vertex', accountId });
    store.getState().setDefaults({ duration: 4, resolution: '720p', aspectRatio: '16:9' });
    store.getState().setPromptText('#0-00\nA valley.\nCamera moves.\n\n#0:04 A river.');
    store.getState().startGeneration();
    store.getState().setAccount({ accountId: 'changed-after-start' });
    store.getState().setPromptText('Changed after start');
  }
  Date.now = originalNow;
  await until(() => videoA.getState().queueState === 'done' && videoB.getState().queueState === 'done');
  assert.equal(images.getState().queueState, 'running');
  assert.equal(saved.size, 4);
  for (const store of [videoA, videoB]) {
    assert.equal(store.getState().progress.succeeded, 2);
    assert.deepEqual(store.getState().videos.map(v => v.tag), ['0-00', '0-04']);
    assert.ok(store.getState().videos.every(v => v.posterBase64 === ''));
    assert.ok(store.getState().videos.every(v => v.estimatedUsd === 0.12));
  }
  const videoCalls = calls.filter(c => c.kind === 'video');
  assert.equal(videoCalls.length, 4);
  assert.deepEqual(videoCalls.map(c => c.options.project).sort(), ['project-videos-B', 'project-videos-B', 'project-videos-C', 'project-videos-C']);
  for (const call of videoCalls) {
    assert.equal(call.request.model, model);
    assert.equal(call.request.config.generateAudio, false);
    assert.equal(call.request.config.durationSeconds, 4);
    assert.equal('image' in call.request, false);
    assert.ok(['A valley.\nCamera moves.', 'A river.'].includes(call.request.prompt));
  }
  releaseImages();
  await until(() => images.getState().queueState === 'done');
  assert.equal(saved.size, 6);
  const work = require('../src/server/work.ts');
  const batches = await work.listWork();
  assert.equal(batches.length, 3);
  for (const batch of batches) {
    assert.equal(batch.progress.succeeded, 2);
    const response = await fetch('/api/work/' + batch.id + '/file?index=0&download=1');
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-disposition').includes(batch.kind === 'video' ? '0-00.mp4' : '0-00.png'));
  }
  console.log('PASS: paragraph and timestamp parsing, resolution-aware silent pricing, three concurrent accounts, frozen inputs/accounts, no audio or image in text-video SDK requests, collision-free gallery IDs, named Activity downloads');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  releaseImages(); global.setTimeout = timer;
  assert.equal(path.dirname(scratch), os.tmpdir());
  assert.ok(path.basename(scratch).startsWith('text-video-check-'));
  fs.rmSync(scratch, { recursive: true, force: true });
});
