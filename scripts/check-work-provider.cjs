/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(name,...rest){return resolve.call(this,name.startsWith('@/')?path.join(root,'src',name.slice(2)):name,...rest);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);
class KieError extends Error { constructor(message,retryable=true){super(message);this.retryable=retryable;} }
let creates=0,reads=0,failed=false,videoCreates=0,videoDownloads=0;
const original=Module._load;
Module._load=function(name,...rest){
 if(name==='@/server/accounts')return {findAccount:async id=>({id,label:id,apiKey:'fake'}),AccountConfigError:class extends Error{}};
 if(name==='@/server/kie')return {KieError,createTask:async()=>{creates++;return 'task-'+creates;},awaitTask:async()=>{reads++;if(reads===1)throw new KieError('lost poll response');return {state:failed?'fail':'success',creditsConsumed:1};},resultUrls:()=>['https://example.invalid/image.png'],fetchImageBytes:async()=>({bytes:Buffer.from('image'),mimeType:'image/png'}),taskFailure:()=>new KieError('confirmed failure'),uploadReference:async()=>''};
 if(name==='@/app/api/vertex/generate/route')return {POST:async request=>{const body=await request.json();return Response.json(body.kind==='video'?{ok:true,videos:[{base64:Buffer.from('vertex-video').toString('base64'),mimeType:'video/mp4'}]}:{ok:true,images:[{base64:'aW1hZ2U=',mimeType:'image/png'}]});}};
 if(name==='@/app/api/kie/video/start/route')return {POST:async()=>{videoCreates++;return Response.json({ok:true,taskId:'video-task'});}};
 if(name==='@/app/api/kie/video/status/route')return {GET:async()=>Response.json({ok:true,state:'done',videoUrl:'https://example.invalid/video.mp4',credits:2})};
 if(name==='@/app/api/kie/video/file/route')return {GET:async()=>{videoDownloads++;return videoDownloads===1?new Response('temporary',{status:502}):new Response('video-bytes',{headers:{'content-type':'video/mp4'}});}};
 return original.call(this,name,...rest);
};
const {performWork}=require('../src/server/workProvider.ts');
const signal=new AbortController().signal,input={provider:'kie',job:{},request:{accountId:'A',model:'custom-test-model',prompt:'Test'}};
async function main(){
 const checkpoint={};let saves=0;const save=async()=>{saves++;};
 const first=await performWork('image',input,'request',checkpoint,save,signal);assert.equal(first.ok,false);assert.equal(checkpoint.taskId,'task-1');
 const second=await performWork('image',input,'request',checkpoint,save,signal);assert.equal(second.ok,true);assert.equal(creates,1);assert.equal(saves,1);
 failed=true;await performWork('image',input,'request',checkpoint,save,signal);assert.equal(checkpoint.taskId,undefined);failed=false;await performWork('image',input,'request',checkpoint,save,signal);assert.equal(creates,2);
 console.log('PASS: image polling failure reuses accepted task; only a confirmed failed task permits a fresh generation');
 const videoCheckpoint={};assert.equal((await performWork('video',input,'video',videoCheckpoint,save,signal)).ok,false);
 const video=await performWork('video',input,'video',videoCheckpoint,save,signal);assert.equal(video.ok,true);assert.equal(videoCreates,1);assert.equal(videoDownloads,2);assert.equal(Buffer.from(video.bytes).toString(),'video-bytes');
 const vertex=await performWork('video',{...input,provider:'vertex'},'vertex',{},save,signal);assert.equal(Buffer.from(vertex.bytes).toString(),'vertex-video');
 console.log('PASS: failed video download resumes existing video without recreating it; Vertex inline result is retained');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
