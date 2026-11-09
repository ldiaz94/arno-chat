/** The conversation thread: message rendering, follow-the-stream scrolling, source
 * previews and the starter suggestions. Depends on core, turns and render.mjs.
 */
import { markdown, cleanOutput, diffHtml } from './render.mjs';
import { $, state, esc, icon, num, duration, modelName, money, copy, main } from './core.js';
import { editMessage, retry } from './turns.js';
import { attachmentsHtml } from './attach.js';
import { artifactCard } from './artifacts.js';
function diffCounts(diff) {
  const lines = (diff || '').split('\n');
  return {
    add: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
    remove: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
    files: lines.filter(l => l.startsWith('diff --git')).length,
  };
}
export function message(role, text, result = {}) {
  const node = document.createElement('article');
  node.className = 'turn ' + (role === 'You' ? 'user' : 'assistant');
  const stamp = result.at
    ? new Date(result.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '';
  node.innerHTML =
    '<div class="turn-header"><div class="avatar">' +
    (role === 'You' ? esc((state.user?.login || 'Y').slice(0, 1).toUpperCase()) : 'a') +
    '</div><strong>' +
    role +
    '</strong>' +
    (role === 'Arno'
      ? '<small>' + esc(modelName(result.model || state.session?.model)) + '</small>'
      : '') +
    '<span class="spacer"></span><small>' +
    stamp +
    '</small></div>';
  if (role === 'You') {
    node.innerHTML += '<div class="user-content">' + esc(text) + '</div>';
    node._attachments = result.attachments || [];
    if (node._attachments.length)
      node.innerHTML +=
        '<div class="message-attachments">' +
        attachmentsHtml(state.session.id, node._attachments) +
        '</div>';
    if (result.at) node.dataset.at = result.at;
    if (state.session?.kind === 'chat') {
      node
        .querySelector('.spacer')
        .insertAdjacentHTML('afterend', '<button type="button" class="edit-message">Edit</button>');
      node.querySelector('.edit-message').onclick = () => editMessage(node, text);
    }
  } else {
    const cleaned = cleanOutput(text);
    if (result.reasoning)
      node.innerHTML +=
        '<details class="model-thinking"><summary>Thinking <span>Provided by the model</span></summary><div class="thinking-text">' +
        esc(result.reasoning) +
        '</div></details>';
    node.innerHTML +=
      '<div class="prose">' +
      markdown(cleaned || 'Task finished without a text response.', result.sources || []) +
      '</div>';
    node._sources = result.sources || [];
    if (node._sources.length)
      node.innerHTML +=
        '<div class="source-strip">' +
        node._sources
          .slice(0, 3)
          .map(
            s =>
              '<button class="source-card" type="button" data-citation="' +
              s.id +
              '"><span class="source-domain">' +
              esc(sourceDomain(s.url)) +
              ' <b>' +
              s.id +
              '</b></span><strong>' +
              esc(s.title || s.url) +
              '</strong></button>',
          )
          .join('') +
        (node._sources.length > 3
          ? '<button class="source-card" data-all-sources>View all ' +
            node._sources.length +
            ' sources</button>'
          : '') +
        '</div>';
    if (result.artifacts?.length)
      node.innerHTML +=
        '<div class="artifact-cards">' + result.artifacts.map(artifactCard).join('') + '</div>';
    const u = result.usage,
      t = result.timing,
      counts = diffCounts(result.diff);
    node.innerHTML +=
      '<div class="turn-footer"><span>' +
      icon('check') +
      ' ' +
      (result.exitCode ? 'Finished with errors' : 'Completed') +
      '</span>' +
      (t ? '<span>' + duration(t.totalMs) + '</span>' : '') +
      (u?.measuredCalls
        ? '<span>' + num((u.inputTokens || 0) + (u.outputTokens || 0)) + ' tokens</span>'
        : '') +
      (u?.cost != null ? '<span>' + money(u.cost) + '</span>' : '') +
      '<button type="button" class="copy-answer" aria-label="Copy answer">' +
      icon('copy') +
      ' Copy</button></div>';
    if (result.diff)
      node.innerHTML +=
        '<details class="details"><summary>' +
        counts.files +
        ' changed file' +
        (counts.files === 1 ? '' : 's') +
        ' <span class="tag">+' +
        counts.add +
        ' −' +
        counts.remove +
        '</span></summary><div class="diff-view">' +
        diffHtml(result.diff) +
        '</div></details>';
    if (result.diagnostics || cleaned !== String(text || '').trim())
      node.innerHTML +=
        '<details class="details"><summary>Execution details</summary><pre>' +
        esc((result.diagnostics || '') + '\n' + text) +
        '</pre></details>';
    node.querySelector('.copy-answer').onclick = () => copy(cleaned);
  }
  $('#thread').append(node);
  scrollDown();
  return node;
}
// Follow the stream only while the reader is at the bottom: scrolling up stops
// following, scrolling back down (or sending) resumes it. Jumps are instant so
// a smooth scroll in progress never reads as the reader leaving the bottom.
let following = true;
main.addEventListener(
  'scroll',
  () => {
    following = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
  },
  { passive: true },
);
/** A failed or stopped turn, shown after its message, with Retry. at is the
 * saved failure's time (known once the session is refreshed), which the retry
 * names so the server replaces the failed record. attachments are resent with it. */
export function failure(text, error, at, attachments = []) {
  const node = document.createElement('div');
  node.className = 'failure';
  node.setAttribute('role', 'alert');
  node.innerHTML =
    '<p>' +
    esc(error || 'This turn failed.') +
    '</p><div class="failure-actions"><button type="button" class="primary">Retry</button></div>';
  if (at) node.dataset.at = at;
  node._attachments = attachments;
  node.querySelector('button').onclick = () => retry(node, text);
  $('#thread').append(node);
  scrollDown();
  return node;
}
export function scrollDown(force = false) {
  if (force) following = true;
  if (following) main.scrollTo({ top: main.scrollHeight, behavior: 'instant' });
}
function sourceDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
}
export function openSources(sources, id) {
  const ordered = id
    ? [...sources].sort((a, b) => Number(b.id === id) - Number(a.id === id))
    : sources;
  $('#sources-body').innerHTML = ordered
    .map(
      s =>
        '<article class="source-preview"><div class="source-domain"><span class="source-number">' +
        s.id +
        '</span>' +
        esc(sourceDomain(s.url)) +
        '</div><h3>' +
        esc(s.title || s.url) +
        '</h3><p>' +
        esc(s.excerpt || 'Open the original page to read this source.') +
        '</p><a href="' +
        esc(s.url) +
        '" target="_blank" rel="noopener noreferrer">Read original source ↗</a><small class="caption">' +
        (s.retrievedAt ? 'Retrieved ' + new Date(s.retrievedAt).toLocaleString() : '') +
        '</small></article>',
    )
    .join('');
  $('#sources-dialog').showModal();
}
export function suggestions() {
  if (state.session?.kind === 'chat')
    return (
      '<div class="starter"><div class="mark">a</div><h2>A little space to think.</h2><p class="muted">Chat with your cloud model. No repository, tools, or coding container needed.</p><div class="suggestions">' +
      [
        'Help me brainstorm an idea',
        'Explain something step by step',
        'Help me write better',
        'Let’s solve a problem together',
      ]
        .map(s => '<button data-suggest="' + esc(s) + '">' + esc(s) + '</button>')
        .join('') +
      '</div></div>'
    );
  return (
    '<div class="starter"><div class="mark">a</div><h2>What shall we build?</h2><p class="muted">Your repository is ready. Ask a question, make a change, or run a check.</p><div class="suggestions">' +
    [
      'Explain this repository',
      'Find bugs and suggest fixes',
      'Run the tests and explain failures',
      'Review the architecture',
    ]
      .map(s => '<button data-suggest="' + esc(s) + '">' + icon('code') + esc(s) + '</button>')
      .join('') +
    '</div></div>'
  );
}
