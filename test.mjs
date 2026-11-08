import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {HTML} from './ui-v2.mjs';
import {catalog} from './models.mjs';
const source=readFileSync(new URL('./worker.js',import.meta.url),'utf8')
 .replace("import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';","class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}; class WorkerEntrypoint {}")
 .replace("import { modelRequest } from './gateway.mjs';",'')
 .replace("import { HTML } from './ui-v2.mjs';",'const HTML="";')
 .replace("from './models.mjs'", "from '"+new URL('./models.mjs',import.meta.url).href+"'");
const {ArnoProbe}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('served browser script parses, including escaped message strings',()=>{
 const client=HTML.split('<script type="module">')[1].split('</script>')[0];
 new Script(client);
});
function fixture(values={}){
 const map=new Map(Object.entries(values)),starts=[];
 const ctx={storage:{get:async k=>map.get(k),put:async(k,v)=>typeof k==='string'?map.set(k,v):Object.entries(k).forEach(([key,value])=>map.set(key,value)),setAlarm:async()=>{}},
 container:{running:false,images:{runner:'pinned'},start:o=>starts.push(o),interceptOutboundHttp:async()=>{},setInactivityTimeout:async()=>{}},
 exports:{ModelGateway:()=>({})},id:{toString:()=> 'id'}};
 ctx.storage.transaction=async fn=>fn(ctx.storage);
 return {obj:new ArnoProbe(ctx,{}),ctx,starts};
}
test('cold session starts from saved checkpoint, with internet disabled',async()=>{
 const f=fixture({snapshot:{id:'saved'}});
 await f.obj.start('mistral-large-4:cloud');
 assert.deepEqual(f.starts[0].containerSnapshot,{id:'saved'});
 assert.equal(f.starts[0].enableInternet,false);
 assert.equal(f.starts[0].image,undefined);
});
test('transcript and repository survive object recreation without container',async()=>{
 const f=fixture({session:{repo:'owner/repo',model:'m'},history:[{prompt:'hello',summary:'done'}]});
 const r=await f.obj.fetch(new Request('https://internal/session/get'));
 assert.equal(r.status,200);
 assert.deepEqual((await r.json()).history,[{prompt:'hello',summary:'done'}]);
});
test('catalog includes only completion models with tools and retains Le Chonk default',async()=>{
 const d=await catalog(async()=>Response.json({models:[{name:'coder',capabilities:['completion','tools']},{name:'vision-only',capabilities:['vision']},{name:'bad\nconfig',capabilities:['completion','tools']}]}));
 assert.deepEqual(d.models.map(m=>m.id),['mistral-large-4:cloud','coder']);
 assert.equal(d.fallback,false);
});
test('catalog failures provide explicit fallback',async()=>{
 const d=await catalog(async()=>{throw Error('unavailable')});
 assert.equal(d.fallback,true);
 assert.equal(d.models.length,3);
});
test('model cannot be changed during an active turn',async()=>{
 const f=fixture();f.obj.inFlight=true;
 const r=await f.obj.fetch(new Request('https://internal/session/model',{method:'POST',body:'{}'}));
 assert.equal(r.status,409);
});
test('submission saves a job, deduplicates retries and rejects a concurrent prompt',async()=>{
 const f=fixture({session:{repo:'test/repo'}});
 const submit=id=>f.obj.fetch(new Request('https://internal/session/enqueue',{method:'POST',body:JSON.stringify({id,prompt:'inspect repository'})}));
 const id='11111111-1111-1111-1111-111111111111';
 assert.equal((await submit(id)).status,202);
 assert.equal((await submit(id)).status,202);
 assert.equal((await submit('22222222-2222-2222-2222-222222222222')).status,409);
 assert.equal((await f.ctx.storage.get('job')).status,'queued');
});
test('alarm runs a saved job and persists its result without the submitting request',async()=>{
 const f=fixture({job:{id:'one',prompt:'hello',status:'queued'}});
 const original=f.obj.fetch.bind(f.obj);
 f.obj.fetch=async req=>new URL(req.url).pathname==='/session/run'?Response.json({summary:'completed offline'}):original(req);
 await f.obj.alarm();
 assert.equal((await f.ctx.storage.get('job')).status,'completed');
 assert.equal((await f.ctx.storage.get('job')).result.summary,'completed offline');
});
