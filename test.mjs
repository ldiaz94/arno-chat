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
