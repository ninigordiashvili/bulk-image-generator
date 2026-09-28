/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),{randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(name,...rest){return resolve.call(this,name.startsWith('@/')?path.join(root,'src',name.slice(2)):name,...rest);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'bulk-background-check-'));process.env.WORK_ROOT=scratch;
const calls=[],attempts=new Map();let running=0,maxRunning=0;
const provider=async(kind,input,id,checkpoint,save,signal)=>{
 calls.push({id,account:input.request.accountId,kind});running++;maxRunning=Math.max(maxRunning,running);
 try {await new Promise((resolve,reject)=>{const done=()=>{signal.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,25);const abort=()=>{clearTimeout(timer);reject(new Error('Cancelled'));};signal.addEventListener('abort',abort,{once:true});});
 if(input.job.prompt==='retry'){const n=(attempts.get(id)||0)+1;attempts.set(id,n);if(n===1)return {ok:false,error:'temporary',retryable:true};}
 if(kind==='video')return {ok:true,video:true,bytes:Buffer.from('video-content'),mimeType:'video/mp4',taskId:id,sourceUrl:'',credits:1};
 return {ok:true,taskId:id,credits:1,images:[{base64:Buffer.from('image-content').toString('base64'),mimeType:'image/png',width:1,height:1,resolution:'1x1',sourceUrl:''}]};
 }finally{running--;}
};
const originalLoad=Module._load;Module._load=function(name,...rest){if(name==='./workProvider')return {performWork:provider};return originalLoad.call(this,name,...rest);};
const api=require('../src/app/api/work/[id]/route.ts');const files=require('../src/app/api/work/[id]/file/route.ts');let work=require('../src/server/work.ts');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test){for(let i=0;i<400;i++){if(await test())return;await pause(10);}throw Error('Timed out');}
async function make(account,kind='image',count=3,prompt='test'){
 const id=randomUUID();await work.createWork({id,kind,accountId:account,total:count,concurrency:2});
 for(let index=0;index<count;index++){
 const input={provider:'kie',request:{accountId:account,model:'test',prompt},job:{id:'job-'+index,promptId:'p'+index,prompt,promptIndex:index,copyIndex:0,tag:null,referencedCharacterIds:[],status:'queued',attempts:0}};
 const bytes=Buffer.from(JSON.stringify(input)),half=Math.floor(bytes.length/2);
 await work.uploadWork(id,index,0,bytes.length,bytes.subarray(0,half));
 assert.equal(await work.uploadWork(id,index,0,bytes.length,bytes.subarray(0,half)),half);
 await work.uploadWork(id,index,half,bytes.length,bytes.subarray(half));
 }
 return id;
}
async function main(){try{
 const draft=randomUUID();await work.createWork({id:draft,kind:'image',accountId:'A',total:1,concurrency:1});await assert.rejects(work.startWork(draft),/Finish uploading/);await work.cancelWork(draft);
 const a=await make('A'),b=await make('B','video');
 const connection=new AbortController();const context={params:Promise.resolve({id:a})};
 const start=new Request('http://local/api/work/'+a,{method:'POST',body:'{}',signal:connection.signal});
 await Promise.all([api.POST(start,context),work.startWork(a),work.startWork(b)]);connection.abort();
 delete require.cache[require.resolve('../src/server/work.ts')];work=require('../src/server/work.ts');
 await until(async()=> (await work.workStatus(a)).phase==='done'&&(await work.workStatus(b)).phase==='done');
 assert.equal(calls.filter(c=>c.account==='A').length,3);assert.equal(calls.filter(c=>c.account==='B').length,3);assert.ok(maxRunning>=3);
 assert.equal((await work.workStatus(a)).progress.succeeded,3);await work.startWork(a);assert.equal(calls.length,6);
 const result=await files.GET(new Request('http://local/file?index=0&download=1'),context);assert.equal(result.status,200);assert.equal(await result.text(),'image-content');
 const video=await files.GET(new Request('http://local/file?index=0',{headers:{range:'bytes=2-5'}}),{params:Promise.resolve({id:b})});assert.equal(video.status,206);assert.equal(await video.text(),'deo-');
 console.log('PASS: disconnected Start request, route reload, two independent accounts, idempotent Start, persisted image/video downloads and range requests');
 const cancelled=await make('C','image',8);await work.startWork(cancelled);await pause(5);await work.cancelWork(cancelled);await until(async()=>(await work.workStatus(cancelled)).phase==='cancelled');assert.ok(calls.filter(c=>c.account==='C').length<=2);assert.equal((await work.workStatus(cancelled)).progress.completed,8);
 const retry=await make('R','image',1,'retry');await work.startWork(retry);await until(async()=>(await work.workStatus(retry)).phase==='done');assert.equal((await work.workStatus(retry)).progress.succeeded,1);assert.equal(calls.filter(c=>c.account==='R').length,2);
 console.log('PASS: explicit Cancel aborts in-flight jobs and prevents pending submissions; transient failure retries once');
 const old=await make('restart','image',1);const file=path.join(scratch,old,'status.json');const data=JSON.parse(fs.readFileSync(file));data.phase='running';data.startedAt=Date.now();fs.writeFileSync(file,JSON.stringify(data));delete global.__backgroundWork;delete require.cache[require.resolve('../src/server/work.ts')];work=require('../src/server/work.ts');assert.equal((await work.workStatus(old)).phase,'interrupted');assert.equal((await work.workStatus(a)).progress.succeeded,3);assert.equal(calls.filter(c=>c.account==='restart').length,0);
 const {timing}=require('../src/types/work.ts');assert.equal(timing(1000,undefined,0,10,11000).remainingMs,null);assert.equal(timing(1000,undefined,2,10,11000).remainingMs,40000);assert.equal(timing(1000,21000,10,10,50000).elapsedMs,20000);
 console.log('PASS: server restart retains completed results, marks uncertain work without duplicate billing; ETA and elapsed timing');
}finally{await pause(30);assert.equal(path.dirname(scratch),os.tmpdir());assert.ok(path.basename(scratch).startsWith('bulk-background-check-'));fs.rmSync(scratch,{recursive:true,force:true});}}
main().catch(error=>{console.error(error);process.exitCode=1;});
