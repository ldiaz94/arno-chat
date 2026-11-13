/** Search across every conversation, chats and coding sessions, from the field
 * at the top of the sidebar. It reads the copies offline.js keeps of each
 * conversation (the 'arno-data' cache of /api/sessions/<id>), so it works
 * offline and needs no index on the server; a conversation not kept yet is
 * found by its title only. Results show as you type, in place of the list;
 * opening one scrolls to the turn quoted. '/' or Ctrl/Cmd+Shift+F focuses the
 * field, Escape clears it.
 *
 *   focus ──> load (cache, each conversation prepared once per change)
 *   typing ──debounce──> fuzzy.search ──> results list
 *
 * Depends on core, layout, today.mjs, fuzzy.mjs and sessions (resume). Leaves out
 * search by meaning and a server-side index.
 */
import { $, state, esc, icon } from './core.js';
import { ago } from './today.mjs';
import { drawer } from './layout.js';
import { prepare, buildIndex, search } from './fuzzy.mjs';
import { resume } from './sessions.js';

const DATA_CACHE = 'arno-data'; // offline.js's cache of API replies
const DEBOUNCE = 120; // ms of quiet typing before searching
const field = $('#find'),
  results = $('#find-results'),
  sidebar = $('.sidebar');

const prepared = new Map(); // id -> {key, doc}: each conversation prepared once per change
let index = null, // the index of what was last loaded
  loading = null, // the load in progress, if any
  timer = 0;

/** The kept reply of /api/sessions/<id>, or null. */
async function saved(id) {
  try {
    const r = await caches.match('/api/sessions/' + id, {
      cacheName: DATA_CACHE,
      ignoreVary: true,
    });
    return r ? await r.json() : null;
  } catch {
    return null; // no Cache API (an insecure origin)
  }
}

/** One conversation prepared for search, from the open one, its kept copy or,
 * failing both, its list entry; a copy is reused while it is unchanged. */
async function prepareOne(row) {
  const key = row.updatedAt + ':' + row.title;
  if (row.id === state.session?.id) return prepare({ ...row, ...state.session });
  if (prepared.get(row.id)?.key === key) return prepared.get(row.id).doc;
  const s = await saved(row.id);
  const doc = prepare({ ...row, ...s, title: row.title, updatedAt: row.updatedAt });
  if (s) prepared.set(row.id, { key, doc });
  return doc;
}

/** Rebuilds the index from every listed conversation. */
function load() {
  loading ??= Promise.all(state.sessions.map(prepareOne))
    .then(docs => (index = buildIndex(docs)))
    .finally(() => (loading = null));
  return loading;
}

/** A text with [start, end) ranges wrapped in <mark>, escaped. */
function marked(text, ranges = []) {
  let html = '',
    at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    html += esc(text.slice(at, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
    at = b;
  }
  return html + esc(text.slice(at));
}

/** One result as a button: title, mode and time, and the snippet. */
function row(r, i) {
  return (
    '<button type="button" class="find-hit" data-hit="' +
    i +
    '"><strong>' +
    marked(r.title, r.titleRanges) +
    '</strong><small>' +
    (r.kind === 'chat' ? 'Chat' : 'Code') +
    ' · <time>' +
    ago(r.at) +
    '</time></small>' +
    (r.snippet
      ? '<span class="find-snippet">' + marked(r.snippet.text, r.snippet.ranges) + '</span>'
      : '') +
    '</button>'
  );
}

let shown = []; // the results on screen
/** Searches for what the field holds and shows the results, or the list again
 * when it is empty. */
async function run() {
  const query = field.value.trim();
  sidebar.classList.toggle('finding', !!query);
  results.hidden = !query;
  if (!query) return;
  if (!index) await load();
  if (field.value.trim() !== query) return; // typed on meanwhile
  shown = search(index, query);
  results.innerHTML = shown.length
    ? shown.map(row).join('')
    : '<div class="empty caption">Nothing matches “' + esc(query) + '”.</div>';
}

/** Empties the field and shows the list again. */
function clear() {
  field.value = '';
  run();
}

/** Opens a result's conversation and scrolls to the turn it quotes. */
async function open(r) {
  await resume(r.id);
  const turn = r.turn && $('#thread .turn.user[data-at="' + r.turn + '"]');
  if (!turn) return;
  turn.scrollIntoView({ block: 'start' });
  turn.classList.add('found');
  setTimeout(() => turn.classList.remove('found'), 2000);
}

$('#find-icon').innerHTML = icon('search');
// Each focus loads what changed since, so new turns and conversations are found.
field.onfocus = () => load().then(run);
field.oninput = () => {
  clearTimeout(timer);
  timer = setTimeout(run, DEBOUNCE);
};
field.onkeydown = e => {
  if (e.key === 'Escape' && field.value) {
    e.stopPropagation(); // not also leave edit mode or close the drawer
    clear();
  } else if (e.key === 'Enter' && shown.length) open(shown[0]);
};
results.onclick = e => {
  const hit = e.target.closest('[data-hit]');
  if (hit) open(shown[Number(hit.dataset.hit)]);
};
// '/' (outside a text field) or Ctrl/Cmd+Shift+F focuses the field.
document.addEventListener('keydown', e => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]'),
    slash = e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey,
    find = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f';
  if ((!slash && !find) || document.querySelector('dialog[open]:modal')) return;
  e.preventDefault();
  drawer(true); // on a phone the sidebar is a drawer
  field.focus();
  field.select();
});
