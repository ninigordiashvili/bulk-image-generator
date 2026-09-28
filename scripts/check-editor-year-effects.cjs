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
const { momentChain } = require('../src/server/editor/textOverlay.ts');
const { textPhases } = require('../src/lib/editor/textAnimation.ts');
const { drawMomentText } = require('../src/lib/editor/momentPreview.ts');
const { clipZoomSettings } = require('../src/lib/editor/clipEffects.ts');
const { planSegments, segmentArgs } = require('../src/server/editor/render.ts');
const { DEFAULT_SETTINGS } = require('../src/types/editor.ts');
const base={id:'year',text:'1969',style:'modern',start:0,duration:2,size:0.2,darken:0,fadeIn:0,fadeOut:0};
async function hashes(animation, start=0, frames=60) {
 const chain=momentChain({...base,animation},start,180).join(',');
 const result=await run(FFMPEG,['-v','error','-f','lavfi','-i','color=c=gray:s=320x180:r=30:d=2','-vf',chain,'-frames:v',String(frames),'-threads','1','-f','framemd5','-']);
 return result.stdout.split('\n').filter(line=>line && !line.startsWith('#')).map(line=>line.split(',').at(-1).trim());
}
async function main(){
 const count=textPhases({...base,animation:'count'});
 assert.equal(count[0].text,'1949'); assert.equal(count.at(-1).text,'1969'); assert.equal(count.at(-1).to,2);
 assert.equal(textPhases({...base,text:'hello',animation:'count'}).length,1);
 assert.equal(textPhases({...base,text:'0000',animation:'count'})[0].text,'0000');
 const stagger=textPhases({...base,animation:'stagger'});
 assert.deepEqual(stagger.map(p=>p.text),['1','9','6','9']);
 assert.equal(stagger[0].offset,-stagger.at(-1).offset);
 for(const animation of ['stagger','count']) {
  for(const elapsed of [0.1,0.2,0.5,1.0]) {
   const drawn=[];
   const context={save(){},restore(){},fillRect(){},measureText(){return {width:20}},strokeText(){},fillText(text,x){drawn.push({text,x})}};
   drawMomentText(context,[{...base,animation}],elapsed,320,180);
   const expected=textPhases({...base,animation}).filter(p=>elapsed>=p.from && elapsed<p.to);
   assert.deepEqual(drawn.map(d=>d.text),expected.map(p=>p.text));
   assert.deepEqual(drawn.map(d=>d.x),expected.map(p=>160+p.offset*36));
  }
  const full=await hashes(animation);
  assert.equal(full.length,60);
  assert.notEqual(full[3],full[30]);
  assert.equal(full[30],full[50]);
  const continuation=await hashes(animation,-0.4,30);
  assert.deepEqual(continuation,full.slice(12,42),'animation must continue across shot boundaries');
 }
 const counting=await hashes('count'); const plain=await hashes('fade');
 assert.equal(counting[30],plain[30],'count must finish on exact requested year');
 console.log('PASS: preview text, stagger positions, counting endpoint, actual FFmpeg frames and cross-shot continuity');
 const settings={...DEFAULT_SETTINGS,width:320,height:180,zoomAmount:0.18,zoomAmountMotion:0.15};
 for(const kind of ['avatar','motion']) {
  const clip={label:'NaRrAtIoN 0-00.mp4',kind};
  assert.deepEqual(clipZoomSettings(clip,'in',settings),{direction:'none',amount:0});
  assert.deepEqual(clipZoomSettings(clip,'out',{...settings,narrationZoomAmount:0.1}),{direction:'in',amount:0.1});
  assert.deepEqual(clipZoomSettings(clip,'none',{...settings,narrationZoomAmount:0.1,effectsOnMotion:false}),{direction:'in',amount:0.1});
  const segment=planSegments([{...clip,file:'source.mp4',start:0,end:2,sourceSeconds:2,zoom:'in',film:false}],30,'C:/test')[0];
  const off=segmentArgs(segment,settings,'C:/test');
  const on=segmentArgs(segment,{...settings,narrationZoomAmount:0.1},'C:/test');
  assert.ok(!off.join(' ').includes('perspective='));
  assert.ok(on.join(' ').includes('perspective='));
  // Exercise exactly the generated filters against a synthetic video input.
  const filter=on[on.indexOf('-vf')+1];
  await run(FFMPEG,['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=30:d=2','-vf',filter,'-frames:v','60','-threads','1','-f','null','-']);
  assert.equal(segment.frames,60); assert.equal(segment.stretch,1);
 }
 assert.equal(clipZoomSettings({label:'shot.mp4',kind:'motion'},'in',settings).amount,0.15);
 assert.equal(clipZoomSettings({label:'narration.png',kind:'still'},'in',settings).amount,0.18);
 assert.equal(clipZoomSettings({label:'talk.mp4',kind:'avatar'},'in',{...settings,narrationZoomAmount:0.1}).amount,0);
 console.log('PASS: narration auto-zoom exclusion, independent opt-in, normal clips, actual zoom filters and unchanged duration');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
