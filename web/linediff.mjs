/** What changed between two texts, line by line, as a unified diff that
 * render.mjs diffHtml draws: Myers' O(ND) shortest edit script over the lines
 * left once the common head and tail are set aside, then hunks with three
 * lines of context. Used by the artifact viewer (artifacts.js) to show what a
 * version changed. DOM-free, so test/test.mjs checks it. Leaves out
 * word-level changes inside a line.
 */
/** Lines of unchanged text kept around each change. */
const CONTEXT = 3;
/** Most edits looked for: past it, the middle is shown as all removed and
 * all added, which is still correct. */
const MAX_EDITS = 1000;

/** The edit script turning lines a into lines b: [op, line] with op ' ',
 * '-' or '+'. */
function script(a, b) {
  let head = 0,
    tail = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail),
    y = b.slice(head, b.length - tail),
    middle = myers(x, y) || [...x.map(l => ['-', l]), ...y.map(l => ['+', l])];
  return [
    ...a.slice(0, head).map(l => [' ', l]),
    ...middle,
    ...a.slice(a.length - tail).map(l => [' ', l]),
  ];
}
/** Myers' greedy shortest edit script from x to y, or null past MAX_EDITS. */
function myers(x, y) {
  const n = x.length,
    m = y.length,
    max = Math.min(n + m, MAX_EDITS),
    v = new Map([[1, 0]]),
    trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let i =
        k === -d || (k !== d && v.get(k - 1) < v.get(k + 1)) ? v.get(k + 1) : v.get(k - 1) + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) (i++, j++);
      v.set(k, i);
      if (i >= n && j >= m) return backtrack(trace, x, y);
    }
  }
  return null;
}
/** Walks Myers' saved frontiers back from the end to the edit script. */
function backtrack(trace, x, y) {
  const out = [];
  let i = x.length,
    j = y.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d],
      k = i - j,
      down = k === -d || (k !== d && v.get(k - 1) < v.get(k + 1)),
      pk = down ? k + 1 : k - 1,
      pi = v.get(pk),
      pj = pi - pk;
    while (i > pi && j > pj) (out.push([' ', x[--i]]), j--);
    if (d > 0) out.push(down ? ['+', y[--j]] : ['-', x[--i]]);
  }
  return out.reverse();
}

/** The unified diff from text a to text b, headed as the file name, or ''
 * when they are the same. */
export function lineDiff(a, b, name = 'artifact') {
  const ops = script(String(a).split('\n'), String(b).split('\n')),
    changes = []; // [first, past last] op of each run of changes
  // Runs of changes no more than two contexts apart share a hunk.
  ops.forEach(([op], i) => {
    if (op === ' ') return;
    const last = changes.at(-1);
    if (last && i - last[1] <= 2 * CONTEXT) last[1] = i + 1;
    else changes.push([i, i + 1]);
  });
  if (!changes.length) return '';
  const lines = ['--- a/' + name, '+++ b/' + name];
  for (const [first, past] of changes) {
    const from = Math.max(0, first - CONTEXT),
      to = Math.min(ops.length, past + CONTEXT);
    // Line numbers where the hunk starts on each side.
    let old = 1,
      neu = 1;
    for (const [op] of ops.slice(0, from)) {
      if (op !== '+') old++;
      if (op !== '-') neu++;
    }
    const part = ops.slice(from, to),
      olds = part.filter(o => o[0] !== '+').length,
      news = part.filter(o => o[0] !== '-').length;
    lines.push('@@ -' + old + ',' + olds + ' +' + neu + ',' + news + ' @@');
    for (const [op, line] of part) lines.push(op + line);
  }
  return lines.join('\n');
}
