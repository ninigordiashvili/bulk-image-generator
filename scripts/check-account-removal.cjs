/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-delete-check-'));
process.env.WORK_ROOT = path.join(scratch, 'work');
process.env.EDITOR_WORK_ROOT = path.join(scratch, 'editor');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(name, ...args) { return resolve.call(this, name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : name, ...args); };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, file);
const load = Module._load;
Module._load = function(name, ...args) { if (name === './workProvider') return { performWork: async () => { throw Error('No generation allowed'); } }; return load.call(this, name, ...args); };

const originalCwd=process.cwd();
async function main(){
 process.chdir(scratch);
 const {removeAccount}=require(path.join(root,'src/server/removeAccount.ts'));
 const {loadAccounts}=require(path.join(root,'src/server/accounts.ts'));
 const {loadVertexAccounts}=require(path.join(root,'src/server/vertexAccounts.ts'));
 const work=require(path.join(root,'src/server/work.ts'));
 fs.writeFileSync('vertex-accounts.json',JSON.stringify([{id:'main',label:'Main',projectId:'project-test',credentials:'key.json',creditUsd:10},{id:'second',label:'Second',projectId:'project-test-2',credentials:'key2.json'}]));
 fs.writeFileSync('kie-accounts.json',JSON.stringify([{id:'main',label:'Kie',apiKey:'fixture-key'}]));
 fs.writeFileSync('key.json','untouched credential');fs.mkdirSync('.local',{recursive:true});fs.writeFileSync('.local/vertex-usage.jsonl','untouched history');
 const id='12345678-1234-1234-1234-123456789abc';
 await work.createWork({id,kind:'image',accountId:'main',total:1,concurrency:1});
 const live=global.__backgroundWork.records.get(id);live.data.phase='running';live.controller=new AbortController();live.data.jobs=[{id:'test',status:'generating'}];
 fs.writeFileSync(path.join(work.workDir(id),'input-0.json'),JSON.stringify({provider:'kie'}));
 await removeAccount('vertex','main');
 assert.deepEqual(JSON.parse(fs.readFileSync('vertex-accounts.json','utf8')).map(a=>a.id),['second']);
 await assert.rejects(removeAccount('kie','main'),/active work/);
 assert.equal(live.controller.signal.aborted,false);
 assert.equal(JSON.parse(fs.readFileSync('kie-accounts.json','utf8')).length,1);
 await removeAccount('vertex','second');assert.equal((await loadVertexAccounts()).accounts.length,0);
 assert.equal(fs.readFileSync('key.json','utf8'),'untouched credential');assert.equal(fs.readFileSync('.local/vertex-usage.jsonl','utf8'),'untouched history');
 assert.equal(fs.readdirSync('.local').filter(n=>n.includes('before-removal')).length,2);
 live.controller=undefined;live.data.phase='done';await removeAccount('kie','main');
 process.env.KIE_API_KEY='fixture-env-key';await removeAccount('kie','env');assert.equal((await loadAccounts()).accounts.length,0,'environment account must not reappear');
 await assert.rejects(removeAccount('vertex','missing'),/not found/);
 assert.ok(!fs.existsSync('outside.json'));
 console.log('PASS: exact provider/account removal, active-work protection, last-account removal, environment fallback suppression, backups, credentials and usage preserved');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
 process.chdir(originalCwd);const target=path.resolve(scratch);
 if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('activity-delete-check-'))throw Error('Unsafe cleanup');
 fs.rmSync(target,{recursive:true,force:true});
});
