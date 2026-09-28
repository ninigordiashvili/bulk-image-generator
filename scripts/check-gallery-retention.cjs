/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const ts=require('typescript');
const {chromium}=require(path.join(os.tmpdir(),'bulk-ui-check-tools/node_modules/playwright-core'));
const compile=file=>ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
async function main(){
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const context=await browser.newContext();const page=await context.newPage();
  await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated retention check</title>'}));
  await page.goto('http://retention.test');
  const install=async()=>{
   await page.addScriptTag({content:fs.readFileSync(require.resolve('idb').replace('index.cjs','umd.js'),'utf8')});
   await page.evaluate(({retention,gallery})=>{
    const r={exports:{}};new Function('module','exports',retention)(r,r.exports);
    const g={exports:{}};new Function('module','exports','require',gallery)(g,g.exports,name=>name==='idb'?window.idb:r.exports);
    window.gallery=g.exports;window.retention=r.exports;
   },{retention:compile('src/lib/retention.ts'),gallery:compile('src/lib/galleryDb.ts')});
  };
  await install();
  const result=await page.evaluate(async()=>{
   const g=window.gallery,now=Date.now(),age=window.retention.RETENTION_MS;
   for(const id of ['old','recent','never'])await g.putImage({id,taskId:id,createdAt:now-age*2,base64:'AA==',mimeType:'image/png'});
   await g.markGalleryDownload('images','old',now-age-1);
   await g.markGalleryDownload('images','old',now);
   await g.markGalleryDownload('images','recent',now-24*3600000);
   await g.putImage({id:'old',taskId:'old',createdAt:now-age*2,base64:'AA==',mimeType:'image/png'});
   await g.putVideo({id:'video',taskId:'video',createdAt:now-age*2,blob:new Blob(['video'])});
   await g.markGalleryDownload('videos','video',now-age-1);
   return await g.cleanupGallery(now);
  });
  assert.deepEqual(result,{images:['old'],videos:['video']});
  await page.reload();await install();
  const kept=await page.evaluate(async()=>(await window.gallery.loadImages()).map(item=>item.id).sort());
  assert.deepEqual(kept,['never','recent']);
  console.log('PASS: real IndexedDB image/video cleanup, 48h age, undownloaded protection, repeat download/reimport protection, browser reload persistence');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
