/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.tmpdir(),'bulk-ui-check-tools/node_modules/playwright-core'));
require('@next/env').loadEnvConfig(process.cwd(),true,{info(){},error(){}});
async function main(){
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const context=await browser.newContext({httpCredentials:{username:'local',password:process.env.APP_PASSWORD?.trim()||''}});
  let accounts=[{id:'main',label:'Test Main',keyHint:'Vertex',source:'file'},{id:'second',label:'Test Second',keyHint:'Vertex',source:'file'}],blocked=true;
  const removed=[];
  await context.route('**/api/**',route=>{
   const req=route.request(),url=new URL(req.url());let body={ok:true,accounts:[],entries:[],files:[],problems:[]},status=200;
   if(url.pathname==='/api/vertex/accounts'){
    if(req.method()==='DELETE'){
     if(blocked){status=409;body={ok:false,error:'This account has active work. Wait until it finishes before removing it.'};}
     else{const id=url.searchParams.get('id');removed.push(id);accounts=accounts.filter(a=>a.id!==id);}
    }else body={ok:true,accounts,problems:[]};
   }
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  const page=await context.newPage();await page.goto('http://localhost:3000',{waitUntil:'networkidle'});
  const select=page.getByRole('combobox',{name:'Image account',exact:true});if(!await select.count())await page.reload({waitUntil:'networkidle'});await select.selectOption('vertex:second');
  await page.getByRole('button',{name:'Remove Test Second from app',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'active work'}).waitFor();assert.equal(await select.inputValue(),'vertex:second');
  blocked=false;await page.getByRole('button',{name:'Remove Test Second from app',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('select[aria-label="Image account"]')?.value==='vertex:main');
  assert.deepEqual(removed,['second']);
  await page.getByRole('button',{name:/^videos/i}).click();
  await page.getByRole('button',{name:'Remove Test Main from app',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('button[aria-label="Remove Test Main from app"]'));
  assert.deepEqual(removed,['second','main']);
  console.log('PASS: visible X in image/video selectors, active-work error, correct selected account removal, fallback and last-account state; all account APIs mocked');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
