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

const { segmentArgs, planSegments } = require('../src/server/editor/render.ts');
const { FFMPEG, FFPROBE, run } = require('../src/server/editor/ffmpeg.ts');
const { DEFAULT_SETTINGS } = require('../src/types/editor.ts');
const { parseEffectTime, formatEffectTime, rangeError, motionPose, filmAt, validateEffectSettings, FILM_LABELS } = require('../src/lib/editor/timedEffects.ts');
async function main() {
  // Long effects should still be gently entering/exiting after 0.6 seconds,
  // with no jump at either boundary, including when ordinary zoom is active.
  for (const effect of ['pan', 'panZoom', 'drift']) {
    for (const base of [1, 1.04]) {
      const range = { effect, direction: 'left', amount: 0.08 };
      const start = 20, end = 30;
      for (const time of [start, end]) {
        const pose = motionPose(range, start, end, time, base);
        assert.equal(pose.scale, base);
        assert.equal(Math.abs(pose.x), 0);
        assert.equal(Math.abs(pose.y), 0);
      }
      for (const time of [start + 0.6, end - 0.6]) {
        const pose = motionPose(range, start, end, time, base);
        assert.ok(Math.abs(pose.scale - base) < 0.007, effect + ' gradual boundary zoom');
        assert.ok(Math.abs(pose.x) < 0.002, effect + ' gradual boundary pan');
      }
      const middle = motionPose(range, start, end, 25, base);
      assert.ok(middle.scale > 1.07, effect + ' retains motion strength');
    }
  }
  assert.equal(parseEffectTime('5:08:434'),308.434);
  assert.equal(parseEffectTime('5:08.434'),308.434);
  assert.equal(parseEffectTime('308.434'),308.434);
  assert.equal(parseEffectTime('65:08:434'),3908.434);
  for(const invalid of ['5:60:434','5:08:4345','5:08:43','-1','abc']) assert.equal(parseEffectTime(invalid),null);
  assert.equal(formatEffectTime(308.434),'5:08:434');
  assert.equal(rangeError([{start:0,end:5},{start:5,end:10}]),null);
  assert.ok(rangeError([{start:0,end:5},{start:4.9,end:10}]));
  assert.ok(validateEffectSettings({motionRanges:[{start:0,end:5,effect:'constructor',direction:'left',amount:0.08}]}));
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'timed-effects-check-'));
  console.log('Scratch:',scratch);
  fs.mkdirSync(path.join(scratch,'images'));
  const image=path.join(scratch,'images','still.png');
  await run(FFMPEG,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=320x180:r=30','-frames:v','1','-threads','1',image]);
  const clip={file:'still.png',kind:'still',start:308,end:311,zoom:'none',film:true};
  const segment=planSegments([clip],30,scratch)[0];
  const settings={...DEFAULT_SETTINGS,width:320,height:180,zoomAmount:0,film:'off',filmRangesEnabled:true};
  async function hashes(chosen) {
    const args=segmentArgs(segment,chosen,scratch);
    const target=path.join(scratch,'frames.md5');
    await run(FFMPEG,[...args.slice(0,args.indexOf('-frames:v')), '-frames:v','90','-an','-c:v','rawvideo','-threads','1','-f','framemd5',target]);
    return fs.readFileSync(target,'utf8').split('\n').filter(l=>l && !l.startsWith('#')).map(l=>l.split(',').pop().trim());
  }
  const baselineHashes=await hashes(settings);
  const timings={};
  for(const effect of ['baseline','pan','panZoom','drift']) {
    const range={id:'r',start:308.434,end:310.434,effect,direction:'left',amount:0.08};
    const chosen={...settings,motionRanges:effect==='baseline'?[]:[range]};
    const args=segmentArgs({...segment,file:effect+'.ts'},chosen,scratch);
    const before=Date.now(); await run(FFMPEG,args); timings[effect]=Date.now()-before;
    const {stdout}=await run(FFPROBE,['-v','error','-count_frames','-show_entries','stream=nb_read_frames','-of','json',path.join(scratch,effect+'.ts')]);
    assert.equal(Number(JSON.parse(stdout).streams[0].nb_read_frames),90);
    if(effect!=='baseline') {
      const frames=await hashes(chosen);
      assert.equal(frames.length,90);
      for (const i of [0,1,10,11,12,73,74,89]) assert.equal(frames[i],baselineHashes[i],effect+' outside range frame '+i);
      assert.notEqual(frames[35],baselineHashes[35],effect+' must move inside range');
      const entry=motionPose(range,308.434,310.434,308.434,1);
      const exit=motionPose(range,308.434,310.434,310.434,1);
      assert.equal(entry.scale,1);assert.equal(Math.abs(entry.x),0);assert.equal(Math.abs(entry.y),0);
      assert.equal(exit.scale,1);assert.equal(Math.abs(exit.x),0);
    }
  }
  const filmFrames=await hashes({...settings,filmRanges:[{id:'f',start:308.434,end:310.434,look:'monochrome'}]});
  for(const i of [0,12,73,89]) assert.equal(filmFrames[i],baselineHashes[i],'film outside range frame '+i);
  for(const i of [13,35,72]) assert.notEqual(filmFrames[i],baselineHashes[i],'film inside range frame '+i);
  for (const look of Object.keys(FILM_LABELS).filter(x=>x!=='off')) {
    const args=segmentArgs({...segment,file:look+'.ts'},{...settings,filmRanges:[{id:'f',start:308.434,end:310.434,look}]},scratch);
    await run(FFMPEG,args);
  }
  assert.equal(filmAt({...settings,filmRanges:[{start:308.434,end:310.434,look:'sepia'}]},308.433),'off');
  assert.equal(filmAt({...settings,filmRanges:[{start:308.434,end:310.434,look:'sepia'}]},308.434),'sepia');
  assert.equal(filmAt({...settings,filmRanges:[{start:308.434,end:310.434,look:'sepia'}]},310.434),'off');
  const protectedArgs=segmentArgs({...segment,kind:'avatar',film:true},{...settings,filmRanges:[{id:'f',start:308,end:311,look:'sepia'}],motionRanges:[{id:'m',start:308,end:311,effect:'pan',direction:'left',amount:0.08}]},scratch).join(' ');
  assert.ok(!protectedArgs.includes('perspective=')); assert.ok(!protectedArgs.includes('colorchannelmixer'));
  // Forty changes within one clip must survive Windows' command length limit.
  const dense={...settings,motionRanges:Array.from({length:40},(_,i)=>({id:String(i),start:308+i*0.075,end:308+(i+1)*0.075,effect:'panZoom',direction:'down',amount:0.08}))};
  const denseArgs=segmentArgs({...segment,file:'dense.ts'},dense,scratch);
  assert.ok(denseArgs.join(' ').length>32767);
  await run(FFMPEG,denseArgs);
  console.log('PASS: timestamp parsing, range validation, all three motion exports, all eight film looks, 90-frame duration and avatar protection.');
  console.log('320x180 cold encode times (ms):',JSON.stringify(timings));
  if(process.argv.includes('--benchmark')) {
    const hdImage=path.join(scratch,'images','hd.png');
    await run(FFMPEG,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=1920x1080:r=30','-frames:v','1','-threads','1',hdImage]);
    const hdSegment=planSegments([{...clip,file:'hd.png',start:0,end:3}],30,scratch)[0];
    const results={};
    for(const effect of ['still','existingZoom','pan','panZoom','drift','panZoomFilm']) {
      const chosen={...DEFAULT_SETTINGS,width:1920,height:1080,film:effect==='panZoomFilm'?'subtle':'off',motionRanges:['still','existingZoom'].includes(effect)?[]:[{id:'b',start:0,end:3,effect:effect==='panZoomFilm'?'panZoom':effect,direction:'left',amount:0.08}]};
      const args=segmentArgs({...hdSegment,zoom:effect==='existingZoom'?'in':'none',file:'hd-'+effect+'.ts'},chosen,scratch);
      const t=Date.now();await run(FFMPEG,args);results[effect]=((Date.now()-t)/1000).toFixed(2);
      console.log('1080p / 3 seconds / '+effect+': '+results[effect]+'s');
    }
    console.log('1080p cold benchmark:',JSON.stringify(results));
  }
}
main().catch(e=>{console.error(e.stderr||e);process.exitCode=1;});
