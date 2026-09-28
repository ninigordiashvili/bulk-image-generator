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
const { FFMPEG, run } = require('../src/server/editor/ffmpeg.ts');


const { momentChain, fontFileFor } = require('../src/server/editor/textOverlay.ts');
const { STYLE_ORDER, TEXT_STYLES } = require('../src/lib/editor/textStyles.ts');
const { narrationDip } = require('../src/lib/editor/transitions.ts');
async function main() {
 const clips = [{label:'Narration 1.mp4',kind:'avatar',start:0,end:1},{label:'shot.png',kind:'still',start:1,end:2},{label:'shot2.png',kind:'still',start:2,end:3}];
 assert.equal(narrationDip(clips,0).fadeOut,0.12);
 assert.equal(narrationDip(clips,1).fadeIn,0.12);
 assert.equal(narrationDip(clips,1).fadeOut,0);
 assert.equal(narrationDip(clips,2).fadeIn,0);
 assert.equal(narrationDip([{...clips[0],kind:'still'},clips[1]],0).fadeOut,0);
 const hashes = new Set();
 for (const style of STYLE_ORDER) {
  const font=fontFileFor(TEXT_STYLES[style].files); assert.ok(font);
  const { GET } = require('../src/app/api/editor/fonts/route.ts');
  const response = await GET(new Request('http://localhost/api/editor/fonts?style='+style));
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(font));
  const chain=momentChain({text:'1969',style,animation:'gentle',start:0,duration:1,size:0.2,darken:0,fadeIn:0.1,fadeOut:0.1},0,180).join(',');
  const result=await run(FFMPEG,['-hide_banner','-loglevel','debug','-f','lavfi','-i','color=c=gray:s=320x180:r=30:d=1','-vf',chain+',fade=t=out:st=0.88:d=0.12','-frames:v','30','-threads','1','-f','hash','-hash','sha256','-']);
  assert.ok(!/Using .*font file/.test(result.stderr), 'Unexpected fontconfig fallback: '+style);
  hashes.add(result.stdout);
  console.log('PASS font '+style+': '+font);
 }
 assert.equal(hashes.size,STYLE_ORDER.length);
 console.log('PASS: real FFmpeg renders for all fonts, gentle year animation and dip filter; narration boundaries');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
