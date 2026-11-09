/** List prices in dollars per million tokens, fetched from the providers'
 * public tables and cached for a day: Ollama Cloud and Google Gemini from their
 * pricing pages, Anthropic and OpenAI from OpenRouter's model list, which
 * republishes their list prices as JSON (neither provider offers a price API).
 * OpenRouter's Gemini prices only fill in models Google's page lacks. A turn's cost is
 * computed when it is saved, so later price changes never rewrite history.
 * Ollama bills some models less off-peak, outside a weekday window the page
 * names; a turn is priced at the rate of the hour it was saved.
 * Left out: long-context price tiers; a model
 * missing from the tables has no cost rather than a guessed one.
 */
const DAY = 86400;
let memo = null;

/** Price keys ignore case, dated snapshots, Ollama's cloud tag, and the
 * dot/hyphen difference between "claude-opus-5.5" and "claude-opus-5-5". */
export function priceKey(model) {
  return String(model)
    .toLowerCase()
    .replace(/^(openai|anthropic|gemini|google)\//, '')
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
    peak = window ? [Number(window[1]), Number(window[2])] : [12, 18];
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

/** Whether Ollama bills at off-peak rates at time at: weekends, and weekdays
 * outside the peak hours (UTC). */
export function isOffPeak(at, [from, to]) {
  const d = new Date(at),
    day = d.getUTCDay(),
    hour = d.getUTCHours();
  return day === 0 || day === 6 || hour < from || hour >= to;
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

/** OpenRouter quotes dollars per token as strings. */
export function parseOpenRouter(data) {
  const rows = new Map(),
    perM = s => (s == null ? null : Number(s) * 1e6);
  for (const m of data?.data || []) {
    const id = String(m.id),
      p = m.pricing || {};
    if (
      !/^(anthropic|openai|google)\/[^:]+$/.test(id) ||
      perM(p.prompt) == null ||
      perM(p.completion) == null
    )
      continue;
    rows.set(priceKey(id.split('/')[1]), {
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
  const [ollama, router, gemini] = await Promise.all([
    get('https://ollama.com/pricing', parseOllama, 'text'),
    get('https://openrouter.ai/api/v1/models', parseOpenRouter, 'json'),
    get('https://aistudio.google.com/docs/pricing.md', parseGemini, 'text'),
  ]);
  const rows = new Map([...ollama, ...router]);
  for (const [k, row] of gemini) rows.set(k, { window: router.get(k)?.window ?? null, ...row });
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
 * output. OpenAI counts cached tokens inside prompt_tokens; Anthropic does not. */
export function tokens(u = {}) {
  const cached = u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    write = u.cache_creation_input_tokens ?? 0;
  const input = u.prompt_tokens != null ? u.prompt_tokens - cached : (u.input_tokens ?? 0);
  // Gemini leaves thinking out of completion_tokens; total_tokens still counts it.
  const output =
    u.prompt_tokens != null && u.total_tokens != null
      ? Math.max(u.completion_tokens ?? 0, u.total_tokens - u.prompt_tokens)
      : (u.completion_tokens ?? u.output_tokens ?? 0);
  return { input: Math.max(0, input), cached, write, output };
}

/** Dollars for a turn's usage, or null when the model has no listed price. */
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
