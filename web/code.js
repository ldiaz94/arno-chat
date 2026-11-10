/** The code dialog: file browser, changes, the checkout's commit history and
 * the review-and-publish flow. Depends on core, render.mjs, highlight.mjs and
 * today.mjs.
 */
import { diffHtml, diffCounts } from './render.mjs';
import { highlight, detect } from './highlight.mjs';
import { $, state, esc, icon, num, api, toast, copy } from './core.js';
import { ago } from './today.mjs';
// Opens the code dialog (docked beside the thread on wide screens) on a tab: files, diff or
// history.
export function openCode(tab = 'files', publish = false) {
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
  else if (tab === 'diff') changes(publish);
  else browse('');
}
/** The Changes tab: what GitHub does not have yet, read from the workspace
 * now (the session's commits not pushed and its edits not committed; work
 * pulled from upstream and other sessions' pushes are not in it), with a bar
 * to pull and to open a pull request from them, in place. */
async function changes(publish = false) {
  const id = state.session.id;
  $('#code-body').innerHTML = '<div class="loading">Reading the changes…</div>';
  try {
    const d = await api('/api/sessions/' + id + '/diff');
    if (state.session?.id !== id || !$('#diff-tab').matches('[aria-pressed="true"]')) return;
    const c = diffCounts(d.diff),
      any = !!d.diff.trim();
    $('#code-body').innerHTML =
      '<div class="changes-bar"><div class="changes-sum"><strong>' +
      (any ? num(c.files) + (c.files === 1 ? ' file' : ' files') + ' to push' : 'Nothing to push') +
      '</strong>' +
      (any ? ' <span class="tag">+' + num(c.add) + ' −' + num(c.remove) + '</span>' : '') +
      '<small>' +
      (any
        ? 'On ' + esc(d.ref || 'this branch') + ', not on GitHub yet'
        : 'The branch matches GitHub') +
      '</small></div><div class="changes-actions"><button type="button" class="ghost" data-pull>' +
      icon('download') +
      ' Pull</button>' +
      (any
        ? '<button type="button" class="primary" data-pr>' +
          icon('branch') +
          ' Pull request…</button>'
        : '') +
      '</div></div><div id="pr-form" hidden></div>' +
      (any ? '<div class="diff-view panel-diff">' + diffHtml(d.diff) + '</div>' : '');
    $('#code-body [data-pr]')?.addEventListener('click', prForm);
    if (publish && any) prForm();
  } catch (e) {
    $('#code-body').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}
/** A branch name from a title: arno/ and the title's words, short. */
function branchFor(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return 'arno/' + (slug || 'change-' + Date.now().toString(36));
}
/** The pull request form, above the diff: the files that will go (exactly
 * those reviewed: the server checks their digest), a title, and the branch,
 * named after the title until edited. Opens a new branch and pull request on
 * the commit the changes start from. */
async function prForm() {
  const form = $('#pr-form'),
    id = state.session.id;
  if (!form) return;
  if (state.busy) return toast('Wait for the turn to finish');
  form.hidden = false;
  form.innerHTML = '<p class="caption">Reading the files to publish…</p>';
  $('#code-body [data-pr]')?.setAttribute('disabled', '');
  try {
    const d = await api('/api/sessions/' + id + '/changes');
    if (state.session?.id !== id) return;
    form.innerHTML =
      '<div class="pr-head"><strong>New pull request</strong><span class="caption">into ' +
      esc(d.ref) +
      ' on ' +
      esc(d.repo) +
      '</span></div><label>Title<input id="publish-title" class="field" maxlength="200" placeholder="What this change does"></label><label>Branch<input id="publish-branch" class="field" maxlength="76" value="' +
      esc(branchFor('')) +
      '"></label><ul class="pr-files">' +
      d.files
        .map(
          f =>
            '<li><code>' +
            esc(f.path) +
            '</code><span class="caption">' +
            (f.deleted ? 'deleted' : num(f.bytes) + ' bytes') +
            '</span></li>',
        )
        .join('') +
      '</ul><div class="pr-actions"><button type="button" class="primary" id="publish-confirm" disabled>Create pull request</button><button type="button" class="ghost" id="publish-cancel">Cancel</button></div><p class="caption" id="publish-status" role="status">A new branch from ' +
      esc(d.sourceSha.slice(0, 7)) +
      ', so nothing on ' +
      esc(d.ref) +
      ' changes until the pull request is merged.</p>';
    const title = $('#publish-title'),
      branch = $('#publish-branch'),
      go = $('#publish-confirm');
    let named = false; // the branch was edited by hand
    branch.oninput = () => (named = true);
    title.oninput = () => {
      if (!named) branch.value = branchFor(title.value);
      go.disabled = !title.value.trim();
    };
    title.focus();
    $('#publish-cancel').onclick = () => {
      form.hidden = true;
      $('#code-body [data-pr]')?.removeAttribute('disabled');
    };
    go.onclick = async () => {
      go.disabled = true;
      $('#publish-status').textContent = 'Opening the pull request…';
      try {
        const r = await api('/api/sessions/' + id + '/publish', {
          method: 'POST',
          body: JSON.stringify({ digest: d.digest, branch: branch.value, title: title.value }),
        });
        form.innerHTML =
          '<div class="pr-done">' +
          icon('check') +
          '<div><strong>Pull request opened</strong><small>' +
          esc(r.branch) +
          ' · ' +
          esc(r.commit.slice(0, 7)) +
          '</small>' +
          (r.warning ? '<small>' + esc(r.warning) + '</small>' : '') +
          '</div><a class="button primary" target="_blank" rel="noopener noreferrer" href="' +
          esc(r.url) +
          '">Open on GitHub ↗</a></div>';
        toast('Pull request opened');
      } catch (e) {
        $('#publish-status').textContent = e.message;
        go.disabled = false;
      }
    };
  } catch (e) {
    form.innerHTML = '<p class="caption">' + esc(e.message) + '</p>';
    $('#code-body [data-pr]')?.removeAttribute('disabled');
  }
}
/** Brings GitHub's new commits on the session's branch into its workspace
 * (server/code/code-routes.mjs pull), and says how it went. */
export async function pull() {
  if (!state.session || state.session.kind === 'chat') return;
  toast('Pulling from GitHub…');
  try {
    const d = await api('/api/sessions/' + state.session.id + '/pull', {
      method: 'POST',
      body: '{}',
    });
    toast(
      d.status === 'up-to-date'
        ? 'Already up to date with GitHub'
        : 'Pulled ' + d.commits + ' commit' + (d.commits === 1 ? '' : 's') + ' from GitHub',
    );
    if ($('#history-tab').matches('[aria-pressed="true"]')) openCode('history');
  } catch (e) {
    toast(
      e.data?.status === 'conflict'
        ? 'Not pulled: GitHub’s changes conflict with yours in ' +
            e.data.files.join(', ') +
            '. Ask Arno to merge and resolve them.'
        : e.message,
    );
  }
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
      (d.behind
        ? '<p class="history-note pull-note">' +
          num(d.behind) +
          ' new commit' +
          (d.behind === 1 ? '' : 's') +
          ' on GitHub (' +
          esc(d.ref || 'this branch') +
          ') <button type="button" class="primary" data-pull>Pull</button></p>'
        : '') +
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
// One commit of the history list, as a button.
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
// Shows a folder or file of the checkout in the dialog. An empty path is the top folder.
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
