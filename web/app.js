/** Browser application entry. Server state is authoritative; view generation tokens
 * prevent old async responses from repainting a newly selected session.
 * Job polling survives mobile disconnects and never resubmits automatically.
 * The code lives in modules: core, layout, models, thread, sessions, code, turns,
 * settings and offline. This file wires the page's events and boots the session.
 */
import { tableResize } from './render.mjs';
import {
  $,
  state,
  esc,
  icon,
  api,
  toast,
  showError,
  copy,
  main,
  prompt,
  loadAvatar,
  sendKey,
} from './core.js';
import { drawer, title, sidebar, theme, toggleWrap } from './layout.js';
import { loadModels, openModels, renderModels, chooseModel } from './models.js';
import { openSources, scrollDown } from './thread.js';
import { startDiagnostics } from './diag.js';
import { openInfo } from './info.js';
import { openUsage } from './usage.js';
import { artifactClick } from './artifacts.js';
import {
  resume,
  newChat,
  switchMode,
  home,
  exportChat,
  renameConversation,
  deleteConversation,
  anotherSession,
} from './sessions.js';
import { openCode, browse, reviewPublish, showCommit } from './code.js';
import { submit, resizePrompt } from './turns.js';
import './attach.js'; // wires the paperclip, paste and drop
import './options.js'; // wires the options button, its popover and chips
import './settings.js'; // wires the account settings dialog
import { register, warm, clearData } from './offline.js';
import { startOutbox, flush } from './outbox.js';
tableResize(document);

$('#menu').onclick = () => drawer(true);
$('#overlay').onclick = () => drawer(false);
$('#new-session').onclick = home;
$('#theme').onclick = theme;
$('#usage').onclick = openInfo;
$('#usage-view').onclick = openUsage;
$('#title').onclick = () => state.session && openInfo();
$('#title').onkeydown = e => {
  if (state.session && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openInfo();
  }
};
$('#export').onclick = exportChat;
$('#model-button').onclick = () => openModels('session');
$('#model-search').oninput = renderModels;
$('#composer').onsubmit = submit;
$('#jump-bottom').onclick = () => scrollDown(true);
$('#publish').onclick = reviewPublish;
$('#new-chat').onclick = () => newChat();
$('#rename-conversation').onclick = () => renameConversation();
$('#delete-conversation').onclick = () => deleteConversation();
$('#list-rename').onclick = () => renameConversation(state.menuTarget);
$('#list-delete').onclick = () => deleteConversation(state.menuTarget);
$('#code').onclick = () => openCode();
$('#files-tab').onclick = () => openCode('files');
$('#diff-tab').onclick = () => openCode('diff');
$('#history-tab').onclick = () => openCode('history');
$('#code-dialog').addEventListener('close', () => {
  if (!$('#code-dialog').open) document.body.classList.remove('code-open');
});
$('#actions').onclick = () => {
  // A coding session's actions start another session on its repository.
  $('#another-session').hidden = !state.session?.repo || state.session.kind === 'chat';
  $('#actions-dialog').showModal();
};
$('#another-session').onclick = () => {
  $('#actions-dialog').close();
  anotherSession();
};
for (const id of ['export', 'publish']) {
  const b = $('#' + id);
  b.className = 'model-option';
  b.innerHTML =
    id === 'export' ? 'Export conversation as Markdown' : 'Review changes & publish to GitHub';
  $('#action-items').append(b);
}
$('#stop').onclick = async () => {
  if (
    !state.session ||
    !confirm(
      state.session.kind === 'chat'
        ? 'Stop this response? It will not be added to the conversation.'
        : 'Stop this task? Work since the last completed checkpoint will be discarded.',
    )
  )
    return;
  try {
    await api('/api/sessions/' + state.session.id + '/cancel', { method: 'POST', body: '{}' });
    toast('Stopping…');
  } catch (e) {
    showError(e);
  }
};
prompt.oninput = () => {
  resizePrompt();
  if (state.session) sessionStorage.setItem('draft:' + state.session.id, prompt.value);
};
prompt.onkeydown = e => {
  if (sendKey(e)) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
};
for (const b of document.querySelectorAll('[data-mode]'))
  b.onclick = () => switchMode(b.dataset.mode);
$('#brand').onclick = () => switchMode(state.mode);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') drawer(false);
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    if (state.session) openModels('session');
    else $('#search')?.focus();
  }
});
document.addEventListener('click', e => {
  const session = e.target.closest('[data-session]');
  if (session) resume(session.dataset.session);
  const sessionMenu = e.target.closest('[data-session-menu]');
  if (sessionMenu) {
    state.menuTarget = sessionMenu.dataset.sessionMenu;
    const row = state.sessions.find(s => s.id === state.menuTarget);
    $('#conversation-menu-heading').textContent = row?.title || row?.repo || 'Conversation';
    $('#conversation-dialog').showModal();
  }
  const model = e.target.closest('[data-model]');
  if (model) chooseModel(model.dataset.model);
  const file = e.target.closest('[data-file]');
  if (file) browse(file.dataset.file);
  const commit = e.target.closest('[data-commit]');
  if (commit) showCommit(commit.dataset.commit);
  const citation = e.target.closest('[data-citation]');
  if (citation)
    openSources(citation.closest('.turn')._sources || [], Number(citation.dataset.citation));
  artifactClick(e);
  const allSources = e.target.closest('[data-all-sources]');
  if (allSources) openSources(allSources.closest('.turn')._sources || []);
  const suggestion = e.target.closest('[data-suggest]');
  if (suggestion) {
    prompt.value = suggestion.dataset.suggest;
    resizePrompt();
    prompt.focus();
  }
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
  const code = e.target.closest('.copy-code');
  if (code) copy(code.closest('.codeblock').querySelector('code').textContent);
  if (e.target.closest('.wrap-toggle')) toggleWrap();
});
async function boot() {
  try {
    const d = await api('/api/me');
    state.user = d.user;
    state.githubConnected = d.githubConnected;
    state.repoAccess = d.repoAccess;
    if (!state.user) {
      if (!state.offline) clearData(); // signed out: drop the device's copy
      title('Welcome to Arno', 'Your code, wherever you are');
      sidebar();
      main.innerHTML =
        '<div class="home"><div class="starter"><div class="mark">a</div><h1>Your next commit<br>starts with a conversation.</h1><p class="muted">A quiet workspace for ambitious ideas. Connect GitHub, choose a model, and build from your phone.</p><p><a class="primary" style="display:inline-block;padding:12px 20px;border-radius:10px" href="/auth/github">Continue with GitHub →</a></p><p class="caption">Powered by Arno · Ollama Cloud · Cloudflare</p></div></div>';
      return;
    }
    await Promise.all([
      loadModels(),
      loadAvatar(),
      api('/api/sessions').then(d => (state.sessions = d.sessions)),
      // The preferences (home page, Enter, default model); defaults without them.
      api('/api/account')
        .then(d => (state.profile = d))
        .catch(() => {}),
    ]);
    await startOutbox(); // chats made offline join the list
    sidebar();
    // A notification links to /?session=<id>: open it, then tidy the address.
    const linked = new URLSearchParams(location.search).get('session');
    if (linked) history.replaceState(null, '', location.pathname);
    // The app opens on its home page, like starting a new chat; only a link
    // (from a notification) opens a conversation.
    if (/^[0-9a-f-]{36}$/.test(linked || '')) await resume(linked);
    else await home();
    flush(); // whatever waited from an earlier visit
    if (!state.offline) setTimeout(warm, 2000); // after the page settles
  } catch (e) {
    main.innerHTML =
      '<div class="empty"><h2>Connection unavailable</h2><p>' +
      esc(e.message) +
      '</p><button type="button" id="reload">Reload</button></div>';
  }
}
for (const [id, name] of [
  ['menu', 'menu'],
  ['theme', 'sun'],
  ['usage', 'panel'],
  ['code', 'code'],
  ['actions', 'dots'],
])
  $('#' + id).innerHTML = icon(name);
$('#new-session').innerHTML = icon('plus') + ' New session';
document.addEventListener('click', e => {
  if (e.target.id === 'reload') location.reload();
});
// A click on a modal dialog's backdrop closes it. A click on the backdrop
// targets the dialog itself but lands outside its box; both press and release
// must be outside, so selecting text that ends past the edge doesn't close it.
// Non-modal dialogs (the docked code pane) are left alone.
const outside = (dialog, e) => {
  const r = dialog.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};
let pressedOutside = null;
document.addEventListener('pointerdown', e => {
  pressedOutside =
    e.target instanceof HTMLDialogElement && e.target.matches(':modal') && outside(e.target, e)
      ? e.target
      : null;
});
document.addEventListener('click', e => {
  if (e.target === pressedOutside && outside(e.target, e)) e.target.close();
  pressedOutside = null;
});
register();
startDiagnostics();
boot();
