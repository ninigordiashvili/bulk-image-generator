/* eslint-disable @typescript-eslint/no-require-imports -- Standalone mock-provider checks. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const os = require('node:os');
const workScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-generation-check-'));
process.env.WORK_ROOT = workScratch;
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(name,...rest) {
  return resolve.call(this,name.startsWith('@/') ? path.join(root,'src',name.slice(2)) : name,...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {
  compilerOptions: { module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true },
}).outputText, filename);
// No credentials, network calls or billed generations are used by these tests.
process.env.VERTEX_QPM = '60000';
delete process.env.GOOGLE_CLOUD_PROJECT;
delete process.env.VERTEX_PROJECT_ID;
const timers = global.setTimeout;
global.setTimeout = (fn,ms,...args) => timers(fn,Math.min(ms,5),...args);
let content = async () => ({ candidates:[{content:{parts:[{inlineData:{data:'aW1hZ2U=',mimeType:'image/png'}}]}}] });
let video = async () => ({ done:true,response:{generatedVideos:[{video:{videoBytes:'dmlkZW8=',mimeType:'video/mp4'}}]} });
let poll = async () => video();
const calls=[];
const clients=[];
class FakeGenAI {
  constructor(options) {
    clients.push(options);
    this.models={
      generateContent: async request => {calls.push({kind:'image',options,request});return content(options,request);},
      generateVideos: async request => {calls.push({kind:'video',options,request});return video(options,request);},
    };
    this.operations={getVideosOperation: request=>poll(options,request)};
  }
}
const account = (id) => ({id,label:id,projectId:'project-'+id,location:'global',credentials:'test-'+id,
  imageConcurrency:1,videoConcurrency:1,imageRequestsPerMinute:60000,videoRequestsPerMinute:60000});
let kieRecord = { state: 'fail', failCode: '500', failMsg: 'render failed' };
class FakeKieError extends Error {}
const originalLoad=Module._load;
Module._load=function(name,...rest) {
  if(name==='./workProvider')return {performWork:async(kind,input,id,checkpoint,save,signal)=>{
    if(kind==='image')return api.generateImage(input.request,{signal});
    if(!checkpoint.taskId){const started=await api.startVideo(input.request,{signal});if(!started.ok)return started;checkpoint.taskId=started.taskId;await save();}
    const settled=await api.pollVideo(input.request.accountId,checkpoint.taskId,input.request.model,signal);
    if(!settled.ok){if(settled.taskFailed){checkpoint.taskId=undefined;await save();}return settled;}
    if(settled.state!=='done')throw Error('Mock task should be settled');
    return {ok:true,video:true,bytes:Buffer.from('video'),mimeType:'video/mp4',taskId:checkpoint.taskId,sourceUrl:settled.videoUrl,credits:settled.credits};
  }};
  if(name==='@/server/accounts')return { findAccount: async id=>({id,apiKey:'fake'}), AccountConfigError:class extends Error{} };
  if(name==='@/server/kie')return { KieError:FakeKieError, getTask:async()=>kieRecord, resultUrls:()=>['https://example.invalid/video.mp4'] };
  if(name==='@google/genai')return {GoogleGenAI:FakeGenAI};
  if(name==='@/server/vertexAccounts')return {findVertexAccount:async id=>account(id),VertexAccountError:class extends Error{}};
  return originalLoad.call(this,name,...rest);
};
const {GenerationQueue}=require('../src/services/GenerationQueue.ts');
const {generateImages,generateVideo}=require('../src/server/vertex.ts');
const {findModel,referenceLimit}=require('../src/lib/kieModels.ts');
const api=require('../src/services/kieApi.ts');
const {POST}=require('../src/app/api/vertex/generate/route.ts');
const imageModel='gemini-3.1-flash-lite-image';
const videoModel='veo-3.1-lite-generate-001';
async function until(test){for(let n=0;n<10000;n++){if(test())return;await new Promise(r=>timers(r,1));}throw Error('Timed out');}
const job=id=>({id,promptId:id,prompt:id,promptIndex:0,copyIndex:0,tag:null,referencedCharacterIds:[],status:'queued',attempts:0});
async function main(){
  for (const model of ['vertex:'+videoModel, videoModel]) {
    const response = await POST(new Request('http://test/api/vertex/generate', {method:'POST',
      body:JSON.stringify({kind:'video',accountId:'nitchiani-mapping-check',model,prompt:'animate',
        durationSeconds:4,resolution:'720p',aspectRatio:'16:9',image:{base64:'aW1hZ2U=',mimeType:'image/png'}})}));
    assert.equal(response.status,200);
    assert.equal((await response.json()).ok,true);
    const sent=calls.at(-1);
    assert.equal(sent.request.model,videoModel);
    assert.equal(sent.options.project,'project-nitchiani-mapping-check');
    assert.equal(sent.request.image.imageBytes,'aW1hZ2U=');
    assert.equal(sent.request.config.durationSeconds,4);
  }
  calls.length=0;
  console.log('PASS: Vertex video UI and provider IDs reach SDK with correct model, account, still and duration');
  const counts={};
  const queue=new GenerationQueue({concurrency:2,retries:5,runJob:async j=>{
    counts[j.id]=(counts[j.id]||0)+1;
    if(j.id==='throws')throw Error('network');
    return j.id==='good'?{ok:true}:{ok:false,error:'rejected',retryable:false};
  }});
  queue.start(['bad','good','throws'].map(job));
  await until(()=>queue.getState()==='done');
  assert.deepEqual(counts,{bad:2,good:1,throws:2});
  assert.equal(queue.getJobs().find(j=>j.id==='bad').status,'error');
  queue.retryJob('bad');queue.retryJob('bad');
  await until(()=>queue.getState()==='done');
  assert.deepEqual(counts,{bad:4,good:1,throws:2});
  console.log('PASS: exactly one retry for returned/thrown failures; manual retry is per prompt and deduplicated');
  let unblock;
  const q1=new GenerationQueue({concurrency:1,retries:1,runJob:()=>new Promise(r=>{unblock=r;})});
  const q2=new GenerationQueue({concurrency:1,retries:1,runJob:async()=>({ok:true})});
  q1.start([job('same')]);q2.start([job('same')]);
  await until(()=>q2.getState()==='done');q1.cancel();unblock({ok:true});
  await until(()=>q1.getState()==='done');
  assert.equal(q2.getJobs()[0].status,'success');assert.equal(q1.getJobs()[0].status,'cancelled');
  console.log('PASS: independent browser queues with matching prompt IDs and independent cancellation');

  assert.equal(referenceLimit(findModel(imageModel)),14);
  const reference={label:'portrait',base64:'aW1hZ2U=',mimeType:'image/png'};
  global.fetch=async(url,options)=> {
    const body=JSON.parse(options.body);assert.deepEqual(body.referenceImages,[reference]);
    return POST(new Request('http://test/api/vertex/generate',{method:'POST',body:options.body}));
  };
  const result=await api.generateImage({provider:'vertex',accountId:'refs',model:imageModel,prompt:'Use this portrait',referenceImages:[reference],input:{aspect_ratio:'16:9'}});
  assert.equal(result.ok,true,result.error);
  const sent=calls.at(-1).request.contents[0].parts;
  assert.deepEqual(sent[1].inlineData,{data:reference.base64,mimeType:reference.mimeType});
  assert.equal(sent.at(-1).text,'Use this portrait');
  assert.equal(clients[0].httpOptions.retryOptions.attempts,1);
  await assert.rejects(generateImages({account:account('refs'),model:imageModel,prompt:'x',referenceImages:Array(15).fill(reference)}),/Too many/);
  console.log('PASS: reference travels through client, HTTP route and SDK; no global project is required');

  const normalContent=content;
  let freeA;
  content=async(options,request)=>request.contents[0].parts.at(-1).text==='hold' ? new Promise(r=>{freeA=()=>r(normalContent());}) : normalContent();
  const a=generateImages({account:account('A'),model:imageModel,prompt:'hold'});
  await until(()=>Boolean(freeA));
  const cancelled=new AbortController();
  const waiting=assert.rejects(generateImages({account:account('A'),model:imageModel,prompt:'must not start',signal:cancelled.signal}),/Cancelled/);
  const b=generateImages({account:account('B'),model:imageModel,prompt:'independent'});
  const v=generateVideo({account:account('A'),model:videoModel,prompt:'video independent',durationSeconds:4});
  await Promise.all([b,v]);
  assert.ok(!calls.some(c=>c.kind==='image'&&c.request.contents[0].parts.at(-1).text==='must not start'));
  cancelled.abort();await waiting;freeA();await a;
  assert.ok(calls.some(c=>c.options.project==='project-B'));
  console.log('PASS: account B and video lane proceed while account A image lane is occupied; waiter cancels promptly');
  content=async()=>{throw Object.assign(Error('provider down'),{status:500});};
  const before=calls.length;
  await assert.rejects(generateImages({account:account('failure'),model:imageModel,prompt:'fail'}));
  assert.equal(calls.length-before,1);
  content=normalContent;
  console.log('PASS: no nested provider retries');

  let starts=0, polls=0;
  const completed={done:true,response:{generatedVideos:[{video:{videoBytes:'dmlkZW8=',mimeType:'video/mp4'}}]}};
  video=async()=>{starts++;return {name:'operations/test',done:false};};
  poll=async()=>{polls++;if(polls===1)throw Error('connection lost');return completed;};
  const request={account:account('resume'),model:videoModel,prompt:'test',durationSeconds:4,requestId:'unique-shot'};
  await assert.rejects(generateVideo(request),/connection lost/);
  await generateVideo(request);await generateVideo(request);
  assert.equal(starts,1);assert.equal(polls,2);
  console.log('PASS: Vertex retry resumes accepted video after lost connection; completed response is reused');
  video=async()=>{starts++;return {done:true,error:{message:'render failed'}};};
  const failed={...request,requestId:'failed-shot'};
  await assert.rejects(generateVideo(failed),/render failed/);
  video=async()=>{starts++;return completed;};
  await generateVideo(failed);assert.equal(starts,3);
  console.log('PASS: a confirmed failed Vertex video starts a fresh render on retry');

  const {NextRequest}=require('next/server');
  const {GET}=require('../src/app/api/kie/video/status/route.ts');
  const {VIDEO_MODELS}=require('../src/lib/videoModels.ts');
  const kieModel=VIDEO_MODELS.find(m=>m.api==='jobs'&&m.input==='prompt');
  const failureResponse=await GET(new NextRequest('http://test/api/kie/video/status?accountId=A&taskId=one&model='+encodeURIComponent(kieModel.id)));
  assert.equal((await failureResponse.json()).taskFailed,true);
  const storage=new Map();
  global.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  const {useGenerationStore:images}=require('../src/store/generationStore.ts');
  const {useVideoStore:videos}=require('../src/store/videoStore.ts');
  images.setState({refreshCredits:async()=>{}});
  const sentAccounts=[];
  let imageRelease, imageRequests=0;
  let startsKie=0;
  global.fetch=async(url,options={})=>{
    if(url.startsWith('/api/work')){
      const request=new Request('http://test'+url,options);
      if(url==='/api/work')return require('../src/app/api/work/route.ts')[options.method||'GET'](request);
      const id=url.split('/')[3].split('?')[0];
      const route=url.includes('/file?')?'../src/app/api/work/[id]/file/route.ts':'../src/app/api/work/[id]/route.ts';
      return require(route)[options.method||'GET'](request,{params:Promise.resolve({id})});
    }
    if(url==='/api/vertex/generate'){
      const body=JSON.parse(options.body);
      sentAccounts.push(body.accountId);
      imageRequests++;
      if(imageRequests===1)await new Promise(r=>{imageRelease=r;});
      return Response.json({ok:true,images:[{base64:'aW1hZ2U=',mimeType:'image/png',width:1024,height:1024,sourceUrl:''}]});
    }
    if(url==='/api/kie/video/start'){
      const body=JSON.parse(options.body);assert.equal(body.accountId,'video-A');
      startsKie++;return Response.json({ok:true,taskId:'task-'+startsKie});
    }
    if(url.startsWith('/api/kie/video/status')){
      kieRecord=startsKie===1?{state:'fail',failCode:'500',failMsg:'render failed'}:{state:'success',creditsConsumed:1};
      return GET(new NextRequest('http://test'+url));
    }
    if(url.startsWith('/api/kie/video/file'))return new Response(new Blob(['video'],{type:'video/mp4'}));
    throw Error('Unexpected mock request '+url);
  };
  images.setState({settings:{...images.getState().settings,provider:'vertex',accountId:'image-A',model:imageModel,imagesPerPrompt:1},
    promptText:'First prompt\nSecond prompt',characters:[],queueConfig:{concurrency:1,retries:1}});
  images.getState().startGeneration();
  await until(()=>Boolean(imageRelease));
  images.setState({settings:{...images.getState().settings,accountId:'image-B'}});
  videos.setState({provider:'kie',accountId:'video-A',concurrency:1,shots:[{id:'shot',prompt:'animate',model:kieModel.id,
    image:{name:'test.png',base64:'aW1hZ2U=',mimeType:'image/png',width:1024,height:1024},
    duration:kieModel.defaultDuration,resolution:kieModel.defaultResolution,aspectRatio:kieModel.defaultAspectRatio}]});
  videos.getState().startGeneration();
  videos.setState({accountId:'video-B'});
  await until(()=>videos.getState().queueState==='done');
  assert.equal(startsKie,2);assert.equal(videos.getState().jobs[0].status,'success');
  imageRelease();await until(()=>images.getState().queueState==='done');
  assert.deepEqual(sentAccounts,['image-A','image-A']);
  console.log('PASS: real image/video stores run together, preserve their original billing account and retry a failed Kie task once');

  // Virtual time makes minute-long quota waits deterministic and free.
  global.setTimeout=timers;
  const {mock}=require('node:test');
  mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
  const advance=async ms=>{mock.timers.tick(ms);await flush();};
  try {
    let attempts=0; const starts=[];
    content=async()=>{
      starts.push(Date.now());
      if(++attempts<=3)throw Object.assign(new Error('quota exhausted'),{status:429});
      return normalContent();
    };
    const retry=generateImages({account:account('quota-repeat'),model:imageModel,prompt:'retry'});
    await flush();assert.equal(attempts,1);
    await advance(29999);assert.equal(attempts,1);
    await advance(3001);assert.equal(attempts,2);
    await advance(63000);assert.equal(attempts,3);
    await advance(123000);await retry;assert.equal(attempts,4);
    assert.ok(starts[1]-starts[0]>=30000);
    assert.ok(starts[2]-starts[1]>=60000);
    assert.ok(starts[3]-starts[2]>=120000);

    const shared={...account('shared'),imageConcurrency:2,imageRequestsPerMinute:2};
    const sent=[];let rejectFirst;
    content=async(options,request)=>{
      const prompt=request.contents[0].parts.at(-1).text;
      sent.push({prompt,time:Date.now()});
      if(prompt==='first'&&!rejectFirst)return new Promise((_,reject)=>{rejectFirst=reject;});
      return normalContent();
    };
    const control=new AbortController();
    const first=generateImages({account:shared,model:imageModel,prompt:'first',signal:control.signal});
    const firstRejected=assert.rejects(first,/Cancelled/);
    const second=generateImages({account:{...shared,id:'alias'},model:imageModel,prompt:'second'});
    await flush();assert.equal(sent.length,1);
    rejectFirst(Object.assign(new Error('429 quota'),{response:{headers:{'retry-after':'120'}}}));
    await flush();
    const independent=generateImages({account:account('independent-quota'),model:imageModel,prompt:'independent'});
    await flush();await independent;
    await advance(30000);assert.equal(sent.filter(x=>x.prompt==='second').length,0);
    control.abort();await flush();await firstRejected;
    await advance(90000);await second;
    assert.ok(sent.find(x=>x.prompt==='second').time-sent[0].time>=120000);

    content=normalContent;
    const paced={...account('paced'),imageConcurrency:4,imageRequestsPerMinute:2};
    const before=calls.length;
    const batch=Promise.all([1,2,3,4].map(n=>generateImages({account:paced,model:imageModel,prompt:String(n)})));
    await flush();assert.equal(calls.length-before,1);
    await advance(29999);assert.equal(calls.length-before,1);
    await advance(1);assert.equal(calls.length-before,2);
    await advance(30000);assert.equal(calls.length-before,3);
    await advance(30000);await batch;assert.equal(calls.length-before,4);

    let videoAttempts=0;
    video=async()=>{if(++videoAttempts<3)throw Object.assign(new Error('429 quota'),{status:429});return {done:true,response:{generatedVideos:[{video:{videoBytes:'dmlkZW8=',mimeType:'video/mp4'}}]}};};
    const v=generateVideo({account:account('video-quota'),model:videoModel,prompt:'quota',requestId:'quota-check'});
    await flush();await advance(33000);await advance(63000);await v;assert.equal(videoAttempts,3);
    let badCalls=0;
    content=async()=>{badCalls++;throw Object.assign(new Error('400 invalid quota setting'),{status:400});};
    await assert.rejects(generateImages({account:account('invalid'),model:imageModel,prompt:'bad'}),/400/);
    assert.equal(badCalls,1);
    console.log('PASS: repeated image/video quota retries, increasing delays, shared cooldown, independent projects, cancellation, minute pacing and non-quota errors');
  } finally {mock.timers.reset();}

}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  global.setTimeout=timers;
  assert.equal(path.dirname(workScratch),os.tmpdir());
  assert.ok(path.basename(workScratch).startsWith('bulk-generation-check-'));
  fs.rmSync(workScratch,{recursive:true,force:true});
});
