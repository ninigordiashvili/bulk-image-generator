/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), ts = require('typescript'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(name, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name, ...rest); };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, file);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-check-'));
process.chdir(scratch);
process.env.WORK_ROOT = scratch;
process.env.HEYGEN_API_KEY = 'mock-key';
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const load = Module._load;
Module._load = function(name, ...rest) {
  if (name === './heygenMedia') return { finishHeygenVideo: async bytes => bytes };
  if (name === 'node:timers/promises') return { setTimeout: async (_, value, options) => { options?.signal?.throwIfAborted(); await new Promise(r => setTimeout(r, 1)); return value; } };
  if (name === '@/lib/galleryDb') return { loadVideos: async () => [], loadImages: async () => [] };
  return load.call(this, name, ...rest);
};
const calls = [], accepted = new Map();
let lostAcknowledgement = true, downloadsFail = false, providerFailed = false, quota = false;
global.fetch = async (url, options = {}) => {
  const value = String(url), endpoint = value.replace('https://api.heygen.com/v3/', '');
  if (value.startsWith('https://output.test/')) return new Response('video-bytes', { status: downloadsFail ? 503 : 200 });
  assert.ok(value.startsWith('https://api.heygen.com/v3/'), 'No unmocked network: ' + value);
  const key = options.headers?.['Idempotency-Key'];
  calls.push({ endpoint, key, body: typeof options.body === 'string' ? JSON.parse(options.body) : null });
  if (endpoint === 'assets') return Response.json({ data: { asset_id: key } });
  if (endpoint === 'avatars') return Response.json({ data: { avatar_item: { id: 'saved-avatar' } } });
  if (endpoint.startsWith('avatars/looks/')) return Response.json({ data: { id: 'saved-avatar', avatar_type: 'photo_avatar', status: 'completed', supported_api_engines: ['avatar_iii', 'avatar_iv', 'avatar_v'] } });
  if (endpoint === 'videos') {
    if (quota) { quota = false; return Response.json({ error: { message: 'quota' } }, { status: 429, headers: { 'Retry-After': '0.001' } }); }
    if (!accepted.has(key)) accepted.set(key, 'video-' + accepted.size);
    if (lostAcknowledgement) { lostAcknowledgement = false; throw new Error('lost acknowledgement'); }
    return Response.json({ data: { video_id: accepted.get(key) } });
  }
  if (endpoint.startsWith('videos/')) return Response.json({ data: providerFailed ? { status: 'failed', failure_message: 'provider failed' } : { status: 'completed', video_url: 'https://output.test/' + endpoint } });
  throw new Error('Unexpected request: ' + endpoint);
};
async function main() {
  const { videoModel, defaultVideoModelFor } = require('../src/lib/videoModels.ts');
  const { heygenEstimate } = require('../src/lib/heygen.ts');
  const { encodeCut } = require('../src/lib/audioCut.ts');
  const { buildHeygenRequest, performHeygenWork, validateHeygenAudio } = require('../src/server/heygen.ts');
  const { useVideoStore, isRunnable, shotSize } = require('../src/store/videoStore.ts');
  assert.equal(defaultVideoModelFor('kie'), 'veo3_lite');
  assert.equal(defaultVideoModelFor('heygen'), 'heygen:avatar_iv');
  assert.equal(heygenEstimate(90), 1.5);
  const decoded = { pcm: new Int16Array(48000 * 4).map((_, i) => i % 300), sampleRate: 48000, duration: 4 };
  const cut = await encodeCut(decoded, 0.75, 1.23, 32 * 1024 * 1024);
  assert.equal(cut.seconds, 1.23);
  const wav = Buffer.from(cut.base64, 'base64');
  assert.equal(wav.readInt16LE(44), decoded.pcm[36000]);
  assert.equal(wav.length, 44 + 59040 * 2);
  const req = { accountId: 'main', model: 'heygen:avatar_iv', prompt: 'Small gestures', duration: 8, resolution: '1080p', aspectRatio: 'auto', image: { base64: 'aW1hZ2U=', mimeType: 'image/png' }, audio: { base64: cut.base64, mimeType: cut.mimeType, seconds: cut.seconds }, heygen: { expressiveness: 'high', fit: 'contain' } };
  assert.throws(() => validateHeygenAudio({ ...req.audio, seconds: 2 }), /does not match/);
  const body = buildHeygenRequest(req, 'audio', 'image');
  assert.equal(body.aspect_ratio, 'auto'); assert.equal(body.audio_asset_id, 'audio'); assert.equal(body.expressiveness, 'high');
  assert.equal(body.motion_prompt, 'Small gestures'); assert.equal(body.fit, 'contain');
  // POST /v3/videos image schema has additionalProperties:false and no engine.
  const imageFields = new Set(["title", "folder_id", "resolution", "aspect_ratio", "fit", "background", "remove_background", "callback_url", "callback_id", "watermark", "caption", "output_format", "script", "voice_id", "audio_url", "audio_asset_id", "voice_settings", "type", "image", "brand_glossary_id", "motion_prompt", "expressiveness"]);
  const assertImageSchema = value => {
    assert.equal(value.type, "image");
    for (const field of Object.keys(value)) assert.ok(imageFields.has(field), "HeyGen image schema rejects: " + field);
  };
  assertImageSchema(body);
  assertImageSchema(buildHeygenRequest({ ...req, heygen: { ...req.heygen, source: "image", captions: true, title: "Test", removeBackground: true, backgroundColor: "#ffffff" } }, "audio", "image"));
  const iv = buildHeygenRequest({ ...req, heygen: { source: "avatar", avatarId: "saved-avatar", expressiveness: "low" } }, "audio", undefined, { id: "saved-avatar", avatar_type: "photo_avatar" });
  assert.equal(iv.engine.type, "avatar_iv");
  assert.equal(iv.motion_prompt, req.prompt);
  assert.equal(iv.expressiveness, "low");
  assert.ok(!('script' in body) && !('duration' in body) && !('voice_settings' in body));
  const look = { id: 'saved-avatar', avatar_type: 'photo_avatar', supported_api_engines: ['avatar_iii', 'avatar_iv', 'avatar_v'] };
  const iii = buildHeygenRequest({ ...req, model: 'heygen:avatar_iii', heygen: { source: 'avatar', avatarId: look.id } }, 'audio', undefined, look);
  assert.equal(iii.engine.type, 'avatar_iii'); assert.ok(!iii.motion_prompt && !iii.expressiveness);
  assert.throws(() => buildHeygenRequest({ ...req, model: 'heygen:avatar_iii', resolution: '4k' }, 'audio', undefined, look), /1080p/);
  assert.throws(() => buildHeygenRequest({ ...req, model: 'heygen:avatar_v', heygen: { source: 'image' } }, 'audio', 'image'), /Avatar IV/);
  const v = buildHeygenRequest({ ...req, model: 'heygen:avatar_v', heygen: { source: 'avatar', avatarId: look.id, referenceLookId: 'ref', outputFormat: 'webm', backgroundColor: '#ffffff' } }, 'audio', undefined, look);
  assert.equal(v.engine.reference_look_id, 'ref'); assert.equal(v.output_format, 'webm'); assert.ok(!v.background);
  useVideoStore.getState().setAccount({ provider: 'heygen', accountId: 'main' });
  assert.equal(useVideoStore.getState().defaults.aspectRatio, 'auto');
  useVideoStore.getState().applyToAll({ model: 'heygen:avatar_iii', heygen: { source: 'avatar', avatarId: look.id, avatarType: 'photo_avatar' }, resolution: '4k' });
  assert.equal(useVideoStore.getState().defaults.resolution, '1080p');
  useVideoStore.getState().addAvatarShots(3);
  for (const shot of useVideoStore.getState().shots) {
    useVideoStore.getState().setShotAudio(shot.id, { sourceId: 'track', name: 'voice', start: 0.75, duration: 1.23 });
  }
  assert.ok(useVideoStore.getState().shots.every(isRunnable));
  assert.equal(shotSize(useVideoStore.getState().shots[0]).duration, 1.23);
  const checkpoint = {}; let saved = 0;
  quota = true;
  await performHeygenWork(req, 'test', checkpoint, async () => { saved++; }, new AbortController().signal);
  assert.equal(accepted.size, 1, 'lost acknowledgement reuses one paid task');
  for (const call of calls.filter(c => c.endpoint === "videos" && c.body.type === "image")) assertImageSchema(call.body);
  assert.ok(saved >= 4 && checkpoint.taskId);
  const creates = calls.filter(c => c.endpoint === 'videos').length;
  downloadsFail = true;
  await assert.rejects(performHeygenWork(req, 'test', checkpoint, async () => {}, new AbortController().signal), /download failed/);
  downloadsFail = false;
  await performHeygenWork(req, 'test', checkpoint, async () => {}, new AbortController().signal);
  assert.equal(calls.filter(c => c.endpoint === 'videos').length, creates, 'download retry does not regenerate');
  providerFailed = true;
  await assert.rejects(performHeygenWork(req, 'test', checkpoint, async () => {}, new AbortController().signal), /generation failed/);
  assert.equal(checkpoint.heygen.failed, true);
  providerFailed = false;
  await performHeygenWork(req, 'test', checkpoint, async () => {}, new AbortController().signal);
  assert.equal(accepted.size, 2, 'confirmed failure can start a new task on retry');
  await assert.rejects(performHeygenWork(req, 'expired', { heygen: { submittedAt: Date.now() - 24 * 3600000 } }, async () => {}, new AbortController().signal), /safe retry window expired/);
  const work = require('../src/server/work.ts'), id = randomUUID();
  await work.createWork({ id, kind: 'video', accountId: 'main', total: 3, concurrency: 2 });
  for (let index = 0; index < 3; index++) {
    const input = { provider: 'heygen', request: { ...req, aspectRatio: index === 1 ? '9:16' : 'auto' }, job: { id: 'job-' + index, prompt: req.prompt, promptId: String(index), promptIndex: index, copyIndex: 0, tag: 'clip-' + index } };
    const bytes = Buffer.from(JSON.stringify(input));
    await work.uploadWork(id, index, 0, bytes.length, bytes);
  }
  await work.startWork(id);
  for (let n = 0; n < 500 && (await work.workStatus(id)).phase !== 'done'; n++) await new Promise(r => setTimeout(r, 10));
  const status = await work.workStatus(id);
  assert.equal(status.progress.succeeded, 3, JSON.stringify(status.jobs));
  assert.equal((await work.workResult(id, 1)).actualResolution, '1080p');
  assert.ok(calls.some(c => c.endpoint === 'videos' && c.body.aspect_ratio === '9:16'));
  const photoRequest = { ...req, model: 'heygen:avatar_iii', heygen: { source: 'photo' } };
  const firstPhoto = {}, secondPhoto = {};
  await performHeygenWork(photoRequest, 'photo-one', firstPhoto, async () => {}, new AbortController().signal);
  await performHeygenWork(photoRequest, 'photo-two', secondPhoto, async () => {}, new AbortController().signal);
  assert.equal(calls.filter(c => c.endpoint === 'avatars').length, 1, 'Reuse a Photo Avatar across batches with the same image');
  assert.equal(firstPhoto.heygen.avatarId, secondPhoto.heygen.avatarId);
  assert.ok(calls.filter(c => c.endpoint === 'videos').some(c => c.body.avatar_id === 'saved-avatar' && c.body.engine.type === 'avatar_iii'));
  console.log('PASS: audio sample cuts, estimates, engine settings, auto/manual ratios, 3-row durable batch, safe network/download retries, failed-operation retry, expired-idempotency protection. No paid requests.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  process.chdir(root);
  if (path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('heygen-check-')) fs.rmSync(scratch, { recursive: true, force: true });
});
