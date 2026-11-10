/** Artifact dialog: a titled Markdown document the model made, with its versions, and
 * Copy, Download .md, Download .csv (first table) and Print. Depends on core and render.mjs.
 */
import { markdown, tableResize } from './render.mjs';
import { $, state, esc, icon, api, copy, showError } from './core.js';

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
// Offers text as a file download.
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' })),
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
// A timestamp as the reader's local date and time.
const when = ms => new Date(ms).toLocaleString();
let shown = null; // {title, content} of the version on screen

// Paints one version into the dialog.
function show(art, v) {
  shown = v;
  $('#artifact-heading').textContent = v.title;
  $('#artifact-meta').textContent = 'Version ' + v.version + ' · updated ' + when(v.updatedAt);
  $('#artifact-content').innerHTML = markdown(v.content);
  tableResize($('#artifact-content'));
  $('#artifact-csv').hidden = !tableCsv(v.content);
}
/** Opens the artifact id of a conversation, at version (default the latest). */
export async function openArtifact(sessionId, id, version) {
  const dialog = $('#artifact-dialog');
  $('#artifact-heading').textContent = 'Artifact';
  $('#artifact-meta').textContent = 'Loading…';
  $('#artifact-content').innerHTML = '';
  $('#artifact-csv').hidden = true;
  $('#artifact-versions').hidden = true;
  if (!dialog.open) dialog.showModal();
  try {
    const art = await api('/api/sessions/' + sessionId + '/artifacts/' + id),
      versions = [art, ...(art.previous || []).slice().reverse()],
      select = $('#artifact-versions');
    select.innerHTML = versions
      .map(v => '<option value="' + v.version + '">Version ' + v.version + '</option>')
      .join('');
    select.hidden = versions.length < 2;
    const first = versions.find(v => v.version === Number(version)) || art;
    select.value = String(first.version);
    select.onchange = () =>
      show(
        art,
        versions.find(v => String(v.version) === select.value),
      );
    show(art, first);
  } catch (e) {
    dialog.close();
    showError(e);
  }
}
$('#artifact-copy').onclick = () => shown && copy(shown.content);
$('#artifact-md').onclick = () =>
  shown && download(slug(shown.title) + '.md', shown.content, 'text/markdown');
$('#artifact-csv').onclick = () =>
  shown && download(slug(shown.title) + '.csv', tableCsv(shown.content), 'text/csv');
$('#artifact-print').onclick = () => window.print();

/** Card for an artifact a turn made; clicking it (see app.js) opens the dialog. */
export function artifactCard(a) {
  return (
    '<button type="button" class="artifact-card" data-artifact="' +
    esc(a.id) +
    '" data-version="' +
    Number(a.version) +
    '">' +
    icon('doc') +
    '<strong>' +
    esc(a.title) +
    '</strong>' +
    (a.version > 1 ? '<span class="tag">v' + Number(a.version) + '</span>' : '') +
    '</button>'
  );
}
/** Artifact buttons (cards, links, rows) open the dialog for the open session. */
export function artifactClick(e) {
  const b = e.target.closest('[data-artifact]');
  if (b && state.session) openArtifact(state.session.id, b.dataset.artifact, b.dataset.version);
  return !!b;
}
