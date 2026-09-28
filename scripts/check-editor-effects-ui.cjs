/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.tmpdir(),'bulk-ui-check-tools/node_modules/playwright-core'));
require('@next/env').loadEnvConfig(process.cwd(),true,{info(){},error(){}});
async function main(){
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
 const context=await browser.newContext({httpCredentials:{username:'local',password:process.env.APP_PASSWORD?.trim()||''},viewport:{width:1440,height:1080}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/api/**',r=>r.request().method()==='GET' && r.request().url().includes('/editor/fonts') ? r.continue() : r.abort());
 await page.goto('http://192.168.100.162:3000/editor',{waitUntil:'networkidle'});
 const motion=page.locator('details').filter({has:page.locator('summary',{hasText:'Still image motion ranges'})});
 await motion.locator('summary').click();
 await motion.getByLabel('motion range start').fill('0:00:000');
 await motion.getByLabel('motion range end').fill('5:08:434');
 await motion.getByRole('button',{name:'Add range',exact:true}).click();
 await motion.getByLabel('Still motion effect').selectOption('panZoom');
 await motion.getByLabel('motion range end').fill('10:00:000');
 await motion.getByRole('button',{name:'Add range',exact:true}).click();
 await motion.getByLabel('Still motion effect').selectOption('drift');
 await motion.getByRole('button',{name:'Add range',exact:true}).click();
 await motion.getByLabel('motion range start').fill('0:01:000');
 await motion.getByRole('button',{name:'Add range',exact:true}).click();
 assert.match(await motion.getByRole('alert').innerText(),/overlap/);
 await motion.getByRole('button',{name:'Edit',exact:true}).first().click();
 await motion.getByLabel('Pan direction').selectOption('up');
 await motion.getByRole('button',{name:'Save range',exact:true}).click();
 const film=page.locator('details').filter({has:page.locator('summary',{hasText:'Film look time ranges'})});
 await film.locator('summary').click();
 await film.getByLabel('film range start').fill('5:08:434');
 await film.getByLabel('film range end').fill('10:00:000');
 await film.getByLabel('Range film look').selectOption('sepia');
 await film.getByRole('button',{name:'Add range',exact:true}).click();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('bulk-generator-editor')).state.settings);
 assert.equal(saved.motionRanges.length,3);assert.equal(saved.motionRanges[0].end,308.434);assert.equal(saved.motionRanges[0].direction,'up');
 assert.equal(saved.filmRanges[0].start,308.434);assert.equal(saved.filmRanges[0].look,'sepia');assert.equal(saved.filmRangesEnabled,true);
 await page.reload({waitUntil:'networkidle'});
 assert.equal(await motion.getByRole('button',{name:'Edit',exact:true}).count(),3);
 assert.equal(await film.getByRole('button',{name:'Edit',exact:true}).count(),1);
 await film.getByRole('checkbox').uncheck();
 await film.getByRole('button',{name:'Remove',exact:true}).click();
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1280;c.height=720;const ctx=c.getContext('2d');for(let x=0;x<1280;x+=40){ctx.fillStyle=x%80?'#ff8844':'#2255aa';ctx.fillRect(x,0,40,720);}return c.toDataURL().split(',')[1];});
 await page.locator('input[type=file][accept="image/*,video/*"]').setInputFiles({name:'0-00.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await page.waitForFunction(()=>{const c=document.querySelector('canvas');return c && c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data[2]>0;});
 const before=await page.locator('canvas').first().evaluate(c=>c.toDataURL());
 await page.getByRole('button',{name:'Play',exact:true}).click();
 await page.waitForFunction(old=>document.querySelector('canvas').toDataURL()!==old,before);
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await motion.locator('summary').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(os.tmpdir(),'editor-effects-ui.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: browser range add/edit/remove, millisecond persistence, three motion choices, film schedule toggle, overlap errors and reload.');
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
