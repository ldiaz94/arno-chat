/** The code dialog: file browser, changes, the checkout's commit history and
 * the review-and-publish flow. Depends on core, render.mjs, highlight.mjs and
 * today.mjs.
 */
import { diffHtml } from './render.mjs';
import { highlight, detect } from './highlight.mjs';
import { $, state, esc, icon, num, api, toast, copy } from './core.js';
import { ago } from './today.mjs';
export function openCode(tab = 'files') {
  if (!state.session || state.session.kind === 'chat')
    return toast('Open a repository to browse its code');
  const dialog = $('#code-dialog');
  if (!dialog.open) {
    if (innerWidth >= 1600) {
      dialog.show();
      document.body.classList.add('code-open');
    } else dialog.showModal();
  }
  for (const t of ['files', 'diff', 'history'])
    $('#' + t + '-tab').setAttribute('aria-pressed', String(t === tab));
  if (tab === 'history') history();
  else if (tab === 'diff') {
    const diff = state.session.history?.filter(t => t.diff).at(-1)?.diff;
    $('#code-body').innerHTML = diff
      ? '<div class="caption" style="padding:12px">Cumulative working-tree changes from the last completed turn</div><div class="diff-view panel-diff">' +
        diffHtml(diff) +
        '</div>'
      : '<div class="empty">No recorded changes yet. Ask Arno to make a change first.</div>';
  } else browse('');
}
/** The History tab: the checkout's newest commits, newest first; those not
 * yet on GitHub are marked. */
async function history() {
  const id = state.session.id;
  $('#code-body').innerHTML = '<div class="loading">Reading the history…</div>';
  try {
    const d = await api('/api/sessions/' + id + '/history');
    if (state.session?.id !== id) return;
    $('#code-body').innerHTML =
      (d.uncommitted
        ? '<p class="history-note">' +
          num(d.uncommitted) +
          ' file' +
          (d.uncommitted === 1 ? '' : 's') +
          ' changed since the last commit</p>'
        : '') +
      '<ol class="commit-list">' +
      d.commits.map(commitRow).join('') +
      '</ol>';
  } catch (e) {
    $('#code-body').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}
// The branch and tag names git decorates a commit with, as tags.
function refTags(refs) {
  return (refs || '')
    .split(', ')
    .filter(r => r && r !== 'HEAD' && !r.endsWith('/HEAD'))
    .map(
      r => '<span class="tag">' + esc(r.replace(/^HEAD -> /, '').replace(/^tag: /, '')) + '</span>',
    )
    .join('');
}
function commitRow(c) {
  return (
    '<li><button type="button" class="commit-row" data-commit="' +
    esc(c.sha) +
    '"><span class="commit-dot' +
    (c.local ? ' local' : '') +
    '"></span><span class="commit-main"><span class="commit-subject">' +
    esc(c.subject) +
    '</span><span class="commit-meta"><code>' +
    esc(c.sha.slice(0, 7)) +
    '</code> ' +
    esc(c.author) +
    ' · <time title="' +
    esc(new Date(c.at).toLocaleString()) +
    '">' +
    esc(ago(c.at)) +
    '</time>' +
    (c.local ? '<span class="tag local-tag">Not pushed</span>' : '') +
    refTags(c.refs) +
    '</span></span></button></li>'
  );
}
/** One commit: its message, who and when, and its changes. */
export async function showCommit(sha) {
  const id = state.session.id;
  $('#code-body').innerHTML = '<div class="loading">Opening ' + esc(sha.slice(0, 7)) + '…</div>';
  try {
    const c = await api('/api/sessions/' + id + '/commit?sha=' + sha);
    if (state.session?.id !== id) return;
    const [subject, ...body] = c.message.split('\n');
    $('#code-body').innerHTML =
      '<div class="commit-view"><button type="button" class="ghost history-back">← History</button><h3>' +
      esc(subject) +
      '</h3>' +
      (body.join('\n').trim()
        ? '<pre class="commit-body">' + esc(body.join('\n').trim()) + '</pre>'
        : '') +
      '<p class="caption"><code>' +
      esc(c.sha.slice(0, 12)) +
      '</code> · ' +
      esc(c.author) +
      ' · ' +
      esc(new Date(c.at).toLocaleString()) +
      '</p></div>' +
      (c.patch.trim()
        ? '<div class="diff-view panel-diff">' + diffHtml(c.patch) + '</div>'
        : '<div class="empty">No changes in this commit.</div>');
    $('#code-body .history-back').onclick = () => openCode('history');
  } catch (e) {
    $('#code-body').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}
export async function browse(path) {
  if (!state.session) return;
  const id = state.session.id;
  $('#code-body').innerHTML =
    '<div class="loading">Opening ' + esc(path || 'repository') + '…</div>';
  try {
    const d = await api('/api/sessions/' + id + '/files?path=' + encodeURIComponent(path));
    if (state.session?.id !== id) return;
    const parts = path.split('/').filter(Boolean);
    let acc = '';
    $('#code-body').innerHTML =
      '<nav class="breadcrumbs"><button data-file="">Repository</button>' +
      parts
        .map(p => {
          acc += (acc ? '/' : '') + p;
          return '<span>/</span><button data-file="' + esc(acc) + '">' + esc(p) + '</button>';
        })
        .join('') +
      '</nav>';
    if (d.directory) {
      $('#code-body').insertAdjacentHTML(
        'beforeend',
        '<div class="file-list">' +
          (path
            ? '<button data-file="' +
              esc(parts.slice(0, -1).join('/')) +
              '">↰ Parent directory</button>'
            : '') +
          d.entries
            .map(
              f =>
                '<button data-file="' +
                esc(f.path) +
                '">' +
                icon(f.directory ? 'repo' : 'code') +
                '<span>' +
                esc(f.name) +
                '</span>' +
                (f.directory ? icon('chevron') : '') +
                '</button>',
            )
            .join('') +
          '</div>' +
          (d.truncated ? '<p class="caption">Showing the first 300 entries.</p>' : ''),
      );
    } else {
      $('#code-body').insertAdjacentHTML('beforeend', fileView(d, path));
      $('#copy-file').onclick = () => copy(d.content);
    }
  } catch (e) {
    $('#code-body').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}
// A byte count, short.
const size = n =>
  n < 1024
    ? n + ' B'
    : n < 1048576
      ? (n / 1024).toFixed(1) + ' KB'
      : (n / 1048576).toFixed(1) + ' MB';
// A file: a compact header (name, size, lines, language, Wrap, Copy) over its numbered lines,
// coloured by highlight(), which leaves large files plain. A number is CSS (data-n), so
// selecting and copying lines never picks it up.
function fileView(d, path) {
  const name = path.split('/').at(-1),
    lang = detect({ path, code: d.content }),
    lines = highlight(lang, d.content).split('\n');
  return (
    '<div class="codehead filehead"><span class="file-name" title="' +
    esc(path) +
    '">' +
    esc(name) +
    '</span><span class="file-meta">' +
    size(d.bytes ?? d.content.length) +
    ' · ' +
    num(lines.length) +
    ' lines' +
    (lang ? ' · ' + lang : '') +
    '</span><span class="code-actions"><button type="button" class="wrap-toggle" title="Wrap long lines">Wrap</button><button type="button" id="copy-file">Copy</button></span></div><div class="source-scroll"><div class="source-lines" style="--digits:' +
    String(lines.length).length +
    '">' +
    lines.map((h, k) => '<div class="sl" data-n="' + (k + 1) + '">' + h + '</div>').join('') +
    '</div></div>'
  );
}
// The digest binds the action to reviewed file contents. The server re-exports
// and rechecks it; a model edit between review and click cannot be published.
export async function reviewPublish() {
  if (!state.session || state.session.kind === 'chat' || state.busy)
    return toast('Open an idle coding session first');
  $('#publish-body').innerHTML = '<p class="muted">Reading your working tree…</p>';
  $('#publish-dialog').showModal();
  try {
    const id = state.session.id,
      d = await api('/api/sessions/' + id + '/changes');
    $('#publish-body').innerHTML =
      '<p>Create a new branch and pull request in <strong>' +
      esc(d.repo) +
      '</strong>.</p><p class="caption">Base: ' +
      esc(d.ref) +
      ' · ' +
      esc(d.sourceSha.slice(0, 7)) +
      '</p><div class="publish-files">' +
      d.files
        .map(
          f =>
            '<details class="details" style="margin-left:0"><summary>' +
            esc(f.path) +
            ' <span class="tag">' +
            (f.deleted ? 'deleted' : num(f.bytes) + ' bytes') +
            '</span></summary><pre>' +
            esc(f.deleted ? 'This file will be deleted.' : f.content || '') +
            '</pre></details>',
        )
        .join('') +
      '</div><label class="caption">Branch<input id="publish-branch" value="arno/change-' +
      Date.now().toString(36) +
      '" class="field"></label><label class="caption">Commit and pull request title<input id="publish-title" maxlength="200" placeholder="Describe this change" class="field"></label><p class="caption">This creates a new GitHub branch. Review the diff in the conversation before publishing.</p><button id="publish-confirm" class="primary">Create branch & pull request</button><p id="publish-status" role="status"></p>';
    $('#publish-confirm').onclick = async () => {
      const b = $('#publish-confirm');
      b.disabled = true;
      $('#publish-status').textContent = 'Publishing reviewed changes…';
      try {
        const r = await api('/api/sessions/' + id + '/publish', {
          method: 'POST',
          body: JSON.stringify({
            digest: d.digest,
            branch: $('#publish-branch').value,
            title: $('#publish-title').value,
          }),
        });
        $('#publish-status').innerHTML =
          '<a target="_blank" rel="noopener noreferrer" href="' +
          esc(r.url) +
          '">Open on GitHub ↗</a>' +
          (r.warning ? '<p>' + esc(r.warning) + '</p>' : '');
        toast('Branch and commit created');
      } catch (e) {
        $('#publish-status').textContent = e.message;
        b.disabled = false;
      }
    };
  } catch (e) {
    $('#publish-body').innerHTML = '<p class="banner">' + esc(e.message) + '</p>';
  }
}
