/** Artifacts in the browser: the cards a turn shows, the viewer and the gallery.
 *
 *   card (thread.js) ─┐
 *   row (info.js) ────┼─► viewer: kind · title · versions ‹ v2 of 3 ›
 *   gallery tile ─────┘     Preview | Source | Changes   Copy Download Open Print
 *
 * The viewer docks beside the chat on a wide screen and fills a phone's.
 * Markdown and code it draws itself (render.mjs, highlight.mjs); an HTML page
 * or a Mermaid diagram it frames from the server's sandboxed page of it, an
 * SVG or an image it shows from there (server/probe/artifacts.mjs
 * viewResponse). Changes is the diff from the version before (linediff.mjs);
 * an earlier version can be restored as the newest. The gallery lists every
 * artifact of every conversation (GET /api/artifacts), searchable and by
 * kind. Depends on core, render.mjs, highlight.mjs, linediff.mjs, today.mjs
 * and sessions (to go to an artifact's conversation).
 */
import { markdown, tableResize, diffHtml } from './render.mjs';
import { highlight, detect } from './highlight.mjs';
import { lineDiff } from './linediff.mjs';
import { $, state, esc, icon, api, copy, showError, toast, prompt } from './core.js';
import { ago } from './today.mjs';
import { resume } from './sessions.js';
import { canSpeak, speak, stopSpeaking } from './voice.js';

/** Each kind: its icon, its name, the extension it downloads with, its
 * MIME type and the language its source is coloured as. */
const KIND = {
  markdown: ['doc', 'Document', 'md', 'text/markdown', 'markdown'],
  html: ['page', 'Page', 'html', 'text/html', 'html'],
  svg: ['drawing', 'Drawing', 'svg', 'image/svg+xml', 'xml'],
  mermaid: ['diagram', 'Diagram', 'mmd', 'text/plain', ''],
  code: ['code', 'Code', 'txt', 'text/plain', ''],
  image: ['image', 'Image', 'png', 'image/png', ''],
};
const kindOf = a => KIND[a.kind] || KIND.markdown;
/** Kinds shown from the server's page of them rather than drawn here. */
const FRAMED = new Set(['html', 'mermaid']),
  PICTURED = new Set(['svg', 'image']);
/** What an iframe showing an artifact's page may do (the page's own policy
 * says the same). */
const SANDBOX =
  'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-forms';

// A table row's cells, honouring \| escapes; null when the line is not a row.
function cells(line) {
  if (!line.includes('|')) return null;
  const row = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (line[i] === '|') {
      row.push(cur.trim());
      cur = '';
    } else cur += line[i];
  }
  row.push(cur.trim());
  if (line.trim().startsWith('|')) row.shift();
  if (line.trim().endsWith('|') && !line.trim().endsWith('\\|')) row.pop();
  return row;
}
// A Markdown table's delimiter row, such as |---|:--:|.
const Separator = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
// RFC 4180: quote a cell holding a comma, quote or line break; double its quotes.
const csvCell = c => (/[",\r\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c);
/** The first Markdown table of text as CSV, or '' when there is none. */
export function tableCsv(text) {
  const lines = String(text).split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!cells(lines[i]) || !Separator.test(lines[i + 1]) || !lines[i + 1].includes('-')) continue;
    const rows = [cells(lines[i])];
    for (let j = i + 2; j < lines.length && cells(lines[j]); j++) rows.push(cells(lines[j]));
    return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  return '';
}
// Offers data (text, or bytes) as a file download.
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// A file-name-safe form of a title.
const slug = t =>
  (t || 'artifact')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'artifact';
/** The name an artifact downloads as: its file's, or its title's with the
 * kind's extension (a code file's language, when it is one). */
function fileName(a) {
  if (a.path) return a.path.split('/').pop();
  const ext =
    a.kind === 'code' && /^[a-z0-9+#]{1,10}$/i.test(a.language || '')
      ? a.language.toLowerCase()
      : kindOf(a)[2];
  return slug(a.title) + '.' + ext;
}
/** The language an artifact's text is coloured as. */
const languageOf = a =>
  a.kind === 'code' ? detect({ fence: a.language || '' }) || a.language : kindOf(a)[4];
/** The address of the server's page showing version v of artifact a of
 * session sid (a Mermaid diagram's in the app's theme). */
function viewUrl(sid, a, v = a.version) {
  return (
    '/api/sessions/' +
    sid +
    '/artifacts/' +
    a.id +
    '?v=' +
    v +
    '&view' +
    (a.kind === 'mermaid'
      ? '&theme=' + (document.body.classList.contains('light') ? 'light' : 'dark')
      : '')
  );
}
/** "Page · v2", what a card or a row says of an artifact. */
const kindLine = a =>
  kindOf(a)[1] +
  (a.kind === 'code' && a.language ? ' · ' + a.language : '') +
  (a.version > 1 ? ' · v' + a.version : '');

// --- The viewer --------------------------------------------------------------------------------

const dialog = $('#artifact-dialog');
/** What the viewer shows: the session, the version on screen (with the
 * artifact's list of versions), the view, and versions fetched before. */
let cur = null,
  held = false; // opened modal on purpose (over the gallery): it stays so

/** Opens artifact id of session sid at version (default the newest) in the
 * viewer, docked beside the chat on a wide screen unless modal is asked. */
export async function openArtifact(sid, id, version, modal = false) {
  const dock = !modal && innerWidth >= 1100 && !document.querySelector('dialog[open]:modal');
  if (!dialog.open) {
    held = modal || !!document.querySelector('dialog[open]:modal');
    if (dock) {
      $('#code-dialog').close(); // one panel docks at a time
      dialog.show();
      document.body.classList.add('artifact-open');
    } else dialog.showModal();
  }
  $('#artifact-heading').textContent = 'Artifact';
  $('#artifact-meta').textContent = 'Loading…';
  $('#artifact-content').innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  try {
    // The newest first (the copy kept offline), then the version asked for.
    const art = await api('/api/sessions/' + sid + '/artifacts/' + id);
    cur = { sid, art, view: cur?.art.id === id ? cur.view : 'preview', seen: new Map() };
    cur.seen.set(art.version, art);
    if (Number(version) && Number(version) !== art.version)
      cur.art = await fetchVersion(Number(version)).catch(() => art);
    if (cur.view === 'changes' && !older()) cur.view = 'preview';
    paint();
  } catch (e) {
    dialog.close();
    showError(e);
  }
}
/** Shows version v of the artifact on screen. */
async function showVersion(v) {
  const art = cur.seen.get(v) || (await fetchVersion(v));
  cur.art = art;
  if (cur.view === 'changes' && !older()) cur.view = 'preview';
  paint();
}
/** Version v of the artifact on screen, fetched once. */
async function fetchVersion(v) {
  const art = await api('/api/sessions/' + cur.sid + '/artifacts/' + cur.art.id + '?v=' + v);
  cur.seen.set(v, art);
  return art;
}
/** The number of the version before the one on screen, or 0. */
function older() {
  const list = cur.art.versions,
    at = list.findIndex(v => v.version === cur.art.version);
  return list[at + 1]?.version || 0;
}
/** The number of the version after the one on screen, or 0. */
function newer() {
  const list = cur.art.versions,
    at = list.findIndex(v => v.version === cur.art.version);
  return at > 0 ? list[at - 1].version : 0;
}
/** Draws the viewer for cur. */
function paint() {
  const a = cur.art,
    [glyph, name] = kindOf(a),
    textual = a.kind !== 'image';
  $('#artifact-kind').innerHTML = icon(glyph);
  $('#artifact-kind').dataset.kind = a.kind;
  $('#artifact-heading').textContent = a.title;
  $('#artifact-meta').textContent =
    name +
    (a.kind === 'code' && a.language ? ' · ' + a.language : '') +
    (a.path ? ' · ' + a.path : '') +
    ' · ' +
    ago(a.updatedAt);
  $('#artifact-version').textContent = 'v' + a.version + ' of ' + a.latest;
  $('#artifact-versions').hidden = a.versions.length < 2;
  $('#artifact-older').disabled = !older();
  $('#artifact-newer').disabled = !newer();
  $('#artifact-old').hidden = a.version === a.latest;
  for (const b of dialog.querySelectorAll('[data-view]')) {
    b.setAttribute('aria-pressed', String(b.dataset.view === cur.view));
    b.disabled =
      (b.dataset.view === 'source' && !textual) ||
      (b.dataset.view === 'changes' && (!textual || !older()));
    if (b.dataset.view === 'changes') b.title = textual && !older() ? 'No earlier version' : '';
  }
  $('#artifact-copy').hidden = !textual;
  $('#artifact-csv').hidden = a.kind !== 'markdown' || !tableCsv(a.content);
  $('#artifact-tab').hidden = !FRAMED.has(a.kind) && !PICTURED.has(a.kind);
  $('#artifact-print').hidden = a.kind !== 'markdown';
  $('#artifact-listen').hidden = !canSpeak || !['markdown', 'html'].includes(a.kind);
  $('#artifact-goto').hidden = cur.sid === state.session?.id;
  $('#artifact-download').title = 'Download ' + fileName(a);
  dialog.dataset.kind = a.kind;
  dialog.dataset.view = cur.view;
  body();
}
/** Draws the viewer's body: the preview, the source or the changes. */
async function body() {
  const a = cur.art,
    box = $('#artifact-content');
  cur.errors = []; // a page loaded afresh reports afresh
  problems();
  if (cur.view === 'source')
    box.innerHTML =
      '<pre class="artifact-code"><code>' + highlight(languageOf(a), a.content) + '</code></pre>';
  else if (cur.view === 'changes') {
    box.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    const shown = a,
      before = await fetchVersion(older()).catch(() => null);
    if (cur.art !== shown || cur.view !== 'changes') return;
    const diff = before && lineDiff(before.content, a.content, fileName(a));
    box.innerHTML = diff
      ? '<p class="artifact-diff-head">From v' +
        before.version +
        ' to v' +
        a.version +
        '</p><div class="diff-view">' +
        diffHtml(diff) +
        '</div>'
      : '<div class="empty">' +
        (before ? 'The text is the same as v' + before.version : 'Could not load it') +
        '</div>';
  } else if (FRAMED.has(a.kind))
    box.innerHTML =
      '<iframe class="artifact-frame" sandbox="' +
      SANDBOX +
      '" src="' +
      viewUrl(cur.sid, a) +
      '" title="' +
      esc(a.title) +
      '"></iframe>';
  else if (PICTURED.has(a.kind))
    box.innerHTML =
      '<div class="artifact-stage"><img src="' +
      viewUrl(cur.sid, a) +
      '" alt="' +
      esc(a.title) +
      '"></div>';
  else if (a.kind === 'code')
    box.innerHTML =
      '<pre class="artifact-code"><code>' + highlight(languageOf(a), a.content) + '</code></pre>';
  else {
    box.innerHTML = '<div class="prose artifact-prose">' + markdown(a.content) + '</div>';
    tableResize(box);
  }
}
/** Makes the version on screen the newest, as a new version. */
async function restore() {
  try {
    const r = await api('/api/sessions/' + cur.sid + '/artifacts/' + cur.art.id, {
      method: 'POST',
      body: JSON.stringify({ version: cur.art.version }),
    });
    toast('Restored as v' + r.version);
    openArtifact(cur.sid, cur.art.id);
  } catch (e) {
    showError(e);
  }
}

// The tools' icons.
for (const [id, glyph] of [
  ['copy', 'copy'],
  ['download', 'download'],
  ['csv', 'chart'],
  ['tab', 'external'],
  ['print', 'print'],
  ['listen', 'speaker'],
  ['goto', 'chat'],
]) {
  const b = $('#artifact-' + id);
  b.setAttribute('aria-label', b.textContent.trim()); // the words go on a phone
  b.title = b.textContent.trim();
  b.insertAdjacentHTML('afterbegin', icon(glyph));
}
for (const b of dialog.querySelectorAll('[data-view]'))
  b.onclick = () => {
    cur.view = b.dataset.view;
    paint();
  };
$('#artifact-older').onclick = () => showVersion(older());
$('#artifact-newer').onclick = () => showVersion(newer());
$('#artifact-restore').onclick = restore;
$('#artifact-copy').onclick = () => copy(cur.art.content);
$('#artifact-download').onclick = () => {
  const a = cur.art;
  download(
    fileName(a),
    a.kind === 'image' ? Uint8Array.from(atob(a.content), c => c.charCodeAt(0)) : a.content,
    (a.kind === 'image' ? a.mime || 'image/png' : kindOf(a)[3]) +
      (a.kind === 'image' ? '' : ';charset=utf-8'),
  );
};
$('#artifact-csv').onclick = () =>
  download(slug(cur.art.title) + '.csv', tableCsv(cur.art.content), 'text/csv;charset=utf-8');
$('#artifact-tab').onclick = () => window.open(viewUrl(cur.sid, cur.art), '_blank', 'noopener');
$('#artifact-print').onclick = () => window.print();
// An HTML page is read by its text, its scripts and styles left out.
$('#artifact-listen').onclick = () => {
  const a = cur.art;
  let text = a.content;
  if (a.kind === 'html') {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    for (const n of doc.querySelectorAll('script, style, noscript')) n.remove();
    text = doc.body.innerText || doc.body.textContent;
  }
  speak(text, $('#artifact-listen'));
};
$('#artifact-wide').onclick = () => {
  const wide = document.body.classList.toggle('artifact-wide');
  $('#artifact-wide').setAttribute('aria-pressed', String(wide));
};
$('#artifact-goto').onclick = () => {
  const sid = cur.sid;
  $('#gallery-dialog').close();
  dialog.close();
  resume(sid);
};
let moving = false; // closed only to be shown again, docked or not
dialog.addEventListener('close', () => {
  if (moving) return void (moving = false);
  stopSpeaking();
  document.body.classList.remove('artifact-open', 'artifact-wide');
  $('#artifact-wide').setAttribute('aria-pressed', 'false');
  $('#artifact-content').innerHTML = ''; // stops a page that runs
});
// Docks or undocks an open viewer when the window crosses the width it docks at.
addEventListener('resize', () => {
  const docked = document.body.classList.contains('artifact-open');
  if (!dialog.open || !cur || held || docked === innerWidth >= 1100) return;
  moving = true;
  dialog.close();
  document.body.classList.toggle('artifact-open', !docked);
  if (docked) dialog.showModal();
  else dialog.show();
});
// A docked viewer is not modal, so Escape is not the browser's to close it.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && dialog.open && !dialog.matches(':modal')) dialog.close();
});

// --- Cards, rows and /open --------------------------------------------------------------------

/** A small picture of artifact a of session sid: an SVG or an image itself,
 * else its kind's icon. */
function thumb(sid, a) {
  return (
    '<span class="artifact-thumb" data-kind="' +
    esc(a.kind || 'markdown') +
    '">' +
    (PICTURED.has(a.kind) && sid
      ? '<img loading="lazy" alt="" src="' + viewUrl(sid, a) + '">'
      : icon(kindOf(a)[0])) +
    '</span>'
  );
}
/** Card for an artifact a turn made or changed; a click opens the viewer
 * (artifactClick). */
export function artifactCard(a) {
  return (
    '<button type="button" class="artifact-card" data-artifact="' +
    esc(a.id) +
    '" data-version="' +
    Number(a.version) +
    '">' +
    thumb(state.session?.id, a) +
    '<span class="artifact-card-text"><strong>' +
    esc(a.title) +
    '</strong><small>' +
    esc(kindLine(a)) +
    '</small>' +
    (a.preview ? '<span class="artifact-card-preview">' + esc(a.preview) + '</span>' : '') +
    '</span><span class="artifact-card-open">Open</span></button>'
  );
}
/** A live, usable preview of a page or diagram a turn made, under its card;
 * '' for other kinds. Shown on wide screens only (style.css), and loaded once
 * it scrolls into view (watchPreviews), so a phone never loads it. */
export function artifactPreview(a) {
  if (!FRAMED.has(a.kind) || !state.session) return '';
  return (
    '<div class="artifact-live"><iframe sandbox="' +
    SANDBOX +
    '" data-src="' +
    viewUrl(state.session.id, a) +
    '" title="' +
    esc(a.title) +
    ' (preview)"></iframe></div>'
  );
}
/** Loads root's previews as they come into view. */
export function watchPreviews(root) {
  for (const f of root.querySelectorAll('.artifact-live iframe[data-src]')) lazy.observe(f);
}
/** A row of the conversation details' artifacts (info.js). */
export function artifactRow(a) {
  return (
    '<button type="button" class="info-row artifact-row" data-artifact="' +
    esc(a.id) +
    '">' +
    thumb(state.session?.id, a) +
    '<span class="artifact-card-text"><strong>' +
    esc(a.title) +
    '</strong><small>' +
    esc(kindLine(a)) +
    ' · ' +
    ago(a.updatedAt) +
    '</small></span></button>'
  );
}
/** Artifact buttons (cards, links, rows) open the viewer for the open session. */
export function artifactClick(e) {
  const b = e.target.closest('[data-artifact]');
  if (b && state.session) openArtifact(state.session.id, b.dataset.artifact, b.dataset.version);
  return !!b;
}
/** /open [name]: opens the open conversation's artifact whose title or file
 * has name in it, or its newest. */
export async function openNamed(name) {
  const sid = state.session?.id;
  if (!sid) return;
  try {
    const { artifacts } = await api('/api/sessions/' + sid + '/artifacts'),
      word = name.trim().toLowerCase(),
      newest = artifacts.slice().sort((a, b) => b.updatedAt - a.updatedAt),
      found = word
        ? newest.find(a => (a.title + ' ' + (a.path || '')).toLowerCase().includes(word))
        : newest[0];
    if (found) openArtifact(sid, found.id);
    else toast(word ? 'No artifact called ' + name.trim() : 'No artifacts here yet');
  } catch (e) {
    showError(e);
  }
}

// --- The gallery -------------------------------------------------------------------------------

const gallery = $('#gallery-dialog');
let all = [], // every artifact, newest first
  kind = ''; // the kind shown, or '' for all

/** Opens the gallery of every conversation's artifacts. */
export async function openGallery() {
  $('#gallery-grid').innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  if (!gallery.open) gallery.showModal();
  try {
    ({ artifacts: all } = await api('/api/artifacts'));
    drawGallery();
  } catch (e) {
    $('#gallery-grid').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}
/** A gallery tile: a preview (the page itself, small, for a page or diagram),
 * the title and where it is from. */
function tile(a) {
  const framed = FRAMED.has(a.kind);
  return (
    '<button type="button" class="gallery-tile" data-gallery="' +
    esc(a.sessionId + ':' + a.id) +
    '"><span class="gallery-thumb" data-kind="' +
    esc(a.kind) +
    '">' +
    (framed
      ? '<iframe tabindex="-1" aria-hidden="true" sandbox="allow-scripts" data-src="' +
        viewUrl(a.sessionId, a) +
        '"></iframe>'
      : PICTURED.has(a.kind)
        ? '<img loading="lazy" alt="" src="' + viewUrl(a.sessionId, a) + '">'
        : '<span class="gallery-text' +
          (a.kind === 'code' ? ' mono' : '') +
          '">' +
          esc(a.preview || '') +
          '</span>') +
    '<span class="gallery-kind">' +
    icon(kindOf(a)[0]) +
    esc(kindOf(a)[1]) +
    '</span></span><span class="gallery-info"><strong>' +
    esc(a.title) +
    '</strong><small>' +
    esc(a.sessionTitle) +
    ' · ' +
    ago(a.updatedAt) +
    '</small></span></button>'
  );
}
// Frames a tile's page only once it is on screen.
const lazy = new IntersectionObserver(seen => {
  for (const s of seen)
    if (s.isIntersecting) {
      s.target.src = s.target.dataset.src;
      lazy.unobserve(s.target);
    }
});
/** Draws the gallery's kind chips and the tiles matching the search and kind. */
function drawGallery() {
  const word = $('#gallery-search').value.trim().toLowerCase(),
    kinds = [...new Set(all.map(a => a.kind))],
    shown = all.filter(
      a =>
        (!kind || a.kind === kind) &&
        (!word || (a.title + ' ' + a.preview + ' ' + a.sessionTitle).toLowerCase().includes(word)),
    );
  $('#gallery-kinds').innerHTML =
    kinds.length > 1
      ? ['', ...kinds]
          .map(
            k =>
              '<button type="button" class="chip" data-kind="' +
              k +
              '" aria-pressed="' +
              (k === kind) +
              '">' +
              (k ? kindOf({ kind: k })[1] + 's' : 'All · ' + all.length) +
              '</button>',
          )
          .join('')
      : '';
  $('#gallery-grid').innerHTML = shown.length
    ? shown.map(tile).join('')
    : '<div class="empty">' +
      (all.length
        ? 'Nothing matches'
        : 'No artifacts yet. Ask for a document, a page, a drawing or a diagram and it will be kept here.') +
      '</div>';
  for (const f of $('#gallery-grid').querySelectorAll('iframe[data-src]')) lazy.observe(f);
}
$('#gallery-search').addEventListener('input', drawGallery);
$('#gallery-kinds').addEventListener('click', e => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  kind = b.dataset.kind;
  drawGallery();
});
$('#gallery-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-gallery]');
  if (!b) return;
  const [sid, id] = b.dataset.gallery.split(':');
  openArtifact(sid, id, undefined, true);
});
gallery.addEventListener('close', () => ($('#gallery-grid').innerHTML = ''));

/** Most errors one page load reports. */
const MAX_PAGE_ERRORS = 20;
// An HTML artifact's page tells of its errors (REPORTER, server/probe/artifacts.mjs):
// they show above it, and go to the server a moment later, together, for the
// log and for the model's read_artifact.
addEventListener('message', e => {
  const frame = $('#artifact-content .artifact-frame'),
    m = e.data?.arnoPageError;
  if (!cur || !frame || e.source !== frame.contentWindow || typeof m !== 'string') return;
  if (cur.errors.includes(m) || cur.errors.length >= MAX_PAGE_ERRORS) return;
  cur.errors.push(m);
  problems();
  clearTimeout(cur.reportTimer);
  const { sid, art, errors } = cur;
  cur.reportTimer = setTimeout(
    () =>
      api('/api/sessions/' + sid + '/artifact-errors/' + art.id, {
        method: 'POST',
        body: JSON.stringify({ version: art.version, errors }),
      }).catch(() => {}), // best effort: the strip has shown them
    1500,
  );
});
/** The strip above a page that reported errors: how many, the list, and, in
 * the artifact's own conversation, a button that asks Arno to fix them. */
function problems() {
  const box = $('#artifact-problems'),
    errors = cur?.errors || [];
  box.hidden = !errors.length;
  if (!errors.length) return (box.innerHTML = '');
  const here = cur.sid === state.session?.id;
  box.innerHTML =
    '<details><summary>' +
    errors.length +
    (errors.length === 1 ? ' problem' : ' problems') +
    ' on this page</summary><ul>' +
    errors.map(m => '<li>' + esc(m) + '</li>').join('') +
    '</ul></details>' +
    (here ? '<button type="button" class="ghost" id="artifact-fix">Fix with Arno</button>' : '');
  if (here) $('#artifact-fix').onclick = fix;
}
/** Puts a request to fix the page's errors in the composer, to read and send. */
function fix() {
  const a = cur.art;
  prompt.value =
    'Fix the artifact "' +
    a.title +
    '" (' +
    a.id +
    ', v' +
    a.version +
    '). When opened, its page showed:\n' +
    cur.errors.map(m => '- ' + m).join('\n');
  prompt.dispatchEvent(new Event('input')); // resizes it and keeps the draft
  if (dialog.matches(':modal')) dialog.close();
  prompt.focus();
}
