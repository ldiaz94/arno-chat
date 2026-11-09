/** Sessions and the home page: open, create, list, search, export, rename and delete
 * conversations, and the usage dialog. Depends on core, layout, models, thread, turns and render.mjs.
 */
import { cleanOutput } from './render.mjs';
import {
  $,
  state,
  esc,
  icon,
  num,
  duration,
  modelName,
  api,
  toast,
  showError,
  money,
  main,
  composer,
  prompt,
} from './core.js';
import { drawer, busy, title, sidebar } from './layout.js';
import { modelButton, openModels } from './models.js';
import { message, failure, scrollDown, suggestions } from './thread.js';
import { watchJob, resizePrompt } from './turns.js';
export async function resume(id) {
  $('#code-dialog').close();
  const gen = ++state.generation;
  state.search++;
  drawer(false);
  composer.hidden = true;
  main.innerHTML =
    '<div class="loading"><span class="spinner"></span><p>Opening saved workspace…</p></div>';
  try {
    const s = await api('/api/sessions/' + id);
    if (gen !== state.generation) return;
    state.session = { id, ...s };
    state.job = null;
    state.busy = false;
    sessionStorage.setItem('session', id);
    sidebar();
    $('.composer-hint').textContent =
      s.kind === 'chat'
        ? '⌘ / Ctrl + Enter to send · Conversations are saved automatically'
        : '⌘ / Ctrl + Enter to send · Changes are saved after each turn';
    prompt.placeholder =
      s.kind === 'chat' ? 'Message Arno…' : 'Ask Arno to build, fix, or explain…';
    $('#code').hidden = s.kind === 'chat';
    $('#publish').hidden = s.kind === 'chat';
    title(
      s.title || s.repo,
      s.kind === 'chat'
        ? 'Private chat · No repository required'
        : (s.ref || 'main') +
            ' · ' +
            (s.sourceSha ? s.sourceSha.slice(0, 7) + ' · ' : '') +
            'GitHub workspace',
    );
    main.innerHTML = '<div class="thread"><div id="thread"></div></div>';
    if (!s.history?.length) $('#thread').innerHTML = suggestions();
    else
      for (const t of s.history) {
        message('You', t.prompt, { at: t.at });
        if (t.failed) failure(t.prompt, t.error, t.at);
        else message('Arno', t.summary, t);
      }
    composer.hidden = false;
    modelButton();
    busy(false);
    prompt.value = sessionStorage.getItem('draft:' + id) || '';
    resizePrompt();
    scrollDown(true);
    watchJob(id, gen);
  } catch (e) {
    main.innerHTML =
      '<div class="empty"><h2>Couldn’t open this session</h2><p>' +
      esc(e.message) +
      '</p><button id="retry-open">Try again</button></div>';
    $('#retry-open').onclick = () => resume(id);
  }
}
function sessionStats() {
  return (
    state.session?.stats || {
      turns: state.session?.history?.length || 0,
      calls: null,
      inputTokens: null,
      outputTokens: null,
      measuredCalls: 0,
      totalMs: null,
    }
  );
}
export async function newChat() {
  const model = state.session?.model || state.selectedModel || 'mistral-large-4:cloud';
  try {
    const s = await api('/api/chats', { method: 'POST', body: JSON.stringify({ model }) });
    state.sessions.unshift(s);
    await resume(s.id);
  } catch (e) {
    showError(e);
  }
}
export function openUsage() {
  const s = state.session,
    stats = sessionStats(),
    history = s?.history || [],
    last = history.at(-1);
  $('#usage-body').innerHTML =
    '<div class="eyebrow">This session</div><h3>' +
    esc(s?.repo || s?.title || 'No session selected') +
    '</h3><div class="stat-grid">' +
    [
      ['Completed turns', num(stats.turns)],
      ['Model requests', num(stats.calls)],
      ['Input tokens', stats.measuredCalls ? num(stats.inputTokens) : '—'],
      ['Output tokens', stats.measuredCalls ? num(stats.outputTokens) : '—'],
      [
        'Cost',
        stats.cost || stats.turns
          ? money(stats.cost || 0) +
            (stats.unpriced ? ' + ' + num(stats.unpriced) + ' unpriced' : '')
          : '—',
      ],
    ]
      .map(
        ([name, value]) =>
          '<div class="metric"><b>' + value + '</b><span>' + name + '</span></div>',
      )
      .join('') +
    '</div><p class="caption">Tokens are reported by the selected provider. A dash means usage was not recorded. Historical turns may have incomplete usage. Cost uses each model’s list price on the day of the turn (Ollama’s and Google’s pricing pages; Anthropic and OpenAI via OpenRouter); unpriced turns used a model missing from those tables. Ollama’s off-peak rates apply to turns saved off-peak. Web searches are not included.</p>' +
    (last?.timing
      ? '<div class="eyebrow">Last turn</div>' +
        [
          ['Workspace', last.timing.workspace || '—'],
          ['Preparation', duration(last.timing.startupMs)],
          ['Agent execution', duration(last.timing.executionMs)],
          ['Checkpoint', duration(last.timing.checkpointMs)],
          ['Total', duration(last.timing.totalMs)],
        ]
          .map(
            ([k, v]) =>
              '<div class="timing-row"><span>' + k + '</span><strong>' + v + '</strong></div>',
          )
          .join('')
      : '<p class="caption">Timing measurements will appear after a new turn.</p>') +
    (s && s.kind !== 'chat'
      ? '<div class="section-title"><h2>Repository identity</h2></div><p><a href="' +
        esc(s.remoteUrl || 'https://github.com/' + s.repo) +
        '" target="_blank" rel="noopener noreferrer">' +
        esc(s.repo) +
        '</a></p><div class="timing-row"><span>Branch</span><strong>' +
        esc(s.ref || 'main') +
        '</strong></div><div class="timing-row"><span>Source commit</span><strong>' +
        esc(s.sourceSha?.slice(0, 12) || 'Not recorded for this session') +
        '</strong></div><p class="caption">The workspace is imported from a GitHub snapshot. Git history and GitHub writes require the publishing workflow.</p>'
      : '');
  $('#usage-dialog').showModal();
}
export async function home() {
  $('#code-dialog').close();
  $('#code').hidden = false;
  $('#publish').hidden = false;
  ++state.generation;
  state.search++;
  state.session = null;
  state.job = null;
  busy(false);
  drawer(false);
  composer.hidden = true;
  sessionStorage.removeItem('session');
  title('Your workspace', 'Build from wherever you are');
  sidebar();
  main.innerHTML =
    '<div class="home"><div class="welcome"><div class="eyebrow">Arno / Remote coding</div><h1>Good ideas don’t wait<br>for a desk.</h1><p>Pick a repository. Start a conversation. Turn the next idea into working code.</p></div><div class="home-actions"><button class="primary" data-new-chat>＋ Start a regular chat</button><a class="caption" href="/auth/github?repos=1">Connect / refresh GitHub repository access ↗</a></div><div class="overview"><div class="metric"><b>' +
    state.sessions.length +
    '</b><span>Saved sessions</span></div><div class="metric"><b>' +
    state.models.length +
    '</b><span>Cloud models</span></div><div class="metric"><b>' +
    icon('check') +
    '</b><span>Persistent conversations</span></div></div><div class="section-title"><h2>Your repositories</h2><button id="home-model" class="ghost">' +
    icon('code') +
    esc(modelName(state.selectedModel || 'mistral-large-4:cloud')) +
    '</button></div><div class="searchbox">' +
    icon('search') +
    '<input id="search" type="search" placeholder="Search all accessible repositories" aria-label="Search repositories" autocomplete="off"></div><div id="repo-progress" class="search-progress" role="status"></div><div id="repos" class="repo-grid"></div><div id="more-repos"></div></div>';
  let timer;
  $('#search').oninput = () => {
    state.search++;
    clearTimeout(timer);
    $('#repo-progress').textContent = 'Searching…';
    timer = setTimeout(() => searchRepos($('#search').value), 250);
  };
  $('#home-model').onclick = () => openModels('home');
  searchRepos('');
}
function repoCard(r) {
  const node = document.createElement('div');
  node.className = 'repo-card';
  node.innerHTML =
    '<div class="row">' +
    icon('repo') +
    ' <span class="caption">' +
    esc(r.private ? 'Private' : 'Public') +
    (r.archived ? ' · Archived' : '') +
    '</span></div><h3>' +
    esc(r.full_name) +
    '</h3><p>' +
    esc(r.description || 'Open a workspace to explore this repository.') +
    '</p><div class="repo-foot"><span class="caption">' +
    esc(r.language || r.default_branch || 'main') +
    '</span><button class="open-repo" aria-label="Open ' +
    esc(r.full_name) +
    '">Open ' +
    icon('chevron') +
    '</button></div>';
  node.querySelector('button').onclick = () => openRepo(r);
  return node;
}
// Search advances until there are no GitHub pages left, even if early pages have
// zero matches. A generation token cancels stale queries without mixing results.
async function searchRepos(query) {
  const version = ++state.search,
    box = $('#repos'),
    progress = $('#repo-progress'),
    more = $('#more-repos');
  if (!box) return;
  box.innerHTML = '';
  more.innerHTML = '';
  let found = 0,
    scanned = 0;
  async function page(n) {
    if (version !== state.search || !box.isConnected) return;
    progress.innerHTML =
      '<span class="spinner"></span> ' +
      (query ? 'Searching all repository pages' : 'Loading repositories') +
      '… ' +
      (scanned ? scanned + ' checked · ' + found + ' matches' : '');
    try {
      const d = await api('/api/repos?page=' + n + '&q=' + encodeURIComponent(query));
      if (version !== state.search || !box.isConnected) return;
      scanned += d.scanned ?? 100;
      for (const r of d.repos) {
        box.append(repoCard(r));
        found++;
      }
      if (d.nextPage) {
        if (query) {
          await page(d.nextPage);
        } else {
          progress.textContent = found + ' repositories loaded · more available';
          const b = document.createElement('button');
          b.style.marginTop = '20px';
          b.textContent = 'Load more repositories';
          b.onclick = () => {
            b.remove();
            page(d.nextPage);
          };
          more.append(b);
        }
      } else {
        progress.textContent = query
          ? 'Search complete · ' +
            found +
            ' match' +
            (found === 1 ? '' : 'es') +
            ' across ' +
            scanned +
            ' visible repositories'
          : found + ' repositories visible to this GitHub connection';
        const access = document.createElement('div');
        access.className = 'access-notice';
        access.innerHTML =
          '<strong>Missing repositories?</strong><p>' +
          esc(
            d.access?.privateAccess === false
              ? 'This connection does not have private-repository permission.'
              : 'GitHub returned ' +
                  scanned +
                  ' repositories for this connection. Private repositories and organizations may need renewed authorization or SSO approval.',
          ) +
          '</p><a href="/auth/github?repos=1">Reconnect GitHub with repository access ↗</a><p class="caption">' +
          esc(
            d.access?.scopes
              ? 'Granted scopes: ' + d.access.scopes
              : 'GitHub did not report scopes for this token.',
          ) +
          (d.access?.ssoRequired ? ' · Organization SSO authorization required.' : '') +
          '</p>';
        access.insertAdjacentHTML(
          'beforeend',
          '<p class="caption">Using a GitHub App? <a href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">Manage installation repository access</a> and select all required repositories.</p>',
        );
        more.append(access);
        if (!found)
          box.innerHTML =
            '<div class="empty">No repositories match. Try an owner or a shorter name.</div>';
      }
    } catch (e) {
      if (version !== state.search) return;
      progress.textContent = 'Search interrupted: ' + e.message;
      const b = document.createElement('button');
      b.textContent = 'Continue search';
      b.onclick = () => {
        b.remove();
        page(n);
      };
      more.append(b);
    }
  }
  await page(1);
}
async function openRepo(repo) {
  state.search++;
  const gen = ++state.generation;
  drawer(false);
  main.innerHTML =
    '<div class="loading"><span class="spinner"></span><h3>Preparing ' +
    esc(repo.full_name) +
    '</h3><p>Downloading the selected revision and saving its first checkpoint.<br>This setup happens once per new session.</p></div>';
  try {
    const s = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        repo: repo.full_name,
        ref: repo.default_branch,
        model: state.selectedModel || 'mistral-large-4:cloud',
      }),
    });
    state.sessions.unshift({ id: s.id, ...s });
    if (gen === state.generation) await resume(s.id);
  } catch (e) {
    if (gen === state.generation) {
      main.innerHTML =
        '<div class="empty"><h2>Workspace setup failed</h2><p>' +
        esc(e.message) +
        '</p><button id="back-home">Back to repositories</button></div>';
      $('#back-home').onclick = home;
    }
  }
}
export function exportChat() {
  if (!state.session) return toast('Open a session first');
  const text =
    '# ' +
    state.session.repo +
    '\n\n' +
    (state.session.history || [])
      .map(
        t =>
          '## You\n\n' +
          t.prompt +
          '\n\n## Arno · ' +
          (t.model || state.session.model) +
          '\n\n' +
          cleanOutput(t.summary),
      )
      .join('\n\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  a.download = state.session.repo.replace('/', '-') + '-chat.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export async function renameConversation(id = state.session?.id) {
  const target = state.sessions.find(s => s.id === id) || state.session;
  if (!id || !target) return toast('Choose a conversation first');
  $('#actions-dialog').close();
  $('#conversation-dialog').close();
  const value = window.prompt('Conversation name', target.title || target.repo);
  if (value == null || !value.trim()) return;
  try {
    const d = await api('/api/sessions/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ title: value.trim() }),
    });
    if (state.session?.id === id) {
      state.session = { ...state.session, ...d };
      title(
        d.title,
        state.session.kind === 'chat'
          ? 'Private chat · No repository required'
          : (d.ref || 'main') + ' · ' + d.repo,
      );
    }
    state.sessions = state.sessions.map(s => (s.id === id ? { ...s, ...d } : s));
    sidebar();
    toast('Conversation renamed');
  } catch (e) {
    showError(e);
  }
}
export async function deleteConversation(id = state.session?.id) {
  if (!id) return toast('Choose a conversation first');
  if (state.busy && state.session?.id === id)
    return toast('Stop the active task before deleting this conversation');
  if (!confirm('Delete this conversation and its saved workspace? This cannot be undone.')) return;
  try {
    await api('/api/sessions/' + id, { method: 'DELETE' });
    state.sessions = state.sessions.filter(s => s.id !== id);
    $('#actions-dialog').close();
    $('#conversation-dialog').close();
    if (state.session?.id === id) await home();
    else sidebar();
    toast('Conversation deleted');
  } catch (e) {
    showError(e);
  }
}
