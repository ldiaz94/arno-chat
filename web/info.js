/** The "Conversation details" panel: context fill, usage, sources, shared links, images and
 * repository identity of the open conversation, in the `#usage-dialog`. Depends on core and
 * thread (source preview) and attach. Artifacts are listed from the server and open in the artifact dialog.
 */
import { $, state, esc, num, duration, money, api } from './core.js';
import { openSources } from './thread.js';
import { attachmentsHtml } from './attach.js';

const MarkdownImage = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BareLink = /https?:\/\/[^\s<>()[\]"'`]+/g;
const ImagePath = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

// Session totals, or a minimal stand-in for sessions saved before stats existed.
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
// A titled block of the panel.
function section(heading, body) {
  return body ? '<div class="section-title"><h2>' + heading + '</h2></div>' + body : '';
}
function domain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
// host + path, cut to fit one line.
function shortUrl(url) {
  try {
    const u = new URL(url),
      text = domain(url) + (u.pathname === '/' ? '' : u.pathname) + u.search;
    return text.length > 60 ? text.slice(0, 59) + '…' : text;
  } catch {
    return url.slice(0, 60);
  }
}
function link(url, inner) {
  return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>';
}
// Prompts and summaries of every turn, in order.
function texts(history) {
  return history.flatMap(t => [t.prompt, t.summary]).filter(Boolean);
}

// Input tokens of the latest turn that recorded them, against the model's window.
function contextSection(history) {
  const used = history.findLast(t => t.usage?.lastInputTokens > 0)?.usage.lastInputTokens,
    window = state.session?.contextWindow;
  if (!used) return '';
  const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : null;
  return section(
    'Context',
    '<p class="context-fill"><b>' +
      (pct == null
        ? num(used) + ' tokens'
        : num(used) + ' of ' + num(window) + ' tokens (' + pct + '%)') +
      '</b></p>' +
      (pct == null
        ? ''
        : '<div class="meter' +
          (pct > 80 ? ' warn' : '') +
          '" role="progressbar" aria-label="Context used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
          pct +
          '"><span style="width:' +
          pct +
          '%"></span></div>') +
      '<p class="caption">' +
      (state.session?.kind === 'chat'
        ? 'Chats send up to the last 20 turns (32,000 characters of history).'
        : 'Coding sessions send bounded repository context.') +
      '</p>',
  );
}
// What a session's (and its last turn's) cost is made of; parts are recorded
// per turn from this feature on, so older sessions show only the total.
const COST_PARTS = [
  ['input', 'Input tokens'],
  ['cached', 'Cached input'],
  ['cacheWrite', 'Cache writes'],
  ['output', 'Output tokens'],
  ['search', 'Web searches'],
  ['reads', 'Page reads'],
];
function costBreakdown(stats, last) {
  const session = stats.costParts,
    turn = last?.usage?.costParts;
  if (!session && !turn) return '';
  const rows = COST_PARTS.filter(([k]) => session?.[k] || turn?.[k]);
  return (
    '<div class="eyebrow">Cost breakdown</div><div class="table-wrap"><table class="cost-table"><thead><tr><th></th><th class="num">Session</th><th class="num">Last turn</th></tr></thead><tbody>' +
    rows
      .map(
        ([k, label]) =>
          '<tr><td>' +
          label +
          '</td><td class="num">' +
          (session ? money(session[k] || 0) : '—') +
          '</td><td class="num">' +
          (turn ? money(turn[k] ?? null) : '—') +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table></div>'
  );
}
function usageSection(history) {
  const stats = sessionStats(),
    last = history.at(-1);
  return section(
    'Usage',
    '<div class="stat-grid">' +
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
        .map(([k, v]) => '<div class="metric"><b>' + v + '</b><span>' + k + '</span></div>')
        .join('') +
      '</div>' +
      costBreakdown(stats, history.filter(t => !t.failed).at(-1)) +
      '<p class="caption">Tokens are reported by the selected provider. A dash means usage was not recorded. Historical turns may have incomplete usage. Cost uses each model’s list price on the day of the turn (the pricing pages of Ollama, Google, DeepSeek, Mistral and Meta; Anthropic, OpenAI and Kimi via OpenRouter); unpriced turns used a model missing from those tables. Ollama’s and DeepSeek’s off-peak rates apply to turns saved off-peak. Web searches and page reads use the per-request rates Ollama actually billed this account (from its usage data).</p>' +
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
        : '<p class="caption">Timing measurements will appear after a new turn.</p>'),
  );
}
// Cited sources of all turns, one per url, renumbered across the conversation.
function allSources(history) {
  const seen = new Map();
  for (const s of history.flatMap(t => t.sources || []))
    if (s?.url && !seen.has(s.url)) seen.set(s.url, { ...s, id: seen.size + 1 });
  return [...seen.values()];
}
function sourcesSection(sources) {
  return section(
    'Sources',
    sources
      .map(
        s =>
          '<button type="button" class="info-row" data-info-source="' +
          s.id +
          '"><span class="source-number">' +
          s.id +
          '</span><span class="info-text">' +
          esc(s.title || s.url) +
          '</span><small>' +
          esc(domain(s.url)) +
          '</small></button>',
      )
      .join(''),
  );
}
function linksSection(history, sources) {
  const skip = new Set(sources.map(s => s.url)),
    links = new Set();
  for (const text of texts(history))
    for (const raw of text.replace(MarkdownImage, '').match(BareLink) || []) {
      const url = raw.replace(/[.,;:!?*_]+$/, '');
      if (!skip.has(url) && !ImagePath.test(url.split(/[?#]/)[0])) links.add(url);
    }
  return section(
    'Links shared',
    [...links]
      .map(url => '<div class="info-row">' + link(url, esc(shortUrl(url))) + '</div>')
      .join(''),
  );
}
// Markdown images of assistant summaries, shown through the same proxy as the thread.
function imagesSection(history) {
  const images = new Map();
  for (const t of history)
    for (const [, alt, url] of (t.summary || '').matchAll(MarkdownImage))
      if (!images.has(url)) images.set(url, alt);
  return section(
    'Images',
    images.size
      ? '<div class="info-images">' +
          [...images]
            .map(([url, alt]) =>
              link(
                url,
                '<img src="/api/image?url=' +
                  encodeURIComponent(url) +
                  '" alt="' +
                  esc(alt) +
                  '" loading="lazy" decoding="async" referrerpolicy="no-referrer">',
              ),
            )
            .join('') +
          '</div>'
      : '',
  );
}
// Every file the user attached to the conversation, once each.
function attachmentsSection(history) {
  const all = new Map(history.flatMap(t => t.attachments || []).map(a => [a.id, a])),
    list = [...all.values()],
    images = list.filter(a => a.kind === 'image'),
    files = list.filter(a => a.kind !== 'image'),
    html = id => attachmentsHtml(state.session.id, id);
  return section(
    'Attachments',
    (images.length ? '<div class="attach-grid">' + html(images) + '</div>' : '') +
      (files.length ? '<div class="attach-files">' + html(files) + '</div>' : ''),
  );
}
// Artifacts of the conversation, from the list route; rows open the artifact dialog.
function artifactRows(list) {
  return list
    .map(
      a =>
        '<button type="button" class="info-row artifact-row" data-artifact="' +
        esc(a.id) +
        '"><strong>' +
        esc(a.title) +
        '</strong><span>v' +
        a.version +
        ' · ' +
        new Date(a.updatedAt).toLocaleString() +
        '</span></button>',
    )
    .join('');
}
// Fills the Artifacts section once the list arrives; absent when there are none.
async function loadArtifacts(sessionId) {
  try {
    const { artifacts } = await api('/api/sessions/' + sessionId + '/artifacts');
    if (artifacts.length && state.session?.id === sessionId)
      $('#info-artifacts').innerHTML = section('Artifacts', artifactRows(artifacts));
  } catch {
    // The panel works without it.
  }
}
function repositorySection(s) {
  return s && s.kind !== 'chat'
    ? section(
        'Repository identity',
        '<p>' +
          link(s.remoteUrl || 'https://github.com/' + s.repo, esc(s.repo)) +
          '</p><div class="timing-row"><span>Branch</span><strong>' +
          esc(s.ref || 'main') +
          '</strong></div><div class="timing-row"><span>Source commit</span><strong>' +
          esc(s.sourceSha?.slice(0, 12) || 'Not recorded for this session') +
          '</strong></div><p class="caption">The workspace is imported from a GitHub snapshot. Git history and GitHub writes require the publishing workflow.</p>',
      )
    : '';
}
export function openInfo() {
  const s = state.session,
    history = s?.history || [],
    sources = allSources(history);
  $('#usage-heading').textContent = s?.title || s?.repo || 'Conversation details';
  $('#usage-body').innerHTML =
    contextSection(history) +
    usageSection(history) +
    sourcesSection(sources) +
    linksSection(history, sources) +
    imagesSection(history) +
    attachmentsSection(history) +
    '<div id="info-artifacts"></div>' +
    repositorySection(s);
  $('#usage-body').onclick = e => {
    const row = e.target.closest('[data-info-source]');
    if (row) openSources(sources, Number(row.dataset.infoSource));
  };
  $('#usage-dialog').showModal();
  if (s?.id) loadArtifacts(s.id);
}
