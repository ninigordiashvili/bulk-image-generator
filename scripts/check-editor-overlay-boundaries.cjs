/* eslint-disable @typescript-eslint/no-require-imports -- This standalone CommonJS check installs an in-memory TypeScript loader. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const { spawnSync } = require('node:child_process');
const { shapeGraph } = require('../src/server/editor/shapeOverlay.ts');
const { scrimGraph } = require('../src/server/editor/textOverlay.ts');
const ffmpeg = require('ffmpeg-static');
const bytesPerFrame = 64 * 36 * 3;
function render(graph, start, frames) {
  const item = { start: 0, duration: 4, fadeIn: 0.35, fadeOut: 0.45,
    image: 'plate', backdropImage: 'plate', opacity: 0.8, backdropOpacity: 0.8 };
  const filter = graph([item], start, start + frames / 30, '0:v', 'out', new Map([['plate', 1]]), 64, 36);
  const result = spawnSync(ffmpeg, ['-v','error','-f','lavfi','-i','color=black:s=64x36:r=30',
    '-f','lavfi','-i','color=white:s=64x36:r=30','-filter_complex',filter,
    '-map','[out]','-frames:v',String(frames),'-threads','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'], {maxBuffer: 8 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, frames * bytesPerFrame);
  return result.stdout;
}
for (const graph of [shapeGraph, scrimGraph]) {
  const full = render(graph, 0, 120);
  for (const frame of [6, 60, 112]) {
    const count = Math.min(8, 120 - frame);
    const segment = render(graph, frame / 30, count);
    const expected = full.subarray(frame * bytesPerFrame, (frame + count) * bytesPerFrame);
    let difference = 0;
    for (let i=0;i<segment.length;i++) difference = Math.max(difference, Math.abs(segment[i]-expected[i]));
    assert.ok(difference <= 2, `${graph.name} frame ${frame}: pixel difference ${difference}`);
  }
  console.log(`PASS ${graph.name}: fades across clip boundaries match continuous rendering`);
}
