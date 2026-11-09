/** Browser application. Server state is authoritative; view generation tokens
 * prevent old async responses from repainting a newly selected session.
 * Job polling survives mobile disconnects and never resubmits automatically.
 */
export const CLIENT=String.raw`
const $=s=>document.querySelector(s),shell=$('#shell'),main=$('#main'),composer=$('#composer-wrap'),prompt=$('#prompt');
const state={session:null,sessions:[],models:[],user:null,busy:false,generation:0,search:0,job:null,modelTarget:null};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={plus:'M12 5v14M5 12h14',menu:'M4 6h16M4 12h16M4 18h16',arrow:'M12 19V5M5 12l7-7 7 7',chevron:'m9 5 7 7-7 7',branch:'M6 3v12a3 3 0 0 0 6 0V9a3 3 0 0 1 3-3h3M3 6h6',search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',chart:'M4 20h16M7 16V9M12 16V4M17 16v-5',copy:'M9 9h11v11H9zM4 15H2V2h13v2',check:'m5 12 4 4L19 6',sun:'M12 3v2M12 19v2M3 12h2M19 12h2M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',close:'m6 6 12 12M6 18 18 6',code:'m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',download:'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',clock:'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',repo:'M4 4h15v17H4zM4 17h15M8 4v9',logout:'M9 4H3v16h6m6-5 4-3-4-3m-6 3h10'};
function icon(name){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(paths[name]||paths.code)+'"/></svg>'}
function num(n){return typeof n==='number'?n.toLocaleString():'—'}
function duration(ms){if(ms==null)return '—';return ms<1000?Math.round(ms)+' ms':ms<60000?(ms/1000).toFixed(1)+' s':Math.floor(ms/60000)+'m '+Math.round(ms%60000/1000)+'s'}
function modelName(id){return state.models.find(m=>m.id===id)?.name||id||'Choose model'}
function date(ms){return ms?new Date(ms).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'Saved session'}
async function api(path,opt={}){
 const r=await fetch(path,{...opt,headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(path==='/api/sessions'&&opt.method==='POST'?180000:25000)});
 let d;try{d=await r.json()}catch{throw Error('The server could not complete this request. Please try again.')}
 if(!r.ok)throw Error(d.error||'Request failed');return d;
}
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,4000)}
function showError(e){toast(e.message||String(e))}
function fit(){const v=window.visualViewport;shell.style.height=(v?v.height:innerHeight)+'px';shell.style.top=(v?v.offsetTop:0)+'px';const d=$('#account-dialog');if(d){d.style.height=d.open&&innerWidth<=800?(v?v.height:innerHeight)+'px':'';d.style.top=d.open&&innerWidth<=800?(v?v.offsetTop:0)+'px':''}const code=$('#code-dialog');if(code?.open){const dock=innerWidth>=1600;if(dock!==document.body.classList.contains('code-open')){code.close();if(dock)code.show();else code.showModal();document.body.classList.toggle('code-open',dock)}}}
window.visualViewport?.addEventListener('resize',fit);window.visualViewport?.addEventListener('scroll',fit);window.addEventListener('resize',fit);fit();
function drawer(open){shell.classList.toggle('drawer-open',open);$('#menu').setAttribute('aria-expanded',String(open))}
function busy(value){state.busy=value;$('#send').disabled=value;$('#stop').hidden=!value;$('#model-button').disabled=value;$('#home-model')?.toggleAttribute('disabled',value);$('#send').innerHTML=value?(state.session?.kind==='chat'?($('#live-response .prose')?.textContent?'Responding…':'Thinking…'):'<span class="spinner"></span> Working'):icon('arrow')+'<span>Send</span>'}
function title(name,subtitle){$('#title').textContent=name;$('#subtitle').textContent=subtitle;$('#workspace-pill').hidden=!state.session||state.session.kind==='chat';$('#workspace-label').textContent=state.session?.workspaceState==='warm'?'Workspace warm':'Workspace saved'}
function sidebar(){
 $('#account').textContent=state.user?.login||'Guest';$('#account-avatar').textContent=(state.user?.login||'A').slice(0,2).toUpperCase();
 $('#session-list').innerHTML=state.sessions.length?state.sessions.map(s=>'<div class="session-row"><button class="session-item '+(s.id===state.session?.id?'active':'')+'" data-session="'+esc(s.id)+'"><strong>'+esc(s.title||s.repo)+'</strong><small>'+esc(s.kind==='chat'?'Plain chat':s.ref||'main')+' · '+date(s.createdAt)+'</small></button><button class="session-more" type="button" data-session-menu="'+esc(s.id)+'" aria-label="Conversation actions for '+esc(s.title||s.repo)+'">⋯</button></div>').join(''):'<div class="empty caption">Your coding sessions will appear here.</div>';
}
async function loadModels(){try{const d=await api('/api/models');state.models=d.models;state.fallback=d.fallback;if(d.fallback)toast('Live model catalog unavailable. Showing saved models.')}catch{state.models=[{id:'mistral-large-4:cloud',name:'Mistral Large 4 · Le Chonk'}]}}
function modelButton(){const id=state.session?.model||state.selectedModel||'mistral-large-4:cloud';$('#model-button').innerHTML=icon('code')+'<span>'+esc(modelName(id))+'</span><span aria-hidden="true">⌄</span>'}
function openModels(target){
 if(state.busy)return;state.modelTarget=target;$('#model-search').value='';renderModels();$('#model-dialog').showModal();$('#model-search').focus();
}
function renderModels(){
 const q=$('#model-search').value.toLowerCase(),current=state.session?.model||state.selectedModel||'mistral-large-4:cloud';
 const models=state.models.some(m=>m.id===current)?state.models:[{id:current,name:current},...state.models];
 $('#model-options').innerHTML=models.filter(m=>(m.id+' '+m.name).toLowerCase().includes(q)).map(m=>'<button class="model-option '+(m.id===current?'selected':'')+'" data-model="'+esc(m.id)+'"><span>'+esc(m.name)+'</span>'+(m.id===current?icon('check'):'')+'</button>').join('')||'<p class="empty">No matching models.</p>';
}
async function chooseModel(id){
 $('#model-dialog').close();
 if(!state.session){state.selectedModel=id;$('#home-model').innerHTML=icon('code')+esc(modelName(id));return}
 const sid=state.session.id;busy(true);toast('Saving model selection…');
 try{const d=await api('/api/sessions/'+sid+'/model',{method:'POST',body:JSON.stringify({model:id})});if(state.session?.id===sid){state.session.model=d.model;modelButton();toast('Model updated for the next turn')}}catch(e){showError(e)}finally{busy(false)}
}
function diffCounts(diff){const lines=(diff||'').split('\n');return {add:lines.filter(l=>l.startsWith('+')&&!l.startsWith('+++')).length,remove:lines.filter(l=>l.startsWith('-')&&!l.startsWith('---')).length,files:lines.filter(l=>l.startsWith('diff --git')).length}}
function message(role,text,result={}){
 const node=document.createElement('article');node.className='turn '+(role==='You'?'user':'assistant');
 const stamp=result.at?new Date(result.at).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}):'';
 node.innerHTML='<div class="turn-header"><div class="avatar">'+(role==='You'?esc((state.user?.login||'Y').slice(0,1).toUpperCase()):'a')+'</div><strong>'+role+'</strong>'+(role==='Arno'?'<small>'+esc(modelName(result.model||state.session?.model))+'</small>':'')+'<span class="spacer"></span><small>'+stamp+'</small></div>';
 if(role==='You'){
  node.innerHTML+='<div class="user-content">'+esc(text)+'</div>';if(result.at)node.dataset.at=result.at;
  if(state.session?.kind==='chat'){node.querySelector('.spacer').insertAdjacentHTML('afterend','<button type="button" class="edit-message">Edit</button>');node.querySelector('.edit-message').onclick=()=>editMessage(node,text)}
 }
 else {
  const cleaned=cleanOutput(text);
  if(result.reasoning)node.innerHTML+='<details class="model-thinking"><summary>Thinking <span>Provided by the model</span></summary><div class="thinking-text">'+esc(result.reasoning)+'</div></details>';
  node.innerHTML+='<div class="prose">'+markdown(cleaned||'Task finished without a text response.',result.sources||[])+'</div>';
  node._sources=result.sources||[];
  if(node._sources.length)node.innerHTML+='<div class="source-strip">'+node._sources.slice(0,3).map(s=>'<button class="source-card" type="button" data-citation="'+s.id+'"><span class="source-domain">'+esc(sourceDomain(s.url))+' <b>'+s.id+'</b></span><strong>'+esc(s.title||s.url)+'</strong></button>').join('')+(node._sources.length>3?'<button class="source-card" data-all-sources>View all '+node._sources.length+' sources</button>':'')+'</div>';
  const u=result.usage,t=result.timing,counts=diffCounts(result.diff);
  node.innerHTML+='<div class="turn-footer"><span>'+icon('check')+' '+(result.exitCode?'Finished with errors':'Completed')+'</span>'+(t?'<span>'+duration(t.totalMs)+'</span>':'')+(u?.measuredCalls?'<span>'+num((u.inputTokens||0)+(u.outputTokens||0))+' tokens</span>':'')+(u?.cost!=null?'<span>'+money(u.cost)+'</span>':'')+'<button type="button" class="copy-answer" aria-label="Copy answer">'+icon('copy')+' Copy</button></div>';
  if(result.diff)node.innerHTML+='<details class="details"><summary>'+counts.files+' changed file'+(counts.files===1?'':'s')+' <span class="tag">+'+counts.add+' −'+counts.remove+'</span></summary><div class="diff-view">'+diffHtml(result.diff)+'</div></details>';
  if(result.diagnostics||cleaned!==String(text||'').trim())node.innerHTML+='<details class="details"><summary>Execution details</summary><pre>'+esc((result.diagnostics||'')+'\n'+text)+'</pre></details>';
  node.querySelector('.copy-answer').onclick=()=>copy(cleaned);
 }
 $('#thread').append(node);scrollDown();return node;
}
// Follow the stream only while the reader is at the bottom: scrolling up stops
// following, scrolling back down (or sending) resumes it. Jumps are instant so
// a smooth scroll in progress never reads as the reader leaving the bottom.
let following=true;
main.addEventListener('scroll',()=>{following=main.scrollHeight-main.scrollTop-main.clientHeight<80},{passive:true});
function scrollDown(force=false){if(force)following=true;if(following)main.scrollTo({top:main.scrollHeight,behavior:'instant'})}
function sourceDomain(url){try{return new URL(url).hostname.replace(/^www\./,'')}catch{return 'Source'}}
function openSources(sources,id){
 const ordered=id?[...sources].sort((a,b)=>Number(b.id===id)-Number(a.id===id)):sources;
 $('#sources-body').innerHTML=ordered.map(s=>'<article class="source-preview"><div class="source-domain"><span class="source-number">'+s.id+'</span>'+esc(sourceDomain(s.url))+'</div><h3>'+esc(s.title||s.url)+'</h3><p>'+esc(s.excerpt||'Open the original page to read this source.')+'</p><a href="'+esc(s.url)+'" target="_blank" rel="noopener noreferrer">Read original source ↗</a><small class="caption">'+(s.retrievedAt?'Retrieved '+new Date(s.retrievedAt).toLocaleString():'')+'</small></article>').join('');
 $('#sources-dialog').showModal();
}
function suggestions(){
 if(state.session?.kind==='chat')return '<div class="starter"><div class="mark">a</div><h2>A little space to think.</h2><p class="muted">Chat with your cloud model. No repository, tools, or coding container needed.</p><div class="suggestions">'+['Help me brainstorm an idea','Explain something step by step','Help me write better','Let’s solve a problem together'].map(s=>'<button data-suggest="'+esc(s)+'">'+esc(s)+'</button>').join('')+'</div></div>';
 return '<div class="starter"><div class="mark">a</div><h2>What shall we build?</h2><p class="muted">Your repository is ready. Ask a question, make a change, or run a check.</p><div class="suggestions">'+['Explain this repository','Find bugs and suggest fixes','Run the tests and explain failures','Review the architecture'].map(s=>'<button data-suggest="'+esc(s)+'">'+icon('code')+esc(s)+'</button>').join('')+'</div></div>';
}
async function resume(id){
 $('#code-dialog').close();
 const gen=++state.generation;state.search++;drawer(false);composer.hidden=true;main.innerHTML='<div class="loading"><span class="spinner"></span><p>Opening saved workspace…</p></div>';
 try{
  const s=await api('/api/sessions/'+id);if(gen!==state.generation)return;
  state.session={id,...s};state.job=null;state.busy=false;sessionStorage.setItem('session',id);sidebar();
  $('.composer-hint').textContent=s.kind==='chat'?'⌘ / Ctrl + Enter to send · Conversations are saved automatically':'⌘ / Ctrl + Enter to send · Changes are saved after each turn';
  prompt.placeholder=s.kind==='chat'?'Message Arno…':'Ask Arno to build, fix, or explain…';
  $('#code').hidden=s.kind==='chat';$('#publish').hidden=s.kind==='chat';
  title(s.title||s.repo,s.kind==='chat'?'Private chat · No repository required':(s.ref||'main')+' · '+(s.sourceSha?s.sourceSha.slice(0,7)+' · ':'')+'GitHub workspace');
  main.innerHTML='<div class="thread"><div id="thread"></div></div>';
  if(!s.history?.length)$('#thread').innerHTML=suggestions();
  else for(const t of s.history){message('You',t.prompt,{at:t.at});message('Arno',t.summary,t)}
  composer.hidden=false;modelButton();busy(false);prompt.value=sessionStorage.getItem('draft:'+id)||'';resizePrompt();scrollDown(true);watchJob(id,gen);
 }catch(e){main.innerHTML='<div class="empty"><h2>Couldn’t open this session</h2><p>'+esc(e.message)+'</p><button id="retry-open">Try again</button></div>';$('#retry-open').onclick=()=>resume(id)}
}
function money(n){return n==null?'—':'$'+n.toFixed(n<0.01?4:2)}
function sessionStats(){return state.session?.stats||{turns:state.session?.history?.length||0,calls:null,inputTokens:null,outputTokens:null,measuredCalls:0,totalMs:null}}
async function newChat(){
 const model=state.session?.model||state.selectedModel||'mistral-large-4:cloud';
 try{const s=await api('/api/chats',{method:'POST',body:JSON.stringify({model})});state.sessions.unshift(s);await resume(s.id)}catch(e){showError(e)}
}
function openCode(tab='files'){
 if(!state.session||state.session.kind==='chat')return toast('Open a repository to browse its code');
 const dialog=$('#code-dialog');
 if(!dialog.open){if(innerWidth>=1600){dialog.show();document.body.classList.add('code-open')}else dialog.showModal()}
 if(tab==='diff'){
  const diff=state.session.history?.filter(t=>t.diff).at(-1)?.diff;
  $('#code-body').innerHTML=diff?'<div class="caption" style="padding:12px">Cumulative working-tree changes from the last completed turn</div><div class="diff-view panel-diff">'+diffHtml(diff)+'</div>':'<div class="empty">No recorded changes yet. Ask Arno to make a change first.</div>';
 }else browse('');
}
async function browse(path){
 if(!state.session)return;const id=state.session.id;
 $('#code-body').innerHTML='<div class="loading">Opening '+esc(path||'repository')+'…</div>';
 try{
  const d=await api('/api/sessions/'+id+'/files?path='+encodeURIComponent(path));if(state.session?.id!==id)return;
  const parts=path.split('/').filter(Boolean);let acc='';
  $('#code-body').innerHTML='<nav class="breadcrumbs"><button data-file="">Repository</button>'+parts.map(p=>{acc+=(acc?'/':'')+p;return '<span>/</span><button data-file="'+esc(acc)+'">'+esc(p)+'</button>'}).join('')+'</nav>';
  if(d.directory){
   $('#code-body').insertAdjacentHTML('beforeend','<div class="file-list">'+(path?'<button data-file="'+esc(parts.slice(0,-1).join('/'))+'">↰ Parent directory</button>':'')+d.entries.map(f=>'<button data-file="'+esc(f.path)+'">'+icon(f.directory?'repo':'code')+'<span>'+esc(f.name)+'</span>'+(f.directory?icon('chevron'):'')+'</button>').join('')+'</div>'+(d.truncated?'<p class="caption">Showing the first 300 entries.</p>':''));
  }else{
   const lines=d.content.split('\n');
   $('#code-body').insertAdjacentHTML('beforeend','<div class="codehead"><span>'+num(d.bytes)+' bytes · '+lines.length+' lines · read only</span><button id="copy-file">Copy file</button></div><div class="source-scroll"><ol class="source-lines">'+lines.map(line=>'<li><code>'+esc(line||' ')+'</code></li>').join('')+'</ol></div>');
   $('#copy-file').onclick=()=>copy(d.content);
  }
 }catch(e){$('#code-body').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
}
function openUsage(){
 const s=state.session,stats=sessionStats(),history=s?.history||[],last=history.at(-1);
 $('#usage-body').innerHTML='<div class="eyebrow">This session</div><h3>'+esc(s?.repo||s?.title||'No session selected')+'</h3><div class="stat-grid">'+[
  ['Completed turns',num(stats.turns)],['Model requests',num(stats.calls)],['Input tokens',stats.measuredCalls?num(stats.inputTokens):'—'],['Output tokens',stats.measuredCalls?num(stats.outputTokens):'—'],['Cost',stats.cost||stats.turns?money(stats.cost||0)+(stats.unpriced?' + '+num(stats.unpriced)+' unpriced':''):'—']
 ].map(([name,value])=>'<div class="metric"><b>'+value+'</b><span>'+name+'</span></div>').join('')+'</div><p class="caption">Tokens are reported by the selected provider. A dash means usage was not recorded. Historical turns may have incomplete usage. Cost uses each model’s list price on the day of the turn (Ollama’s pricing page; Anthropic and OpenAI via OpenRouter); unpriced turns used a model missing from those tables. Ollama’s off-peak rates apply to turns saved off-peak. Web searches are not included.</p>'+
 (last?.timing?'<div class="eyebrow">Last turn</div>'+[['Workspace',last.timing.workspace||'—'],['Preparation',duration(last.timing.startupMs)],['Agent execution',duration(last.timing.executionMs)],['Checkpoint',duration(last.timing.checkpointMs)],['Total',duration(last.timing.totalMs)]].map(([k,v])=>'<div class="timing-row"><span>'+k+'</span><strong>'+v+'</strong></div>').join(''):'<p class="caption">Timing measurements will appear after a new turn.</p>')+
 (s&&s.kind!=='chat'?'<div class="section-title"><h2>Repository identity</h2></div><p><a href="'+esc(s.remoteUrl||'https://github.com/'+s.repo)+'" target="_blank" rel="noopener noreferrer">'+esc(s.repo)+'</a></p><div class="timing-row"><span>Branch</span><strong>'+esc(s.ref||'main')+'</strong></div><div class="timing-row"><span>Source commit</span><strong>'+esc(s.sourceSha?.slice(0,12)||'Not recorded for this session')+'</strong></div><p class="caption">The workspace is imported from a GitHub snapshot. Git history and GitHub writes require the publishing workflow.</p>':'');
 $('#usage-dialog').showModal();
}
async function home(){
 $('#code-dialog').close();$('#code').hidden=false;$('#publish').hidden=false;
 const gen=++state.generation;state.search++;state.session=null;state.job=null;busy(false);drawer(false);composer.hidden=true;sessionStorage.removeItem('session');title('Your workspace','Build from wherever you are');sidebar();
 main.innerHTML='<div class="home"><div class="welcome"><div class="eyebrow">Arno / Remote coding</div><h1>Good ideas don’t wait<br>for a desk.</h1><p>Pick a repository. Start a conversation. Turn the next idea into working code.</p></div><div class="home-actions"><button class="primary" data-new-chat>＋ Start a regular chat</button><a class="caption" href="/auth/github?repos=1">Connect / refresh GitHub repository access ↗</a></div><div class="overview"><div class="metric"><b>'+state.sessions.length+'</b><span>Saved sessions</span></div><div class="metric"><b>'+state.models.length+'</b><span>Cloud models</span></div><div class="metric"><b>'+icon('check')+'</b><span>Persistent conversations</span></div></div><div class="section-title"><h2>Your repositories</h2><button id="home-model" class="ghost">'+icon('code')+esc(modelName(state.selectedModel||'mistral-large-4:cloud'))+'</button></div><div class="searchbox">'+icon('search')+'<input id="search" type="search" placeholder="Search all accessible repositories" aria-label="Search repositories" autocomplete="off"></div><div id="repo-progress" class="search-progress" role="status"></div><div id="repos" class="repo-grid"></div><div id="more-repos"></div></div>';
 let timer;$('#search').oninput=()=>{state.search++;clearTimeout(timer);$('#repo-progress').textContent='Searching…';timer=setTimeout(()=>searchRepos($('#search').value),250)};$('#home-model').onclick=()=>openModels('home');searchRepos('');
}
function repoCard(r){
 const node=document.createElement('div');node.className='repo-card';node.innerHTML='<div class="row">'+icon('repo')+' <span class="caption">'+esc(r.private?'Private':'Public')+(r.archived?' · Archived':'')+'</span></div><h3>'+esc(r.full_name)+'</h3><p>'+esc(r.description||'Open a workspace to explore this repository.')+'</p><div class="repo-foot"><span class="caption">'+esc(r.language||r.default_branch||'main')+'</span><button class="open-repo" aria-label="Open '+esc(r.full_name)+'">Open '+icon('chevron')+'</button></div>';node.querySelector('button').onclick=()=>openRepo(r);return node;
}
// Search advances until there are no GitHub pages left, even if early pages have
// zero matches. A generation token cancels stale queries without mixing results.
async function searchRepos(query){
 const version=++state.search,box=$('#repos'),progress=$('#repo-progress'),more=$('#more-repos');if(!box)return;box.innerHTML='';more.innerHTML='';let found=0,scanned=0;
 async function page(n){
  if(version!==state.search||!box.isConnected)return;
  progress.innerHTML='<span class="spinner"></span> '+(query?'Searching all repository pages':'Loading repositories')+'… '+(scanned?scanned+' checked · '+found+' matches':'');
  try{
   const d=await api('/api/repos?page='+n+'&q='+encodeURIComponent(query));if(version!==state.search||!box.isConnected)return;
   scanned+=d.scanned??100;
   for(const r of d.repos){box.append(repoCard(r));found++}
   if(d.nextPage){
    if(query){await page(d.nextPage)}
    else{progress.textContent=found+' repositories loaded · more available';const b=document.createElement('button');b.style.marginTop='20px';b.textContent='Load more repositories';b.onclick=()=>{b.remove();page(d.nextPage)};more.append(b)}
   }else{progress.textContent=query?'Search complete · '+found+' match'+(found===1?'':'es')+' across '+scanned+' visible repositories':found+' repositories visible to this GitHub connection';const access=document.createElement('div');access.className='access-notice';access.innerHTML='<strong>Missing repositories?</strong><p>'+esc(d.access?.privateAccess===false?'This connection does not have private-repository permission.':'GitHub returned '+scanned+' repositories for this connection. Private repositories and organizations may need renewed authorization or SSO approval.')+'</p><a href="/auth/github?repos=1">Reconnect GitHub with repository access ↗</a><p class="caption">'+esc(d.access?.scopes?'Granted scopes: '+d.access.scopes:'GitHub did not report scopes for this token.')+(d.access?.ssoRequired?' · Organization SSO authorization required.':'')+'</p>';access.insertAdjacentHTML('beforeend','<p class="caption">Using a GitHub App? <a href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">Manage installation repository access</a> and select all required repositories.</p>');more.append(access);if(!found)box.innerHTML='<div class="empty">No repositories match. Try an owner or a shorter name.</div>'}
  }catch(e){if(version!==state.search)return;progress.textContent='Search interrupted: '+e.message;const b=document.createElement('button');b.textContent='Continue search';b.onclick=()=>{b.remove();page(n)};more.append(b)}
 }
 await page(1);
}
async function openRepo(repo){
 state.search++;const gen=++state.generation;drawer(false);main.innerHTML='<div class="loading"><span class="spinner"></span><h3>Preparing '+esc(repo.full_name)+'</h3><p>Downloading the selected revision and saving its first checkpoint.<br>This setup happens once per new session.</p></div>';
 try{const s=await api('/api/sessions',{method:'POST',body:JSON.stringify({repo:repo.full_name,ref:repo.default_branch,model:state.selectedModel||'mistral-large-4:cloud'})});state.sessions.unshift({id:s.id,...s});if(gen===state.generation)await resume(s.id)}catch(e){if(gen===state.generation){main.innerHTML='<div class="empty"><h2>Workspace setup failed</h2><p>'+esc(e.message)+'</p><button id="back-home">Back to repositories</button></div>';$('#back-home').onclick=home}}
}
function activity(job){
 let node=$('#activity');if(!node){node=document.createElement('div');node.id='activity';node.className='activity';$('#thread').append(node)}
 if(state.session?.kind==='chat'){
  node.className='chat-activity';
  const label=job.stage==='searching'?'Searching the web':job.stage==='reading'?'Reading sources':job.stage==='saving'?'Saving response':$('#live-response .prose')?.textContent?'Responding':'Thinking';
  node.innerHTML='<div class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></div><span>'+label+'…</span>';
  scrollDown();return;
 }
 const stage=job.stage||'queued',order=['queued','preparing','thinking','checkpointing'],at=stage==='restoring'?1:Math.max(0,order.indexOf(stage));
 const labels={queued:'Task saved · waiting to start',preparing:'Preparing your warm workspace',restoring:'Restoring your saved workspace',thinking:'Arno is reading, reasoning, and working',checkpointing:'Saving your changes and conversation'};
 node.innerHTML='<div class="activity-top"><span class="spinner"></span><strong>'+esc(labels[stage]||'Working…')+'</strong><span class="spacer"></span><span class="caption">'+duration(Date.now()-(job.createdAt||Date.now()))+'</span></div><small>'+(stage==='restoring'?'Your existing workspace is being restored, not checked out again.':stage==='checkpointing'?'Your answer will appear when its workspace checkpoint is safely saved.':'This task continues if you close the page.')+'</small><div class="steps">'+order.map((s,i)=>'<span class="'+(i<=at?'done':'')+'"></span>').join('')+'</div>';scrollDown();
}
/** Live text is provisional until the durable result arrives. Native details
 * preserve keyboard accessibility and keep model thinking optional/collapsed.
 * Only the answer is rendered as Markdown; thinking is escaped plain text. */
function livePreview(preview){
 if(!preview||preview.jobId!==state.job?.id||!['queued','running'].includes(state.job.status)||(!preview.text&&!preview.reasoning))return;
 let node=$('#live-response');
 if(!node){node=document.createElement('article');node.id='live-response';node.className='turn assistant streaming';node.innerHTML='<div class="turn-header"><div class="avatar arno-avatar"></div><strong>Arno</strong><span class="caption live-label">Live response</span></div><details class="model-thinking"><summary>Thinking <span>Provided by the model</span></summary><div class="thinking-text"></div></details><div class="prose"></div><small class="caption live-pass"></small>';$('#thread').insertBefore(node,$('#activity'))}
 const round=Number(node.dataset.round||0),updatedAt=Number(node.dataset.updatedAt||0);
 if(preview.round<round||preview.round===round&&preview.updatedAt<=updatedAt)return;
 node.dataset.round=preview.round;node.dataset.updatedAt=preview.updatedAt;
 const thinking=node.querySelector('.model-thinking');thinking.hidden=!preview.reasoning;node.querySelector('.thinking-text').textContent=preview.reasoning||'';
 node.querySelector('.prose').innerHTML=markdown(preview.text||'');
 if(state.session?.kind==='chat'&&preview.text){const label=$('#activity > span');if(label)label.textContent='Responding…';$('#send').textContent='Responding…'}
 node.querySelector('.live-pass').textContent=state.session?.kind==='chat'?'Streaming · response not yet saved':'Model pass '+preview.round+' · workspace not yet saved';scrollDown();
}
function watchLive(id,gen){
 if(!window.EventSource)return ()=>{};
 const stream=new EventSource('/api/sessions/'+id+'/events');
 stream.addEventListener('preview',e=>{if(gen!==state.generation){stream.close();return}try{livePreview(JSON.parse(e.data))}catch{}});
 // EventSource reconnects itself. Polling below remains the fallback and source
 // of truth for final results, errors, cancellation, and workspace checkpoints.
 return ()=>stream.close();
}
// Poll durable task state. expected is an idempotency record for a new send;
// without it, resume only follows an active job and avoids duplicate old answers.
async function watchJob(id,gen,expected){
 let active=false,stopLive;
 try{
  for(let attempt=0;attempt<240&&gen===state.generation;attempt++){
   let job;try{job=await api('/api/sessions/'+id+'/job')}catch{
    if(gen!==state.generation)return;busy(true);if(!$('#activity'))activity({stage:'queued'});const label=$('#activity strong')||$('#activity span');if(label)label.textContent='Connection interrupted · reconnecting';await new Promise(r=>setTimeout(r,3000));continue;
   }
   if(gen!==state.generation)return;
   if(!expected&&!active&&!['queued','running'].includes(job.status))return;
   if(expected&&job.status==='idle'){toast('Message was not received. Your draft has been restored.');prompt.value=expected.prompt;return}
   if(expected&&job.id!==expected.id)return;
   if(!active&&!expected&&job.prompt)message('You',job.prompt);active=true;state.job=job;
   if(job.status==='completed'||job.status==='failed'||job.status==='cancelled'){
    stopLive?.();$('#activity')?.remove();$('#live-response')?.remove();
    if(job.status==='completed'){message('Arno',job.result.summary,{...job.result,at:job.finishedAt});const updated=await api('/api/sessions/'+id);if(gen===state.generation){state.session={id,...updated};const asked=[...document.querySelectorAll('#thread .turn.user')].at(-1),saved=updated.history?.at(-1)?.at;if(asked&&saved)asked.dataset.at=saved;state.sessions=state.sessions.map(s=>s.id===id?{...s,...updated}:s);sidebar();title(updated.title||updated.repo,updated.kind==='chat'?'Private chat · Web research enabled':(updated.ref||'main')+' · GitHub workspace')}toast(state.session?.kind==='chat'?'Response saved':'Turn complete · workspace saved')}
    else{const node=document.createElement('div');node.className='banner';node.textContent=job.status==='cancelled'?'Task stopped. The next turn restores the last completed checkpoint.':job.result?.error||'Task failed. Your previous checkpoint is preserved.';$('#thread').append(node);prompt.value=job.prompt||'';toast(job.status==='cancelled'?'Task stopped':'Task failed. Review the error and retry when ready.')}
    return;
   }
   busy(true);activity(job);if(!stopLive)stopLive=watchLive(id,gen);livePreview(job.preview);await new Promise(r=>setTimeout(r,2000));
  }
  if(gen===state.generation)toast('Task is still saved. Reopen the session to check its status.');
 }catch(e){showError(e)}
 finally{stopLive?.();if(gen===state.generation){busy(false);state.job=null}}
}
async function submit(e){
 e.preventDefault();if(!state.session||state.busy||!prompt.value.trim())return;
 const text=prompt.value.trim();prompt.value='';resizePrompt();sessionStorage.removeItem('draft:'+state.session.id);await send(text);
}
/** Edit a saved chat message in place; sending replaces it and every later turn. */
function editMessage(node,text){
 if(state.busy)return toast('Wait for the current turn to finish');
 const at=Number(node.dataset.at);if(!at)return toast('This message can be edited once its answer is saved');
 const box=node.querySelector('.user-content');box.innerHTML='<textarea class="edit-box" rows="3"></textarea><div class="edit-actions"><button type="button">Cancel</button><button type="button" class="primary">Send</button></div>';
 const area=box.querySelector('textarea');area.value=text;area.focus();
 const [cancel,save]=box.querySelectorAll('button');
 cancel.onclick=()=>{box.textContent=text};
 save.onclick=()=>{const v=area.value.trim();if(!v||state.busy)return;while(node.nextSibling)node.nextSibling.remove();node.remove();send(v,at)};
}
async function send(text,editAt){
 const id=state.session.id,gen=state.generation,body={id:crypto.randomUUID(),prompt:text,...(editAt?{editAt}:{})};
 $('#thread .starter')?.remove();message('You',body.prompt);busy(true);activity({stage:'queued',createdAt:Date.now()});scrollDown(true);
 try{await api('/api/sessions/'+id+'/messages',{method:'POST',body:JSON.stringify(body)})}catch{toast('Checking whether your message was saved…')}
 await watchJob(id,gen,body);
}
function resizePrompt(){prompt.style.height='auto';prompt.style.height=Math.min(prompt.scrollHeight,innerWidth<800?105:150)+'px'}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('Copied to clipboard')}catch{toast('Clipboard unavailable in this browser')}}
function exportChat(){
 if(!state.session)return toast('Open a session first');
 const text='# '+state.session.repo+'\n\n'+(state.session.history||[]).map(t=>'## You\n\n'+t.prompt+'\n\n## Arno · '+(t.model||state.session.model)+'\n\n'+cleanOutput(t.summary)).join('\n\n');
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/markdown'}));a.download=state.session.repo.replace('/','-')+'-chat.md';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
// The digest binds the action to reviewed file contents. The server re-exports
// and rechecks it; a model edit between review and click cannot be published.
async function reviewPublish(){
 if(!state.session||state.session.kind==='chat'||state.busy)return toast('Open an idle coding session first');
 $('#publish-body').innerHTML='<p class="muted">Reading your working tree…</p>';$('#publish-dialog').showModal();
 try{
  const id=state.session.id,d=await api('/api/sessions/'+id+'/changes');
  $('#publish-body').innerHTML='<p>Create a new branch and pull request in <strong>'+esc(d.repo)+'</strong>.</p><p class="caption">Base: '+esc(d.ref)+' · '+esc(d.sourceSha.slice(0,7))+'</p><div class="publish-files">'+d.files.map(f=>'<details class="details" style="margin-left:0"><summary>'+esc(f.path)+' <span class="tag">'+(f.deleted?'deleted':num(f.bytes)+' bytes')+'</span></summary><pre>'+esc(f.deleted?'This file will be deleted.':f.content||'')+'</pre></details>').join('')+'</div><label class="caption">Branch<input id="publish-branch" value="arno/change-'+Date.now().toString(36)+'" class="field"></label><label class="caption">Commit and pull request title<input id="publish-title" maxlength="200" placeholder="Describe this change" class="field"></label><p class="caption">This creates a new GitHub branch. Review the diff in the conversation before publishing.</p><button id="publish-confirm" class="primary">Create branch & pull request</button><p id="publish-status" role="status"></p>';
  $('#publish-confirm').onclick=async()=>{
   const b=$('#publish-confirm');b.disabled=true;$('#publish-status').textContent='Publishing reviewed changes…';
   try{const r=await api('/api/sessions/'+id+'/publish',{method:'POST',body:JSON.stringify({digest:d.digest,branch:$('#publish-branch').value,title:$('#publish-title').value})});$('#publish-status').innerHTML='<a target="_blank" rel="noopener noreferrer" href="'+esc(r.url)+'">Open on GitHub ↗</a>'+(r.warning?'<p>'+esc(r.warning)+'</p>':'');toast('Branch and commit created')}
   catch(e){$('#publish-status').textContent=e.message;b.disabled=false}
  };
 }catch(e){$('#publish-body').innerHTML='<p class="banner">'+esc(e.message)+'</p>'}
}
async function renameConversation(id=state.session?.id){
 const target=state.sessions.find(s=>s.id===id)||state.session;if(!id||!target)return toast('Choose a conversation first');
 $('#actions-dialog').close();$('#conversation-dialog').close();const value=window.prompt('Conversation name',target.title||target.repo);
 if(value==null||!value.trim())return;
 try{
  const d=await api('/api/sessions/'+id,{method:'PATCH',body:JSON.stringify({title:value.trim()})});
  if(state.session?.id===id){state.session={...state.session,...d};title(d.title,state.session.kind==='chat'?'Private chat · No repository required':(d.ref||'main')+' · '+d.repo)}
  state.sessions=state.sessions.map(s=>s.id===id?{...s,...d}:s);sidebar();toast('Conversation renamed');
 }catch(e){showError(e)}
}
async function deleteConversation(id=state.session?.id){
 if(!id)return toast('Choose a conversation first');
 if(state.busy&&state.session?.id===id)return toast('Stop the active task before deleting this conversation');
 if(!confirm('Delete this conversation and its saved workspace? This cannot be undone.'))return;
 try{
  await api('/api/sessions/'+id,{method:'DELETE'});state.sessions=state.sessions.filter(s=>s.id!==id);$('#actions-dialog').close();$('#conversation-dialog').close();if(state.session?.id===id)await home();else sidebar();toast('Conversation deleted');
 }catch(e){showError(e)}
}
function theme(){document.body.classList.toggle('light');localStorage.setItem('theme',document.body.classList.contains('light')?'light':'dark')}
if(localStorage.getItem('theme')==='light')document.body.classList.add('light');
$('#menu').onclick=()=>drawer(true);$('#overlay').onclick=()=>drawer(false);$('#new-session').onclick=home;$('#theme').onclick=theme;$('#usage').onclick=openUsage;$('#export').onclick=exportChat;$('#model-button').onclick=()=>openModels('session');$('#model-search').oninput=renderModels;$('#composer').onsubmit=submit;
$('#publish').onclick=reviewPublish;$('#new-chat').onclick=newChat;
$('#rename-conversation').onclick=()=>renameConversation();$('#delete-conversation').onclick=()=>deleteConversation();
$('#list-rename').onclick=()=>renameConversation(state.menuTarget);$('#list-delete').onclick=()=>deleteConversation(state.menuTarget);
$('#code').onclick=()=>openCode();$('#files-tab').onclick=()=>openCode('files');$('#diff-tab').onclick=()=>openCode('diff');
$('#code-dialog').addEventListener('close',()=>{if(!$('#code-dialog').open)document.body.classList.remove('code-open')});
$('#actions').onclick=()=>$('#actions-dialog').showModal();
for(const id of ['export','publish']){const b=$('#'+id);b.className='model-option';b.innerHTML=id==='export'?'Export conversation as Markdown':'Review changes & publish to GitHub';$('#action-items').append(b)}
$('#stop').onclick=async()=>{if(!state.session||!confirm(state.session.kind==='chat'?'Stop this response? It will not be added to the conversation.':'Stop this task? Work since the last completed checkpoint will be discarded.'))return;try{await api('/api/sessions/'+state.session.id+'/cancel',{method:'POST',body:'{}'});toast('Stopping…')}catch(e){showError(e)}};
prompt.oninput=()=>{resizePrompt();if(state.session)sessionStorage.setItem('draft:'+state.session.id,prompt.value)};
prompt.onkeydown=e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();$('#composer').requestSubmit()}};
document.addEventListener('keydown',e=>{if(e.key==='Escape')drawer(false);if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();if(state.session)openModels('session');else $('#search')?.focus()}});
document.addEventListener('click',e=>{
 const session=e.target.closest('[data-session]');if(session)resume(session.dataset.session);
 const sessionMenu=e.target.closest('[data-session-menu]');if(sessionMenu){state.menuTarget=sessionMenu.dataset.sessionMenu;const row=state.sessions.find(s=>s.id===state.menuTarget);$('#conversation-menu-heading').textContent=row?.title||row?.repo||'Conversation';$('#conversation-dialog').showModal()}
 const model=e.target.closest('[data-model]');if(model)chooseModel(model.dataset.model);
 const file=e.target.closest('[data-file]');if(file)browse(file.dataset.file);
 const citation=e.target.closest('[data-citation]');if(citation)openSources(citation.closest('.turn')._sources||[],Number(citation.dataset.citation));
 const allSources=e.target.closest('[data-all-sources]');if(allSources)openSources(allSources.closest('.turn')._sources||[]);
 const suggestion=e.target.closest('[data-suggest]');if(suggestion){prompt.value=suggestion.dataset.suggest;resizePrompt();prompt.focus()}
 if(e.target.closest('[data-new-chat]'))newChat();
 const close=e.target.closest('[data-close]');if(close)close.closest('dialog').close();
 const code=e.target.closest('.copy-code');if(code)copy(code.closest('.codeblock').querySelector('code').textContent);
});
async function boot(){
 try{
  const d=await api('/api/me');state.user=d.user;state.githubConnected=d.githubConnected;
  if(!state.user){title('Welcome to Arno','Your code, wherever you are');sidebar();main.innerHTML='<div class="home"><div class="starter"><div class="mark">a</div><h1>Your next commit<br>starts with a conversation.</h1><p class="muted">A quiet workspace for ambitious ideas. Connect GitHub, choose a model, and build from your phone.</p><p><a class="primary" style="display:inline-block;padding:12px 20px;border-radius:10px" href="/auth/github">Continue with GitHub →</a></p><p class="caption">Powered by Arno · Ollama Cloud · Cloudflare</p></div></div>';return}
  await Promise.all([loadModels(),api('/api/sessions').then(d=>state.sessions=d.sessions)]);sidebar();
  const saved=sessionStorage.getItem('session');if(saved)await resume(saved);else await home();
 }catch(e){main.innerHTML='<div class="empty"><h2>Connection unavailable</h2><p>'+esc(e.message)+'</p><button onclick="location.reload()">Reload</button></div>'}
}
for(const [id,name] of [['menu','menu'],['theme','sun'],['usage','chart'],['code','code']])$('#'+id).innerHTML=icon(name);
$('#new-session').innerHTML=icon('plus')+' New session';
boot();
`;
