import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { modelRequest } from './gateway.mjs';
import { HTML } from './ui-v2.mjs';
import { catalog, modelAllowed } from './models.mjs';
import { EXPORT_FILES,validateFiles,WORKTREE_DIFF } from './publish.mjs';
import { buildPrompt } from './context.mjs';
import { plainChat } from './chat.mjs';
import { READ_FILE,validPath } from './files.mjs';
import { LOGO } from './branding.mjs';
import MASCOT from './brand/mascot.webp';
import {profile,credential,instructions,providerModel,providerModels,accountRoute,unseal} from './account.mjs';
import {proxyMcp,testMcp} from './mcp.mjs';
import {WEB_INSTRUCTIONS,research,citedSources,webMcp} from './web.mjs';
import {prices,priceOf,cost} from './prices.mjs';

const COOKIE = 'arno_session';
const MAX_ARCHIVE = 50 * 1024 * 1024;
const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store'
};

function json(value, status = 200) {
  return Response.json(value, { status, headers: SECURITY });
}
function cookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const item of raw.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
function sessionCookie(value, maxAge = 2592000) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}
async function boundedJson(request, limit = 12000) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limit) throw new Error('Request is too large');
  const text = await request.text();
  if (text.length > limit) throw new Error('Request is too large');
  return JSON.parse(text);
}
function authObject(env, id) { return env.PROBE.getByName(`auth:${id}`); }
async function currentAuth(request, env) {
  const id = cookie(request, COOKIE);
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const response = await authObject(env, id).fetch('https://internal/auth/get');
  if (!response.ok) return null;
  return { id, ...(await response.json()) };
}
async function github(path, token, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    redirect: init.redirect || 'follow',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'arno-remote/0.1',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {})
    }
  });
}

export class ModelGateway extends WorkerEntrypoint {
  async fetch(request) {
    const task = this.env.PROBE.get(this.env.PROBE.idFromString(this.ctx.props.task));
    const {ownerId}=await (await task.fetch('https://internal/model-account')).json();
    const preferences=await profile(this.env,ownerId),selection=providerModel(this.ctx.props.model);
    let turnId,round;
    return modelRequest(request, {
      key:await credential(this.env,ownerId,preferences,selection.provider),
      model:selection.id,provider:selection.provider,instructions:[instructions(preferences),WEB_INSTRUCTIONS].filter(Boolean).join('\n\n'),
      authorize: async () => {const r=await task.fetch('https://internal/model-permit',{method:'POST'});turnId=r.headers.get('X-Turn-Id');round=Number(r.headers.get('X-Model-Round'));return r.ok},
      onUsage: usage=>task.fetch('https://internal/model-usage',{method:'POST',body:JSON.stringify({turnId,usage})}),
      onProgress: preview=>task.fetch('https://internal/model-progress',{method:'POST',body:JSON.stringify({turnId,round,...preview})})
    });
  }
}
/** Account-approved MCP traffic is mediated outside the untrusted VM. */
export class McpGateway extends WorkerEntrypoint {
 async fetch(request){
  const task=this.env.PROBE.get(this.env.PROBE.idFromString(this.ctx.props.task)),url=new URL(request.url),id=url.pathname.slice(1);
  if(url.hostname!=='mcp.internal'||!/^[a-z][a-z0-9_-]{0,29}$/.test(id))return new Response('Denied',{status:403});
  const r=await task.fetch('https://internal/mcp-permit',{method:'POST'});if(!r.ok)return new Response('MCP task limit reached',{status:429});
  const {ownerId}=await r.json(),p=await profile(this.env,ownerId),connection=p.mcp?.find(m=>m.id===id&&m.enabled);
  if(id==='web')return webMcp(request,{task,key:await credential(this.env,ownerId,p,'ollama')});
  if(!connection)return new Response('MCP connection not enabled',{status:403});
  const token=await unseal(this.env,ownerId,'mcp:'+id,connection.token);
  return proxyMcp(request,connection,token);
 }
}

export class ArnoProbe extends DurableObject {
  /** Full bounded snapshots make SSE reconnects idempotent. This is a view of
   * the durable job, never its execution lifetime. Slow readers are disconnected
   * rather than allowing their buffers to grow without bound. */
  broadcast(preview){
    const frame=new TextEncoder().encode('event: preview\ndata: '+JSON.stringify(preview)+'\n\n');
    for(const c of this.viewers||[]){try{if(c.desiredSize<=0){c.close();this.viewers.delete(c)}else c.enqueue(frame)}catch{this.viewers.delete(c)}}
  }
  async progress(preview){
    const job=await this.ctx.storage.get('job');
    if(job?.status!=='running'||preview.jobId&&preview.jobId!==job.id)return;
    const old=this.live?.jobId===job.id?this.live:null;
    if(old&&preview.round<old.round)return;
    this.live={jobId:job.id,round:preview.round,text:String(preview.text||'').slice(0,16000),reasoning:String(preview.reasoning||'').slice(0,12000),updatedAt:Math.max(Date.now(),(old?.updatedAt||0)+1)};
    if(new TextEncoder().encode(JSON.stringify(this.live)).byteLength>100000){this.live.text=this.live.text.slice(0,8000);this.live.reasoning=this.live.reasoning.slice(0,6000)}
    this.broadcast(this.live);
    if(preview.final||!this.liveSavedAt||Date.now()-this.liveSavedAt>=1000){this.liveSavedAt=Date.now();await this.ctx.storage.put('live',this.live)}
  }
  async events(){
    const job=await this.ctx.storage.get('job');
    if(!job)return json({error:'No active conversation task'},404);
    const saved=this.live||await this.ctx.storage.get('live');
    this.viewers||=new Set();
    if(this.viewers.size>=8)return json({error:'Too many live viewers'},429);
    let controller,timer;
    const remove=()=>{clearInterval(timer);this.viewers.delete(controller)};
    const stream=new ReadableStream({
      start:c=>{controller=c;this.viewers.add(c);c.enqueue(new TextEncoder().encode('retry: 1500\n\n'));if(saved?.jobId===job.id)c.enqueue(new TextEncoder().encode('event: preview\ndata: '+JSON.stringify(saved)+'\n\n'));timer=setInterval(()=>{try{if(c.desiredSize<=0){c.close();remove()}else c.enqueue(new TextEncoder().encode(': heartbeat\n\n'))}catch{remove()}},15000)},
      cancel:remove
    });
    return new Response(stream,{headers:{...SECURITY,'Content-Type':'text/event-stream','X-Accel-Buffering':'no'}});
  }
  /** Shared persistent transcript/statistics path for plain and coding turns. */
  async saveTurn(result,prompt,snapshot,sourceRegistry,editAt){
    if(editAt){const turns=await this.ctx.storage.list({prefix:'turn:'});await this.ctx.storage.delete([...turns].filter(([,t])=>t.at>=editAt).map(([k])=>k))}
    // Keep individual KV values bounded even with multi-byte code/log output.
    const clip=(s,n)=>new TextDecoder().decode(new TextEncoder().encode(s||'').slice(0,n));
    result.summary=clip(result.summary,16000);result.reasoning=clip(result.reasoning,12000);result.diff=clip(result.diff,40000);result.diagnostics=clip(result.diagnostics,8000);
    if(new TextEncoder().encode(JSON.stringify({prompt,...result})).byteLength>115000){
      result.sources=(result.sources||[]).map(s=>({...s,excerpt:s.excerpt?.slice(0,80)}));
      result.diff=clip(result.diff,24000);result.diagnostics=clip(result.diagnostics,4000);result.reasoning=clip(result.reasoning,4000);result.truncated=true;
    }
    const stats=(await this.ctx.storage.get('stats'))||{turns:0,calls:0,inputTokens:0,outputTokens:0,measuredCalls:0,totalMs:0};
    result.model||=(await this.ctx.storage.get('session'))?.model;result.usage.cost=cost(priceOf(await prices(),result.model),result.usage);stats.cost=(stats.cost||0)+(result.usage.cost||0);stats.unpriced=(stats.unpriced||0)+Number(result.usage.cost==null&&!!result.usage.measuredCalls);
    stats.turns++;stats.calls+=result.usage.calls;stats.measuredCalls+=result.usage.measuredCalls;stats.inputTokens+=result.usage.inputTokens||0;stats.outputTokens+=result.usage.outputTokens||0;stats.totalMs+=result.timing.totalMs;
    const records={stats},legacy=await this.ctx.storage.get('history');
    stats.webSearches=(stats.webSearches||0)+(result.webUsage?.searches||0);stats.webReads=(stats.webReads||0)+(result.webUsage?.reads||0);
    if(sourceRegistry){const meta=await this.ctx.storage.get('session');records.session={...meta,sources:sourceRegistry}}
    if(snapshot)records.snapshot=snapshot;
    if(legacy)for(let i=0;i<legacy.length;i++)records['turn:'+String(legacy[i].at||i).padStart(16,'0')+':legacy'+i]=legacy[i];
    records['turn:'+String(Date.now()).padStart(16,'0')+':'+crypto.randomUUID()]={prompt,...result,at:Date.now()};
    await this.ctx.storage.put(records);if(legacy)await this.ctx.storage.delete('history');
    const all=await this.ctx.storage.list({prefix:'turn:'});if(all.size>20)await this.ctx.storage.delete([...all.keys()].slice(0,all.size-20));
  }
  /** editAt names the turn an edited message replaces: it and every later
   * turn are left out of the context, and dropped once the new answer saves. */
  async plainTurn(session,prompt,editAt){
    this.inFlight=true;this.chatAbort=new AbortController();const timer=setTimeout(()=>this.chatAbort?.abort(),240000),began=Date.now();
    try{
      await this.phase('thinking',{workspace:'chat',startupMs:0});
      const p=await profile(this.env,session.ownerId),selected=providerModel(session.model);
      const sources=[...(session.sources||[])],counts={searches:0,reads:0},webKey=await credential(this.env,session.ownerId,p,'ollama');
      const previous=(await this.history()).filter(t=>!editAt||t.at<editAt);
      const jobId=(await this.ctx.storage.get('job'))?.id;
      const result=await plainChat({model:selected.id,provider:selected.provider,history:previous,prompt,key:await credential(this.env,session.ownerId,p,selected.provider),instructions:[instructions(p),WEB_INSTRUCTIONS].filter(Boolean).join('\n\n'),signal:this.chatAbort.signal,
       onRound:()=>this.phase('thinking',{workspace:'chat',startupMs:0}),
       onProgress:preview=>this.progress({...preview,jobId}),
       runTool:async(name,args)=>{await this.phase(name==='web_search'?'searching':'reading',{workspace:'chat'});const data=await research(name,args,{key:webKey,sources,counts});await this.phase('thinking',{workspace:'chat',webCounts:{...counts},sourceCount:sources.length});return data}
      });
      result.model=session.model;
      result.sources=citedSources(result.summary,sources,previous);result.webUsage=counts;
      if((await this.ctx.storage.get('job'))?.status==='cancelled')throw Error('Chat cancelled');
      result.timing={workspace:'chat',startupMs:0,executionMs:Date.now()-began,checkpointMs:0,totalMs:Date.now()-began};
      await this.phase('saving',{workspace:'chat'});
      if((await this.ctx.storage.get('job'))?.status==='cancelled')throw Error('Chat cancelled');
      await this.saveTurn(result,prompt,null,sources,editAt);
      const current=await this.ctx.storage.get('session');
      if(current.title==='General chat'&&!current.customTitle&&session.ownerId&&session.id){
        const meta={...current,title:prompt.slice(0,70)};await this.ctx.storage.put('session',meta);
        await this.env.PROBE.getByName('index:'+session.ownerId).fetch('https://internal/index/add',{method:'POST',body:JSON.stringify(meta)});
      }
      return json(result);
    }finally{clearTimeout(timer);this.chatAbort=null;this.inFlight=false}
  }
  /** Read bounded recent turns; old sessions migrate lazily after a successful
   * checkpoint, so a failed model run never discards their prior transcript. */
  async history(){
    const rows=await this.ctx.storage.list({prefix:'turn:',reverse:true,limit:20});
    return rows.size?[...rows.values()].reverse():(await this.ctx.storage.get('history'))||[];
  }
  /** Persist phase updates for mobile polling; never revive a cancelled job. */
  async phase(stage,extra={}){
    const job=await this.ctx.storage.get('job');
    if(job?.status==='running')await this.ctx.storage.put('job',{...job,stage,...extra});
  }
  /** Repair archive-based legacy sessions without adding account credentials.
   * Provenance comes from host session metadata, not from repository text. */
  async repoContext(session){
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(session.repo))return;
    const remote='https://github.com/'+session.repo+'.git';
    const existing=await this.exec(['git','remote','get-url','origin'],{cwd:'/workspace/repo'},10);
    if(existing.exitCode!==0)await this.exec(['git','remote','add','origin',remote],{cwd:'/workspace/repo'},10);
  }
  async writeConfig(model) {
    const selected=providerModel(model),session=await this.ctx.storage.get('session'),preferences=await profile(this.env,session?.ownerId);
    let config='provider = '+(selected.provider==='anthropic'?'claude':selected.provider==='openai'?'openai':'ollama-cloud')+'\nmodel = '+selected.id+'\nurl = http://model.internal/v1\nkey =\nexecution_boundary = outer-sandbox\nsafety = auto\ncontext_files = no\nproject_map = no\nmax_tokens = 4096\n';
    config+='mcp = web http://mcp.internal/web\ntrust = web_web_search web_web_read\n';
    for(const c of preferences.mcp||[])if(c.enabled&&c.id!=='web')config+='mcp = '+c.id+' http://mcp.internal/'+c.id+'\n';
    const p=await this.ctx.container.exec(['tee','/workspace/config/arno/config'],{stdin:'pipe',stdout:'ignore'});
    const writer=p.stdin.getWriter();
    await writer.write(new TextEncoder().encode(config));
    await writer.close();
    if(await p.exitCode!==0)throw Error('Could not update model config');
  }
  async exec(argv, options = {}, seconds = 180) {
    const process = await this.ctx.container.exec(['timeout', '--kill-after=5', String(seconds), ...argv], options);
    const output = await process.output();
    const decode = bytes => new TextDecoder().decode(bytes);
    return { exitCode: output.exitCode, stdout: decode(output.stdout).slice(-50000), stderr: decode(output.stderr).slice(-12000) };
  }
  /** Reuse a live VM. Restore only when it has stopped; callers can report this
   * mode independently of the model's own latency. No repository is reimported. */
  async start(model) {
    const container = this.ctx.container;
    let mode='warm';
    if (!container.running) {
      const snapshot = await this.ctx.storage.get('snapshot');
      mode=snapshot?'restored':'new';
      container.start({ ...(snapshot ? { containerSnapshot: snapshot } : { image: container.images.runner }), entrypoint: ['sleep', 'infinity'], enableInternet: false, instance: 'standard-1' });
    }
    await container.interceptOutboundHttp('model.internal', this.ctx.exports.ModelGateway({ props: { task: this.ctx.id.toString(), model } }));
    await container.interceptOutboundHttp('mcp.internal',this.ctx.exports.McpGateway({props:{task:this.ctx.id.toString()}}));
    await container.setInactivityTimeout(30 * 60 * 1000);
    await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
    return mode;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if(url.pathname==='/session/rename'&&request.method==='POST'){
      const {title}=await request.json();if(typeof title!=='string'||!title.trim()||title.length>100)return json({error:'Conversation names must be 1–100 characters'},400);
      const meta=await this.ctx.storage.get('session');if(!meta)return json({error:'Conversation not found'},404);
      const renamed={...meta,title:title.trim(),customTitle:true};await this.ctx.storage.put('session',renamed);return json(renamed);
    }
    if(url.pathname==='/session/delete'&&request.method==='POST'){
      const job=await this.ctx.storage.get('job');
      if(this.inFlight||job&&['queued','running'].includes(job.status))return json({error:'Stop the active task before deleting this conversation'},409);
      if(this.ctx.container?.running)await this.ctx.container.destroy();
      await this.ctx.storage.deleteAlarm();await this.ctx.storage.deleteAll();return json({deleted:true});
    }
    if(url.pathname==='/index/remove'&&request.method==='POST'){
      const {id}=await request.json();await this.ctx.storage.delete('session:'+id);return new Response(null,{status:204});
    }
    if(url.pathname==='/web-state'){
      const q=await this.ctx.storage.get('modelQuota');
      if(!q||q.deadline<Date.now())return json({error:'No active research task'},403);
      if(request.method==='POST'){
        const state=await request.json();
        await this.ctx.storage.transaction(async txn=>{const current=await txn.get('modelQuota');if(!current)return;await txn.put('modelQuota',{...current,sources:state.sources,webCounts:state.counts})});
        return new Response(null,{status:204});
      }
      return json({sources:q.sources||[],counts:q.webCounts||{searches:0,reads:0}});
    }
    if(url.pathname==='/profile/get')return json(await this.ctx.storage.get('profile')||{systemPrompt:'',skills:[],mcp:[],keys:{},models:[]});
    if((url.pathname==='/profile/patch'||url.pathname==='/profile/key')&&request.method==='POST'){
      const patch=await request.json();
      await this.ctx.storage.transaction(async txn=>{
        const p=await txn.get('profile')||{};
        if(url.pathname==='/profile/key')p.keys={...(p.keys||{}),[patch.provider]:patch.value};
        else Object.assign(p,patch);
        await txn.put('profile',p);
      });return new Response(null,{status:204});
    }
    if(url.pathname==='/model-account')return json({ownerId:(await this.ctx.storage.get('session'))?.ownerId||null});
    if(url.pathname==='/session/owner'&&request.method==='POST'){
      const {ownerId}=await request.json(),session=await this.ctx.storage.get('session');
      if(!session)return json({error:'Session not found'},404);
      await this.ctx.storage.put('session',{...session,ownerId});return new Response(null,{status:204});
    }
    if(url.pathname==='/mcp-permit'&&request.method==='POST'){
      const allowed=await this.ctx.storage.transaction(async txn=>{
        const q=await txn.get('modelQuota');if(!q||q.deadline<Date.now()||(q.mcpUsed||0)>=50)return false;
        q.mcpUsed=(q.mcpUsed||0)+1;await txn.put('modelQuota',q);return true;
      });
      return allowed?json({ownerId:(await this.ctx.storage.get('session'))?.ownerId||null}):new Response('Denied',{status:429});
    }
    if(url.pathname==='/session/files'&&request.method==='GET'){
      const name=url.searchParams.get('path')||'';
      if(!validPath(name))return json({error:'Invalid file path'},400);
      const session=await this.ctx.storage.get('session');
      if(!session||session.kind==='chat')return json({error:'Open a repository to browse code'},400);
      if(!this.ctx.container.running){
        const job=await this.ctx.storage.get('job');
        if(job&&['queued','running'].includes(job.status))return json({error:'Workspace is starting. Try again shortly.'},409);
        await this.start(session.model);
      }
      const p=await this.ctx.container.exec(['node','-e',READ_FILE,name],{cwd:'/workspace/repo'});
      const result=await p.output();
      if(result.exitCode!==0)return json({error:'Cannot preview this path. Preview supports regular UTF-8 files up to 200 KB and no symlinks.'},400);
      if(result.stdout.byteLength>1500000)return json({error:'Preview too large'},413);
      return json(JSON.parse(new TextDecoder().decode(result.stdout)));
    }
    if(url.pathname==='/session/chat-init'&&request.method==='POST'){
      const {model,ownerId,id}=await request.json();if(!await modelAllowed(model))return json({error:'Unsupported model'},400);
      const meta={id,ownerId,kind:'chat',title:'General chat',repo:'General chat',model,createdAt:Date.now()};
      await this.ctx.storage.put('session',meta);return json(meta);
    }
    if(url.pathname==='/session/cancel'&&request.method==='POST'){
      const job=await this.ctx.storage.get('job');
      if(!job||!['queued','running'].includes(job.status))return json({error:'No active task'},409);
      if(['checkpointing','saving'].includes(job.stage))return json({error:'This response is being saved. Please wait for it to finish.'},409);
      await this.ctx.storage.put('job',{...job,status:'cancelled',finishedAt:Date.now()});
      this.chatAbort?.abort();
      await this.ctx.storage.delete('modelQuota');
      if(this.ctx.container?.running)await this.ctx.container.destroy();
      return json({status:'cancelled'});
    }
    if(url.pathname==='/session/changes'&&request.method==='GET'){
      const job=await this.ctx.storage.get('job');
      if(this.inFlight||job&&['queued','running'].includes(job.status))return json({error:'Wait for the task to finish before publishing'},409);
      const session=await this.ctx.storage.get('session');if(!session)return json({error:'Session not found'},404);
      if(!session.sourceSha)return json({error:'This older session has no pinned source commit. Open a new session before publishing.'},409);
      this.inFlight=true;
      try{
        await this.start(session.model);
        const p=await this.ctx.container.exec(['node','-e',EXPORT_FILES],{cwd:'/workspace/repo'});
        const output=await p.output();
        if(output.exitCode!==0)return json({error:'Unable to export changes. Only regular text files up to 1 MB are supported.'},400);
        if(output.stdout.byteLength>2000000)return json({error:'Changes too large'},413);
        const {files}=JSON.parse(new TextDecoder().decode(output.stdout));
        return json({files:validateFiles(files),repo:session.repo,ref:session.ref,sourceSha:session.sourceSha});
      }finally{this.inFlight=false}
    }
    if(url.pathname==='/session/suspend' && request.method==='POST'){
      const job=await this.ctx.storage.get('job');
      if(this.inFlight||job&&['queued','running'].includes(job.status))return json({error:'Task is running'},409);
      if(this.ctx.container?.running)await this.ctx.container.destroy();
      await this.ctx.storage.deleteAlarm();
      return json({stopped:true});
    }
    if(url.pathname==='/session/job' && request.method==='GET'){
      const job=await this.ctx.storage.get('job');
      const live=this.live||await this.ctx.storage.get('live');
      return json(job?{...job,preview:live?.jobId===job.id?live:undefined}:{status:'idle'});
    }
    if(url.pathname==='/session/events'&&request.method==='GET')return this.events();
    if(url.pathname==='/session/enqueue' && request.method==='POST'){
      const body=await request.json();
      if(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>8000||!/^[-a-f0-9]{36}$/.test(body.id||'')||(body.editAt!=null&&!Number.isSafeInteger(body.editAt)))return json({error:'Invalid message'},400);
      return this.ctx.storage.transaction(async txn=>{
        const current=await txn.get('job');
        if(current?.id===body.id)return json(current,202);
        if(current&&['queued','running'].includes(current.status))return json({error:'A turn is already running'},409);
        const session=await txn.get('session');
        if(!session)return json({error:'Session not found'},404);
        if(body.editAt&&session.kind!=='chat')return json({error:'Only chat messages can be edited'},400);
        const job={id:body.id,prompt:body.prompt,editAt:body.editAt||null,status:'queued',createdAt:Date.now()};
        await txn.put('job',job);await txn.setAlarm(Date.now()+100);
        return json(job,202);
      });
    }
    if (url.pathname === '/session/model' && request.method === 'POST') {
      const job=await this.ctx.storage.get('job');
      if(job && ['queued','running'].includes(job.status))return json({error:'Wait for the current turn to finish'},409);
      if(this.inFlight)return json({error:'Wait for the current turn to finish'},409);
      this.inFlight=true;
      try {
        const session=await this.ctx.storage.get('session');
        if(!session)return json({error:'Session not found'},404);
        const {model}=await request.json();
        if(!await modelAllowed(model))return json({error:'Unsupported model'},400);
        await this.ctx.storage.put('session',{...session,model});
        return json({model});
      }finally{this.inFlight=false;}
    }
    if (url.pathname === '/index/list') {
      const entries = await this.ctx.storage.list({ prefix: 'session:' });
      return json({ sessions: [...entries.values()].sort((a,b) => b.createdAt-a.createdAt) });
    }
    if (url.pathname === '/index/add') {
      const entry = await request.json();
      await this.ctx.storage.put('session:' + entry.id, entry);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/session/get') {
      const meta = await this.ctx.storage.get('session');
      if (!meta) return json({error:'Session not found'},404);
      return json({...meta,remoteUrl:meta.remoteUrl||'https://github.com/'+meta.repo,workspaceState:this.ctx.container?.running?'warm':'sleeping',stats:await this.ctx.storage.get('stats')||null,history:await this.history()});
    }
    if (url.pathname === '/auth/put' && request.method === 'POST') {
      const data = await request.json();
      await this.ctx.storage.put('auth', data);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/auth/get') {
      const auth = await this.ctx.storage.get('auth');
      if (!auth || auth.expiresAt < Date.now()) {
        if (auth) await this.ctx.storage.deleteAll();
        return new Response(null, { status: 404 });
      }
      return Response.json(auth);
    }
    if (url.pathname === '/auth/delete' && request.method === 'POST') {
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/oauth/put' && request.method === 'POST') {
      await this.ctx.storage.put('oauth', { ...(await request.json()), expiresAt: Date.now() + 10 * 60 * 1000 });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/oauth/take' && request.method === 'POST') {
      const value = await this.ctx.storage.get('oauth');
      await this.ctx.storage.delete('oauth');
      if (!value || value.expiresAt < Date.now()) return new Response(null, { status: 404 });
      return Response.json(value);
    }
    if (url.pathname === '/model-permit' && request.method === 'POST') {
      let turnId='',round=0;
      const allowed = await this.ctx.storage.transaction(async txn => {
        const quota = await txn.get('modelQuota');
        if (!quota || quota.deadline < Date.now() || quota.used >= 16) return false;
        quota.used += 1;
        round=quota.used;
        turnId=quota.turnId||'';
        await txn.put('modelQuota', quota);
        return true;
      });
      return new Response(null, { status: allowed ? 204 : 429,headers:{'X-Turn-Id':turnId,'X-Model-Round':String(round)} });
    }
    if(url.pathname==='/model-progress'&&request.method==='POST'){
      const preview=await request.json(),q=await this.ctx.storage.get('modelQuota');
      if(!q||q.turnId!==preview.turnId||q.deadline<Date.now()||preview.round!==q.used)return new Response(null,{status:409});
      await this.progress(preview);return new Response(null,{status:204});
    }
    if(url.pathname==='/model-usage'&&request.method==='POST'){
      const {turnId,usage}=await request.json();
      await this.ctx.storage.transaction(async txn=>{
        const q=await txn.get('modelQuota');if(!q||q.turnId!==turnId)return;
        const safe=n=>Number.isSafeInteger(n)&&n>=0?n:0;
        q.inputTokens=(q.inputTokens||0)+safe(usage.prompt_tokens);
        q.outputTokens=(q.outputTokens||0)+safe(usage.completion_tokens);q.cachedTokens=(q.cachedTokens||0)+safe(usage.cached_tokens);q.cacheWriteTokens=(q.cacheWriteTokens||0)+safe(usage.cache_write_tokens);
        q.measuredCalls=(q.measuredCalls||0)+1;await txn.put('modelQuota',q);
      });return new Response(null,{status:204});
    }
    if (url.pathname === '/session/init' && request.method === 'POST') {
      const model = request.headers.get('X-Arno-Model');
      const repo = request.headers.get('X-Arno-Repo');
      const ref = request.headers.get('X-Arno-Ref');
      if (!await modelAllowed(model) || !repo || !ref || !request.body) return json({ error: 'Invalid session' }, 400);
      await this.start(model);
      await this.exec(['sh', '-c', 'rm -rf /workspace/repo /workspace/config /workspace/data; mkdir -p /workspace/repo /workspace/config/arno /workspace/data'], {}, 30);
      const unpack = await this.exec(['tar', '-xz', '--strip-components=1', '-C', '/workspace/repo'], { stdin: request.body }, 120);
      if (unpack.exitCode !== 0) return json({ error: 'Could not unpack repository', detail: unpack.stderr }, 400);
      const config = `provider = ollama-cloud\nmodel = ${model}\nurl = http://model.internal/v1\nkey =\nexecution_boundary = outer-sandbox\nsafety = auto\ncontext_files = no\nproject_map = no\nmax_tokens = 4096\n`;
      const write = await this.ctx.container.exec(['tee', '/workspace/config/arno/config'], { stdin: 'pipe', stdout: 'ignore' });
      const writer = write.stdin.getWriter();
      await writer.write(new TextEncoder().encode(config));
      await writer.close();
      await write.exitCode;
      const baseline = await this.exec(['sh', '-c', "git init -q && git add -A && git -c user.name='Arno Remote' -c user.email='arno@localhost' commit -qm baseline"], { cwd: '/workspace/repo' }, 120);
      if (baseline.exitCode !== 0) return json({ error: 'Could not prepare git workspace', detail: baseline.stderr }, 500);
      await this.exec(['git','branch','-M',ref],{cwd:'/workspace/repo'},10);
      const meta = { repo, ref, model,ownerId:request.headers.get('X-Arno-Owner')||null,remoteUrl:'https://github.com/'+repo,sourceSha:request.headers.get('X-Arno-Sha')||null,createdAt:Date.now() };
      if(meta.sourceSha)await this.exec(['git','config','arno.sourceCommit',meta.sourceSha],{cwd:'/workspace/repo'},10);
      await this.repoContext(meta);
      const snapshot=await this.ctx.container.snapshotContainer({});
      await this.ctx.storage.put({session:meta,snapshot});
      return json(meta);
    }
    if (url.pathname === '/session/run' && request.method === 'POST') {
      if (this.inFlight) return json({ error: 'Arno is already working' }, 409);
      const session = await this.ctx.storage.get('session');
      if (!session) return json({ error: 'Session not found' }, 404);
      const { prompt,editAt } = await request.json();
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) return json({ error: 'Invalid prompt' }, 400);
      if(this.inFlight)return json({error:'Arno is already working'},409);
      if(session.kind==='chat')return this.plainTurn(session,prompt.trim(),editAt);
      this.inFlight = true;
      try {
        const began=Date.now(),turnId=crypto.randomUUID();
        await this.phase(this.ctx.container.running?'preparing':'restoring');
        const workspace=await this.start(session.model);
        if((await this.ctx.storage.get('job'))?.status==='cancelled')throw Error('Task cancelled');
        await this.writeConfig(session.model);
        await this.repoContext(session);
        const startupMs=Date.now()-began;
        await this.phase('thinking',{workspace,startupMs});
        const previous=await this.history();
        const taskPrompt=buildPrompt(session,previous,prompt);
        await this.ctx.storage.put('modelQuota', { used: 0,turnId,sources:session.sources||[],webCounts:{searches:0,reads:0},deadline:Date.now()+4*60*1000 });
        const modelBegan=Date.now();
        const process = await this.ctx.container.exec(['timeout', '--kill-after=5', '240', '/usr/local/bin/arno', taskPrompt], {
          cwd: '/workspace/repo',
          env: { XDG_CONFIG_HOME: '/workspace/config', XDG_DATA_HOME: '/workspace/data', PYTHONDONTWRITEBYTECODE: '1' },
          stdin: 'pipe'
        });
        const writer = process.stdin.getWriter();
        await writer.write(new TextEncoder().encode('y\ny\ny\n'));
        await writer.close();
        const output = await process.output();
        const executionMs=Date.now()-modelBegan;
        await this.phase('checkpointing',{workspace,startupMs,executionMs});
        const decode = bytes => new TextDecoder().decode(bytes);
        const stdout = decode(output.stdout).slice(-40000);
        const stderr = decode(output.stderr).slice(-10000);
        const diffResult = await this.exec(['node','-e',WORKTREE_DIFF], { cwd: '/workspace/repo' }, 30);
        const result = {
          exitCode: output.exitCode,
          model: session.model,
          summary: (stdout || stderr || `Arno exited with code ${output.exitCode}`).slice(-12000),
          diff: diffResult.stdout.slice(-40000),
          diagnostics:stderr,
          reasoning:this.live?.jobId===(await this.ctx.storage.get('job'))?.id?this.live?.reasoning||'':'',
          timing:{startupMs,executionMs,workspace}
        };
        const q=await this.ctx.storage.get('modelQuota');
        result.usage={calls:q?.used||0,measuredCalls:q?.measuredCalls||0,inputTokens:q?.measuredCalls?q.inputTokens:null,outputTokens:q?.measuredCalls?q.outputTokens:null,cachedTokens:q?.cachedTokens||0,cacheWriteTokens:q?.cacheWriteTokens||0};
        result.sources=citedSources(result.summary,q?.sources||[],previous);result.webUsage=q?.webCounts||{searches:0,reads:0};
        const checkpointBegan=Date.now();
        const snapshot=await this.ctx.container.snapshotContainer({});
        result.timing.checkpointMs=Date.now()-checkpointBegan;result.timing.totalMs=Date.now()-began;
        await this.saveTurn(result,prompt.trim(),snapshot,q?.sources||[]);
        return json(result);
      } finally {
        this.inFlight = false;
        await this.ctx.storage.delete('modelQuota');
        await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
      }
    }
    return new Response('Not found', { status: 404 });
  }
  /** Alarms own the long-running turn, not the submitting browser request.
   * Mark running before execution; an interrupted alarm must not silently replay
   * commands with side effects. Cancelled jobs remain cancelled on every path. */
  async alarm() {
    const job=await this.ctx.storage.get('job');
    if(job?.status==='queued'){
      await this.ctx.storage.put('job',{...job,status:'running'});
      try{
        const r=await this.fetch(new Request('https://internal/session/run',{method:'POST',body:JSON.stringify({prompt:job.prompt,editAt:job.editAt})}));
        const result=await r.json();
        const ok=r.ok&&(!result.exitCode||result.exitCode===0);
        if(!ok&&!result.error)result.error=result.summary||'The coding task failed.';
        const current=await this.ctx.storage.get('job');
        if(current?.status!=='cancelled')await this.ctx.storage.put('job',{...current,...job,status:ok?'completed':'failed',result,finishedAt:Date.now()});
      }catch(e){
        console.error(JSON.stringify({event:'turn_failed',error:String(e)}));
        const current=await this.ctx.storage.get('job');
        if(current?.status==='cancelled'){if(this.ctx.container?.running)await this.ctx.container.destroy()}
        else await this.ctx.storage.put('job',{...job,status:'failed',result:{error:'The coding task failed. Your last checkpoint is preserved.'}});
      }
      await this.ctx.storage.setAlarm(Date.now()+35*60*1000);
      return;
    }
    if(job?.status==='running'){
      await this.ctx.storage.put('job',{...job,status:'failed',result:{error:'The task was interrupted. Retry from the last saved checkpoint.'}});
    }
    await this.ctx.storage.delete('modelQuota');
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}

async function handleOAuth(request, env, url) {
  if (url.pathname === '/auth/github') {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ error: 'GitHub OAuth is not configured' }, 503);
    const state = crypto.randomUUID();
    const connectRepos=url.searchParams.get('repos')==='1';
    await authObject(env, state).fetch('https://internal/oauth/put', { method: 'POST', body: JSON.stringify({ origin: url.origin,connectRepos }) });
    const target = new URL('https://github.com/login/oauth/authorize');
    target.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    target.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
    target.searchParams.set('scope',connectRepos?'read:user repo':'read:user');
    if(connectRepos)target.searchParams.set('prompt','select_account');
    target.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { Location: target.toString(), 'Set-Cookie': `arno_oauth=${state}; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`, ...SECURITY } });
  }
  if (url.pathname === '/auth/callback') {
    const state = url.searchParams.get('state') || '';
    if (state !== cookie(request, 'arno_oauth') || !/^[0-9a-f-]{36}$/.test(state)) return json({ error: 'Invalid OAuth state' }, 400);
    const saved = await authObject(env, state).fetch('https://internal/oauth/take', { method: 'POST' });
    if (!saved.ok) return json({ error: 'OAuth state expired' }, 400);
    const savedState=await saved.json();
    if(savedState.origin!==url.origin)return json({error:'OAuth origin mismatch'},400);
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'manual', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: `${url.origin}/auth/callback` })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) return json({ error: 'GitHub sign-in failed' }, 401);
    const userResponse = await github('/user', tokenData.access_token);
    if (!userResponse.ok) return json({ error: 'Could not read GitHub profile' }, 502);
    const user = await userResponse.json();
    const allowed=(env.ALLOWED_GITHUB_LOGINS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    if(allowed.length&&!allowed.includes(user.login?.toLowerCase()))return json({error:'This private deployment is restricted to its owner.'},403);
    const id = crypto.randomUUID();
    const scopes=(tokenData.scope||userResponse.headers.get('X-OAuth-Scopes')||'').split(/[, ]+/).filter(Boolean);
    await authObject(env, id).fetch('https://internal/auth/put', { method: 'POST', body: JSON.stringify({ token: tokenData.access_token,scopes,githubConnected:scopes.includes('repo'),user: { id: user.id, login: user.login }, expiresAt: Date.now() + 30 * 86400000 }) });
    return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': sessionCookie(id), ...SECURITY } });
  }
  if (url.pathname === '/auth/logout') {
    const id = cookie(request, COOKIE);
    if (/^[0-9a-f-]{36}$/.test(id)) await authObject(env, id).fetch('https://internal/auth/delete', { method: 'POST' });
    return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': sessionCookie('', 0), ...SECURITY } });
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/auth/')) {
        const response = await handleOAuth(request, env, url);
        if (response) return response;
      }
      if (url.pathname === '/' && request.method === 'GET') return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY } });
      if(url.pathname==='/brand/logo.svg')return new Response(LOGO,{headers:{'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400','X-Content-Type-Options':'nosniff'}});
      if(url.pathname==='/brand/mascot.webp')return new Response(MASCOT,{headers:{'Content-Type':'image/webp','Cache-Control':'public,max-age=86400','X-Content-Type-Options':'nosniff'}});
      if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404, headers: SECURITY });
      if (!sameOrigin(request)) return json({ error: 'Cross-origin request denied' }, 403);
      const auth = await currentAuth(request, env);
      if (url.pathname === '/api/me') return json({ user: auth?.user || null,githubConnected:auth?.githubConnected??null,scopes:auth?.scopes||null,githubConfigured: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) });
      if (!auth) return json({ error: 'Sign in required' }, 401);
      const allowed=(env.ALLOWED_GITHUB_LOGINS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
      if(allowed.length&&!allowed.includes(auth.user.login?.toLowerCase()))return json({error:'This private deployment is restricted to its owner.'},403);
      if(url.pathname==='/api/account/mcp-test'&&request.method==='POST'){
        const {id}=await boundedJson(request),p=await profile(env,auth.user.id),connection=p.mcp?.find(c=>c.id===id);
        if(!connection)return json({error:'Save this MCP connection first'},400);
        try{return json(await testMcp(connection,await unseal(env,auth.user.id,'mcp:'+id,connection.token)))}catch(e){return json({error:e.message},400)}
      }
      if(url.pathname==='/api/account'||url.pathname==='/api/account/key'||url.pathname==='/api/account/test'){
        if(!['GET','POST'].includes(request.method))return json({error:'Unsupported method'},405);
        const r=await accountRoute(request,env,auth.user.id);
        return new Response(r.body,{status:r.status,headers:{'Content-Type':'application/json',...SECURITY}});
      }
      const fileMatch=url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/files$/);
      if(fileMatch&&request.method==='GET')return env.PROBE.getByName('code:'+auth.user.id+':'+fileMatch[1]).fetch('https://internal/session/files?path='+encodeURIComponent(url.searchParams.get('path')||''));
      if(url.pathname==='/api/chats'&&request.method==='POST'){
        const {model}=await boundedJson(request),id=crypto.randomUUID();
        const object=env.PROBE.getByName('code:'+auth.user.id+':'+id);
        const r=await object.fetch('https://internal/session/chat-init',{method:'POST',body:JSON.stringify({model,ownerId:auth.user.id,id})});
        const meta=await r.json();if(!r.ok)return json(meta,r.status);
        await env.PROBE.getByName('index:'+auth.user.id).fetch('https://internal/index/add',{method:'POST',body:JSON.stringify({id,...meta})});
        return json({id,...meta},201);
      }
      const cancelMatch=url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/cancel$/);
      if(cancelMatch&&request.method==='POST')return env.PROBE.getByName('code:'+auth.user.id+':'+cancelMatch[1]).fetch('https://internal/session/cancel',{method:'POST'});
      const publishMatch=url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/(changes|publish)$/);
      if(publishMatch&&((publishMatch[2]==='changes'&&request.method==='GET')||(publishMatch[2]==='publish'&&request.method==='POST'))){
        const object=env.PROBE.getByName('code:'+auth.user.id+':'+publishMatch[1]);
        const r=await object.fetch('https://internal/session/changes');if(!r.ok)return r;
        const changes=await r.json(),files=validateFiles(changes.files);
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({files,sourceSha:changes.sourceSha}))))).map(n=>n.toString(16).padStart(2,'0')).join('');
        if(request.method==='GET')return json({...changes,digest,files:files.map(f=>({...f,bytes:f.content?new TextEncoder().encode(f.content).length:0}))});
        const body=await boundedJson(request);
        if(body.digest!==digest)return json({error:'Changes have changed since review. Review them again before publishing.'},409);
        if(typeof body.branch!=='string'||!/^arno\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}$/.test(body.branch)||typeof body.title!=='string'||!body.title.trim()||body.title.length>200)return json({error:'Use an arno/branch-name and a commit title up to 200 characters'},400);
        const prefix='/repos/'+changes.repo;
        const call=async(path,method='GET',data)=>{const r=await github(prefix+path,auth.token,{method,...(data?{body:JSON.stringify(data),headers:{'Content-Type':'application/json'}}:{})});if(!r.ok)throw Error('GitHub rejected publishing ('+r.status+'). A branch may already exist; check GitHub before retrying.');return r.json()};
        const base=await call('/git/commits/'+changes.sourceSha);
        const tree=await call('/git/trees','POST',{base_tree:base.tree.sha,tree:files.map(f=>({path:f.path,mode:f.mode||'100644',type:'blob',...(f.deleted?{sha:null}:{content:f.content})}))});
        const commit=await call('/git/commits','POST',{message:body.title.trim(),tree:tree.sha,parents:[changes.sourceSha]});
        await call('/git/refs','POST',{ref:'refs/heads/'+body.branch,sha:commit.sha});
        let prUrl=null,warning=null;
        try{const pr=await call('/pulls','POST',{title:body.title.trim(),head:body.branch,base:changes.ref,body:'Changes prepared with Arno Chat.\n\nBase revision: '+changes.sourceSha});prUrl=pr.html_url}catch{warning='Branch created, but the pull request could not be opened. Open it on GitHub.'}
        return json({branch:body.branch,commit:commit.sha,url:prUrl||'https://github.com/'+changes.repo+'/tree/'+body.branch,warning});
      }
      if(url.pathname==='/api/models' && request.method==='GET'){
        const base=await catalog(),p=await profile(env,auth.user.id);
        const extra=await Promise.allSettled(['openai','anthropic'].filter(id=>p.keys?.[id]).map(async id=>providerModels(id,await credential(env,auth.user.id,p,id))));
        const all=[...base.models,...extra.filter(r=>r.status==='fulfilled').flatMap(r=>r.value),...(p.models||[])];
        return json({...base,models:[...new Map(all.map(m=>[m.id,m])).values()]});
      }
      const modelMatch=url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/model$/);
      if(modelMatch && request.method==='POST'){
        const body=await boundedJson(request);
        return env.PROBE.getByName('code:'+auth.user.id+':'+modelMatch[1]).fetch('https://internal/session/model',{method:'POST',body:JSON.stringify(body)});
      }
      if (url.pathname === '/api/repos' && request.method === 'GET') {
        const page = Math.max(1, Math.min(10000, Number(url.searchParams.get('page')) || 1));
        const query = (url.searchParams.get('q') || '').trim().replace(/^https?:\/\/github.com\//i,'').replace(/\.git\/?$/,'').replace(/\/$/,'').toLowerCase().slice(0,100);
        const response = await github('/user/repos?per_page=100&page='+page+'&sort=updated&affiliation=owner,collaborator,organization_member', auth.token);
        if (!response.ok) return json({ error: 'GitHub rejected the repository request' }, 502);
        const raw=await response.json();
        const pageLength=raw.length;
        // A known URL can be opened even if an organization omits it from the
        // user's listing. GitHub still enforces authorization on this lookup.
        if(page===1&&/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(query)&&!raw.some(r=>r.full_name.toLowerCase()===query)){
          const direct=await github('/repos/'+query,auth.token);
          if(direct.ok)raw.push(await direct.json());
        }
        const repos=raw.map(({full_name,private:isPrivate,default_branch,archived,description,language,updated_at})=>({full_name,private:isPrivate,default_branch,archived,description,language,updated_at}));
        const scopes=response.headers.get('X-OAuth-Scopes')||null;
        const sso=response.headers.get('X-GitHub-SSO')||null;
        return json({repos:repos.filter(r=>(r.full_name+' '+(r.description||'')).toLowerCase().includes(query)),scanned:pageLength,access:{connectionType:auth.token.startsWith('ghu_')?'github-app':'oauth',scopes,privateAccess:raw.some(r=>r.private)||(scopes?scopes.split(/[, ]+/).includes('repo'):auth.githubConnected??null),ssoRequired:!!sso},nextPage:response.headers.get('Link')?.includes('rel="next"')||pageLength===100?page+1:null});
      }
      if (url.pathname === '/api/sessions' && request.method === 'GET') {
        return env.PROBE.getByName('index:'+auth.user.id).fetch('https://internal/index/list');
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
      if(sessionMatch&&['PATCH','DELETE'].includes(request.method)){
        const id=sessionMatch[1],object=env.PROBE.getByName('code:'+auth.user.id+':'+id);
        if(request.method==='PATCH'){
          const body=await boundedJson(request),r=await object.fetch('https://internal/session/rename',{method:'POST',body:JSON.stringify(body)});
          const meta=await r.json();if(!r.ok)return json(meta,r.status);
          await env.PROBE.getByName('index:'+auth.user.id).fetch('https://internal/index/add',{method:'POST',body:JSON.stringify({id,...meta})});return json({id,...meta});
        }
        const r=await object.fetch('https://internal/session/delete',{method:'POST'});if(!r.ok)return r;
        await env.PROBE.getByName('index:'+auth.user.id).fetch('https://internal/index/remove',{method:'POST',body:JSON.stringify({id})});return json({deleted:true});
      }
      if (sessionMatch && request.method === 'GET') {
        return env.PROBE.getByName('code:'+auth.user.id+':'+sessionMatch[1]).fetch('https://internal/session/get');
      }
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        const body = await boundedJson(request);
        if (typeof body.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.repo) || typeof body.ref !== 'string' || body.ref.length > 200 || !await modelAllowed(body.model)) return json({ error: 'Invalid repository or model' }, 400);
        const [owner, repo] = body.repo.split('/');
        const revision=await github('/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repo)+'/commits/'+encodeURIComponent(body.ref),auth.token);
        if(!revision.ok)return json({error:'Could not resolve repository revision'},502);
        const {sha}=await revision.json();
        if(!/^[a-f0-9]{40}$/.test(sha))return json({error:'Invalid repository revision'},502);
        const archive = await github(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${sha}`, auth.token);
        if (!archive.ok || !archive.body) return json({ error: 'Could not download repository from GitHub' }, 502);
        const length = Number(archive.headers.get('Content-Length') || 0);
        if (length > MAX_ARCHIVE) { await archive.body.cancel(); return json({ error: 'Repository archive is larger than 50 MB' }, 413); }
        let received = 0;
        const limitedBody = archive.body.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > MAX_ARCHIVE) throw new Error('Repository archive is larger than 50 MB');
            controller.enqueue(chunk);
          }
        }));
        const id = crypto.randomUUID();
        const object = env.PROBE.getByName(`code:${auth.user.id}:${id}`);
        const initialized = await object.fetch('https://internal/session/init', { method: 'POST', headers: { 'X-Arno-Repo': body.repo, 'X-Arno-Ref': body.ref, 'X-Arno-Model': body.model,'X-Arno-Sha':sha,'X-Arno-Owner':String(auth.user.id) }, body: limitedBody });
        const result = await initialized.json();
        if (!initialized.ok) return json({ error: result.error || 'Could not create workspace' }, initialized.status);
        await env.PROBE.getByName('index:'+auth.user.id).fetch('https://internal/index/add', {method:'POST', body:JSON.stringify({id,...result})});
        return json({ id, ...result }, 201);
      }
      const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/messages$/);
      const jobMatch=url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/job$/);
      if(jobMatch && request.method==='GET')return env.PROBE.getByName('code:'+auth.user.id+':'+jobMatch[1]).fetch('https://internal/session/job');
      const eventsMatch=url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/events$/);
      if(eventsMatch&&request.method==='GET')return env.PROBE.getByName('code:'+auth.user.id+':'+eventsMatch[1]).fetch('https://internal/session/events');
      if (match && request.method === 'POST') {
        const body = await boundedJson(request);
        const object = env.PROBE.getByName(`code:${auth.user.id}:${match[1]}`);
        await object.fetch('https://internal/session/owner',{method:'POST',body:JSON.stringify({ownerId:auth.user.id})});
        const response = await object.fetch('https://internal/session/enqueue', { method: 'POST', body: JSON.stringify(body) });
        return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json', ...SECURITY } });
      }
      return new Response('Not found', { status: 404, headers: SECURITY });
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_error', path: url.pathname, error: String(error) }));
      const message=String(error.message||error);
      return json({ error:message.startsWith('GitHub rejected publishing')?message:'Request failed' }, 500);
    }
  }
};

