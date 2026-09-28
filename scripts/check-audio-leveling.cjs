/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const assert=require('node:assert/strict'),ts=require('typescript'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(name,...rest){return resolve.call(this,name.startsWith('@/')?path.join(root,'src',name.slice(2)):name,...rest);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);
const {VOLUME_LEVELING_FILTER,joinVoiceovers}=require('../src/server/editor/voiceover.ts');
const {FFMPEG,run}=require('../src/server/editor/ffmpeg.ts');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'bulk-level-check-'));
function pcm(file,filter){const result=spawnSync(FFMPEG,['-v','error','-i',file,...(filter?['-af',filter]:[]),'-f','f32le','-acodec','pcm_f32le','-'],{maxBuffer:20*1024*1024,windowsHide:true});assert.equal(result.status,0,result.stderr.toString());const b=result.stdout;return Array.from({length:b.length/4},(_,i)=>b.readFloatLE(i*4));}
function rms(samples,start,end){const part=samples.slice(start*44100,end*44100);return Math.sqrt(part.reduce((n,v)=>n+v*v,0)/part.length);}
async function main(){try{
const input=path.join(scratch,'voice.wav');
await run(FFMPEG,['-v','error','-f','lavfi','-i',"aevalsrc='if(lt(t,6),0.04,0.4)*sin(2*PI*440*t)':s=44100:d=12",'-c:a','pcm_s16le',input]);
const before=pcm(input),after=pcm(input,VOLUME_LEVELING_FILTER);
assert.equal(after.length,before.length,'leveling must preserve every sample position');
const oldDifference=20*Math.log10(rms(before,8,10)/rms(before,2,4));
const newDifference=20*Math.log10(rms(after,8,10)/rms(after,2,4));
assert.ok(Math.abs(newDifference)<Math.abs(oldDifference)-6,`${oldDifference} -> ${newDifference}`);
assert.ok(after.every(Number.isFinite));assert.ok(after.every(v=>Math.abs(v)<0.9));
// Sign/zero-crossing preservation checks pitch and absence of inserted gaps, including endpoints.
for(let i=0;i<before.length;i++){if(Math.abs(before[i])>0.0001)assert.equal(Math.sign(after[i]),Math.sign(before[i]));}
console.log(`PASS: level gap ${oldDifference.toFixed(1)} -> ${newDifference.toFixed(1)} dB; identical sample count, waveform sign, endpoints and bounded peaks`);
const options={maxGap:0.7,keepGap:0.3,leadIn:0.15,thresholdDb:null};
const job={dir:scratch};
const off=await joinVoiceovers(job,['voice.wav'],options);
const on=await joinVoiceovers(job,['voice.wav'],{...options,evenVolume:true});
assert.equal(on.tightened,off.tightened);assert.equal(on.removed,off.removed);assert.equal(on.duration,off.duration);
const full=await joinVoiceovers(job,['voice.wav'],{...options,evenVolume:true,shortenPauses:false});
assert.equal(full.tightened,0);assert.equal(full.removed,0);assert.ok(Math.abs(full.duration-12)<0.025,'volume-only mode must preserve the entire recording, including quiet passages');
for(const file of ['voice-bed.m4a','voice-bed.mp3'])assert.ok(pcm(path.join(scratch,file)).length>0);
await run(FFMPEG,['-v','error','-f','lavfi','-i','anullsrc=r=44100:cl=mono','-t','1','-c:a','pcm_s16le',path.join(scratch,'silent.wav')]);
const silent=pcm(path.join(scratch,'silent.wav'),VOLUME_LEVELING_FILTER);
assert.equal(silent.length,44100);assert.ok(silent.every(v=>v===0));
console.log('PASS: real M4A/MP3 joins, unchanged cut decisions and duration, volume-only mode preserves full recording, silence preserved');
}finally{assert.equal(path.dirname(scratch),os.tmpdir());assert.ok(path.basename(scratch).startsWith('bulk-level-check-'));fs.rmSync(scratch,{recursive:true,force:true});}}
main().catch(error=>{console.error(error);process.exitCode=1;});
