/** List prices in dollars per million tokens, fetched from the providers'
 * public tables and cached for a day: Ollama Cloud, Google Gemini, DeepSeek,
 * Mistral and Meta from their pricing pages; Anthropic, OpenAI and Kimi from
 * OpenRouter's model list, which republishes list prices as JSON (none of
 * them offers a price API, and Kimi's page draws its table in the browser).
 * OpenRouter's prices only fill in models a provider's own page lacks. A
 * turn's cost is computed when it is saved, so later price changes never
 * rewrite history. Ollama and DeepSeek bill less off-peak, outside weekday
 * windows their pages name; a turn is priced at the rate of the hour it was
 * saved.
 * Left out: long-context price tiers, DeepSeek's off-peak Chinese public
 * holidays (priced at peak), Kimi's cache-write TTL tiers; a model missing
 * from the tables has no cost rather than a guessed one.
 */
const DAY = 86400;
let memo = null;

/** Our provider prefix for OpenRouter's (and for our own) where other hosts
 * serve the same model names at other prices. */
const SCOPE = {
  deepseek: 'deepseek',
  kimi: 'kimi',
  moonshotai: 'kimi',
  mistral: 'mistral',
  mistralai: 'mistral',
  meta: 'meta',
};

/** Price keys ignore case, dated snapshots, Ollama's cloud tag, and the
 * dot/hyphen difference between "claude-opus-5.5" and "claude-opus-5-5".
 * DeepSeek, Kimi, Mistral and Meta keep their prefix ("deepseek/…"), so that
 * Ollama's price for the same open model never stands in for theirs. */
export function priceKey(model) {
  return String(model)
    .toLowerCase()
    .replace(/^(openai|anthropic|gemini|google)\//, '')
    .replace(/^(deepseek|kimi|moonshotai|mistralai|mistral|meta)\//, (_, p) => SCOPE[p] + '/')
    .replace(/[:-]cloud$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\./g, '-');
}

/** Rows of Ollama's model pricing table: name, input, cached input, output.
 * A "name (Off-Peak)" row becomes the offPeak rates of name's row, and the
 * page's sentence "outside 12:00 and 18:00 UTC on weekdays" its peak hours. */
export function parseOllama(html) {
  const cell = s =>
    s
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .trim();
  const dollars = s => (/^\$[\d.]+$/.test(s) ? Number(s.slice(1)) : null);
  const window = String(html).match(/outside (\d\d?):00 and (\d\d?):00 UTC/i),
    peak = [window ? [Number(window[1]), Number(window[2])] : [12, 18]];
  const rows = new Map(),
    offPeak = new Map();
  for (const tr of String(html)
    .split(/<tr[\s>]/)
    .slice(1)) {
    const cells = [...tr.split('</tr>')[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m =>
      cell(m[1]),
    );
    if (cells.length < 4) continue;
    const [inp, cached, out] = cells.slice(1, 4).map(dollars),
      off = /\(off-peak\)/i.test(cells[0]);
    if (inp != null && out != null)
      (off ? offPeak : rows).set(priceKey(cells[0].replace(/\(off-peak\)/i, '').trim()), {
        inp,
        cached: cached ?? inp,
        out,
      });
  }
  for (const [k, rates] of offPeak)
    if (rows.has(k)) rows.set(k, { ...rows.get(k), offPeak: rates, peak });
  return rows;
}

/** Whether a provider bills at off-peak rates at time at: weekends, and
 * weekdays outside every peak window [from, to) of hours (UTC). */
export function isOffPeak(at, peak) {
  const d = new Date(at),
    day = d.getUTCDay(),
    hour = d.getUTCHours();
  return day === 0 || day === 6 || !peak.some(([from, to]) => from <= hour && hour < to);
}

/** Markdown table rows as lists of trimmed cells. */
const tableRows = text =>
  String(text)
    .split('\n')
    .filter(line => line.startsWith('|'))
    .map(line =>
      line
        .split('|')
        .slice(1, -1)
        .map(cell => cell.trim()),
    );
const dollars = s => (/^\$[\d.]+$/.test(s) ? Number(s.slice(1)) : null);

/** DeepSeek's pricing page as Markdown (pricing.md): a table with a column
 * per model ("| MODEL | MODEL | MODEL | deepseek-flash(1) | … |") whose PRICING
 * rows give cache-hit input, cache-miss input and output, each at OFF-PEAK and
 * PEAK, and a sentence naming the peak hours ("Peak hours are 01:00 - 04:00
 * and 06:00 - 10:00 UTC, Monday through Friday"). */
export function parseDeepSeek(text) {
  const rows = tableRows(text),
    names = (rows.find(c => c[0] === 'MODEL') || []).slice(3),
    hours = String(text).match(/Peak hours are ([^.]*) UTC/)?.[1] || '',
    peak = [...hours.matchAll(/(\d\d):00 - (\d\d):00/g)].map(m => [Number(m[1]), Number(m[2])]);
  const rates = names.map(() => ({ peak: {}, off: {} }));
  for (const c of rows.filter(c => /^PRICING/.test(c[0]))) {
    const field = /CACHE HIT/.test(c[1]) ? 'cached' : /CACHE MISS/.test(c[1]) ? 'inp' : 'out',
      period = /OFF-PEAK/.test(c[2]) ? 'off' : 'peak';
    c.slice(3).forEach((cell, i) => rates[i] && (rates[i][period][field] = dollars(cell)));
  }
  const full = r => r.inp != null && r.cached != null && r.out != null;
  return new Map(
    names
      .map((name, i) => [name.replace(/\(\d+\)$/, ''), rates[i]])
      .filter(([, r]) => full(r.peak))
      .map(([name, r]) => [
        priceKey('deepseek/' + name),
        full(r.off) && peak.length ? { ...r.peak, offPeak: r.off, peak } : r.peak,
      ]),
  );
}

/** Mistral's pricing page as Markdown (pricing.md): rows of "| [Name](…) |
 * `api-name` | Input $0.7 /M Tokens<br>Cached input $0.07 /M Tokens<br>Output
 * $2.1 /M Tokens |"; rows priced per page, minute or character are skipped. */
export function parseMistral(text) {
  const rows = new Map();
  for (const [, name = '', cell = ''] of tableRows(text)) {
    const id = name.match(/^`([^`]+)`$/)?.[1];
    if (!id) continue;
    const rate = label =>
      dollars(cell.match(new RegExp('(?:^|>)' + label + ' (\\$[\\d.]+) /M Tokens'))?.[1] || '');
    const inp = rate('Input'),
      out = rate('Output');
    if (inp != null && out != null)
      rows.set(priceKey('mistral/' + id), { inp, cached: rate('Cached input') ?? inp, out });
  }
  return rows;
}

/** Meta's pricing page as Markdown (pricing-rate-limits.md): a "### Model"
 * section per family whose "Models:" line names its ids in backticks, then a
 * table of Cached input / Input / Output rows with a Contributor-mode and a
 * Standard-mode column; "-contributor" ids take the Contributor column. */
export function parseMeta(text) {
  const rows = new Map();
  for (const section of String(text).split(/^### /m).slice(1)) {
    const ids = [...(section.match(/^Models?: (.*)$/m)?.[1] || '').matchAll(/`([^`]+)`/g)],
      table = Object.fromEntries(
        tableRows(section)
          .filter(c => c.length >= 3)
          .map(c => [c[0], { contributor: dollars(c[1]), standard: dollars(c[2]) }]),
      );
    for (const [, id] of ids) {
      const mode = /-contributor$/.test(id) ? 'contributor' : 'standard',
        [inp, out, cached] = ['Input', 'Output', 'Cached input'].map(k => table[k]?.[mode]);
      if (inp != null && out != null)
        rows.set(priceKey('meta/' + id), { inp, cached: cached ?? inp, out });
    }
  }
  return rows;
}

/** Rows of Google's Gemini pricing page, served as Markdoc at pricing.md: a
 * "## Name {% id="model" %}" section per model, whose first tab (Standard)
 * holds a table of "* label / * free tier / * paid tier" rows split by "---".
 * A paid cell may list prices for prompt-size tiers (the first, smaller tier
 * is taken) or for dates ("$0.75 through December 31, 2026. $1.50 starting
 * January 1, 2027"); dated prices become a schedule that priceOf resolves. */
export function parseGemini(text) {
  const day = d => Date.parse(d + ' UTC');
  const schedule = cell =>
    cell
      .split('\n')
      .filter(line => /\$[\d.]/.test(line) && !/per hour|storage/i.test(line))
      .map(line => {
        const through = line.match(/through (\w+ \d+, \d{4})/),
          starting = line.match(/starting (\w+ \d+, \d{4})/);
        return {
          dollars: Number(line.match(/\$([\d.]+)/)[1]),
          from: starting ? day(starting[1]) : -Infinity,
          to: through ? day(through[1]) + 86400000 : Infinity,
        };
      });
  const rows = new Map();
  for (const section of String(text)
    .split(/^## .*\{% id="/m)
    .slice(1)) {
    const id = section.slice(0, section.indexOf('"')),
      standard = section.split('{% /tab %}')[0],
      found = {};
    for (const row of standard.split(/^\s*---\s*$/m)) {
      const cells = row.split(/^\s*\* /m).slice(1);
      if (cells.length < 3) continue;
      const field = /^Input price/.test(cells[0])
        ? 'inp'
        : /^Output price/.test(cells[0])
          ? 'out'
          : /^Context caching price/.test(cells[0])
            ? 'cached'
            : null;
      if (field) found[field] = schedule(cells[2]);
    }
    if (found.inp?.length && found.out?.length)
      rows.set(priceKey(id), { schedule: { cached: found.inp, ...found } });
  }
  return rows;
}

/** OpenRouter quotes dollars per token as strings. Only makers' own models
 * are taken: OpenRouter's DeepSeek ids are priced by other hosts (DeepSeek's
 * page covers its API), as are Meta's open Llama ids (meta-llama/). */
export function parseOpenRouter(data) {
  const rows = new Map(),
    perM = s => (s == null ? null : Number(s) * 1e6);
  for (const m of data?.data || []) {
    const id = String(m.id),
      p = m.pricing || {};
    if (
      !/^(anthropic|openai|google|moonshotai|mistralai|meta)\/[^:]+$/.test(id) ||
      perM(p.prompt) == null ||
      perM(p.completion) == null
    )
      continue;
    rows.set(priceKey(id), {
      inp: perM(p.prompt),
      cached: perM(p.input_cache_read) ?? perM(p.prompt),
      write: perM(p.input_cache_write) ?? perM(p.prompt),
      out: perM(p.completion),
      window: m.context_length || null,
    });
  }
  return rows;
}

/** Both tables, from Cloudflare's cache when it holds a copy under a day old. */
export async function prices(upstream = fetch) {
  if (memo && Date.now() - memo.at < DAY * 1000) return memo.rows;
  const get = async (url, parse, type) => {
    try {
      const r = await upstream(url, {
        signal: AbortSignal.timeout(8000),
        cf: { cacheTtl: DAY, cacheEverything: true },
      });
      return r.ok ? parse(await r[type]()) : new Map();
    } catch {
      return new Map();
    }
  };
  const [ollama, router, ...pages] = await Promise.all([
    get('https://ollama.com/pricing', parseOllama, 'text'),
    get('https://openrouter.ai/api/v1/models', parseOpenRouter, 'json'),
    get('https://aistudio.google.com/docs/pricing.md', parseGemini, 'text'),
    get('https://api-docs.deepseek.com/quick_start/pricing.md', parseDeepSeek, 'text'),
    get('https://docs.mistral.ai/inference/pricing.md', parseMistral, 'text'),
    get('https://dev.meta.ai/docs/pricing-rate-limits.md', parseMeta, 'text'),
  ]);
  const rows = new Map([...ollama, ...router]);
  for (const page of pages)
    for (const [k, row] of page) rows.set(k, { window: router.get(k)?.window ?? null, ...row });
  if (rows.size) memo = { at: Date.now(), rows };
  return rows;
}

/** A model's price at time at, falling back to its family ("gemma4:31b" to
 * "gemma4"), at off-peak rates when they apply, and at the dated rates in
 * force when the price has a schedule. */
export function priceOf(rows, model, at = Date.now()) {
  const k = priceKey(model),
    price = rows.get(k) ?? rows.get(k.split(':')[0]) ?? null;
  if (price?.schedule) {
    const pick = list => list.find(p => p.from <= at && at < p.to)?.dollars;
    const { inp, cached, out } = price.schedule;
    return pick(inp) == null || pick(out) == null
      ? null
      : { inp: pick(inp), cached: pick(cached) ?? pick(inp), out: pick(out) };
  }
  return price?.offPeak && isOffPeak(at, price.peak) ? price.offPeak : price;
}

/** One provider usage report as uncached input, cache reads, cache writes and
 * output. OpenAI-style reports count cache reads (and Kimi's cache_write_tokens)
 * inside prompt_tokens; Anthropic counts neither in input_tokens. DeepSeek
 * names its cache reads prompt_cache_hit_tokens, mirrored in cached_tokens. */
export function tokens(u = {}) {
  const inside = u.prompt_tokens_details?.cache_write_tokens ?? 0,
    cached =
      u.cache_read_input_tokens ??
      u.prompt_tokens_details?.cached_tokens ??
      u.prompt_cache_hit_tokens ??
      0,
    write = u.cache_creation_input_tokens ?? inside;
  const input = u.prompt_tokens != null ? u.prompt_tokens - cached - inside : (u.input_tokens ?? 0);
  // Gemini leaves thinking out of completion_tokens; total_tokens still counts it.
  const output =
    u.prompt_tokens != null && u.total_tokens != null
      ? Math.max(u.completion_tokens ?? 0, u.total_tokens - u.prompt_tokens)
      : (u.completion_tokens ?? u.output_tokens ?? 0);
  return { input: Math.max(0, input), cached, write, output };
}

/** Dollars for a turn's usage, or null when the model has no listed price. */
/** Ollama's web search and page-read fees in dollars each. They aren't on its
 * pricing page, so they are derived from what the account was actually billed:
 * ollama.com/api/usage?group_by=model (undocumented, used by its usage page)
 * lists web_search and web_fetch with request counts and dollars. Cached for a
 * day per isolate; these fallbacks are the rates observed on 2026-11-09. */
export const WEB_RATES = { search: 0.011, fetch: 0.001 };
let webMemo = null;
export async function webRates(key, upstream = fetch) {
  if (webMemo && Date.now() - webMemo.at < DAY * 1000) return webMemo.rates;
  const rates = { ...WEB_RATES };
  try {
    const r = await upstream('https://ollama.com/api/usage?group_by=model', {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(5000),
    });
    const totals = {};
    for (const bucket of r.ok ? (await r.json()).buckets || [] : [])
      for (const g of bucket.groups || []) {
        const t = (totals[g.model] ||= { usd: 0, n: 0 });
        t.usd += g.usage_usd || 0;
        t.n += g.request_count || 0;
      }
    if (totals.web_search?.n) rates.search = totals.web_search.usd / totals.web_search.n;
    if (totals.web_fetch?.n) rates.fetch = totals.web_fetch.usd / totals.web_fetch.n;
    if (r.ok) webMemo = { at: Date.now(), rates };
  } catch {
    // keep the fallback rates
  }
  return rates;
}

/** A turn's cost by part, in dollars: model input (uncached), cached input,
 * cache writes, output, web searches and page reads. Model parts are null
 * when the model has no listed price. */
export function costParts(price, usage, webUsage, rates = WEB_RATES) {
  const { inputTokens = 0, cachedTokens = 0, cacheWriteTokens = 0, outputTokens = 0 } = usage || {};
  const priced = !!price && !!usage?.measuredCalls,
    part = (tokens, rate) => (priced ? (tokens * rate) / 1e6 : null);
  return {
    input: part(inputTokens - cachedTokens - cacheWriteTokens, price?.inp),
    cached: part(cachedTokens, price?.cached),
    cacheWrite: part(cacheWriteTokens, price?.write ?? price?.inp),
    output: part(outputTokens, price?.out),
    search: (webUsage?.searches || 0) * rates.search,
    reads: (webUsage?.reads || 0) * rates.fetch,
  };
}

/** Dollars for a turn's model usage, or null when the model has no listed price. */
export function cost(price, usage) {
  if (!price || !usage?.measuredCalls) return null;
  const { inputTokens = 0, cachedTokens = 0, cacheWriteTokens = 0, outputTokens = 0 } = usage;
  return (
    ((inputTokens - cachedTokens - cacheWriteTokens) * price.inp +
      cachedTokens * price.cached +
      cacheWriteTokens * (price.write ?? price.inp) +
      outputTokens * price.out) /
    1e6
  );
}
