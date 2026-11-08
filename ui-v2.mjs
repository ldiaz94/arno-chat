export const HTML=String.raw`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Arno Chat</title><style>
*{box-sizing:border-box;min-width:0}html,body{margin:0;width:100%;overflow:hidden;background:#0b0d0c;color:#edf2ed;font:16px/1.5 system-ui}#shell{position:fixed;top:0;left:0;width:100%;height:100dvh;display:flex;flex-direction:column;padding:env(safe-area-inset-top) 12px env(safe-area-inset-bottom)}header{padding:12px 0;display:flex;gap:15px;align-items:center;border-bottom:1px solid #333}header strong{flex:1}main{flex:1;overflow:auto;overflow-x:hidden;overflow-wrap:anywhere;padding:10px 0}button,select,input,textarea{font:inherit;font-size:16px;min-height:44px;max-width:100%;background:#171d17;border:1px solid #394339;color:inherit;border-radius:8px;padding:9px}button{cursor:pointer}button:disabled{opacity:.5}a{color:#c5f36c}form{display:flex;gap:8px;padding:10px 0;align-items:flex-end;flex-shrink:0}form[hidden]{display:none}textarea{flex:1;resize:none;max-height:100px}.message{white-space:pre-wrap;overflow-wrap:anywhere;border-left:2px solid #394339;padding:10px;margin:12px 0}.user{border-color:#c5f36c}.muted{color:#a0aaa0}.error{color:#ffaaa0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 monospace;max-width:100%}.repo{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid #333}.repo span{flex:1}#search{width:100%}label{display:block;margin:12px 0}@media(min-width:800px){#shell{width:800px;left:calc((100vw - 800px)/2)}}
</style></head><body><div id="shell"><header><strong>ARNO CHAT</strong><button id="home">Sessions</button><a href="/auth/logout">Sign out</a></header><main id="app">Loading…</main><form id="composer" hidden><textarea id="prompt" rows="1" maxlength="8000" placeholder="Ask Arno…" aria-label="Message"></textarea><button id="send">Run</button></form></div><script type="module">
const $=s=>document.querySelector(s),app=$('#app'),form=$('#composer'),prompt=$('#prompt');let session=null,version=0;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{'Content-Type':'application/json'}});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
function fit(){const v=window.visualViewport;$('#shell').style.height=(v?v.height:innerHeight)+'px';$('#shell').style.top=(v?v.offsetTop:0)+'px'}window.visualViewport?.addEventListener('resize',fit);window.visualViewport?.addEventListener('scroll',fit);window.addEventListener('resize',fit);fit();
function error(e){app.insertAdjacentHTML('beforeend','<p class="error">'+esc(e.message)+'</p>')}
async function modelPicker(select,id){
 const current=id?session.model:'mistral-large-4:cloud';
 try{
  const d=await api('/api/models');
  if(!select.isConnected)return;
  const models=d.models.some(m=>m.id===current)?d.models:[{id:current,name:current},...d.models];
  select.innerHTML=models.map(m=>'<option value="'+esc(m.id)+'">'+esc(m.name)+'</option>').join('');
  select.value=current;
  if(d.fallback)select.insertAdjacentHTML('afterend','<small class="muted">Catalog unavailable; showing saved models.</small>');
  if(id)select.onchange=async()=>{
   const old=session.model;select.disabled=true;$('#send').disabled=true;
   try{const r=await api('/api/sessions/'+id+'/model',{method:'POST',body:JSON.stringify({model:select.value})});session.model=r.model}
   catch(e){select.value=old;error(e)}
   finally{select.disabled=false;$('#send').disabled=false}
  };
 }catch(e){error(e)}
}
new MutationObserver(()=>{
 for(const select of document.querySelectorAll('select:not([data-loaded])')){
  select.dataset.loaded='true';modelPicker(select,select.id==='session-model'?session?.id:null);
 }
}).observe(app,{childList:true,subtree:true});
function message(role,text,diff){app.insertAdjacentHTML('beforeend','<div class="message '+(role==='You'?'user':'')+'"><strong>'+role+'</strong>\n'+esc(text)+(diff?'<details><summary>Working tree diff</summary><pre>'+esc(diff)+'</pre></details>':'')+'</div>');app.scrollTop=app.scrollHeight}
async function resume(id){version++;form.hidden=true;app.textContent='Loading saved session…';try{session={id,...await api('/api/sessions/'+id)};sessionStorage.setItem('session',id);app.innerHTML='<p>'+esc(session.repo)+'</p><label>Model <select id="session-model" aria-label="Session model"><option>'+esc(session.model)+'</option></select></label>';for(const t of session.history||[]){message('You',t.prompt);message('Arno · '+esc(t.model||session.model),t.summary,t.diff)}form.hidden=false;watchJob(id)}catch(e){error(e)}}
function repoRow(r,box){const row=document.createElement('div');row.className='repo';row.innerHTML='<span>'+esc(r.full_name)+'<br><small class="muted">'+(r.private?'private':'public')+'</small></span><button>Open</button>';row.querySelector('button').onclick=()=>openRepo(r);box.append(row)}
async function pageRepos(q,page,box,v){try{const d=await api('/api/repos?page='+page+'&q='+encodeURIComponent(q));if(v!==version||!box.isConnected)return;for(const r of d.repos)repoRow(r,box);if(d.nextPage){if(q){await pageRepos(q,d.nextPage,box,v)}else{const b=document.createElement('button');b.textContent='Load more repositories';b.onclick=()=>{b.remove();pageRepos(q,d.nextPage,box,v)};box.append(b)}}else if(!box.children.length)box.textContent='No matching repositories.'}catch(e){if(v===version)box.textContent=e.message}}
function search(q){const v=++version,box=$('#repos');box.textContent='';pageRepos(q,1,box,v)}
async function home(){version++;session=null;form.hidden=true;sessionStorage.removeItem('session');app.textContent='Loading…';try{const me=await api('/api/me');if(!me.user){app.innerHTML='<p>Remote coding with Arno and Ollama Cloud.</p><a href="/auth/github">Continue with GitHub</a>';return}const d=await api('/api/sessions');app.innerHTML='<h2>Recent sessions</h2><div id="sessions"></div><h2>Open repository</h2><label>Model <select id="model"><option>mistral-large-4:cloud</option><option>devstral-2:123b-cloud</option><option>qwen3-coder:480b-cloud</option></select></label><input id="search" type="search" placeholder="Search all accessible repositories" aria-label="Search repositories"><div id="repos"></div>';for(const s of d.sessions){const b=document.createElement('button');b.textContent=s.repo;b.onclick=()=>resume(s.id);$('#sessions').append(b)}let timer;$('#search').oninput=()=>{version++;clearTimeout(timer);timer=setTimeout(()=>search($('#search').value),300)};search('')}catch(e){error(e)}}
async function openRepo(r){const model=$('#model').value;version++;app.textContent='Preparing workspace and saving checkpoint…';try{const s=await api('/api/sessions',{method:'POST',body:JSON.stringify({repo:r.full_name,ref:r.default_branch,model})});await resume(s.id)}catch(e){error(e)}}
function busy(value){$('#send').disabled=value;if($('#session-model'))$('#session-model').disabled=value}
async function watchJob(id,expected){
 const status=document.createElement('p');status.className='muted';let active=false;
 try{
  for(let attempts=0;attempts<200&&session?.id===id;attempts++){
   let job;
   try{job=await api('/api/sessions/'+id+'/job')}
   catch{if(!active){app.append(status);active=true}busy(true);status.textContent='Connection interrupted. Reconnecting to your saved task…';await new Promise(r=>setTimeout(r,3000));continue}
   if(!expected&&!['queued','running'].includes(job.status))return;
   if(job.status==='idle'){status.textContent='The message was not received. Please submit it again.';app.append(status);prompt.value=expected?.prompt||'';return}
   if(expected&&job.id!==expected.id)return;
   if(!active){app.append(status);active=true}
   if(job.status==='completed'){message('Arno · '+esc(job.result.model||session.model),job.result.summary,job.result.diff);status.remove();return}
   if(job.status==='failed'){status.textContent=job.result?.error||'Task failed. You can retry.';status.className='error';return}
   busy(true);status.textContent=job.status==='queued'?'Task saved. Starting Arno…':'Arno is working. You can leave and reopen this session.';
   await new Promise(r=>setTimeout(r,3000));
  }
  if(session?.id===id)status.textContent='Still waiting. Reopen this session to check the saved task.';
 }finally{if(session?.id===id)busy(false)}
}
form.onsubmit=async e=>{e.preventDefault();const text=prompt.value.trim();if(!text||!session||$('#send').disabled)return;const id=session.id,body={id:crypto.randomUUID(),prompt:text};message('You',text);prompt.value='';busy(true);try{await api('/api/sessions/'+id+'/messages',{method:'POST',body:JSON.stringify(body)})}catch(e){error({message:'Submission connection interrupted. Checking whether the task was saved…'})}await watchJob(id,body)};
prompt.oninput=()=>{prompt.style.height='auto';prompt.style.height=Math.min(prompt.scrollHeight,100)+'px'};$('#home').onclick=home;const saved=sessionStorage.getItem('session');if(saved)resume(saved);else home();
</script></body></html>`;
