/** Browser application entry. Server state is authoritative; view generation tokens
 * prevent old async responses from repainting a newly selected session.
 * Job polling survives mobile disconnects and never resubmits automatically.
 * The code lives in modules: core, layout, models, thread, sessions, code, turns
 * and settings. This file wires the page's events and boots the session.
 */
import { tableResize } from './render.mjs';
import { $, state, esc, icon, api, toast, showError, copy, main, prompt } from './core.js';
import { drawer, title, sidebar, theme } from './layout.js';
import { loadModels, openModels, renderModels, chooseModel } from './models.js';
import { openSources } from './thread.js';
import {
  resume,
  newChat,
  openUsage,
  home,
  exportChat,
  renameConversation,
  deleteConversation,
} from './sessions.js';
import { openCode, browse, reviewPublish } from './code.js';
import { submit, resizePrompt } from './turns.js';
import './settings.js'; // wires the account settings dialog
tableResize(document);

$('#menu').onclick = () => drawer(true);
$('#overlay').onclick = () => drawer(false);
$('#new-session').onclick = home;
$('#theme').onclick = theme;
$('#usage').onclick = openUsage;
$('#export').onclick = exportChat;
$('#model-button').onclick = () => openModels('session');
$('#model-search').oninput = renderModels;
$('#composer').onsubmit = submit;
$('#publish').onclick = reviewPublish;
$('#new-chat').onclick = newChat;
$('#rename-conversation').onclick = () => renameConversation();
$('#delete-conversation').onclick = () => deleteConversation();
$('#list-rename').onclick = () => renameConversation(state.menuTarget);
$('#list-delete').onclick = () => deleteConversation(state.menuTarget);
$('#code').onclick = () => openCode();
$('#files-tab').onclick = () => openCode('files');
$('#diff-tab').onclick = () => openCode('diff');
$('#code-dialog').addEventListener('close', () => {
  if (!$('#code-dialog').open) document.body.classList.remove('code-open');
});
$('#actions').onclick = () => $('#actions-dialog').showModal();
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
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
};
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
  const citation = e.target.closest('[data-citation]');
  if (citation)
    openSources(citation.closest('.turn')._sources || [], Number(citation.dataset.citation));
  const allSources = e.target.closest('[data-all-sources]');
  if (allSources) openSources(allSources.closest('.turn')._sources || []);
  const suggestion = e.target.closest('[data-suggest]');
  if (suggestion) {
    prompt.value = suggestion.dataset.suggest;
    resizePrompt();
    prompt.focus();
  }
  if (e.target.closest('[data-new-chat]')) newChat();
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
  const code = e.target.closest('.copy-code');
  if (code) copy(code.closest('.codeblock').querySelector('code').textContent);
});
async function boot() {
  try {
    const d = await api('/api/me');
    state.user = d.user;
    state.githubConnected = d.githubConnected;
    if (!state.user) {
      title('Welcome to Arno', 'Your code, wherever you are');
      sidebar();
      main.innerHTML =
        '<div class="home"><div class="starter"><div class="mark">a</div><h1>Your next commit<br>starts with a conversation.</h1><p class="muted">A quiet workspace for ambitious ideas. Connect GitHub, choose a model, and build from your phone.</p><p><a class="primary" style="display:inline-block;padding:12px 20px;border-radius:10px" href="/auth/github">Continue with GitHub →</a></p><p class="caption">Powered by Arno · Ollama Cloud · Cloudflare</p></div></div>';
      return;
    }
    await Promise.all([
      loadModels(),
      api('/api/sessions').then(d => (state.sessions = d.sessions)),
    ]);
    sidebar();
    const saved = sessionStorage.getItem('session');
    if (saved) await resume(saved);
    else await home();
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
  ['usage', 'chart'],
  ['code', 'code'],
])
  $('#' + id).innerHTML = icon(name);
$('#new-session').innerHTML = icon('plus') + ' New session';
document.addEventListener('click', e => {
  if (e.target.id === 'reload') location.reload();
});
boot();
