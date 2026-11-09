/** The "Usage" view: spend summary, per-model totals and a per-request report for every
 * provider (`/api/usage/requests`), plus the Ollama account's own balance and usage
 * (`/api/usage/ollama`). Depends on core, layout and (through the `data-session` click
 * handler in app.js) sessions.
 */
import { $, state, esc, num, money, api, main, composer } from './core.js';
import { busy, drawer, title, sidebar } from './layout.js';

const Day = 86400000;
const PageSize = 100;
const Ranges = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
];
const Filters = [
  ['all', 'All'],
  ['model', 'Models'],
  ['tool', 'Search & reads'],
];

// What the view shows right now; reset each time it opens.
let view = { requests: [], ollama: null, note: '', range: '7d', filter: 'all', shown: PageSize };

// Start of the local day, or `days` days back from now.
function since(range) {
  if (range === 'today') return new Date().setHours(0, 0, 0, 0);
  return Date.now() - (range === '7d' ? 7 : 30) * Day;
}
// Cost of the requests since a time; unpriced requests count as zero.
function spent(requests, from) {
  return requests.filter(r => r.at >= from).reduce((sum, r) => sum + (r.cost || 0), 0);
}
// 'now', '5m', '2h', '3d' for a time in ms.
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < Day / 1000) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / (Day / 1000)) + 'd';
}
// Costs under a cent read '<$0.01', as on ollama.com.
function cost(n) {
  return n == null ? '—' : n > 0 && n < 0.01 ? '<$0.01' : money(n);
}
// Cached input as a share of input.
function cachePct(r) {
  return r.input > 0 && r.cached != null ? Math.round((r.cached / r.input) * 100) + '%' : '—';
}
function chips(list, current, attr) {
  return (
    '<div class="chips" role="group">' +
    list
      .map(
        ([k, label]) =>
          '<button type="button" class="chip" data-' +
          attr +
          '="' +
          k +
          '" aria-pressed="' +
          (k === current) +
          '">' +
          label +
          '</button>',
      )
      .join('') +
    '</div>'
  );
}

// Spend today / 7 days / 30 days.
function summaryCards() {
  return (
    '<div class="overview">' +
    Ranges.map(
      ([k, label]) =>
        '<div class="metric"><b>' +
        money(spent(view.requests, since(k))) +
        '</b><span>' +
        label +
        '</span></div>',
    ).join('') +
    '</div>'
  );
}
// Requests, tokens and cost per model (or tool) over the selected range.
function byModel() {
  const rows = new Map();
  for (const r of view.requests.filter(r => r.at >= since(view.range))) {
    const t = rows.get(r.model) || {
      model: r.model,
      n: 0,
      input: 0,
      cached: 0,
      output: 0,
      cost: 0,
    };
    t.n++;
    t.input += r.input || 0;
    t.cached += r.cached || 0;
    t.output += r.output || 0;
    t.cost += r.cost || 0;
    rows.set(r.model, t);
  }
  const list = [...rows.values()].sort((a, b) => b.cost - a.cost || b.n - a.n);
  return (
    '<div class="section-title"><h2>By model</h2>' +
    chips(Ranges, view.range, 'range') +
    '</div>' +
    (list.length
      ? '<div class="table-wrap"><table><thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Cached</th><th class="num">Output</th><th class="num">Cost</th></tr></thead><tbody>' +
        list
          .map(
            t =>
              '<tr><td>' +
              esc(t.model) +
              '</td><td class="num">' +
              num(t.n) +
              '</td><td class="num">' +
              num(t.input) +
              '</td><td class="num">' +
              num(t.cached) +
              '</td><td class="num">' +
              num(t.output) +
              '</td><td class="num">' +
              cost(t.cost) +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>'
      : '<p class="caption">No requests in this range.</p>')
  );
}
function requestRow(r) {
  return (
    '<tr><td title="' +
    esc(new Date(r.at).toLocaleString()) +
    '">' +
    ago(r.at) +
    '</td><td>' +
    esc(r.model) +
    '</td><td>' +
    (r.sessionId
      ? '<button type="button" class="link" data-session="' +
        esc(r.sessionId) +
        '">' +
        esc(r.title || 'Untitled') +
        '</button>'
      : esc(r.title || '—')) +
    '</td><td class="num">' +
    num(r.input ?? undefined) +
    '</td><td class="num">' +
    cachePct(r) +
    '</td><td class="num">' +
    num(r.output ?? undefined) +
    '</td><td class="num">' +
    cost(r.cost) +
    '</td></tr>'
  );
}
function recent() {
  const rows = view.requests.filter(
    r => view.filter === 'all' || (view.filter === 'model') === (r.kind === 'model'),
  );
  return (
    '<div class="section-title"><h2>Recent requests</h2>' +
    chips(Filters, view.filter, 'filter') +
    '</div>' +
    (rows.length
      ? '<div class="table-wrap"><table id="recent-requests"><thead><tr><th>Time</th><th>Model</th><th>Conversation</th><th class="num">Input</th><th class="num">Cache</th><th class="num">Output</th><th class="num">Cost</th></tr></thead><tbody>' +
        rows.slice(0, view.shown).map(requestRow).join('') +
        '</tbody></table></div>' +
        (rows.length > view.shown
          ? '<button type="button" class="ghost" data-usage-more>Show more (' +
            (rows.length - view.shown) +
            ' left)</button>'
          : '')
      : '<p class="caption">No requests yet.</p>')
  );
}

// Per-model spend over the account's last 7 days, from its daily buckets.
function accountSpend(usage) {
  const sums = new Map();
  for (const b of usage?.buckets || [])
    for (const g of b.groups || [])
      sums.set(g.model, (sums.get(g.model) || 0) + (g.usage_usd || 0));
  const list = [...sums].sort((a, b) => b[1] - a[1]);
  return list.length
    ? '<div class="eyebrow">Last 7 days</div>' +
        list
          .map(
            ([m, usd]) =>
              '<div class="timing-row"><span>' + esc(m) + '</span><b>' + cost(usd) + '</b></div>',
          )
          .join('')
    : '';
}
function ollamaCard() {
  const o = view.ollama;
  if (view.note) return '<p class="caption">' + esc(view.note) + '</p>';
  if (!o) return '';
  const inc = o.balance?.included,
    bought = o.balance?.purchased?.balance_usd,
    pct = inc?.allowance_usd > 0 ? Math.round((inc.balance_usd / inc.allowance_usd) * 100) : null;
  return (
    '<div class="card ollama-card"><div class="eyebrow">Ollama account</div>' +
    (inc
      ? '<p class="context-fill"><b>' +
        esc(money(inc.balance_usd)) +
        ' of ' +
        esc(money(inc.allowance_usd)) +
        ' left</b></p>' +
        (pct == null
          ? ''
          : '<div class="meter' +
            (pct < 20 ? ' warn' : '') +
            '" role="progressbar" aria-label="Included balance left" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
            Math.min(100, pct) +
            '"><span style="width:' +
            Math.min(100, Math.max(0, pct)) +
            '%"></span></div>') +
        (inc.period?.until
          ? '<p class="caption">Resets ' +
            esc(new Date(inc.period.until).toLocaleDateString()) +
            '</p>'
          : '')
      : '') +
    (bought > 0 ? '<p>Purchased balance: <b>' + esc(money(bought)) + '</b></p>' : '') +
    accountSpend(o.usage) +
    '<p class="caption">From Ollama’s own usage data (ollama.com/api/usage); counts all use of this key, not only this app. Key: ' +
    (o.source === 'account' ? 'your account key' : 'the deployment’s key') +
    '.</p></div>'
  );
}

function render() {
  main.innerHTML =
    '<div class="home usage-view">' +
    ollamaCard() +
    summaryCards() +
    byModel() +
    recent() +
    '</div>';
}
// Failed requests become a note; a 404 (no Ollama key) shows nothing.
function ollamaNote(e) {
  return e?.status === 404 ? '' : 'Ollama’s account usage is unavailable right now.';
}
export async function openUsage() {
  ++state.generation;
  state.search++;
  state.session = null;
  state.job = null;
  busy(false);
  drawer(false);
  $('#code-dialog').close();
  composer.hidden = true;
  title('Usage', 'Requests and spend');
  sidebar();
  view = { requests: [], ollama: null, note: '', range: '7d', filter: 'all', shown: PageSize };
  main.innerHTML = '<div class="loading"><span class="spinner"></span><p>Loading usage…</p></div>';
  const gen = state.generation;
  const [reqs, ollama] = await Promise.allSettled([
    api('/api/usage/requests'),
    api('/api/usage/ollama'),
  ]);
  if (gen !== state.generation) return;
  view.requests = reqs.status === 'fulfilled' ? reqs.value.requests || [] : [];
  if (ollama.status === 'fulfilled') view.ollama = ollama.value;
  else view.note = ollamaNote(ollama.reason);
  render();
  if (reqs.status === 'rejected')
    main.firstChild.insertAdjacentHTML(
      'afterbegin',
      '<p class="caption">' + esc(reqs.reason.message) + '</p>',
    );
}

main.addEventListener('click', e => {
  const range = e.target.closest('[data-range]'),
    filter = e.target.closest('[data-filter]');
  if (!main.querySelector('.usage-view')) return;
  if (range) view.range = range.dataset.range;
  else if (filter) {
    view.filter = filter.dataset.filter;
    view.shown = PageSize;
  } else if (e.target.closest('[data-usage-more]')) view.shown += PageSize;
  else return;
  render();
});
