/* eslint-disable @typescript-eslint/no-require-imports -- This standalone CommonJS check installs an in-memory TypeScript loader. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
// Compile project TypeScript in memory; no build server or generated JS needed.
const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...rest) {
  return originalResolve.call(this, name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name, ...rest);
};
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  module._compile(output.outputText, filename);
};
const { acquireRender } = require('../src/server/editor/renderQueue.ts');
const { renderJob, codecArgs, segmentArgs, planSegments } = require('../src/server/editor/render.ts');
const { SegmentCache } = require('../src/server/editor/segmentCache.ts');
const { FFMPEG, FFPROBE, run } = require('../src/server/editor/ffmpeg.ts');
const { DEFAULT_SETTINGS } = require('../src/types/editor.ts');

async function main() {
  for (const bitrate of [0, 6000, 8000, 10000]) {
    const args = codecArgs({ ...DEFAULT_SETTINGS, videoBitrateKbps: bitrate });
    assert.equal(args.includes('-crf'), bitrate === 0);
    if (bitrate) assert.equal(args[args.indexOf('-b:v') + 1], bitrate + 'k');
    const hardware = codecArgs({ ...DEFAULT_SETTINGS, encoder: 'h264_videotoolbox', videoBitrateKbps: bitrate });
    if (bitrate) assert.equal(hardware[hardware.indexOf('-b:v') + 1], bitrate + 'k');
  }
  console.log('PASS: automatic quality and all three bitrate choices for both encoders');
  const first = await acquireRender(new AbortController().signal);
  let entered = false;
  const queued = new AbortController();
  const cancelled = assert.rejects(acquireRender(queued.signal), /Cancelled/);
  const next = acquireRender(new AbortController().signal).then(release => { entered = true; return release; });
  await Promise.resolve();
  assert.equal(entered, false, 'second render must wait');
  queued.abort();
  await cancelled;
  first();
  const release = await next;
  first(); // Releasing twice must not unlock the next owner.
  let thirdEntered = false;
  const third = acquireRender(new AbortController().signal).then(unlock => { thirdEntered = true; return unlock; });
  await Promise.resolve();
  assert.equal(thirdEntered, false);
  release();
  (await third)();
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  await assert.rejects(acquireRender(alreadyCancelled.signal), /Cancelled/);
  console.log('PASS: export queue ordering, cancellation and double-release protection');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-render-check-'));
  const previousCache = process.env.EDITOR_CACHE_DIR;
  process.env.EDITOR_CACHE_DIR = path.join(scratch, 'cache');
  try {
    function job(id) {
      const dir = path.join(scratch, id);
      fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
      return { id, dir, createdAt: Date.now(), startedAt: 0, controller: null,
        cancelRequested: false, nextImage: 0, nextVoice: 0,
        status: { id, phase: 'new', done: 0, total: 0, message: '', error: null, outputBytes: 0, elapsedMs: 0 } };
    }
    const a = job('a'), b = job('b'), c = job('cancelled');
    for (const item of [a, b]) {
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'testsrc2=s=320x180:r=30', '-frames:v', '1', '-threads', '1', path.join(item.dir, 'images', 'still.png')]);
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'sine=frequency=440:duration=1.2', path.join(item.dir, 'audio.wav')]);
    }
    const request = {
      clips: [0, 0.4, 0.8].map(start => ({ file: 'still.png', kind: 'still', start, end: start + 0.4, zoom: 'in', film: true })),
      audio: 'audio.wav', total: 1.2,
      settings: { ...DEFAULT_SETTINGS, width: 320, height: 180, film: 'subtle', audioFadeOut: 0.1 },
      moments: [], shapes: [{ id: 'plate', image: 'still.png', kind: 'rect', start: 0, duration: 1.2,
        opacity: 0.2, fadeIn: 0.1, fadeOut: 0.1 }],
    };
    const running = renderJob(a, request);
    const waiting = renderJob(b, { ...request, settings: { ...request.settings, videoBitrateKbps: 8000 } });
    const abandoned = renderJob(c, request);
    await assert.rejects(renderJob(a, request), /already rendering/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(b.status.phase, 'preparing');
    assert.match(b.status.message, /Waiting/);
    c.cancelRequested = true;
    c.controller.abort();
    await abandoned;
    assert.equal(c.status.phase, 'cancelled');
    await Promise.all([running, waiting]);
    for (const item of [a, b]) {
      assert.equal(item.status.phase, 'done', item.status.error || 'render must finish');
      const result = await run(FFPROBE, ['-v', 'error', '-count_frames', '-show_entries',
        'stream=codec_type,nb_read_frames:format=duration', '-of', 'json', path.join(item.dir, 'output.mp4')]);
      const info = JSON.parse(result.stdout);
      assert.equal(Number(info.streams.find(stream => stream.codec_type === 'video').nb_read_frames), 36);
      assert.ok(info.streams.some(stream => stream.codec_type === 'audio'));
      assert.ok(Math.abs(Number(info.format.duration) - 1.2) < 0.1);
    }
    for (const videoBitrateKbps of [6000, 10000]) {
      await renderJob(b, { ...request, settings: { ...request.settings, videoBitrateKbps } });
      assert.equal(b.status.phase, 'done', b.status.error);
    }
    console.log('PASS: actual FFmpeg exports at 6,000, 8,000 and 10,000 kbps targets');
    console.log('PASS: two queued FFmpeg exports, zoom, grain, overlay, audio, frame count and timing');
    console.log('PASS: duplicate-job rejection and cancellation of a waiting export');

    const cacheFiles = () => fs.readdirSync(process.env.EDITOR_CACHE_DIR).filter(name => name.endsWith('.ts')).sort();
    const before = cacheFiles();
    const warm = job('warm');
    fs.copyFileSync(path.join(a.dir, 'images', 'still.png'), path.join(warm.dir, 'images', 'renamed.png'));
    fs.copyFileSync(path.join(a.dir, 'audio.wav'), path.join(warm.dir, 'audio.wav'));
    const warmRequest = { ...request,
      clips: request.clips.map(clip => ({ ...clip, file: 'renamed.png' })),
      shapes: request.shapes.map(shape => ({ ...shape, image: 'renamed.png' })),
    };
    await renderJob(warm, warmRequest);
    assert.equal(warm.status.phase, 'done', warm.status.error);
    assert.deepEqual(cacheFiles(), before, 'new session and renamed identical files must reuse the cache');
    const decodedHash = async item => (await run(FFMPEG, ['-v', 'error', '-i', path.join(item.dir, 'output.mp4'),
      '-map', '0:v', '-f', 'hash', '-hash', 'sha256', '-'])).stdout;
    assert.equal(await decodedHash(a), await decodedHash(warm), 'cached pixels must be identical, including grain and zoom');
    const caption = { id: 'caption', text: 'Changed', start: 0, duration: 0.3,
      animation: 'fade', darken: 0.2, size: 0.12, fadeIn: 0.05, fadeOut: 0.05 };
    await renderJob(warm, { ...warmRequest, moments: [caption] });
    assert.equal(warm.status.phase, 'done', warm.status.error);
    assert.equal(cacheFiles().length, before.length + 1, 'caption edit must reencode only its segment');
    const afterCaption = cacheFiles();
    await renderJob(warm, { ...warmRequest, moments: [caption], settings: { ...request.settings, audioFadeOut: 0.2 } });
    assert.equal(warm.status.phase, 'done', warm.status.error);
    assert.deepEqual(cacheFiles(), afterCaption, 'audio-only changes must reuse all video');

    const segment = planSegments(request.clips, 30, a.dir)[0];
    const args = segmentArgs(segment, request.settings, a.dir);
    const key = await new SegmentCache().key(args);
    for (const settings of [ { film: 'heavy' }, { zoomAmount: 0.15 }, { fps: 24 }, { width: 640 }, { videoBitrateKbps: 6000 } ]) {
      assert.notEqual(await new SegmentCache().key(segmentArgs(segment, { ...request.settings, ...settings }, a.dir)), key);
    }
    assert.notEqual(await new SegmentCache().key(segmentArgs({ ...segment, frames: 18 }, request.settings, a.dir)), key);
    const gap = { ...segment, source: null };
    assert.equal(await new SegmentCache().key(segmentArgs(gap, request.settings, a.dir)),
      await new SegmentCache().key(segmentArgs(gap, request.settings, warm.dir)), 'generated black gaps are cacheable');
    fs.appendFileSync(path.join(a.dir, 'images', 'still.png'), Buffer.from('changed source'));
    assert.notEqual(await new SegmentCache().key(args), key, 'source replacement must invalidate even with same name');
    const failed = new SegmentCache();
    await assert.rejects(failed.materialize(args, async encodeArgs => {
      fs.writeFileSync(encodeArgs.at(-1), 'partial encode');
      throw new Error('Cancelled.');
    }), /Cancelled/);
    assert.ok(fs.readdirSync(failed.dir).every(name => !name.endsWith('.tmp')));
    assert.deepEqual(cacheFiles(), afterCaption, 'failed encodes must never enter cache');
    const stale = path.join(failed.dir, '0'.repeat(64) + '.ts');
    fs.writeFileSync(stale, 'expired');
    fs.utimesSync(stale, new Date(0), new Date(0));
    const active = path.join(failed.dir, '1'.repeat(64) + '-123.tmp');
    fs.writeFileSync(active, 'active encode');
    await failed.prune();
    assert.equal(fs.existsSync(stale), true, 'legacy cache is retained without a recorded export download');
    assert.equal(fs.existsSync(active), true, 'pruning must leave recent in-progress encodes alone');
    fs.rmSync(active);
    console.log('PASS: cache across sessions, identical decoded pixels, selective caption invalidation, audio reuse, source/settings invalidation and failed-encode cleanup');

    if (process.env.CHECK_RENDER_BENCHMARK === '1') {
      const bench = job('benchmark');
      await run(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30',
        '-t', '0.5', '-c:v', 'libx264', '-preset', 'veryfast', path.join(bench.dir, 'images', 'motion.mp4')]);
      const benchRequest = { total: 4, audio: null, moments: [], shapes: [],
        settings: { ...DEFAULT_SETTINGS, film: 'subtle' },
        clips: Array.from({ length: 4 }, (_, i) => ({ file: 'motion.mp4', kind: 'motion',
          start: i, end: i + 1, sourceSeconds: 0.5, zoom: i % 2 ? 'out' : 'in', film: true })),
      };
      const previousWorkers = process.env.EDITOR_RENDER_WORKERS;
      // Distinct overlays prevent identical clips sharing an encode inside the benchmark.
      benchRequest.moments = benchRequest.clips.map((clip, i) => ({ ...caption, text: String(i), start: clip.start, duration: 1 }));
      for (const workers of [2, 4]) {
        process.env.EDITOR_RENDER_WORKERS = String(workers);
        process.env.EDITOR_CACHE_DIR = path.join(scratch, `benchmark-cache-${workers}`);
        const start = performance.now();
        await renderJob(bench, benchRequest);
        assert.equal(bench.status.phase, 'done', bench.status.error);
        console.log(`BENCHMARK: ${workers} workers, cold 1080p slow motion + zoom + film + captions: ${((performance.now() - start) / 1000).toFixed(2)}s`);
        const warmStart = performance.now();
        await renderJob(bench, benchRequest);
        assert.equal(bench.status.phase, 'done', bench.status.error);
        console.log(`BENCHMARK: ${workers} workers, cached export: ${((performance.now() - warmStart) / 1000).toFixed(2)}s`);
      }
      if (previousWorkers === undefined) delete process.env.EDITOR_RENDER_WORKERS;
      else process.env.EDITOR_RENDER_WORKERS = previousWorkers;
    }
  } finally {
    if (previousCache === undefined) delete process.env.EDITOR_CACHE_DIR;
    else process.env.EDITOR_CACHE_DIR = previousCache;
    // Only this test's own mkdtemp directory is removed.
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(scratch).startsWith('bulk-render-check-'));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
