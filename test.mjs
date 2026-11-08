import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {HTML} from './ui-v2.mjs';
const source=readFileSync(new URL('./worker.js',import.meta.url),'utf8')
 .replace("import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';","class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}; class WorkerEntrypoint {}")
 .replace("import { modelRequest } from './gateway.mjs';",'')
 .replace("import { HTML } from './ui-v2.mjs';",'const HTML="";');
const {ArnoProbe}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('served browser script parses, including escaped message strings',()=>{
 const client=HTML.split('<script type="module">')[1].split('</script>')[0];
 new Script(client);
});
function fixture(values={}){
 const map=new Map(Object.entries(values)),starts=[];
 const ctx={storage:{get:async k=>map.get(k),put:async(k,v)=>map.set(k,v),setAlarm:async()=>{}},
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
