/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.tmpdir(),'bulk-ui-check-tools/node_modules/playwright-core'));
require('@next/env').loadEnvConfig(process.cwd(),true,{info(){},error(){}});
async function main(){
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const context=await browser.newContext({acceptDownloads:true,httpCredentials:{username:'local',password:process.env.APP_PASSWORD?.trim()||''}});
  await context.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,accounts:[],entries:[],files:[],credits:[]})}));
  const page=await context.newPage();await page.goto('http://localhost:3000',{waitUntil:'networkidle'});
  await page.evaluate(async()=>{
   const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('bulk-image-generator',2);req.onupgradeneeded=()=>{for(const name of ['images','videos']){const store=req.result.createObjectStore(name,{keyPath:'id'});store.createIndex('createdAt','createdAt');}};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
   const tx=db.transaction('videos','readwrite');
   for(let i=0;i<2;i++)tx.objectStore('videos').put({id:'retention-'+i,shotId:'shot-'+i,prompt:'Test '+i,tag:'test-'+i,model:'test',modelLabel:'Test',mimeType:'video/mp4',blob:new Blob(['video-'+i]),sizeBytes:7,duration:1,resolution:'64x36',aspectRatio:'16:9',posterBase64:'',posterMimeType:'',createdAt:Date.now(),credits:0,taskId:'task-'+i,sourceUrl:''});
   await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  });
  await page.reload({waitUntil:'networkidle'});
  await page.getByRole('button',{name:/^videos/i}).click();
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download all (ZIP)',exact:true}).click();
  const result=await downloaded;assert.equal(result.suggestedFilename(),'generated-videos-2.zip');
  const zip=await require('jszip').loadAsync(fs.readFileSync(await result.path()));
  assert.deepEqual(Object.keys(zip.files).sort(),['test-0.mp4','test-1.mp4']);
  assert.equal(await zip.file('test-0.mp4').async('string'),'video-0');
  assert.equal(await zip.file('test-1.mp4').async('string'),'video-1');
  await page.waitForFunction(async()=>{
   const db=await new Promise(resolve=>{const r=indexedDB.open('bulk-image-generator',2);r.onsuccess=()=>resolve(r.result);});
   const rows=await new Promise(resolve=>{const r=db.transaction('videos').objectStore('videos').getAll();r.onsuccess=()=>resolve(r.result);});db.close();return rows.length===2&&rows.every(row=>row.downloadedAt>0);
  });
  console.log('PASS: real gallery ZIP contains both unchanged videos, with persistent download receipts only after ZIP handoff; provider APIs intercepted');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
