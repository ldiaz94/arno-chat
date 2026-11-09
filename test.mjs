import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {HTML} from './ui-v2.mjs';
import {catalog} from './models.mjs';
import {markdown,cleanOutput} from './render.mjs';
import {buildPrompt} from './context.mjs';
import {validateFiles} from './publish.mjs';
import {usageStream,modelRequest} from './gateway.mjs';
import {plainChat} from './chat.mjs';
import {validPath} from './files.mjs';
import {seal,unseal,publicProfile,instructions,validMcpUrl,accountRoute} from './account.mjs';
import {proxyMcp,testMcp} from './mcp.mjs';
import {research,citedSources} from './web.mjs';
const source=readFileSync(new URL('./worker.js',import.meta.url),'utf8')
 .replace("import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';","class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}; class WorkerEntrypoint {}")
 .replace("import { modelRequest } from './gateway.mjs';",'')
 .replace("import { HTML } from './ui-v2.mjs';",'const HTML="";')
 .replace("import MASCOT from './mascot.webp';",'const MASCOT=new Uint8Array();')
 .replace("from './models.mjs'", "from '"+new URL('./models.mjs',import.meta.url).href+"'")
 .replace("from './publish.mjs'", "from '"+new URL('./publish.mjs',import.meta.url).href+"'")
 .replace("from './context.mjs'", "from '"+new URL('./context.mjs',import.meta.url).href+"'")
 .replace("from './chat.mjs'", "from '"+new URL('./chat.mjs',import.meta.url).href+"'")
 .replace("from './files.mjs'", "from '"+new URL('./files.mjs',import.meta.url).href+"'")
 .replace("from './account.mjs'", "from '"+new URL('./account.mjs',import.meta.url).href+"'")
 .replace("from './mcp.mjs'", "from '"+new URL('./mcp.mjs',import.meta.url).href+"'")
 .replace("from './branding.mjs'", "from '"+new URL('./branding.mjs',import.meta.url).href+"'")
 .replace("from './web.mjs'", "from '"+new URL('./web.mjs',import.meta.url).href+"'");
const {ArnoProbe,default:worker}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('served browser script parses, including escaped message strings',()=>{
 const client=HTML.split('<script type="module">')[1].split('</script>')[0];
 new Script(client);
});
function fixture(values={}){
 const map=new Map(Object.entries(values)),starts=[];
 const ctx={storage:{get:async k=>map.get(k),put:async(k,v)=>typeof k==='string'?map.set(k,v):Object.entries(k).forEach(([key,value])=>map.set(key,value)),setAlarm:async()=>{}},
 container:{running:false,images:{runner:'pinned'},start:o=>starts.push(o),interceptOutboundHttp:async()=>{},setInactivityTimeout:async()=>{}},
 exports:{ModelGateway:()=>({}),McpGateway:()=>({})},id:{toString:()=> 'id'}};
 ctx.storage.transaction=async fn=>fn(ctx.storage);
 ctx.storage.list=async({prefix,reverse,limit}={})=>new Map([...map.entries()].filter(([k])=>k.startsWith(prefix||'')).sort(([a],[b])=>reverse?b.localeCompare(a):a.localeCompare(b)).slice(0,limit||Infinity));
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
test('Markdown renders formatting while escaping HTML and refusing executable links',()=>{
 const html=markdown('## Heading\n\n**bold** and [link](https://example.com)\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n`code`');
 assert.match(html,/<h3>Heading/);assert.match(html,/<strong>bold/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/href="javascript:/);assert.match(html,/<code>code/);
 assert.equal(cleanOutput('\nsafety: auto, working on a copy at /tmp\nAnswer'),'Answer');
});
test('follow-up prompts retain conversation and original GitHub identity',()=>{
 const p=buildPrompt({repo:'owner/repo',ref:'feature',sourceSha:'abc'},[{prompt:'Remember lemon-42',summary:'Remembered'}],'What was the phrase?');
 assert.match(p,/lemon-42/);assert.match(p,/https:\/\/github.com\/owner\/repo/);assert.match(p,/"branch":"feature"/);
});
test('publish validation rejects traversal, duplicate paths and invalid file types',()=>{
 assert.throws(()=>validateFiles([{path:'../secret',content:'x',mode:'100644'}]));
 assert.throws(()=>validateFiles([{path:'x',deleted:true},{path:'x',deleted:true}]));
 assert.throws(()=>validateFiles([{path:'x',content:'x',mode:'120000'}]));
 assert.equal(validateFiles([{path:'src/a.txt',content:'ok',mode:'100644'}]).length,1);
});
test('SSE usage capture handles split chunks without changing streamed bytes',async()=>{
 let usage;const text='data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":42,"completion_tokens":9}}\n\ndata: [DONE]\n\n';
 const encoder=new TextEncoder(),stream=new ReadableStream({start(c){c.enqueue(encoder.encode(text.slice(0,35)));c.enqueue(encoder.encode(text.slice(35)));c.close()}});
 const result=await new Response(stream.pipeThrough(usageStream(async u=>usage=u))).text();
 assert.equal(result,text);assert.deepEqual(usage,{prompt_tokens:42,completion_tokens:9});
});
test('publishing checks review digest and creates only a new branch from pinned source',async()=>{
 const authId='11111111-1111-1111-1111-111111111111',changes={repo:'test/repo',ref:'main',sourceSha:'a'.repeat(40),files:[{path:'demo.txt',content:'reviewed content',mode:'100644'}]};
 const env={PROBE:{getByName:name=>({fetch:async()=>Response.json(name.startsWith('auth:')?{user:{id:1},token:'test-only'}:changes)})}};
 const req=(method,path,body)=>new Request('https://arno.test/api/sessions/'+authId+'/'+path,{method,headers:{Cookie:'arno_session='+authId,Origin:'https://arno.test'},...(body?{body:JSON.stringify(body)}:{})});
 const review=await (await worker.fetch(req('GET','changes'),env)).json();
 const oldFetch=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,opt)=>{
  requests.push({url,body:opt.body?JSON.parse(opt.body):null});
  if(url.endsWith('/git/commits/'+changes.sourceSha))return Response.json({tree:{sha:'base-tree'}});
  if(url.endsWith('/git/trees'))return Response.json({sha:'new-tree'});
  if(url.endsWith('/git/commits'))return Response.json({sha:'new-commit'});
  if(url.endsWith('/git/refs'))return Response.json({ref:'refs/heads/arno/test'});
  if(url.endsWith('/pulls'))return Response.json({html_url:'https://github.com/test/repo/pull/1'});
  throw Error('Unexpected GitHub request');
 };
 try{
  const body={digest:'stale',branch:'arno/test',title:'Test change'};
  assert.equal((await worker.fetch(req('POST','publish',body),env)).status,409);
  assert.equal(requests.length,0);
  const result=await worker.fetch(req('POST','publish',{...body,digest:review.digest}),env);
  assert.equal(result.status,200);
  assert.deepEqual(requests.find(r=>r.url.endsWith('/git/commits')).body.parents,[changes.sourceSha]);
  assert.equal(requests.find(r=>r.url.endsWith('/git/refs')).body.ref,'refs/heads/arno/test');
  assert.equal(requests.find(r=>r.url.endsWith('/pulls')).body.base,'main');
 }finally{globalThis.fetch=oldFetch}
});
test('cancel stops an active container and preserves the saved checkpoint',async()=>{
 const f=fixture({job:{status:'running',stage:'thinking'},snapshot:{id:'last-good'}});
 let stopped=false;f.ctx.storage.delete=async()=>{};
 f.ctx.container.running=true;f.ctx.container.destroy=async()=>stopped=true;
 const r=await f.obj.fetch(new Request('https://internal/session/cancel',{method:'POST'}));
 assert.equal(r.status,200);assert.equal(stopped,true);
 assert.equal((await f.ctx.storage.get('job')).status,'cancelled');
 assert.deepEqual(await f.ctx.storage.get('snapshot'),{id:'last-good'});
});
test('new session import pins the branch revision before requesting its archive',async()=>{
 const id='11111111-1111-1111-1111-111111111111',sha='b'.repeat(40),seen=[];
 const env={PROBE:{getByName:name=>({fetch:async(url,opt)=>{
  if(name.startsWith('auth:'))return Response.json({user:{id:42},token:'test-only'});
  if(url.endsWith('/session/init')){assert.equal(opt.headers['X-Arno-Sha'],sha);return Response.json({repo:'test/repo',sourceSha:sha})}
  return new Response(null,{status:204});
 }})}};
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url)=>{seen.push(url);return url.includes('/commits/')?Response.json({sha}):new Response('fixture archive')};
 try{
  const req=new Request('https://arno.test/api/sessions',{method:'POST',headers:{Cookie:'arno_session='+id},body:JSON.stringify({repo:'test/repo',ref:'main',model:'mistral-large-4:cloud'})});
  const result=await worker.fetch(req,env);
  // Catalog discovery is allowed to fail into its known-good model fallback.
  assert.equal(result.status,201);assert.ok(seen.some(url=>url.endsWith('/tarball/'+sha)));
 }finally{globalThis.fetch=oldFetch}
});
test('chat adapter carries prior turns and collects usage when tools are disabled',async()=>{
 let payload;
 const result=await plainChat({model:'test',history:[{prompt:'Remember peach',summary:'Okay'}],prompt:'What fruit?',key:'test',upstream:async(url,opt)=>{
  payload=JSON.parse(opt.body);return new Response('data: {"choices":[{"delta":{"content":"peach"}}]}\n\ndata: {"usage":{"prompt_tokens":30,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
 }});
 assert.equal(result.summary,'peach');assert.equal(result.usage.inputTokens,30);assert.equal(payload.tools,undefined);assert.equal(payload.messages[0].content,'Remember peach');
});
test('code navigation rejects traversal and Git internals',()=>{
 for(const path of ['../secret','src/../../secret','/etc/passwd','.git/config','src/.git/config'])assert.equal(validPath(path),false);
 for(const path of ['','src','src/module.raz'])assert.equal(validPath(path),true);
});
test('repository visibility reports missing repo scope rather than implying all account repos',async()=>{
 const env={PROBE:{getByName:()=>({fetch:async()=>Response.json({user:{id:1},token:'test-only'})})}};
 const old=globalThis.fetch;
 globalThis.fetch=async()=>Response.json(Array.from({length:17},(_,n)=>({full_name:'user/repo'+n,default_branch:'main',private:false})),{headers:{'X-OAuth-Scopes':'read:user'}});
 try{
  const req=new Request('https://arno.test/api/repos?page=1',{headers:{Cookie:'arno_session=11111111-1111-1111-1111-111111111111'}});
  const d=await (await worker.fetch(req,env)).json();
  assert.equal(d.scanned,17);assert.equal(d.access.privateAccess,false);assert.equal(d.nextPage,null);
 }finally{globalThis.fetch=old}
});
test('account secrets are encrypted, masked and bound to user and credential field',async()=>{
 const env={ACCOUNT_ENCRYPTION_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))};
 const encrypted=await seal(env,1,'provider:openai','sk-test-placeholder');
 assert.notEqual(encrypted.value,'sk-test-placeholder');
 assert.equal(await unseal(env,1,'provider:openai',encrypted),'sk-test-placeholder');
 await assert.rejects(()=>unseal(env,2,'provider:openai',encrypted));
 await assert.rejects(()=>unseal(env,1,'provider:anthropic',encrypted));
 const masked=publicProfile(env,{keys:{openai:encrypted},mcp:[{id:'demo',token:encrypted}]});
 assert.equal(masked.providers.openai.saved,true);assert.equal(masked.mcp[0].hasToken,true);assert.equal(masked.mcp[0].token,undefined);
 assert.equal(JSON.stringify(masked).includes(encrypted.value),false);
});
test('account API saves a key without returning it',async()=>{
 const f=fixture(),env={ACCOUNT_ENCRYPTION_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),PROBE:{getByName:()=>({fetch:(url,opt)=>f.obj.fetch(new Request(url,opt))})}};
 const r=await accountRoute(new Request('https://arno.test/api/account/key',{method:'POST',body:JSON.stringify({provider:'openai',key:'sk-test-placeholder'})}),env,1);
 assert.equal(r.status,200);const text=await r.text();assert.equal(text.includes('sk-test-placeholder'),false);assert.equal(JSON.parse(text).providers.openai.saved,true);
});
test('Anthropic gateway uses native protocol and merges usage without exposing credentials',async()=>{
 let seen,usage;
 const r=await modelRequest(new Request('http://model.internal/v1/messages',{method:'POST',body:JSON.stringify({model:'claude-test',messages:[{role:'user',content:'hi'}],system:'Harness',stream:true})}),{
  provider:'anthropic',model:'claude-test',key:'test-only',instructions:'User preference',authorize:async()=>true,onUsage:async u=>usage=u,
  upstream:async(url,opt)=>{seen={url,opt,body:JSON.parse(opt.body)};return new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":25}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n')}
 });
 await r.text();assert.equal(seen.url,'https://api.anthropic.com/v1/messages');assert.equal(seen.opt.headers['x-api-key'],'test-only');
 assert.equal(seen.body.system[0].text,'User preference');assert.equal(seen.body.system[1].text,'Harness');
 assert.deepEqual(usage,{prompt_tokens:25,completion_tokens:7});
});
test('account instructions include only enabled skills and MCP rejects private endpoints',()=>{
 assert.equal(instructions({systemPrompt:'Be concise',skills:[{name:'Tests',content:'Run checks',enabled:true},{name:'Hidden',content:'No',enabled:false}]}),'Be concise\n\nSkill: Tests\nRun checks');
 for(const url of ['http://example.com/mcp','https://127.0.0.1/mcp','https://metadata.google.internal/mcp','https://name:password@example.com/mcp'])assert.equal(validMcpUrl(url),false);
 assert.equal(validMcpUrl('https://mcp.example.com/mcp'),true);
});
test('remote MCP proxy rebuilds authorization outside the container and confirms initialization',async()=>{
 const old=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,opt)=>{requests.push({url,opt});return Response.json({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26',serverInfo:{name:'Fixture'}}})};
 try{
  const d=await testMcp({id:'fixture',name:'Fixture',url:'https://mcp.example.com/mcp'},'mcp-test-token');
  assert.equal(d.ok,true);assert.equal(requests[0].opt.headers.Authorization,'Bearer mcp-test-token');assert.equal(requests[0].opt.redirect,'manual');
 }finally{globalThis.fetch=old}
});
test('research registers several real results and citations only link known sources',async()=>{
 const sources=[],counts={};
 const data=await research('web_search',{query:'official docs'},{key:'test',sources,counts,upstream:async()=>Response.json({results:[{title:'One',url:'https://one.example.com/docs',content:'A'},{title:'Two',url:'https://two.example.com/blog',content:'B'}]})});
 assert.equal(data.sources.length,2);assert.equal(counts.searches,1);
 const html=markdown('Fact [1] and other fact [2]. Fabricated [99].',sources);
 assert.match(html,/data-citation="1"/);assert.match(html,/data-citation="2"/);assert.doesNotMatch(html,/data-citation="99"/);
 assert.equal(citedSources('Fact [2]',sources)[0].title,'Two');
});
test('plain chat executes a web tool then returns a cited final answer',async()=>{
 let calls=0,executed=false;
 const result=await plainChat({model:'test',history:[],prompt:'Research this',key:'test',runTool:async(name,args)=>{executed=true;assert.equal(name,'web_search');return {sources:[{id:1,title:'Official',url:'https://example.com/docs'}]}},
  upstream:async()=>new Response(++calls===1?'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"web_search","arguments":"{\\"query\\":\\"test\\"}"}}]}}]}\n\n':'data: {"choices":[{"delta":{"content":"Verified fact [1]."}}]}\n\n')
 });
 assert.equal(executed,true);assert.equal(result.usage.calls,2);assert.equal(result.summary,'Verified fact [1].');
});
test('conversation rename preserves repository identity and delete rejects active work',async()=>{
 const f=fixture({session:{repo:'owner/repo',ref:'main',model:'m'},job:{status:'running'}});
 const r=await f.obj.fetch(new Request('https://internal/session/rename',{method:'POST',body:JSON.stringify({title:'My research'})}));
 assert.equal(r.status,200);assert.equal((await f.ctx.storage.get('session')).repo,'owner/repo');
 assert.equal((await f.ctx.storage.get('session')).title,'My research');
 assert.equal((await f.obj.fetch(new Request('https://internal/session/delete',{method:'POST'}))).status,409);
});
