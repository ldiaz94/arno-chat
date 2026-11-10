/** Sessions and the home pages: switch between Chat and Code, open, create, list,
 * search, export, rename and delete conversations. Each mode has its own home and
 * remembers its last open conversation (sessionStorage `session:chat`,
 * `session:code`); the mode itself survives reloads (localStorage `mode`).
 * Offline, a new chat and a rename wait in the outbox. Depends on core, layout,
 * models, thread, turns, attach, home, offline, outbox, queue.mjs and render.mjs.
 */
import { cleanOutput } from './render.mjs';
import {
  $,
  state,
  esc,
  icon,
  api,
  toast,
  showError,
  unreachable,
  main,
  composer,
  prompt,
  shell,
  modeOf,
  sendKey,
  sendHint,
} from './core.js';
import { drawer, busy, title, sidebar } from './layout.js';
import { modelButton, modelLabel, openModels, startModel } from './models.js';
import { message, failure, scrollDown, suggestions } from './thread.js';
import { watchJob, resizePrompt } from './turns.js';
import { clearAttachments } from './attach.js';
import { render as renderOptions, keepOptions } from './options.js';
import { greeting, todayCard, wireToday } from './home.js';
import { controls } from './offline.js';
import {
  showQueued,
  localChat,
  queueChat,
  queueRename,
  dropSession,
  chatFailure,
  retryChat,
} from './outbox.js';
import { isLocal } from './queue.mjs';
import { byRecent, ago, activeAt } from './today.mjs';
// Opens a saved conversation by id: loads it, draws its thread and picks up a running job.
export async function resume(id) {
  $('#code-dialog').close();
  const gen = ++state.generation;
  state.search++;
  drawer(false);
  composer.hidden = true;
  main.innerHTML =
    '<div class="loading"><span class="spinner"></span><p>Opening saved workspace…</p></div>';
  try {
    // A chat made offline lives only in the outbox until the server makes it.
    const s = isLocal(id) ? localChat(id) : await api('/api/sessions/' + id);
    if (!s) throw Error('This conversation is no longer on this device.');
    if (gen === state.generation) show({ id, ...s }, gen);
  } catch (e) {
    main.innerHTML =
      '<div class="empty"><h2>Couldn’t open this session</h2><p>' +
      esc(e.message) +
      '</p><button id="retry-open">Try again</button></div>';
    $('#retry-open').onclick = () => resume(id);
  }
}
// Draws a conversation as the open one: its thread, title and composer.
function show(s, gen) {
  const id = s.id;
  state.session = s;
  state.job = null;
  state.busy = false;
  setMode(modeOf(s));
  clearAttachments();
  sidebar();
  $('.composer-hint').textContent = composerHint(s);
  prompt.placeholder = s.kind === 'chat' ? 'Message Arno…' : 'Ask Arno to build, fix, or explain…';
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
      message('You', t.prompt, { at: t.at, attachments: t.attachments });
      if (t.failed) failure(t.prompt, t.error, t.at, t.attachments, t.usage);
      else message('Arno', t.summary, t);
    }
  showQueued();
  const refused = isLocal(id) && chatFailure(id);
  if (refused) {
    const card = document.createElement('div');
    card.className = 'failure';
    card.setAttribute('role', 'alert');
    card.innerHTML =
      '<p>This chat was made offline and the server refused to create it: ' +
      esc(refused) +
      '</p><div class="failure-actions"><button type="button" data-chat-delete>Delete</button><button type="button" class="primary" data-chat-retry>Retry</button></div>';
    card.querySelector('[data-chat-retry]').onclick = async () => {
      await retryChat(id);
      card.remove();
      sidebar();
    };
    card.querySelector('[data-chat-delete]').onclick = () => deleteConversation(id);
    $('#thread').prepend(card);
  }
  composer.hidden = false;
  modelButton();
  renderOptions();
  busy(false);
  prompt.value = (id && sessionStorage.getItem('draft:' + id)) || '';
  resizePrompt();
  scrollDown(true);
  if (id && !isLocal(id)) watchJob(id, gen);
}
// The hint under the composer for a kind of session.
const composerHint = s =>
  sendHint() +
  (s.kind === 'chat'
    ? ' · Conversations are saved automatically'
    : ' · Changes are saved after each turn');
// Sets the sidebar's mode, Chat or Code, and remembers it.
function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('mode', mode);
}
/** Shows a mode's home page: switching modes, or tapping the current one to
 * get back home. On a phone the drawer stays open when switching, so that
 * mode's list of conversations is what you see. */
export async function switchMode(mode) {
  const open = shell.classList.contains('drawer-open') && mode !== state.mode;
  setMode(mode);
  state.editing = false; // selection is per list; switching modes leaves edit mode
  state.selected.clear();
  await home();
  if (open) drawer(true);
}
/** Opens a new chat with the default model; with `text`, sends it as the first
 * message. The chat is a draft, on no server or list, until `persist` makes it. */
export function newChat(text) {
  $('#code-dialog').close();
  state.search++;
  drawer(false);
  show(
    { id: null, draft: true, kind: 'chat', title: 'New chat', model: startModel(), history: [] },
    ++state.generation,
  );
  if (text) {
    prompt.value = text;
    $('#composer').requestSubmit();
  }
}
/** Makes the open draft chat a real one the first time it needs to be: its
 * first message or file. Offline it waits in the outbox. Returns false when
 * it could not, or when the chat was left meanwhile. */
export function persist() {
  const draft = state.session;
  if (!draft?.draft) return true;
  // Several files dropped at once make one chat.
  return (draft.making ||= make(draft));
}
// Creates a draft chat on the server, or in the outbox, and opens it in place.
async function make(draft) {
  busy(true);
  try {
    let s;
    try {
      if (state.offline) throw unreachable();
      s = await api('/api/chats', { method: 'POST', body: JSON.stringify({ model: draft.model }) });
    } catch (e) {
      if (!e.network) throw e;
      s = await queueChat(draft.model); // made on the server once back online
    }
    state.sessions.unshift(s);
    keepOptions(s.id, draft.options);
    if (state.session !== draft) return false;
    state.session = { ...s, id: s.id };
    sidebar();
    return true;
  } catch (e) {
    showError(e);
    return false;
  } finally {
    busy(false);
  }
}
/** On the Code home: a note when private repositories can't be reached, saying
 * what to change on GitHub. Nothing when every repository is reachable, or
 * when GitHub couldn't be asked. */
function repoBanner() {
  const r = state.repoAccess;
  if (!r || r.access === 'all' || r.access === 'unknown') return '';
  const [head, text, link, label] = r.app
    ? r.access === 'selected'
      ? [
          'Arno can reach only some of your repositories',
          'The Arno GitHub app is installed on selected repositories. To work on others, add them on GitHub, or choose All repositories.',
          r.configure,
          'Choose repositories on GitHub',
        ]
      : [
          'Private repositories aren’t connected',
          'The Arno GitHub app isn’t installed on your account, so only public repositories show. Install it with All repositories; an organisation’s repositories need the app installed there too.',
          r.configure,
          'Install on GitHub',
        ]
    : [
        'Private repositories aren’t connected',
        'Signing in only lets Arno see your public repositories. Connect repository access to work on private ones.',
        '/auth/github?repos=1',
        'Connect GitHub repositories',
      ];
  return (
    '<div class="connect-repos"><div><strong>' +
    head +
    '</strong><p class="caption">' +
    text +
    '</p></div><a class="primary button-link" href="' +
    esc(link) +
    '"' +
    (r.app ? ' target="_blank" rel="noopener noreferrer"' : '') +
    '>' +
    label +
    '</a></div>'
  );
}
// Shows the home page of the current mode.
export async function home() {
  $('#code-dialog').close();
  ++state.generation;
  state.search++;
  state.session = null;
  state.job = null;
  busy(false);
  drawer(false);
  composer.hidden = true;
  sidebar();
  if (state.mode === 'chat') chatHome();
  else codeHome();
  $('#home-model').onclick = () => openModels('home');
  wireToday();
  controls();
}
// Saved preferences show at once: the home page again, or the composer's hint.
addEventListener('arno:prefs', () => {
  if (!state.session && main.querySelector('.home')) home();
  else if (state.session) $('.composer-hint').textContent = composerHint(state.session);
});
/** Opening lines for the chat home's chips: each fills the box, to finish and send. */
const STARTERS = [
  ['Explain', 'Explain like I’m new to it: '],
  ['Plan', 'Help me plan '],
  ['Write', 'Help me write '],
  ['Brainstorm', 'Brainstorm ideas for '],
  ['Summarize', 'Summarize this for me:\n\n'],
];
// The button that picks the model for new conversations.
const modelChip = () =>
  '<button id="home-model" class="ghost model-button" type="button" aria-label="Model for new conversations">' +
  modelLabel(startModel()) +
  '</button>';
// The Chat home: a greeting and a box to start a chat from.
function chatHome() {
  title('Chat', 'Ask, think and research');
  main.innerHTML =
    '<div class="home home-chat">' +
    greeting('Arno / Chat', 'Ask anything. Arno can search the web and cite its sources.') +
    '<form id="home-ask" class="home-ask"><textarea id="home-prompt" rows="2" maxlength="8000" placeholder="What’s on your mind?" aria-label="Start a chat"></textarea><div class="home-ask-bar">' +
    modelChip() +
    '<span class="caption home-hint">' +
    sendHint() +
    '</span><button class="primary" type="submit" aria-label="Start chat">' +
    icon('arrow') +
    '</button></div></form><div class="chips">' +
    STARTERS.map(
      ([label, text]) =>
        '<button type="button" class="chip" data-starter="' +
        esc(text) +
        '">' +
        label +
        '</button>',
    ).join('') +
    '</div>' +
    todayCard(false) +
    '</div>';
  const box = $('#home-prompt'),
    start = () => box.value.trim() && newChat(box.value.trim());
  $('#home-ask').onsubmit = e => {
    e.preventDefault();
    start();
  };
  box.onkeydown = e => {
    if (!sendKey(e)) return;
    e.preventDefault();
    start();
  };
  for (const chip of main.querySelectorAll('[data-starter]'))
    chip.onclick = () => {
      box.value = chip.dataset.starter;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    };
}
// The Code home: a greeting, recent sessions and repositories to start from.
function codeHome() {
  title('Code', 'Build from wherever you are');
  const recent = byRecent(state.sessions.filter(s => modeOf(s) === 'code')).slice(0, 4);
  main.innerHTML =
    '<div class="home home-code">' +
    greeting(
      'Arno / Code',
      'Pick a repository, start a session, turn the next idea into working code.',
    ) +
    todayCard(true) +
    (recent.length
      ? '<div class="section-title"><h2>Recent sessions</h2></div><div class="recent-grid">' +
        recent
          .map(
            s =>
              '<button type="button" class="recent-card" data-session="' +
              esc(s.id) +
              '"><strong>' +
              esc(s.title || s.repo) +
              '</strong><small>' +
              esc(s.repo) +
              ' · ' +
              esc(s.ref || 'main') +
              ' · ' +
              ago(activeAt(s)) +
              '</small></button>',
          )
          .join('') +
        '</div>'
      : '') +
    repoBanner() +
    '<div class="section-title"><h2>Start from a repository</h2>' +
    modelChip() +
    '</div><div class="searchbox">' +
    icon('search') +
    '<input id="search" type="search" placeholder="Search all accessible repositories" aria-label="Search repositories" autocomplete="off"></div><div id="repo-progress" class="search-progress" role="status"></div><div id="repos" class="repo-grid"></div><div id="more-repos"></div><p><a class="caption" href="/auth/github?repos=1">Connect / refresh GitHub repository access ↗</a></p></div>';
  let timer;
  $('#search').oninput = () => {
    state.search++;
    clearTimeout(timer);
    $('#repo-progress').textContent = 'Searching…';
    timer = setTimeout(() => searchRepos($('#search').value), 250);
  };
  searchRepos('');
}
// One repository of the picker, as a card that opens it.
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
    '</span><button class="open-repo" data-online="Reconnect to start a coding session" aria-label="Open ' +
    esc(r.full_name) +
    '">Open ' +
    icon('chevron') +
    '</button></div>';
  node.querySelector('button').onclick = () => openRepo(r);
  node.querySelector('button').disabled = state.offline;
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
/** Starts another session on the open session's repository, from the branch
 * it is on (the one it last pushed, if the checkout followed it). */
export function anotherSession() {
  const s = state.session;
  if (s?.repo) openRepo({ full_name: s.repo, default_branch: s.ref || 'main' });
}
// Creates a coding session for a repository and opens it.
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
        model: startModel(),
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
// Downloads the open conversation as a Markdown file.
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
// Renames a conversation after asking for the new title; offline it waits in the outbox.
export async function renameConversation(id = state.session?.id) {
  const target = state.sessions.find(s => s.id === id) || state.session;
  if (!id || !target) return toast('Choose a conversation first');
  $('#actions-dialog').close();
  $('#conversation-dialog').close();
  const value = window.prompt('Conversation name', target.title || target.repo);
  if (value == null || !value.trim()) return;
  try {
    let d, queued;
    try {
      if (state.offline || isLocal(id)) throw unreachable();
      d = await api('/api/sessions/' + id, {
        method: 'PATCH',
        body: JSON.stringify({ title: value.trim() }),
      });
    } catch (e) {
      if (!e.network) throw e;
      // Sent once back online, checked against the name it replaces.
      await queueRename(id, value.trim(), target.title);
      d = { title: value.trim(), ref: target.ref, repo: target.repo };
      queued = true;
    }
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
    toast(queued ? 'Rename saved · sends when online' : 'Conversation renamed');
  } catch (e) {
    showError(e);
  }
}
/** Deletes one conversation where it lives: on the server, or on this device
 * for a chat made offline. Throws when it could not. */
function remove(id) {
  return isLocal(id) ? dropSession(id) : api('/api/sessions/' + id, { method: 'DELETE' });
}
/** Takes deleted conversations off the list, and goes home if one was open. */
async function forget(ids) {
  state.sessions = state.sessions.filter(s => !ids.includes(s.id));
  for (const id of ids) state.selected.delete(id);
  $('#actions-dialog').close();
  $('#conversation-dialog').close();
  if (state.session && ids.includes(state.session.id)) await home();
  else sidebar();
}
// Deletes a conversation after confirming; on the open one it returns to the home page.
export async function deleteConversation(id = state.session?.id) {
  if (!id) return toast('Choose a conversation first');
  if (state.busy && state.session?.id === id)
    return toast('Stop the active task before deleting this conversation');
  if (!confirm('Delete this conversation and its saved workspace? This cannot be undone.')) return;
  try {
    await remove(id);
    await forget([id]);
    toast('Conversation deleted');
  } catch (e) {
    showError(e);
  }
}
/** Enters or leaves the sidebar's multi-select mode. */
export function toggleEdit() {
  state.editing = !state.editing;
  if (!state.editing) state.selected.clear();
  sidebar();
}
/** Selects or deselects one conversation row in edit mode. */
export function togglePick(id) {
  if (!state.editing) return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  sidebar();
}
/** Deletes every selected conversation, one request each. Those that fail stay
 * listed and selected, so they can be tried again; edit mode ends when all go. */
export async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (state.busy && ids.includes(state.session?.id))
    return toast('Stop the active task before deleting this conversation');
  const n = ids.length === 1 ? '1 conversation' : ids.length + ' conversations';
  if (!confirm('Delete ' + n + ' and their saved workspaces? This cannot be undone.')) return;
  const done = [];
  for (const id of ids)
    try {
      await remove(id);
      done.push(id);
    } catch (e) {
      console.error('delete failed for ' + id, e);
    }
  const failed = ids.length - done.length;
  if (!failed) state.editing = false;
  await forget(done);
  toast(
    failed
      ? done.length +
          ' deleted · ' +
          failed +
          ' could not be deleted' +
          (state.offline ? ' while offline' : '')
      : done.length === 1
        ? 'Conversation deleted'
        : done.length + ' conversations deleted',
  );
}
