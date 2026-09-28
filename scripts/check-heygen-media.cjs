/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(name, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name, ...rest); };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, file);
async function main() {
  const { FFMPEG, FFPROBE, run } = require('../src/server/editor/ffmpeg.ts');
  const { finishHeygenVideo } = require('../src/server/heygenMedia.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heygen-media-check-'));
  try {
    const video = path.join(dir, 'source.mp4'), audio = path.join(dir, 'voice.wav');
    await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=2', '-c:v', 'libx264', '-threads', '1', video]);
    for (const seconds of [1.23, 2, 2.71]) {
      await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds), '-c:a', 'pcm_s16le', '-threads', '1', audio]);
      const bytes = await finishHeygenVideo(fs.readFileSync(video), { base64: fs.readFileSync(audio).toString('base64'), seconds }, 'video/mp4', new AbortController().signal);
      const out = path.join(dir, 'out.mp4'); fs.writeFileSync(out, bytes);
      const data = JSON.parse((await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out])).stdout);
      assert.ok(Math.abs(Number(data.format.duration) - seconds) <= 0.04, 'Output should be within one frame of selected audio');
      const voice = data.streams.find(stream => stream.codec_type === 'audio');
      assert.ok(Math.abs(Number(voice.duration) - seconds) < 0.001, 'Entire selected recording preserved');
    }
    const transparent = path.join(dir, 'source.webm');
    await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=blue@0.25:s=160x90:r=25:d=2,format=rgba', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-threads', '1', transparent]);
    for (const seconds of [2, 2.71]) {
      await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds), '-c:a', 'pcm_s16le', '-threads', '1', audio]);
      const bytes = await finishHeygenVideo(fs.readFileSync(transparent), { base64: fs.readFileSync(audio).toString('base64'), seconds }, 'video/webm', new AbortController().signal);
      const out = path.join(dir, 'out.webm'), alpha = path.join(dir, 'alpha.bin'); fs.writeFileSync(out, bytes);
      const data = JSON.parse((await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out])).stdout);
      assert.ok(Math.abs(Number(data.format.duration) - seconds) <= 0.05);
      await run(FFMPEG, ['-y', '-c:v', 'libvpx-vp9', '-i', out, '-vf', 'alphaextract', '-frames:v', '1', '-f', 'rawvideo', '-threads', '1', alpha]);
      assert.ok(fs.readFileSync(alpha)[0] < 100, 'Preserve transparent WebM alpha through both copy and duration repair');
    }
    console.log('PASS: real FFmpeg duration repair for shorter, equal and longer audio; audio duration preserved and MP4 length within one video frame. Tiny synthetic clips, one CPU thread, no provider calls.');
  } finally {
    if (path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('heygen-media-check-')) fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
