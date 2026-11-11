/** Syntax highlighting, after ladle's Colour (~/r/ladle/src/Colour.raz), ported to JS.
 *
 *   highlight(lang, code)          code as escaped HTML, its tokens in <span class="hl-…">
 *   detect({ path, fence, code })  the language of a file or a code fence, or ''
 *   diffLines(diff)                a unified diff's lines, each side coloured by its file's language
 *
 * Six classes, as ladle has them: k keyword, t type (and a key in data files), s string,
 * n number or constant (true, nil, null), c comment, b built-in. Names, operators and
 * space are plain. Three rules, also ladle's:
 *   - Everything is escaped; the only markup is the spans.
 *   - A span never crosses a line break: it closes before each \n and reopens after, so a
 *     caller may split the result by line (numbered file views, diffs).
 *   - It never fails: an unknown language, an odd input or a scanner's surprise gives the
 *     code escaped and plain. Files past MaxBytes or MaxLines are plain too.
 *
 * Each language is an ordered list of rules tried at each position (a sticky regex and its
 * class, or a function that consumes text itself); the first that takes text wins, and a
 * character no rule takes is plain. This is an editor's scanner, not a parser: shell and
 * concha keep a little state (is a command's name next?) and that is all.
 */
// Longest text, in bytes, and most lines that are coloured; anything bigger is shown plain.
const MaxBytes = 200_000,
  MaxLines = 5000;
// The five characters HTML needs escaped.
const Entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// HTML-escapes text.
const escape = s => s.replace(/[&<>"']/g, c => Entities[c]);
// A set from a string of space-separated words.
const set = words => new Set(words.split(' '));

// The HTML being built. put is ladle's Cspan.put: one span per line of text.
class Out {
  html = '';
  put(cls, text) {
    if (!text) return;
    if (!cls) this.html += escape(text);
    else {
      const open = '<span class="hl-' + cls + '">';
      this.html += text
        .split('\n')
        .map(p => (p ? open + escape(p) + '</span>' : ''))
        .join('\n');
    }
  }
}

// --- The engine ---------------------------------------------------------------------------

// The scanner's position and the little state a language keeps.
function lexer(src, out) {
  return { src, out, i: 0, prev: '', here: [] };
}
// Runs a language's rules from lx.i to the end, or (close given) to the close that
// matches, which is left unread: the end of a ${...} or $(...).
function run(lx, lang, close) {
  const { src } = lx,
    open = close === '}' ? '{' : '(';
  let depth = 0;
  while (lx.i < src.length) {
    const c = src[lx.i];
    if (close && c === close && !depth--) return;
    if (close && c === open) depth++;
    step(lx, lang);
  }
}
// Takes one token: the first rule that takes text, else one plain character.
function step(lx, lang) {
  const { src } = lx,
    at = lx.i;
  for (const r of lang.rules) {
    if (r.fn) {
      if (r.fn(lx, lang) && lx.i > at) return token(lx, at);
      lx.i = at;
      continue;
    }
    r.re.lastIndex = at;
    const m = r.re.exec(src);
    if (!m || !m[0]) continue;
    const cls = typeof r.cls === 'function' ? r.cls(m[0], lx, at + m[0].length) : r.cls;
    if (cls === false) continue;
    lx.out.put(cls, m[0]);
    lx.i = at + m[0].length;
    return token(lx, at);
  }
  lx.out.put('', src[at]);
  lx.i = at + 1;
  token(lx, at);
  if (lang.punct) lang.punct(lx, src[at]);
}
// Remembers the last token that wasn't space, for rules that look back.
function token(lx, at) {
  const t = lx.src.slice(at, lx.i);
  if (t.trim()) lx.prev = t.length > 32 ? '…' : t.trim();
}
// Whether only blanks lie between the start of the line and position i.
const atLineStart = (src, i) => /^[ \t]*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i));
// A rule that takes any space, plain.
const Space = { re: /\s+/y, cls: '' };
const Blank = { re: /[ \t\r]+/y, cls: '' }; // for languages where a line feed means something

// A quoted string from lx.i, where open starts (after a prefix of plen characters).
// o: esc (backslash escapes), multi (may span lines), dbl (a doubled close is a quote),
// interp(lx, i) (at a character of marks, an interpolation may start: it emits it, advances
// lx.i and returns true), key (the
// class for a string followed by ':', as JSON's keys).
function quoted(lx, open, close, o = {}, plen = 0) {
  const { src } = lx;
  let seg = lx.i,
    i = lx.i + plen + open.length;
  while (i < src.length) {
    if (src.startsWith(close, i)) {
      if (o.dbl && src.startsWith(close, i + close.length)) {
        i += 2 * close.length;
        continue;
      }
      i += close.length;
      break;
    }
    const c = src[i];
    if (c === '\n' && !o.multi) break;
    if (o.esc && c === '\\') {
      i += 2;
      continue;
    }
    if (o.interp && o.marks.includes(c)) {
      lx.out.put('s', src.slice(seg, i));
      lx.i = i;
      if (o.interp(lx, i)) {
        i = seg = lx.i;
        continue;
      }
      seg = i;
    }
    i++;
  }
  i = Math.min(i, src.length);
  const cls = o.key && /^[ \t]*:/.test(src.slice(i, i + 40)) ? o.key : 's';
  lx.out.put(cls, src.slice(seg, i));
  lx.i = i;
  return true;
}
// A rule for a quoted string, with an optional prefix (Python's r, f, b; Rust's b).
const str = (open, o = {}, close = open) => ({
  fn(lx) {
    let plen = 0;
    if (o.prefix) {
      o.prefix.lastIndex = lx.i;
      const m = o.prefix.exec(lx.src);
      if (m) plen = m[0].length;
    }
    return lx.src.startsWith(open, lx.i + plen) && quoted(lx, open, close, o, plen);
  },
});
// A comment that nests, as raz's (* (* *) *) and Rust's /* /* */ */.
const nested = (open, close) => ({
  fn(lx) {
    const { src } = lx;
    if (!src.startsWith(open, lx.i)) return false;
    let i = lx.i,
      depth = 0;
    do {
      if (src.startsWith(open, i)) (depth++, (i += open.length));
      else if (src.startsWith(close, i)) (depth--, (i += close.length));
      else i++;
    } while (depth > 0 && i < src.length);
    lx.out.put('c', src.slice(lx.i, i));
    lx.i = i;
    return true;
  },
});
// JavaScript's ${...} inside a template: the marks plain, the code coloured as code.
function codeIn(lx, lang, open, close, cls = '') {
  lx.out.put(cls, open);
  lx.i += open.length;
  run(lx, lang, close);
  if (lx.src[lx.i] === close) {
    lx.out.put(cls, close);
    lx.i++;
  }
  return true;
}
// Escapes a string for use inside a regular expression.
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// A number: hex, binary, octal, decimal with digit separators, fractions and exponents.
const Num =
  /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)(?:[a-zA-Z_]\w*)?/y;
// An identifier.
const Word = /[A-Za-z_$][\w$]*/y;

// A word's class from a language's lists. A word after '.' is a member, plain; one after a
// typeAfter keyword (class, struct …) names a type.
function words(s) {
  const k = set(s.k || ''),
    t = set(s.t || ''),
    b = set(s.b || ''),
    n = set(s.n || ''),
    after = set(s.typeAfter || ''),
    fold = s.ci ? w => w.toLowerCase() : w => w;
  return (word, lx, end) => {
    const w = fold(word);
    if (lx.prev === '.' && !n.has(w)) return '';
    if (k.has(w)) return 'k';
    if (t.has(w) || after.has(lx.prev)) return 't';
    if (n.has(w)) return 'n';
    if (b.has(w) || (s.bang && lx.src[end] === '!')) return 'b';
    return '';
  };
}
// A language of the C family from its spec: comments, strings, extra rules, word lists.
function clike(s) {
  const rules = [Space, ...(s.extra || [])];
  for (const l of s.line || []) rules.push({ re: new RegExp(reEscape(l) + '.*', 'y'), cls: 'c' });
  if (s.block) {
    const [a, z] = s.block;
    rules.push(
      s.nest
        ? nested(a, z)
        : { re: new RegExp(reEscape(a) + '[\\s\\S]*?(?:' + reEscape(z) + '|$)', 'y'), cls: 'c' },
    );
  }
  rules.push(...(s.strings || []).map(q => (q.fn ? q : str(q[0], q[1] || {}, q[2]))));
  rules.push({ re: s.number || Num, cls: 'n' }, { re: s.word || Word, cls: words(s) });
  return { rules };
}

// --- The languages ------------------------------------------------------------------------

// raz: the report's reserved words and Scan's reading (~/r/raz/tools/Scan.raz): nested
// (* *) comments, "..." and '...' to their line's end with \ escapes, `raw` over lines,
// numbers such as 0FFH and 2.0E-3. The word lists are ladle's Craz.
const raz = clike({
  k: 'and begin break by code const continue defer div do else elsif end extern for forward if import in link match mod module not of or packed proc record repeat return set shl shr then to try type until var variant VOLATILE while xor',
  t: 'I8 I16 I32 I64 INT UINT U8 U16 U32 U64 BOOL F32 F64 ERROR',
  b: 'SIZE ADR LEN PTR NEW MSG SYSCALL FENCE CAS XCHG XADD ARGC ARGV INC DEC COPY',
  n: 'true false nil',
  block: ['(*', '*)'],
  nest: true,
  strings: [
    ['"', { esc: true }],
    ["'", { esc: true }],
    ['`', { multi: true }],
  ],
  number: /\d\w*(?:\.\d\w*(?:(?<=E)[+-]\w*)?)?/y,
  word: /[A-Za-z_]\w*/y,
});

// JavaScript and TypeScript (JSX and TSX loosely: their tags read as code). Templates with
// ${...} coloured as code, regular expressions where an operand may start. Lists: ladle's Cjs.
const jsWords = {
  k: 'break case catch class const continue debugger default delete do else enum export extends finally for function if import in instanceof new return super switch this throw try typeof var void while with yield let static async await of',
  n: 'true false null undefined NaN Infinity',
  b: 'console Math JSON Promise Array Object String Number Boolean Symbol Date RegExp Error TypeError RangeError SyntaxError ReferenceError Map Set WeakMap WeakSet WeakRef BigInt Intl Reflect Proxy ArrayBuffer DataView Atomics Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array globalThis window document navigator location history process require module exports __dirname __filename arguments setTimeout setInterval clearTimeout clearInterval queueMicrotask structuredClone fetch parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI eval atob btoa alert confirm prompt Buffer URL URLSearchParams TextEncoder TextDecoder AbortController Event EventTarget Headers Request Response FormData Blob File localStorage sessionStorage WebSocket requestAnimationFrame performance Worker',
  typeAfter: 'class extends implements interface type enum new',
};
// Where a / starts a regular expression rather than dividing: after an operator or keyword.
const regexAfter = set(
  '( , = : [ ! & | ? { } ; + - * % < > ~ ^ => && || ?? return typeof case do else in of new delete void throw yield await',
);
// The regex literal rule: a slash starts one only where a value is expected, not after a name
// or number.
const jsRegex = {
  re: /\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*/y,
  cls: (m, lx) => (lx.prev === '' || regexAfter.has(lx.prev) ? 's' : false),
};
// The JavaScript family's language, with `extra` word lists added.
function jsLike(extra) {
  const lang = clike({
    ...jsWords,
    ...extra,
    k: jsWords.k + (extra.k ? ' ' + extra.k : ''),
    line: ['//'],
    block: ['/*', '*/'],
    extra: [{ re: /^#!.*/y, cls: 'c' }, { re: /@[A-Za-z_][\w.]*/y, cls: 'b' }, jsRegex],
    strings: [
      ['"', { esc: true }],
      ["'", { esc: true }],
      [
        '`',
        {
          esc: true,
          multi: true,
          marks: '$',
          interp: (lx, i) => lx.src.startsWith('${', i) && codeIn(lx, lang, '${', '}'),
        },
      ],
    ],
  });
  return lang;
}
// JavaScript.
const js = jsLike({});
// TypeScript: JavaScript plus its type words.
const ts = jsLike({
  k: 'interface implements public private protected readonly declare namespace abstract as satisfies keyof infer is type',
  t: 'string number boolean any unknown never void object bigint symbol',
});

// Python: ladle's Cpy lists; prefixed and triple-quoted strings; decorators are b; the
// name after class or def is t.
const pyPrefix = /[rRbBuUfF]{1,2}(?=['"])/y;
// Python.
const python = clike({
  k: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
  n: 'True False None NotImplemented Ellipsis',
  b: 'abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property quit range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ self cls BaseException Exception ArithmeticError AssertionError AttributeError EOFError FileExistsError FileNotFoundError ImportError IndexError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError NotImplementedError OSError OverflowError PermissionError RecursionError RuntimeError StopIteration SyntaxError SystemExit TimeoutError TypeError UnicodeError ValueError ZeroDivisionError',
  typeAfter: 'class def',
  line: ['#'],
  extra: [
    { re: /@[A-Za-z_][\w.]*/y, cls: (m, lx, end) => atLineStart(lx.src, end - m.length) && 'b' },
  ],
  strings: [
    ['"""', { esc: true, multi: true, prefix: pyPrefix }],
    ["'''", { esc: true, multi: true, prefix: pyPrefix }],
    ['"', { esc: true, prefix: pyPrefix }],
    ["'", { esc: true, prefix: pyPrefix }],
  ],
  word: /[A-Za-z_]\w*/y,
});

// Go, Rust, C and C++, Java, Kotlin: keywords, types, constants, built-ins.
const go = clike({
  k: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  t: 'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable',
  n: 'true false nil iota',
  b: 'append cap clear close complex copy delete imag len make max min new panic print println real recover',
  typeAfter: 'type',
  line: ['//'],
  block: ['/*', '*/'],
  strings: [
    ['"', { esc: true }],
    ["'", { esc: true }],
    ['`', { multi: true }],
  ],
  word: /[A-Za-z_]\w*/y,
});
// Rust's raw strings, r#"..."#, whose end depends on the number of #.
const rustRaw = {
  fn(lx) {
    const m = /b?r(#*)"/y;
    m.lastIndex = lx.i;
    const r = m.exec(lx.src);
    if (!r) return false;
    return quoted(lx, '"', '"' + r[1], { multi: true }, r[0].length - 1);
  },
};
// Rust.
const rust = clike({
  k: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while yield',
  t: 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box HashMap',
  n: 'true false None',
  b: 'Some Ok Err',
  bang: true,
  typeAfter: 'struct enum trait type union',
  line: ['//'],
  block: ['/*', '*/'],
  nest: true,
  extra: [
    { re: /#!?\[[^\]\n]*\]/y, cls: 'b' },
    rustRaw,
    { re: /b?'(?:\\(?:x[\da-fA-F]{2}|u\{[\da-fA-F]+\}|.)|[^\\'\n])'/y, cls: 's' },
    { re: /'[A-Za-z_]\w*/y, cls: '' },
  ],
  strings: [['"', { esc: true, multi: true, prefix: /b(?=")/y }]],
  word: /[A-Za-z_]\w*/y,
});
// C and C++.
const cFamily = clike({
  k: 'break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while alignas alignof asm catch class constexpr consteval const_cast decltype delete dynamic_cast explicit export friend mutable namespace new noexcept operator private protected public reinterpret_cast static_assert static_cast template this throw try typeid typename using virtual override final co_await co_return co_yield concept requires',
  t: 'void char short int long float double signed unsigned bool _Bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t intptr_t uintptr_t ptrdiff_t wchar_t char8_t char16_t char32_t FILE auto std string vector',
  n: 'true false NULL nullptr EOF',
  b: 'printf fprintf sprintf snprintf scanf sscanf malloc calloc realloc free memcpy memset memmove memcmp strlen strcmp strncmp strcpy strncpy strcat strchr strdup puts putchar getchar fopen fclose fread fwrite fgets fputs exit abort assert cout cerr endl',
  typeAfter: 'struct class enum union typename',
  line: ['//'],
  block: ['/*', '*/'],
  extra: [
    {
      re: /#[ \t]*[a-z]+/y,
      cls: (m, lx, end) => atLineStart(lx.src, end - m.length) && 'k',
    },
    { re: /<[\w./+-]+>/y, cls: (m, lx) => /^#\s*(include|import)$/.test(lx.prev) && 's' },
  ],
  strings: [
    ['"', { esc: true }],
    ["'", { esc: true }],
  ],
  word: /[A-Za-z_]\w*/y,
});
// Java.
const java = clike({
  k: 'abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield',
  t: 'boolean byte char short int long float double void String Object Integer Long Double Boolean Character List Map Set',
  n: 'true false null',
  b: 'System Math',
  typeAfter: 'class interface enum record extends implements new',
  line: ['//'],
  block: ['/*', '*/'],
  extra: [{ re: /@[A-Za-z_][\w.]*/y, cls: 'b' }],
  strings: [
    ['"""', { esc: true, multi: true }],
    ['"', { esc: true }],
    ["'", { esc: true }],
  ],
  word: /[A-Za-z_$][\w$]*/y,
});
// Kotlin.
const kotlin = clike({
  k: 'as break class continue do else for fun if in interface is object package return super this throw try typealias typeof val var when while by catch constructor finally get import init set where abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg',
  t: 'Int Long Short Byte Double Float Boolean Char String Unit Any Nothing List Map Set Array',
  n: 'true false null',
  b: 'println print listOf mapOf setOf arrayOf mutableListOf mutableMapOf require check error TODO lazy',
  typeAfter: 'class interface object typealias',
  line: ['//'],
  block: ['/*', '*/'],
  nest: true,
  extra: [{ re: /@[A-Za-z_][\w.]*/y, cls: 'b' }],
  strings: [
    ['"""', { multi: true }],
    ['"', { esc: true }],
    ["'", { esc: true }],
  ],
  word: /[A-Za-z_]\w*/y,
});

// SQL (case-insensitive words, '' inside a string), JSON (its keys are t).
const sql = clike({
  ci: true,
  k: 'select from where and or not insert into values update set delete create table drop alter add column index view join inner left right outer full cross on as group by order having limit offset union all distinct case when then else end if exists primary key foreign references default unique check constraint begin commit rollback transaction with recursive returning in is like ilike between asc desc database schema grant revoke trigger procedure function returns declare replace using conflict do nothing',
  t: 'int integer bigint smallint tinyint serial bigserial real double precision float decimal numeric char varchar text blob boolean bool date time timestamp timestamptz interval json jsonb uuid bytea',
  n: 'null true false',
  b: 'count sum avg min max coalesce nullif now cast lower upper length substr substring trim round abs date_trunc extract concat ifnull',
  line: ['--'],
  block: ['/*', '*/'],
  strings: [["'", { multi: true, dbl: true }]],
  word: /[A-Za-z_]\w*/y,
});
// JSON and JSON with comments.
const json = clike({
  n: 'true false null',
  line: ['//'],
  block: ['/*', '*/'],
  strings: [['"', { esc: true, key: 't' }]],
  number: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y,
  word: /[A-Za-z_]\w*/y,
});

// CSS: comments, strings, at-rules k, property names t, numbers and #colours n inside a
// block, functions (var, rgb …) b.
const css = {
  punct(lx, ch) {
    if (ch === '{') lx.depth = (lx.depth || 0) + 1;
    if (ch === '}') lx.depth = Math.max(0, (lx.depth || 0) - 1);
  },
  rules: [
    Space,
    { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'c' },
    { re: /\/\/.*/y, cls: (m, lx, end) => atLineStart(lx.src, end - m.length) && 'c' }, // SCSS
    str('"', { esc: true }),
    str("'", { esc: true }),
    { re: /@[\w-]+/y, cls: 'k' },
    { re: /!important\b/y, cls: 'k' },
    { re: /#[\da-fA-F]{3,8}\b/y, cls: (m, lx) => lx.depth > 0 && 'n' },
    { re: /-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/y, cls: (m, lx) => lx.depth > 0 && 'n' },
    {
      re: /--?[A-Za-z_][\w-]*|[A-Za-z_][\w-]*/y,
      cls: (m, lx, end) => {
        const after = lx.src.slice(end, end + 40);
        if (/^\(/.test(after)) return 'b';
        if (lx.depth > 0 && /^\s*:/.test(after) && !/^\s*:[\w-]+\s*[{,]/.test(after)) return 't';
        return '';
      },
    },
  ],
};

// HTML and XML: comments, tags k, attribute names t, values s, entities n. An HTML
// <script> or <style> is coloured as JavaScript or CSS.
function markup(isHtml) {
  const tag = {
    fn(lx) {
      const { src, out } = lx,
        m = /<(\/?)([A-Za-z][\w:.-]*)/y;
      m.lastIndex = lx.i;
      const r = m.exec(src);
      if (!r) return false;
      out.put('', '<' + r[1]);
      out.put('k', r[2]);
      let i = lx.i + r[0].length;
      const attr = /\s+|([^\s=>/"']+)|=|"[^"]*"?|'[^']*'?|\/(?!>)/y;
      while (i < src.length && src[i] !== '>' && !src.startsWith('/>', i)) {
        attr.lastIndex = i;
        const a = attr.exec(src);
        if (!a) break;
        const t = a[0];
        out.put(a[1] ? (src[i - 1] === '=' ? 's' : 't') : /^["']/.test(t) ? 's' : '', t);
        i += t.length;
      }
      const end = src.startsWith('/>', i) ? 2 : src[i] === '>' ? 1 : 0;
      out.put('', src.slice(i, i + end));
      lx.i = i + end;
      const inner =
        isHtml && !r[1] && end === 1 && { script: 'js', style: 'css' }[r[2].toLowerCase()];
      if (inner) {
        const close = src.toLowerCase().indexOf('</' + r[2].toLowerCase(), lx.i),
          stop = close < 0 ? src.length : close;
        colour(inner, src.slice(lx.i, stop), out);
        lx.i = stop;
      }
      return true;
    },
  };
  return {
    rules: [
      Space,
      { re: /<!--[\s\S]*?(?:-->|$)/y, cls: 'c' },
      { re: /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/y, cls: 's' },
      { re: /<[!?][^>]*>?/y, cls: 'b' },
      tag,
      { re: /&(?:#\d+|#x[\da-fA-F]+|\w+);/y, cls: 'n' },
      { re: /[^<&\s]+/y, cls: '' },
    ],
  };
}

// YAML, TOML and INI: comments, keys t, [sections] k, strings, numbers and constants n.
const scalar = { re: /(?:true|false|null|~)(?![\w-])/y, cls: 'n' };
// A number, or a date and time, in a data file.
const dataNumber = {
  re: /[-+]?(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:[-:T]\d[\d:.TZ+-]*)?(?![\w-])/y,
  cls: 'n',
};
// A comment marker at a line's start or after a space.
const hashComment = mark => ({
  re: new RegExp(mark + '.*', 'y'),
  cls: (m, lx, end) => {
    const at = end - m.length;
    return (at === 0 || /\s/.test(lx.src[at - 1])) && 'c';
  },
});
// YAML.
const yaml = {
  rules: [
    Space,
    hashComment('#'),
    { re: /(?:---|\.\.\.)(?=\s|$)/y, cls: (m, lx, end) => atLineStart(lx.src, end - 3) && 'k' },
    {
      re: /[^\s#'"{}[\],:-][^#\n:]*?(?=[ \t]*:(?:\s|$))|"[^"\n]*"(?=[ \t]*:)|'[^'\n]*'(?=[ \t]*:)/y,
      cls: (m, lx, end) => {
        const line = lx.src.slice(lx.src.lastIndexOf('\n', end - m.length - 1) + 1, end - m.length);
        return /^[ \t]*(?:-[ \t]+)*$|[{,][ \t]*$/.test(line) ? 't' : false;
      },
    },
    str('"', { esc: true, multi: true }),
    str("'", { dbl: true, multi: true }),
    { re: /[&*][\w-]+|!!?[\w/-]*/y, cls: 'b' },
    scalar,
    dataNumber,
    { re: /[\w.-]+/y, cls: '' },
  ],
};
// TOML and INI.
const toml = {
  rules: [
    Space,
    { re: /[#;].*/y, cls: (m, lx, end) => atLineStart(lx.src, end - m.length) && 'c' },
    hashComment('#'),
    { re: /\[\[?[^\]\n]*\]\]?/y, cls: (m, lx, end) => atLineStart(lx.src, end - m.length) && 'k' },
    {
      re: /[\w.$"' -]*[\w"'](?=[ \t]*[=:])/y,
      cls: (m, lx, end) => atLineStart(lx.src, end - m.length) && 't',
    },
    str('"""', { esc: true, multi: true }),
    str("'''", { multi: true }),
    str('"', { esc: true }),
    str("'"),
    scalar,
    dataNumber,
    { re: /[\w.-]+/y, cls: '' },
  ],
};

// Markdown, lightly: headings k, list and quote markers k, emphasis t, code s (a fenced
// block coloured in its own language), links' targets n, HTML comments c.
const markdownLang = {
  rules: [
    Space,
    {
      fn(lx) {
        const { src, out } = lx,
          m = /(`{3,}|~{3,})([^\n]*)/y;
        m.lastIndex = lx.i;
        const r = m.exec(src);
        if (!r || !atLineStart(src, lx.i)) return false;
        out.put('c', r[0]);
        const body = src.indexOf('\n', lx.i) + 1;
        if (!body) {
          lx.i = src.length;
          return true;
        }
        const fence = new RegExp('^[ \\t]*' + r[1][0] + '{' + r[1].length + ',}[ \\t]*$', 'm');
        const rest = src.slice(body),
          close = rest.search(fence),
          end = close < 0 ? src.length : body + close;
        out.put('', '\n');
        const inner = src.slice(body, end);
        // the body without its last line feed, which stays outside the code
        const code = inner.endsWith('\n') ? inner.slice(0, -1) : inner;
        out.html += highlight(detect({ fence: r[2] }), code);
        out.put('', inner.slice(code.length));
        lx.i = end;
        if (close >= 0) {
          const line = src.indexOf('\n', end);
          const stop = line < 0 ? src.length : line;
          out.put('c', src.slice(end, stop));
          lx.i = stop;
        }
        return true;
      },
    },
    { re: /#{1,6}[ \t].*/y, cls: (m, lx, end) => atLineStart(lx.src, end - m.length) && 'k' },
    {
      re: /(?:[-*+]|\d+[.)]|>)(?=[ \t])/y,
      cls: (m, lx, end) => atLineStart(lx.src, end - m.length) && 'k',
    },
    { re: /<!--[\s\S]*?(?:-->|$)/y, cls: 'c' },
    { re: /`[^`\n]+`/y, cls: 's' },
    { re: /\*\*[^*\n]+\*\*|__[^_\n]+__/y, cls: 't' },
    { re: /\*[^*\s][^*\n]*\*|(?<!\w)_[^_\s][^_\n]*_(?!\w)/y, cls: 't' },
    {
      fn(lx) {
        const m = /(!?\[[^\]\n]*\])(\([^)\s]*\))/y;
        m.lastIndex = lx.i;
        const r = m.exec(lx.src);
        if (!r) return false;
        lx.out.put('', r[1]);
        lx.out.put('n', r[2]);
        lx.i += r[0].length;
        return true;
      },
    },
    { re: /\w+/y, cls: '' },
  ],
};

// --- Shell and concha ---------------------------------------------------------------------

// The bodies of the here-documents begun on the line just ended, up to their tag lines.
function heredocs(lx) {
  const { src, out } = lx;
  for (const [n, tag] of lx.here.splice(0).entries()) {
    if (n) {
      if (src[lx.i] !== '\n') break;
      out.put('', '\n');
      lx.i++;
    }
    let i = lx.i,
      end = src.length;
    while (i < src.length) {
      const e = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
      if (src.slice(i, e).trim() === tag) {
        end = e;
        break;
      }
      i = e + 1;
    }
    out.put('s', src.slice(lx.i, end));
    lx.i = end;
  }
}
// A line feed: here-document bodies follow, and a command may start.
const lineFeed = onLine => ({
  fn(lx) {
    if (lx.src[lx.i] !== '\n') return false;
    lx.out.put('', '\n');
    lx.i++;
    if (lx.here.length) heredocs(lx);
    onLine(lx);
    return true;
  },
});
// A shell here-document's start, <<WORD; the text up to WORD is a string.
const heredocStart = {
  fn(lx) {
    const m = /<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1/y;
    m.lastIndex = lx.i;
    const r = m.exec(lx.src);
    if (!r || lx.src[lx.i + 2] === '<') return false;
    lx.out.put('', r[0].slice(0, r[0].length - r[2].length - 2 * r[1].length));
    lx.out.put('s', r[1] + r[2] + r[1]);
    lx.here.push(r[2]);
    lx.i += r[0].length;
    return true;
  },
};

// POSIX sh and bash (zsh as bash), after ladle's Cshell: keywords and built-ins only where
// a command's name goes; $expansions b, their $(...) code coloured; quotes, here-documents.
const shKeywords = set(
    'if then else elif fi for while until do done case esac in function select time [[ ]] !',
  ),
  shCommandAfter = set('if then else elif while until do time ! {'),
  shBuiltins = set(
    'echo printf cd export local read set unset test [ shift trap eval exec source . : return exit break continue declare typeset readonly alias unalias umask wait kill pwd true false getopts let ulimit type hash command builtin pushd popd dirs jobs fg bg history mapfile readarray shopt enable help logout caller disown',
  );
// $name, ${...}, $(...) and `...`: b, with $(...)'s inside coloured as commands.
function shExpansion(lx, lang) {
  const { src } = lx,
    i = lx.i;
  if (src.startsWith('$(', i)) {
    const cmd = lx.cmd;
    lx.cmd = true;
    codeIn(lx, lang, '$(', ')', 'b');
    lx.cmd = cmd;
    return true;
  }
  const m = /\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*|[\d@*#?$!-])|`(?:\\.|[^`\\])*`?/y;
  m.lastIndex = i;
  const r = m.exec(src);
  if (!r) return false;
  lx.out.put('b', r[0]);
  lx.i += r[0].length;
  return true;
}
// sh, bash and similar shells.
const shell = {
  init: lx => (lx.cmd = true),
  rules: [
    Blank,
    lineFeed(lx => ((lx.cmd = true), (lx.inNext = false))),
    {
      re: /#.*/y,
      cls: (m, lx, end) =>
        (end === m.length || /[\s;&|()]/.test(lx.src[end - m.length - 1])) && 'c',
    },
    heredocStart,
    str("$'", { esc: true }, "'"),
    str("'", { multi: true }),
    {
      fn: (lx, lang) =>
        lx.src[lx.i] === '"' &&
        quoted(lx, '"', '"', {
          esc: true,
          multi: true,
          marks: '$`',
          interp: lx2 => shExpansion(lx2, lang),
        }),
    },
    { fn: shExpansion },
    { re: /\\[\s\S]?/y, cls: '' },
    {
      re: /;;|&&|\|\||[;&|()]/y,
      cls: (m, lx) => {
        lx.cmd = true;
        if (m !== '(' && m !== ')') lx.inNext = false;
        return '';
      },
    },
    {
      re: /[^\s;&|()<>'"`$\\]+/y,
      cls: (w, lx) => {
        if (lx.cmd) {
          if (/^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(w)) return '';
          lx.cmd = shCommandAfter.has(w);
          if (shKeywords.has(w)) {
            if (/^(for|case|select)$/.test(w)) lx.inNext = true;
            return 'k';
          }
          return shBuiltins.has(w) ? 'b' : '';
        }
        if (lx.inNext && w === 'in') {
          lx.inNext = false;
          return 'k';
        }
        return /^\d+$/.test(w) ? 'n' : '';
      },
    },
  ],
};

// concha, after ladle's Cconcha: a shell whose scripting language is Pascal. A statement
// that starts with a keyword, an assignment or a call f( is Pascal; anything else is a
// command, whose words are text. lx.mode: 'start' (a statement is next), 'expr' (Pascal),
// 'cmd' (a command's words). A line feed ends a statement unless the line asks for more.
const cnKeywords = set(
    'begin end if then else while do repeat until for to downto in case of var procedure function export break continue exit and or not xor div mod otherwise',
  ),
  cnConstants = set('nil true false'),
  cnBuiltins = set(
    'write writeln readln inc dec halt length copy pos int str trim split join lines glob exists isdir isfile chr ord upcase lowcase match defined replace sort environ getenv setenv now time basename dirname completions',
  ),
  cnCmdBuiltins = set('cd echo source wait exec umask unset ulimit trap jobs fg bg disown'),
  cnStandalone = set('halt write writeln'),
  cnOpeners = set('begin then do else repeat of end otherwise'),
  cnGoesOn = set(
    'and or not xor div mod in to downto if while until for case := , ( [ + - * / = < > \\',
  );
// Classifies a word in concha, which depends on whether it starts a command or sits in an
// expression.
function cnWord(lx) {
  const { src, out } = lx;
  const cmdWord = /[^\s;|&()<>'"`$]+/y,
    pascal = /[A-Za-z_]\w*/y;
  if (lx.mode === 'cmd') {
    cmdWord.lastIndex = lx.i;
    const r = cmdWord.exec(src);
    if (!r) return false;
    out.put('', r[0]);
    lx.i += r[0].length;
    return true;
  }
  pascal.lastIndex = lx.i;
  const r = pascal.exec(src);
  if (!r) {
    if (lx.mode !== 'start' || /[\s;|&()<>'"`$\d]/.test(src[lx.i])) return false;
    lx.mode = 'cmd'; // a command such as ./run or -x
    return cnWord(lx);
  }
  const w = r[0],
    after = src.slice(lx.i + w.length, lx.i + w.length + 40).replace(/^[ \t]+/, '');
  let cls = '';
  if (cnKeywords.has(w)) {
    cls = 'k';
    lx.mode = cnOpeners.has(w) ? 'start' : 'expr';
  } else if (cnConstants.has(w) && lx.mode === 'expr') cls = 'n';
  else if (lx.mode === 'expr' || /^(:=|\(|\[)/.test(after) || cnStandalone.has(w)) {
    if (cnBuiltins.has(w) && (after[0] === '(' || cnStandalone.has(w))) cls = 'b';
    lx.mode = 'expr';
  } else {
    cmdWord.lastIndex = lx.i;
    const full = cmdWord.exec(src)[0];
    out.put(cnCmdBuiltins.has(full) ? 'b' : '', full);
    lx.i += full.length;
    lx.mode = 'cmd';
    return true;
  }
  out.put(cls, w);
  lx.i += w.length;
  return true;
}
// concha, Luis's shell: commands and arguments, with Pascal for expressions.
const concha = {
  init: lx => ((lx.mode = 'start'), (lx.depth = 0)),
  punct(lx, ch) {
    if (lx.mode === 'cmd') {
      if (';|&'.includes(ch)) lx.mode = 'start';
    } else if (ch === ';') ((lx.mode = 'start'), (lx.depth = 0));
    else if ('(['.includes(ch)) lx.depth++;
    else if (')]'.includes(ch)) lx.depth = Math.max(0, lx.depth - 1);
  },
  rules: [
    Blank,
    lineFeed(lx => {
      if (lx.mode === 'cmd' || (lx.depth === 0 && !cnGoesOn.has(lx.prev))) lx.mode = 'start';
    }),
    { re: /#!.*/y, cls: (m, lx, end) => end === m.length && 'c' },
    {
      re: /\/\/.*/y,
      cls: (m, lx, end) => (end === m.length || /\s/.test(lx.src[end - m.length - 1])) && 'c',
    },
    { re: /\{[\s\S]*?(?:\}|$)/y, cls: (m, lx) => lx.mode !== 'cmd' && 'c' },
    heredocStart,
    { re: /'(?:[^'\n]|'')*'?(?:#\d+)*|#\d+(?:'(?:[^'\n]|'')*'?|#\d+)*/y, cls: 's' },
    {
      fn: (lx, lang) =>
        lx.src[lx.i] === '"' &&
        quoted(lx, '"', '"', {
          esc: true,
          multi: true,
          marks: '$',
          interp(lx2, i) {
            const { src } = lx2;
            if (src.startsWith('$(', i)) {
              const [mode, depth] = [lx2.mode, lx2.depth];
              lx2.mode = 'expr';
              lx2.depth = 0;
              codeIn(lx2, lang, '$(', ')');
              [lx2.mode, lx2.depth] = [mode, depth];
              return true;
            }
            const m = /\$(?:\{\w*\}?|\w+)/y;
            m.lastIndex = i;
            const r = m.exec(src);
            if (!r) return false;
            lx2.out.put('', r[0]);
            lx2.i += r[0].length;
            return true;
          },
        }),
    },
    {
      re: /`/y,
      cls: (m, lx) => {
        lx.back = !lx.back;
        lx.mode = lx.back ? 'cmd' : 'expr';
        return '';
      },
    },
    { re: /\$(?:\{\w*\}?|\w+)/y, cls: '' },
    { re: /:=/y, cls: (m, lx) => ((lx.mode = 'expr'), '') },
    {
      re: /\$[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y,
      cls: (m, lx) => lx.mode !== 'cmd' && 'n',
    },
    { fn: cnWord },
  ],
};

// --- Diffs --------------------------------------------------------------------------------

/** A unified diff's lines as [{ kind, html }], kind '', 'file', 'file start' (a file's
 * first header line), 'hunk', 'add' or 'remove'.
 * Each hunk's old and new sides are coloured as small files in the language of the file
 * the diff names (ladle's rule), and their lines put back in the hunk's order. */
export function diffLines(diff) {
  const lines = String(diff ?? '').split('\n'),
    big = lines.length > 4 * MaxLines,
    out = [];
  let lang = '';
  for (let i = 0; i < lines.length;) {
    const line = lines[i],
      head = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (!head) {
      const file = line.startsWith('diff ') || line.startsWith('+++ ') || line.startsWith('--- ');
      if (line.startsWith('diff ')) lang = detect({ path: line.split(' ').at(-1) });
      if (line.startsWith('+++ ') && !line.includes('/dev/null'))
        lang = detect({ path: line.slice(4).replace(/\t.*/, '') });
      const kind = line.startsWith('diff ')
        ? 'file start'
        : file
          ? 'file'
          : line[0] === '+'
            ? 'add'
            : line[0] === '-'
              ? 'remove'
              : '';
      out.push({ kind, html: escape(line) });
      i++;
      continue;
    }
    out.push({ kind: 'hunk', html: escape(line) });
    i++;
    let olds = head[1] === undefined ? 1 : +head[1],
      news = head[2] === undefined ? 1 : +head[2];
    const hunk = [];
    while (i < lines.length && (olds > 0 || news > 0)) {
      const c = lines[i][0];
      if (c === '+') news--;
      else if (c === '-') olds--;
      else if (c === ' ' || lines[i] === '') (olds--, news--);
      else if (c !== '\\') break;
      hunk.push(lines[i++]);
    }
    while (lines[i]?.startsWith('\\')) hunk.push(lines[i++]);
    const side = keep =>
      highlight(
        big ? '' : lang,
        hunk
          .filter(l => keep.includes(l[0] || ' '))
          .map(l => l.slice(1))
          .join('\n'),
      ).split('\n');
    const old = side('- '),
      now = side('+ ');
    let o = 0,
      n = 0;
    for (const l of hunk) {
      const c = l[0] || ' ';
      if (c === '\\') out.push({ kind: '', html: escape(l) });
      else if (c === '-') out.push({ kind: 'remove', html: '-' + old[o++] });
      else if (c === '+') out.push({ kind: 'add', html: '+' + now[n++] });
      else (o++, out.push({ kind: '', html: escape(l.slice(0, 1)) + now[n++] }));
    }
  }
  return out;
}
// A unified diff: added and removed lines are coloured, and each file's code in its own language.
const diffLang = (src, out) => {
  out.html += diffLines(src)
    .map(l => (l.kind ? '<span class="hl-' + l.kind + '">' + l.html + '</span>' : l.html))
    .join('\n');
};

// --- Languages and their names ------------------------------------------------------------

// Each language's rules; a diff is coloured by its own procedure.
const Langs = {
  raz,
  concha,
  js,
  ts,
  python,
  shell,
  json,
  css,
  html: markup(true),
  xml: markup(false),
  go,
  rust,
  c: cFamily,
  java,
  kotlin,
  sql,
  yaml,
  toml,
  markdown: markdownLang,
  diff: { colour: diffLang },
};
// src added to out in the colours of the language called name.
function colour(name, src, out) {
  const lang = Langs[name];
  if (lang.colour) return lang.colour(src, out);
  const lx = lexer(src, out);
  lang.init?.(lx);
  run(lx, lang);
}
// Names, fence words, extensions and interpreters, each to its language.
const Names = {
  raz: 'raz',
  concha: 'cn concha concharc',
  js: 'js javascript jsx mjs cjs node deno bun',
  ts: 'ts typescript tsx mts cts',
  python: 'py python python3 pyw pyi',
  shell: 'sh bash zsh dash ksh shell console shellsession bashrc zshrc profile bash_profile',
  json: 'json jsonc json5 webmanifest',
  css: 'css scss less',
  html: 'html htm xhtml vue svelte',
  xml: 'xml svg xsl plist',
  go: 'go golang',
  rust: 'rs rust',
  c: 'c h cc cpp cxx hpp hh hxx c++ cplusplus objc m',
  java: 'java',
  kotlin: 'kt kts kotlin',
  sql: 'sql psql postgres postgresql mysql sqlite',
  yaml: 'yaml yml',
  toml: 'toml ini cfg conf env properties editorconfig gitconfig',
  markdown: 'md markdown mdx',
  diff: 'diff patch',
};
// From each file extension or fence word to its language.
const Alias = {};
for (const [lang, names] of Object.entries(Names))
  for (const n of names.split(' ')) Alias[n] = lang;
// The language for a word, or '' when unknown.
const lookup = w => (Object.hasOwn(Alias, w) ? Alias[w] : '');

/** The language of a file or code block: a fence's first word decides when given; else the
 * path's extension (or, for a name with no dot, the name: concharc, .bashrc); else the
 * interpreter the #! line names (digits cut: python3.11 is python). '' when none is known. */
export function detect({ path = '', fence = '', code = '' } = {}) {
  const word = String(fence)
    .trim()
    .split(/[\s{,]/)[0]
    .replace(/^\./, '')
    .toLowerCase();
  if (word) return lookup(word);
  const base = String(path).split('/').at(-1).toLowerCase(),
    ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base;
  const byPath = base.includes('.') || base === 'concharc' ? lookup(ext) : '';
  if (byPath) return byPath;
  const bang = String(code).match(/^#!\s*(\S+)(?:\s+(?:-\S+\s+)*(\S+))?/);
  if (!bang) return '';
  const prog = p =>
    (p || '')
      .split('/')
      .at(-1)
      .replace(/[\d.]+$/, '');
  return lookup(prog(bang[1]) === 'env' ? prog(bang[2]) : prog(bang[1]));
}

/** code as escaped HTML in the colours of lang (a name, fence word or extension: 'raz',
 * 'sh', 'tsx'). Never throws; an unknown language or a large file is escaped plain. */
export function highlight(lang, code) {
  const src = String(code ?? ''),
    name = lookup(String(lang ?? '').toLowerCase());
  if (!name || src.length > MaxBytes || lineCount(src) > MaxLines) return escape(src);
  try {
    const out = new Out();
    colour(name, src, out);
    return out.html;
  } catch {
    return escape(src);
  }
}
// The number of lines in a text, counting no further than MaxLines.
function lineCount(s) {
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0 && n <= MaxLines; i = s.indexOf('\n', i + 1)) n++;
  return n;
}
