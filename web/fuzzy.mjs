/** Fuzzy search over conversations, with no DOM so test/test.mjs runs it in
 * Node. A query is split into words, and every word must match somewhere in a
 * conversation (in any order). A word matches a word of the text when its
 * letters appear there in order (fzf style), case and accents ignored; a run of
 * letters together, the start of a word and a hit in the title score higher,
 * and a query word of five or more letters also matches with one typo (one
 * letter added, dropped, changed or two swapped).
 *
 *   conversations ──prepare──> docs ──buildIndex──> {docs, vocab}
 *   vocab: word ──> docs it is in;  doc.words: word ──> its fields
 *   search(index, query) ──> [{id, title, titleRanges, snippet, turn, …}]
 *
 * Each distinct word of all the text is scored against a query word once, so a
 * search costs about the size of the vocabulary, not of the text. Depends on
 * nothing. Leaves out matching across words ("newyork" for "New York"),
 * phrases and search by meaning.
 */

const MAX_FIELD = 8000; // characters of one message or answer that are searched
const MAX_TOKEN = 32; // longer runs of letters (hashes, base64) are not words
const MIN_TYPO = 5; // a query word this long may match with one typo
const SNIPPET = 120; // characters a snippet shows
const LIMIT = 50; // results returned, at most
// How much a hit counts by where it is.
const WEIGHT = { title: 2, artifact: 1.5, prompt: 1.2, answer: 1 };
// The words of folded text: runs of letters and digits.
const WORD = /[\p{L}\p{N}]+/gu;

const folded = new Map(); // memo of foldChar
/** One UTF-16 unit, lowercased and without its accent; a unit that would not
 * stay one unit is only lowercased (or kept), so offsets never shift. */
function foldChar(c) {
  let f = folded.get(c);
  if (f === undefined) {
    f = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    if (f.length !== 1) f = c.toLowerCase().length === 1 ? c.toLowerCase() : c;
    folded.set(c, f);
  }
  return f;
}

/** Text lowercased and without accents, the same length as the text, so a
 * position in one is the same position in the other. Expects NFC text. */
export function fold(text) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase();
  let out = '';
  for (const c of text) out += c.length === 1 ? foldChar(c) : c;
  return out;
}

/** The words of a query, folded. */
export function queryWords(query) {
  return fold(String(query).normalize('NFC')).match(WORD) || [];
}

/** Whether a and b are at most one edit apart, counting two neighbouring
 * letters swapped as one edit (Damerau). */
export function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  const rest = (x, y) => a.slice(x) === b.slice(y);
  return (
    rest(i + 1, i + 1) || // changed
    rest(i + 1, i) || // added in a
    rest(i, i + 1) || // dropped from a
    (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2, i + 2)) // swapped
  );
}

/** Where q's letters fall in word, each as early as it can, as positions;
 * null when they don't all appear in order. */
function subsequence(q, word) {
  const at = [];
  for (let i = 0, j = 0; i < q.length; i++, j++) {
    j = word.indexOf(q[i], j);
    if (j < 0) return null;
    at.push(j);
  }
  return at;
}

/** How many separate runs the positions make: 1 when all are side by side. */
function runs(at) {
  let n = 1;
  for (let i = 1; i < at.length; i++) if (at[i] !== at[i - 1] + 1) n++;
  return n;
}

/** How well query word q matches word of the text, from 1 (the same word)
 * down to 0 (no match): the word itself, its start, inside it, its letters in
 * order (better in fewer runs and from its first letter) or one typo away,
 * whichever is best. A query word of one letter only matches the start of a
 * word, of two letters only inside one. */
export function wordScore(q, word) {
  if (word === q) return 1;
  const at = word.indexOf(q);
  if (at === 0) return 0.9;
  if (at > 0 && q.length > 1) return 0.7;
  if (q.length < 3) return 0;
  const letters = subsequence(q, word),
    inOrder = letters ? 0.2 + 0.3 / runs(letters) + (letters[0] === 0 ? 0.1 : 0) : 0,
    typo = q.length >= MIN_TYPO && oneEdit(q, word) ? 0.5 : 0;
  return Math.max(inOrder, typo);
}

/** The parts of word to highlight for query word q: the run it matches, its
 * letters, or the whole word for a typo; as [start, end) pairs. */
export function wordRanges(q, word) {
  const at = word.indexOf(q);
  if (at >= 0) return [[at, at + q.length]];
  const letters = subsequence(q, word);
  if (!letters) return [[0, word.length]];
  const ranges = [];
  for (const i of letters)
    if (ranges.length && ranges.at(-1)[1] === i) ranges.at(-1)[1]++;
    else ranges.push([i, i + 1]);
  return ranges;
}

/** One searchable text of a conversation: its title, an artifact's title, a
 * message (prompt) or an answer, and the turn it belongs to (its `at`). */
function field(kind, text, turn = null) {
  const original = String(text || '')
    .slice(0, MAX_FIELD)
    .normalize('NFC');
  return { kind, text: original, fold: fold(original), turn };
}

/** A conversation made ready to search, once per load: its fields, and for
 * each word the fields it is in and the weight of the best of them. Takes the reply of /api/sessions/<id> (or a list
 * entry, which has only the title): {id, title, repo, kind, updatedAt,
 * history: [{prompt, summary, at, failed}], artifacts: {id: {title}}}. */
export function prepare(s) {
  const fields = [field('title', s.title || s.repo)];
  // A named coding session is found by its repository too.
  if (s.title && s.repo) fields.push(field('title', s.repo));
  for (const a of Object.values(s.artifacts || {})) fields.push(field('artifact', a.title));
  for (const t of s.history || []) {
    fields.push(field('prompt', t.prompt, t.at));
    if (!t.failed) fields.push(field('answer', t.summary, t.at));
  }
  const words = new Map();
  fields.forEach((f, i) => {
    for (const [w] of f.fold.matchAll(WORD)) {
      if (w.length > MAX_TOKEN) continue;
      const seen = words.get(w);
      if (!seen) words.set(w, { weight: WEIGHT[f.kind], fields: [i] });
      else if (seen.fields.at(-1) !== i) {
        seen.fields.push(i);
        seen.weight = Math.max(seen.weight, WEIGHT[f.kind]);
      }
    }
  });
  return {
    id: s.id,
    kind: s.kind === 'chat' ? 'chat' : 'code',
    at: s.updatedAt || s.createdAt || 0,
    fields,
    words,
  };
}

/** The index of prepared conversations: each word with the conversations it
 * is in, and a memo of each query word's matches. */
export function buildIndex(docs) {
  const vocab = new Map();
  docs.forEach((d, i) => {
    for (const w of d.words.keys()) {
      const list = vocab.get(w);
      if (list) list.push(i);
      else vocab.set(w, [i]);
    }
  });
  return { docs, vocab, matches: new Map() };
}

/** The words of the index that query word q matches, with their scores. */
function matchesOf(index, q) {
  let found = index.matches.get(q);
  if (!found) {
    found = new Map();
    for (const w of index.vocab.keys()) {
      const s = wordScore(q, w);
      if (s) found.set(w, s);
    }
    index.matches.set(q, found);
  }
  return found;
}

/** The ranges to highlight in folded text for the query
 * words' matches, and the position of each hit with the query word it is for. */
function hitsIn(foldedText, qs, found) {
  const hits = [];
  for (const m of foldedText.matchAll(WORD)) {
    let best = 0,
      which = -1;
    qs.forEach((q, i) => {
      const s = found[i].get(m[0]) || 0;
      if (s > best) [best, which] = [s, i];
    });
    if (which >= 0)
      hits.push({
        at: m.index,
        q: which,
        score: best,
        ranges: wordRanges(qs[which], m[0]).map(([a, b]) => [m.index + a, m.index + b]),
      });
  }
  return hits;
}

/** About SNIPPET characters of field f around its hits, chosen to hold the
 * most query words, with the ranges to highlight in it; whitespace becomes
 * spaces and a cut end shows "…". */
function snippet(f, qs, found) {
  const hits = hitsIn(f.fold, qs, found);
  if (!hits.length) return null;
  let best = null;
  for (const h of hits.slice(0, 200)) {
    const a = Math.max(0, h.at - SNIPPET / 3),
      b = a + SNIPPET,
      inside = hits.filter(o => o.at >= a && o.at < b),
      words = new Set(inside.map(o => o.q)).size,
      score = words + inside.reduce((n, o) => Math.max(n, o.score), 0);
    if (!best || score > best.score) best = { score, a, b, inside };
  }
  const start = best.a,
    end = Math.min(f.text.length, Math.max(best.b, start + SNIPPET)),
    pre = start > 0 ? '…' : '',
    text = pre + f.text.slice(start, end).replace(/\s/g, ' ') + (end < f.text.length ? '…' : ''),
    shift = pre.length - start,
    ranges = best.inside
      .flatMap(h => h.ranges)
      .filter(([, b]) => b <= end)
      .map(([a, b]) => [a + shift, b + shift]);
  return { text, ranges };
}

/** For each conversation a hit is in, the best score of each query word in
 * it, weighted by where it is: Map<doc, [score per word]>. */
function tally(index, found) {
  const per = new Map();
  found.forEach((matches, qi) => {
    for (const [w, s] of matches)
      for (const d of index.vocab.get(w)) {
        let best = per.get(d);
        if (!best) per.set(d, (best = found.map(() => 0)));
        best[qi] = Math.max(best[qi], s * index.docs[d].words.get(w).weight);
      }
  });
  return per;
}

/** The field of doc to quote: the one, after the titles, where the query
 * words score most together (the latest on a tie); null when they are only in
 * the titles. */
function bestField(doc, found) {
  const sums = new Map();
  found.forEach(matches => {
    for (const [w, s] of matches) {
      const seen = doc.words.get(w);
      if (!seen) continue;
      for (const fi of seen.fields) {
        const v = s * WEIGHT[doc.fields[fi].kind];
        if (doc.fields[fi].kind !== 'title') sums.set(fi, (sums.get(fi) || 0) + v);
      }
    }
  });
  let best = null;
  for (const [fi, sum] of sums)
    if (best == null || sum > sums.get(best) || (sum === sums.get(best) && fi > best)) best = fi;
  return best;
}

/** The conversations every word of query matches, best first (more recent
 * first on a tie), at most `limit`: {id, title, titleRanges, kind, at, score,
 * snippet: {text, ranges} or null, turn: the `at` of the turn quoted, or null}. */
export function search(index, query, limit = LIMIT) {
  const qs = queryWords(query);
  if (!qs.length) return [];
  const found = qs.map(q => matchesOf(index, q));
  const ranked = [...tally(index, found)]
    .filter(([, best]) => best.every(v => v > 0))
    .map(([d, best]) => ({ doc: index.docs[d], score: best.reduce((n, v) => n + v, 0) }))
    .sort((a, b) => b.score - a.score || b.doc.at - a.doc.at)
    .slice(0, limit);
  return ranked.map(({ doc, score }) => {
    const fi = bestField(doc, found),
      title = doc.fields[0];
    return {
      id: doc.id,
      title: title.text,
      titleRanges: hitsIn(title.fold, qs, found).flatMap(h => h.ranges),
      kind: doc.kind,
      at: doc.at,
      score,
      snippet: fi == null ? null : snippet(doc.fields[fi], qs, found),
      turn: fi == null ? null : doc.fields[fi].turn,
    };
  });
}
