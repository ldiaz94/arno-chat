import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { catalog } from './models.mjs';
import { markdown, cleanOutput, diffHtml } from './web/render.mjs';
import { highlight, detect } from './web/highlight.mjs';
import { Outbox, conflicted, isLocal } from './web/queue.mjs';
import { moon, byRecent, ago, daily, weatherText } from './web/today.mjs';
import { QUOTES, FACTS } from './web/home-content.js';
import { buildPrompt } from './context.mjs';
import { validateFiles } from './publish.mjs';
import { usageStream, modelRequest, displayDelta } from './gateway.mjs';
import { checkOptions, optionTags, DEFAULTS } from './web/options.mjs';
import { turnPlan, codeSettings, codeLimits } from './plan.mjs';
import { gitProxy, refUpdates } from './git.mjs';
import { hostCommand } from './session-routes.mjs';
import { encode, decoderOf } from './serve.mjs';
import { plainChat } from './chat.mjs';
import { validPath } from './files.mjs';
import {
  seal,
  unseal,
  publicProfile,
  instructions,
  validMcpUrl,
  accountRoute,
  requestFields,
} from './account.mjs';
import { testMcp } from './mcp.mjs';
import { startSignIn, mcpCallback, mcpBearer } from './mcp-oauth.mjs';
import { research, citedSources } from './web.mjs';
import { ArnoProbe, default as worker } from './worker.js';
test('browser scripts parse', () => {
  const dir = new URL('./web/', import.meta.url).pathname;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.js')))
    execFileSync(process.execPath, ['--check', dir + f]);
});
test('the service worker precaches every static file the app needs', () => {
  const dir = new URL('./web/', import.meta.url).pathname,
    sw = readFileSync(dir + 'sw.js', 'utf8'),
    shell = JSON.parse(
      sw
        .match(/const SHELL = (\[[^\]]*\]);/)[1]
        .replace(/'/g, '"')
        .replace(/,\s*\]/, ']'),
    ),
    files = readdirSync(dir, { recursive: true })
      .filter(f => statSync(dir + f).isFile() && !['_headers', 'sw.js'].includes(f))
      .map(f => (f === 'index.html' ? '/' : '/' + f));
  assert.deepEqual([...shell].sort(), files.sort());
});
function fixture(values = {}) {
  const map = new Map(Object.entries(values)),
    starts = [];
  const ctx = {
    storage: {
      get: async k => map.get(k),
      put: async (k, v) =>
        typeof k === 'string'
          ? map.set(k, v)
          : Object.entries(k).forEach(([key, value]) => map.set(key, value)),
      setAlarm: async () => {},
      delete: async k => [].concat(k).forEach(key => map.delete(key)),
      deleteAll: async () => map.clear(),
      deleteAlarm: async () => {},
    },
    container: {
      running: false,
      images: { runner: 'pinned' },
      start: o => starts.push(o),
      interceptOutboundHttp: async () => {},
      setInactivityTimeout: async () => {},
    },
    exports: { ModelGateway: () => ({}), McpGateway: () => ({}), GitGateway: () => ({}) },
    id: { toString: () => 'id' },
  };
  ctx.storage.transaction = async fn => fn(ctx.storage);
  ctx.storage.list = async ({ prefix, reverse, limit } = {}) =>
    new Map(
      [...map.entries()]
        .filter(([k]) => k.startsWith(prefix || ''))
        .sort(([a], [b]) => (reverse ? b.localeCompare(a) : a.localeCompare(b)))
        .slice(0, limit || Infinity),
    );
  return { obj: new ArnoProbe(ctx, {}), ctx, starts };
}
test('provider display fields exclude tool arguments and opaque reasoning blocks', () => {
  assert.deepEqual(
    displayDelta({
      choices: [
        {
          delta: {
            content: 'Hello',
            reasoning_content: 'Visible thought',
            tool_calls: [{ function: { arguments: 'SECRET' } }],
          },
        },
      ],
    }),
    { text: 'Hello', reasoning: 'Visible thought' },
  );
  assert.deepEqual(displayDelta({ delta: { type: 'thinking_delta', thinking: 'Visible' } }), {
    text: '',
    reasoning: 'Visible',
  });
  assert.deepEqual(
    displayDelta({
      delta: { type: 'signature_delta', signature: 'PRIVATE' },
      content_block: { type: 'redacted_thinking', data: 'PRIVATE' },
    }),
    { text: '', reasoning: '' },
  );
});
test('coding gateway observes answer/thinking without changing the provider stream', async () => {
  const previews = [],
    events = [
      { choices: [{ delta: { reasoning_content: 'Display explanation' } }] },
      { choices: [{ delta: { content: 'Hello' } }] },
      {
        choices: [
          {
            delta: {
              content: ' world',
              tool_calls: [{ function: { arguments: 'private tool body' } }],
            },
          },
        ],
      },
    ];
  const wire = events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n';
  const observed = new Response(
    new Response(wire).body.pipeThrough(
      usageStream(
        async () => {},
        async p => previews.push(p),
      ),
    ),
  );
  assert.equal(await observed.text(), wire);
  assert.equal(previews.at(-1).text, 'Hello world');
  assert.equal(previews.at(-1).reasoning, 'Display explanation');
  assert.equal(previews.at(-1).final, true);
  assert.ok(!JSON.stringify(previews).includes('private tool body'));
});
test('plain chat publishes text before completion and keeps thinking out of answer text', async () => {
  let controller, ready;
  const shown = new Promise(r => (ready = r)),
    previews = [];
  const pending = plainChat({
    model: 'fixture',
    history: [],
    prompt: 'hello',
    key: 'test',
    onProgress: async p => {
      previews.push(p);
      ready();
    },
    upstream: async () => new Response(new ReadableStream({ start: c => (controller = c) })),
  });
  await new Promise(r => setImmediate(r));
  controller.enqueue(
    new TextEncoder().encode(
      'data: ' +
        JSON.stringify({
          choices: [{ delta: { content: 'Hello', reasoning_content: 'Model explanation' } }],
        }) +
        '\n\n',
    ),
  );
  await shown;
  assert.equal(previews[0].text, 'Hello');
  assert.equal(previews[0].reasoning, 'Model explanation');
  controller.enqueue(
    new TextEncoder().encode(
      'data: ' + JSON.stringify({ choices: [{ delta: { content: ' world' } }] }) + '\n\n',
    ),
  );
  controller.close();
  const result = await pending;
  assert.equal(result.summary, 'Hello world');
  assert.equal(result.reasoning, 'Model explanation');
  assert.equal(previews.at(-1).final, true);
});
test('live SSE replays bounded progress, rejects stale rounds and survives viewer disconnect', async () => {
  const f = fixture({ job: { id: 'job', status: 'running' } });
  await f.obj.progress({
    jobId: 'job',
    round: 2,
    text: 'Hello',
    reasoning: 'Optional',
    final: true,
  });
  await f.obj.progress({ jobId: 'other-job', round: 3, text: 'Wrong user turn' });
  await f.obj.progress({ jobId: 'job', round: 1, text: 'Old round' });
  const r = await f.obj.events(),
    reader = r.body.getReader(),
    decode = v => new TextDecoder().decode(v);
  assert.equal(r.headers.get('Content-Type'), 'text/event-stream');
  await reader.read();
  assert.match(decode((await reader.read()).value), /Hello/);
  await f.obj.progress({
    jobId: 'job',
    round: 2,
    text: 'Hello world',
    reasoning: 'Optional',
    final: true,
  });
  assert.match(decode((await reader.read()).value), /Hello world/);
  await reader.cancel();
  assert.equal(f.obj.viewers.size, 0);
  assert.equal((await f.ctx.storage.get('job')).status, 'running');
  const recreated = new ArnoProbe(f.ctx, {}),
    poll = await recreated.fetch(new Request('https://internal/session/job'));
  assert.equal((await poll.json()).preview.text, 'Hello world');
  f.ctx.storage.put('job', { id: 'job', status: 'cancelled' });
  await f.obj.progress({ round: 3, text: 'After cancel' });
  assert.equal(f.obj.live.text, 'Hello world');
});
test('cold session starts from saved checkpoint, with internet disabled', async () => {
  const f = fixture({ snapshot: { id: 'saved' } });
  await f.obj.start('mistral-large-4:cloud');
  assert.deepEqual(f.starts[0].containerSnapshot, { id: 'saved' });
  assert.equal(f.starts[0].enableInternet, false);
  assert.equal(f.starts[0].image, undefined);
});
test('transcript and repository survive object recreation without container', async () => {
  const f = fixture({
    session: { repo: 'owner/repo', model: 'm' },
    history: [{ prompt: 'hello', summary: 'done' }],
  });
  // The context-window lookup must not reach the network from a test.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  try {
    const r = await f.obj.fetch(new Request('https://internal/session/get'));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.history, [{ prompt: 'hello', summary: 'done' }]);
    assert.equal(body.contextWindow, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
test('catalog includes only completion models with tools and retains Le Chonk default', async () => {
  const d = await catalog(async () =>
    Response.json({
      models: [
        { name: 'coder', capabilities: ['completion', 'tools'] },
        { name: 'vision-only', capabilities: ['vision'] },
        { name: 'bad\nconfig', capabilities: ['completion', 'tools'] },
      ],
    }),
  );
  assert.deepEqual(
    d.models.map(m => m.id),
    ['mistral-large-4:cloud', 'coder'],
  );
  assert.equal(d.fallback, false);
});
test('catalog failures provide explicit fallback', async () => {
  const d = await catalog(async () => {
    throw Error('unavailable');
  });
  assert.equal(d.fallback, true);
  assert.equal(d.models.length, 3);
});
test('model cannot be changed during an active turn', async () => {
  const f = fixture();
  f.obj.inFlight = true;
  const r = await f.obj.fetch(
    new Request('https://internal/session/model', { method: 'POST', body: '{}' }),
  );
  assert.equal(r.status, 409);
});
test('submission saves a job, deduplicates retries and rejects a concurrent prompt', async () => {
  const f = fixture({ session: { repo: 'test/repo' } });
  const submit = id =>
    f.obj.fetch(
      new Request('https://internal/session/enqueue', {
        method: 'POST',
        body: JSON.stringify({ id, prompt: 'inspect repository' }),
      }),
    );
  const id = '11111111-1111-1111-1111-111111111111';
  assert.equal((await submit(id)).status, 202);
  assert.equal((await submit(id)).status, 202);
  assert.equal((await submit('22222222-2222-2222-2222-222222222222')).status, 409);
  assert.equal((await f.ctx.storage.get('job')).status, 'queued');
});
test('alarm runs a saved job and persists its result without the submitting request', async () => {
  const f = fixture({ job: { id: 'one', prompt: 'hello', status: 'queued' } });
  const original = f.obj.fetch.bind(f.obj);
  f.obj.fetch = async req =>
    new URL(req.url).pathname === '/session/run'
      ? Response.json({ summary: 'completed offline' })
      : original(req);
  await f.obj.alarm();
  assert.equal((await f.ctx.storage.get('job')).status, 'completed');
  assert.equal((await f.ctx.storage.get('job')).result.summary, 'completed offline');
});
test('Markdown renders formatting while escaping HTML and refusing executable links', () => {
  const html = markdown(
    '## Heading\n\n**bold** and [link](https://example.com)\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n`code`',
  );
  assert.match(html, /<h3>Heading/);
  assert.match(html, /<strong>bold/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<code>code/);
  assert.equal(cleanOutput('\nsafety: auto, working on a copy at /tmp\nAnswer'), 'Answer');
});
test('Markdown tables honour alignment, escaped pipes and code-span pipes', () => {
  const html = markdown('| a | b | c |\n|:--|:-:|--:|\n| x\\|y | \x60p|q\x60 | $1.20 |\n| short |');
  assert.match(html, /<th style="text-align:left">a/);
  assert.match(html, /<th style="text-align:center">b/);
  assert.match(html, /<th style="text-align:right">c/);
  assert.match(html, /<td style="text-align:left">x\|y</);
  assert.match(html, /<code>p\|q<\/code>/);
  assert.equal((html.match(/<td/g) || []).length, 6);
  assert.equal((html.match(/col-resize/g) || []).length, 3);
  assert.doesNotMatch(markdown('a | b\nnot a delimiter'), /<table/);
});
// The text of highlighted HTML: tags dropped, entities read back.
const unhighlight = h =>
  h
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(lt|gt|amp|quot|#39);/g,
      (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" })[e],
    );
// Whether every line of html opens as many spans as it closes.
const linesBalanced = html =>
  html
    .split('\n')
    .every(l => (l.match(/<span/g) || []).length === (l.match(/<\/span>/g) || []).length);
// The classes highlight gives the tokens of html, as { token: class }.
const classes = html =>
  Object.fromEntries(
    [...html.matchAll(/<span class="hl-(\w+)">([^<]*)<\/span>/g)].map(m => [
      unhighlight(m[2]),
      m[1],
    ]),
  );
test("highlight colours each language by ladle's classes", () => {
  const cases = {
    raz: [
      'proc f(x: INT): BOOL; begin return LEN(s) # nil end f. (* c *)',
      { proc: 'k', INT: 't', LEN: 'b', nil: 'n', '(* c *)': 'c' },
    ],
    concha: [
      "x := 1 // note\nif x > 0 then echo the end; end\nwriteln('hi')",
      { if: 'k', then: 'k', echo: 'b', writeln: 'b', "'hi'": 's', 1: 'n', '// note': 'c' },
    ],
    js: [
      'const a = `t ${b}`; class Foo {} console.log(null, /re/g) // c',
      { const: 'k', class: 'k', Foo: 't', console: 'b', null: 'n', '/re/g': 's', '// c': 'c' },
    ],
    ts: ['interface A { x: string }', { interface: 'k', A: 't', string: 't' }],
    python: [
      '@cache\ndef f(self):\n    return None  # c',
      { '@cache': 'b', def: 'k', f: 't', None: 'n', '# c': 'c' },
    ],
    shell: [
      'for f in *.c; do echo "$f"; done # c',
      { for: 'k', in: 'k', do: 'k', echo: 'b', $f: 'b', '# c': 'c' },
    ],
    json: ['{"a": true, "b": "x"}', { '"a"': 't', true: 'n', '"x"': 's' }],
    css: [
      '@media x { a { color: #fff; width: calc(1px) } }',
      { '@media': 'k', color: 't', '#fff': 'n', calc: 'b' },
    ],
    html: ['<a href="x">y</a><!-- c -->', { a: 'k', href: 't', '"x"': 's', '<!-- c -->': 'c' }],
    go: ['func f() string { return nil }', { func: 'k', string: 't', nil: 'n' }],
    rust: [
      'fn main() { let s: &str = "x"; println!("{}", s); }',
      { fn: 'k', str: 't', println: 'b', '"x"': 's' },
    ],
    c: [
      '#include <stdio.h>\nint main(void) { return NULL; }',
      { '#include': 'k', '<stdio.h>': 's', int: 't', NULL: 'n' },
    ],
    java: ['public class A { String s = null; }', { public: 'k', A: 't', String: 't', null: 'n' }],
    kotlin: ['fun f(): Int = 1', { fun: 'k', Int: 't', 1: 'n' }],
    sql: [
      "SELECT COUNT(*) FROM t WHERE a = 'x' -- c",
      { SELECT: 'k', COUNT: 'b', "'x'": 's', '-- c': 'c' },
    ],
    yaml: ['key: true # c', { key: 't', true: 'n', '# c': 'c' }],
    toml: ['[server]\nport = 80', { '[server]': 'k', port: 't', 80: 'n' }],
    markdown: ['# Title\n\n`code` and *em*', { '# Title': 'k', '`code`': 's', '*em*': 't' }],
  };
  for (const [lang, [code, want]] of Object.entries(cases)) {
    const got = classes(highlight(lang, code));
    for (const [token, cls] of Object.entries(want))
      assert.equal(got[token], cls, lang + ': ' + token);
  }
  assert.equal(detect({ path: 'src/a.cn' }), 'concha');
  assert.equal(detect({ path: 'x/concharc' }), 'concha');
  assert.equal(detect({ code: '#!/usr/bin/env python3\nprint(1)' }), 'python');
  assert.equal(detect({ code: '#!/bin/bash\n' }), 'shell');
  assert.equal(detect({ fence: 'sh title=x' }), 'shell');
  assert.equal(detect({ fence: 'TSX' }), 'ts');
  assert.equal(detect({ path: 'README' }), '');
});
test('highlight escapes everything and never lets a span cross a line break', () => {
  const nasty = '<b>&"\'</b>';
  for (const lang of ['js', 'python', 'raz', 'html', 'shell', 'nope']) {
    const code = 'x = "' + nasty + '" // ' + nasty + '\n# ' + nasty + '\n' + nasty;
    const html = highlight(lang, code);
    assert.doesNotMatch(html.replace(/<\/?span[^>]*>/g, ''), /[<>"']/, lang);
    assert.equal(unhighlight(html), code, lang);
  }
  const multi = {
    raz: '(* one\ntwo\nthree *) x := `raw\nstring`',
    js: '/* one\ntwo */ const s = `a\n${b}\nc`;',
    python: '"""doc\nstring""" x',
    shell: 'cat <<EOF\nbody\nEOF\necho "a\nb"',
    html: '<!-- a\nb -->',
  };
  for (const [lang, code] of Object.entries(multi)) {
    const html = highlight(lang, code);
    assert.equal(html.split('\n').length, code.split('\n').length, lang);
    assert.ok(linesBalanced(html), lang);
    assert.match(html.split('\n')[1], /^<span class="hl-[cs]">/, lang + ' goes on on line 2');
  }
  assert.equal(highlight('klingon', 'a < b'), 'a &lt; b');
  assert.equal(highlight(undefined, null), '');
});
test('highlight round-trips random text in every language without throwing', () => {
  const alphabet = 'ab01 \n\t"\'`$(){}[]<>/*#!-+=:;,.\\@&|%~^_?xX\r',
    langs =
      'raz concha js ts python shell json css html xml go rust c java kotlin sql yaml toml markdown diff';
  let seed = 7;
  const random = n => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let k = 0; k < 600; k++) {
    let s = '';
    for (let n = random(50); n > 0; n--) s += alphabet[random(alphabet.length)];
    for (const lang of langs.split(' ')) {
      const html = highlight(lang, s);
      assert.equal(unhighlight(html), s, lang + ' ' + JSON.stringify(s));
      assert.ok(linesBalanced(html), lang + ' ' + JSON.stringify(s));
    }
  }
  const big = 'let x = 1;\n'.repeat(6000);
  assert.equal(highlight('js', big), big, 'past 5,000 lines, plain');
});
test('code fences and diffs are highlighted by their language', () => {
  const html = markdown('```raz\nproc f(); (* <x> *)\n```\n\n```\n#!/bin/sh\necho hi\n```');
  assert.match(html, /<span class="hl-k">proc<\/span>/);
  assert.match(html, /<span class="hl-c">\(\* &lt;x&gt; \*\)<\/span>/);
  assert.match(html, /<span class="hl-b">echo<\/span>/);
  assert.match(html, /class="wrap-toggle"/);
  const diff = diffHtml(
    'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,3 +1,3 @@\n x = """doc\n-old"""\n+new"""\n y = None',
  );
  assert.match(diff, /<div class="diff-line remove">-<span class="hl-s">old&quot;&quot;&quot;/);
  assert.match(diff, /<div class="diff-line add">\+<span class="hl-s">new&quot;&quot;&quot;/);
  assert.match(diff, /<div class="diff-line "> y = <span class="hl-n">None<\/span>/);
  assert.match(diff, /<div class="diff-line file">\+\+\+ b\/a.py/);
});
test('follow-up prompts retain conversation and original GitHub identity', () => {
  const p = buildPrompt(
    { repo: 'owner/repo', ref: 'feature', sourceSha: 'abc' },
    [{ prompt: 'Remember lemon-42', summary: 'Remembered' }],
    'What was the phrase?',
  );
  assert.match(p, /lemon-42/);
  assert.match(p, /https:\/\/github.com\/owner\/repo/);
  assert.match(p, /"branch":"feature"/);
});
test('publish validation rejects traversal, duplicate paths and invalid file types', () => {
  assert.throws(() => validateFiles([{ path: '../secret', content: 'x', mode: '100644' }]));
  assert.throws(() =>
    validateFiles([
      { path: 'x', deleted: true },
      { path: 'x', deleted: true },
    ]),
  );
  assert.throws(() => validateFiles([{ path: 'x', content: 'x', mode: '120000' }]));
  assert.equal(validateFiles([{ path: 'src/a.txt', content: 'ok', mode: '100644' }]).length, 1);
});
test('SSE usage capture handles split chunks without changing streamed bytes', async () => {
  let usage;
  const text =
    'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":42,"completion_tokens":9}}\n\ndata: [DONE]\n\n';
  const encoder = new TextEncoder(),
    stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(text.slice(0, 35)));
        c.enqueue(encoder.encode(text.slice(35)));
        c.close();
      },
    });
  const result = await new Response(stream.pipeThrough(usageStream(async u => (usage = u)))).text();
  assert.equal(result, text);
  assert.deepEqual(usage, {
    prompt_tokens: 42,
    completion_tokens: 9,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
});
test('publishing checks review digest and creates only a new branch from pinned source', async () => {
  const authId = '11111111-1111-1111-1111-111111111111',
    changes = {
      repo: 'test/repo',
      ref: 'main',
      sourceSha: 'a'.repeat(40),
      files: [{ path: 'demo.txt', content: 'reviewed content', mode: '100644' }],
    };
  const env = {
    PROBE: {
      getByName: name => ({
        fetch: async () =>
          Response.json(
            name.startsWith('auth:') ? { user: { id: 1 }, token: 'test-only' } : changes,
          ),
      }),
    },
  };
  const req = (method, path, body) =>
    new Request('https://arno.test/api/sessions/' + authId + '/' + path, {
      method,
      headers: { Cookie: 'arno_session=' + authId, Origin: 'https://arno.test' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const review = await (await worker.fetch(req('GET', 'changes'), env)).json();
  const oldFetch = globalThis.fetch,
    requests = [];
  globalThis.fetch = async (url, opt) => {
    requests.push({ url, body: opt.body ? JSON.parse(opt.body) : null });
    if (url.endsWith('/git/commits/' + changes.sourceSha))
      return Response.json({ tree: { sha: 'base-tree' } });
    if (url.endsWith('/git/trees')) return Response.json({ sha: 'new-tree' });
    if (url.endsWith('/git/commits')) return Response.json({ sha: 'new-commit' });
    if (url.endsWith('/git/refs')) return Response.json({ ref: 'refs/heads/arno/test' });
    if (url.endsWith('/pulls'))
      return Response.json({ html_url: 'https://github.com/test/repo/pull/1' });
    throw Error('Unexpected GitHub request');
  };
  try {
    const body = { digest: 'stale', branch: 'arno/test', title: 'Test change' };
    assert.equal((await worker.fetch(req('POST', 'publish', body), env)).status, 409);
    assert.equal(requests.length, 0);
    const result = await worker.fetch(
      req('POST', 'publish', { ...body, digest: review.digest }),
      env,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(requests.find(r => r.url.endsWith('/git/commits')).body.parents, [
      changes.sourceSha,
    ]);
    assert.equal(requests.find(r => r.url.endsWith('/git/refs')).body.ref, 'refs/heads/arno/test');
    assert.equal(requests.find(r => r.url.endsWith('/pulls')).body.base, 'main');
  } finally {
    globalThis.fetch = oldFetch;
  }
});
test('cancel stops an active container and preserves the saved checkpoint', async () => {
  const f = fixture({
    job: { status: 'running', stage: 'thinking' },
    snapshot: { id: 'last-good' },
  });
  let stopped = false;
  f.ctx.storage.delete = async () => {};
  f.ctx.container.running = true;
  f.ctx.container.destroy = async () => (stopped = true);
  const r = await f.obj.fetch(new Request('https://internal/session/cancel', { method: 'POST' }));
  assert.equal(r.status, 200);
  assert.equal(stopped, true);
  assert.equal((await f.ctx.storage.get('job')).status, 'cancelled');
  assert.deepEqual(await f.ctx.storage.get('snapshot'), { id: 'last-good' });
});
test('new session import pins the branch revision and hands over the sign-in', async () => {
  const id = '11111111-1111-1111-1111-111111111111',
    sha = 'b'.repeat(40),
    seen = [];
  const env = {
    PROBE: {
      getByName: name => ({
        fetch: async (url, opt) => {
          if (name.startsWith('auth:'))
            return Response.json({ user: { id: 42 }, token: 'test-only' });
          if (url.endsWith('/session/init')) {
            assert.equal(opt.headers['X-Arno-Sha'], sha);
            assert.equal(JSON.parse(opt.headers['X-Arno-GitHub']).token, 'test-only');
            return Response.json({ repo: 'test/repo', sourceSha: sha });
          }
          return new Response(null, { status: 204 });
        },
      }),
    },
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    seen.push(url);
    return url.includes('/commits/') ? Response.json({ sha }) : new Response('fixture archive');
  };
  try {
    const req = new Request('https://arno.test/api/sessions', {
      method: 'POST',
      headers: { Cookie: 'arno_session=' + id },
      body: JSON.stringify({ repo: 'test/repo', ref: 'main', model: 'mistral-large-4:cloud' }),
    });
    const result = await worker.fetch(req, env);
    // Catalog discovery is allowed to fail into its known-good model fallback.
    assert.equal(result.status, 201);
    assert.ok(!seen.some(url => url.includes('/tarball/')), 'the container clones; no archive');
  } finally {
    globalThis.fetch = oldFetch;
  }
});
test('chat adapter carries prior turns and collects usage when tools are disabled', async () => {
  let payload;
  const result = await plainChat({
    model: 'test',
    history: [{ prompt: 'Remember peach', summary: 'Okay' }],
    prompt: 'What fruit?',
    key: 'test',
    upstream: async (url, opt) => {
      payload = JSON.parse(opt.body);
      return new Response(
        'data: {"choices":[{"delta":{"content":"peach"}}]}\n\ndata: {"usage":{"prompt_tokens":30,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
      );
    },
  });
  assert.equal(result.summary, 'peach');
  assert.equal(result.usage.inputTokens, 30);
  assert.equal(payload.tools, undefined);
  assert.equal(payload.messages[0].content, 'Remember peach');
});
test('code navigation rejects traversal and Git internals', () => {
  for (const path of [
    '../secret',
    'src/../../secret',
    '/etc/passwd',
    '.git/config',
    'src/.git/config',
  ])
    assert.equal(validPath(path), false);
  for (const path of ['', 'src', 'src/module.raz']) assert.equal(validPath(path), true);
});
test('repository visibility reports missing repo scope rather than implying all account repos', async () => {
  const env = {
    PROBE: {
      getByName: () => ({
        fetch: async () => Response.json({ user: { id: 1 }, token: 'test-only' }),
      }),
    },
  };
  const old = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      Array.from({ length: 17 }, (_, n) => ({
        full_name: 'user/repo' + n,
        default_branch: 'main',
        private: false,
      })),
      { headers: { 'X-OAuth-Scopes': 'read:user' } },
    );
  try {
    const req = new Request('https://arno.test/api/repos?page=1', {
      headers: { Cookie: 'arno_session=11111111-1111-1111-1111-111111111111' },
    });
    const d = await (await worker.fetch(req, env)).json();
    assert.equal(d.scanned, 17);
    assert.equal(d.access.privateAccess, false);
    assert.equal(d.nextPage, null);
  } finally {
    globalThis.fetch = old;
  }
});
test('account secrets are encrypted, masked and bound to user and credential field', async () => {
  const env = { ACCOUNT_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) };
  const encrypted = await seal(env, 1, 'provider:openai', 'sk-test-placeholder');
  assert.notEqual(encrypted.value, 'sk-test-placeholder');
  assert.equal(await unseal(env, 1, 'provider:openai', encrypted), 'sk-test-placeholder');
  await assert.rejects(() => unseal(env, 2, 'provider:openai', encrypted));
  await assert.rejects(() => unseal(env, 1, 'provider:anthropic', encrypted));
  const masked = publicProfile(env, {
    keys: { openai: encrypted },
    mcp: [{ id: 'demo', token: encrypted }],
  });
  assert.equal(masked.providers.openai.saved, true);
  assert.equal(masked.mcp[0].hasToken, true);
  assert.equal(masked.mcp[0].token, undefined);
  assert.equal(JSON.stringify(masked).includes(encrypted.value), false);
});
test('account API saves a key without returning it', async () => {
  const f = fixture(),
    env = {
      ACCOUNT_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
      PROBE: { getByName: () => ({ fetch: (url, opt) => f.obj.fetch(new Request(url, opt)) }) },
    };
  const r = await accountRoute(
    new Request('https://arno.test/api/account/key', {
      method: 'POST',
      body: JSON.stringify({ provider: 'openai', key: 'sk-test-placeholder' }),
    }),
    env,
    1,
  );
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.equal(text.includes('sk-test-placeholder'), false);
  assert.equal(JSON.parse(text).providers.openai.saved, true);
});
test('account validates and returns the about-you text', async () => {
  const f = fixture(),
    env = {
      ACCOUNT_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
      PROBE: { getByName: () => ({ fetch: (url, opt) => f.obj.fetch(new Request(url, opt)) }) },
    };
  const save = about =>
    accountRoute(
      new Request('https://arno.test/api/account', {
        method: 'POST',
        body: JSON.stringify({ systemPrompt: '', about, skills: [], mcp: [], models: [] }),
      }),
      env,
      1,
    );
  assert.equal((await save('x'.repeat(2001))).status, 400);
  assert.equal((await save(5)).status, 400);
  const r = await save('Ana, a nurse');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).about, 'Ana, a nurse');
});
test('account validates the home page, Enter key and default model', async () => {
  const f = fixture(),
    env = {
      ACCOUNT_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
      PROBE: { getByName: () => ({ fetch: (url, opt) => f.obj.fetch(new Request(url, opt)) }) },
    };
  const save = extra =>
    accountRoute(
      new Request('https://arno.test/api/account', {
        method: 'POST',
        body: JSON.stringify({ systemPrompt: '', skills: [], mcp: [], models: [], ...extra }),
      }),
      env,
      1,
    );
  // Defaults before anything is saved.
  let d = await (await save({})).json();
  assert.deepEqual(d.home, { quote: true, fact: true, moon: true, weather: false, place: '' });
  assert.equal(d.enterSends, false); // today's behaviour: Enter adds a line
  assert.equal(d.defaultModel, '');
  for (const bad of [
    { home: 'yes' },
    { home: { quote: 'yes' } },
    { home: { place: 'x'.repeat(101) } },
    { home: { lat: 95, lon: 0 } },
    { home: { lat: 'a', lon: 2 } },
    { enterSends: 'no' },
    { defaultModel: 5 },
    { defaultModel: 'meta/muse-spark-1.3-contributor' },
  ])
    assert.equal((await save(bad)).status, 400, JSON.stringify(bad));
  d = await (
    await save({
      home: { quote: false, weather: true, lat: 38.7223, lon: -9.1393 },
      enterSends: false,
      defaultModel: 'openai/gpt-test',
    })
  ).json();
  // Coordinates are kept only to about 10 km.
  assert.deepEqual(d.home, {
    quote: false,
    fact: true,
    moon: true,
    weather: true,
    place: '',
    lat: 38.7,
    lon: -9.1,
  });
  assert.equal(d.enterSends, false);
  assert.equal(d.defaultModel, 'openai/gpt-test');
  // A save that leaves them out keeps them.
  d = await (await save({ about: 'Ana' })).json();
  assert.equal(d.enterSends, false);
  assert.equal(d.home.weather, true);
});
test('moon phase matches known new and full moons', () => {
  const near = (phase, target) => Math.min(Math.abs(phase - target), 1 - Math.abs(phase - target));
  // New moons of the total solar eclipses of 2017-08-21 and 2024-04-08.
  for (const at of ['2017-08-21T18:30Z', '2024-04-08T18:21Z']) {
    const m = moon(new Date(at));
    assert.ok(near(m.phase, 0) < 0.03, at);
    assert.equal(m.name, 'New moon');
    assert.ok(m.lit < 0.02);
    assert.ok(Math.abs(m.toFull - 14.8) < 1);
  }
  // Full moon of the total lunar eclipse of 2025-03-14.
  const m = moon(new Date('2025-03-14T06:55Z'));
  assert.ok(near(m.phase, 0.5) < 0.03);
  assert.equal(m.name, 'Full moon');
  assert.ok(m.lit > 0.98);
  assert.equal(moon(new Date('2025-03-21T12:00Z')).name, 'Last quarter');
});
test('home page picks one quote and fact a day, and reads weather codes', () => {
  const day = new Date(2026, 10, 9, 8),
    evening = new Date(2026, 10, 9, 22);
  assert.equal(daily(QUOTES, day), daily(QUOTES, evening));
  assert.notEqual(daily(QUOTES, day), daily(QUOTES, new Date(2026, 10, 10, 8)));
  assert.notEqual(daily(FACTS, day), daily(FACTS, day, 1));
  assert.ok(QUOTES.length >= 450 && FACTS.length >= 450);
  assert.ok(QUOTES.every(([text, author]) => text && typeof author === 'string'));
  assert.equal(weatherText(0).text, 'Clear sky');
  assert.equal(weatherText(63).text, 'Rain');
  assert.equal(weatherText(99).text, 'Thunderstorm with hail');
  assert.equal(weatherText(1234).text, 'Unknown');
});
test('conversations are ordered by last activity, with relative times', async () => {
  const list = [
    { id: 'old', createdAt: 1 },
    { id: 'busy', createdAt: 2, updatedAt: 50 },
    { id: 'new', createdAt: 10 },
  ];
  assert.deepEqual(
    byRecent(list).map(s => s.id),
    ['busy', 'new', 'old'],
  );
  const now = new Date(2026, 10, 9, 15).getTime();
  assert.equal(ago(now - 20000, now), 'now');
  assert.equal(ago(now - 2 * 60000, now), '2m');
  assert.equal(ago(now - 3 * 3600000, now), '3h');
  assert.equal(ago(new Date(2026, 10, 8, 23).getTime(), now), 'Yesterday');
  assert.equal(ago(0, now), '');
  // The server's list is in the same order.
  const f = fixture();
  f.ctx.storage.list = async () => new Map(list.map(s => ['session:' + s.id, s]));
  const r = await f.obj.fetch(new Request('https://internal/index/list'));
  assert.deepEqual(
    (await r.json()).sessions.map(s => s.id),
    ['busy', 'new', 'old'],
  );
});
test('Anthropic gateway uses native protocol and merges usage without exposing credentials', async () => {
  let seen, usage;
  const r = await modelRequest(
    new Request('http://model.internal/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'Harness',
        stream: true,
      }),
    }),
    {
      provider: 'anthropic',
      model: 'claude-test',
      key: 'test-only',
      instructions: 'User preference',
      authorize: async () => true,
      onUsage: async u => (usage = u),
      upstream: async (url, opt) => {
        seen = { url, opt, body: JSON.parse(opt.body) };
        return new Response(
          'data: {"type":"message_start","message":{"usage":{"input_tokens":25}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
        );
      },
    },
  );
  await r.text();
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.opt.headers['x-api-key'], 'test-only');
  assert.equal(seen.body.system[0].text, 'User preference');
  assert.equal(seen.body.system[1].text, 'Harness');
  assert.deepEqual(usage, {
    prompt_tokens: 25,
    completion_tokens: 7,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
});
test('account instructions include only enabled skills and MCP rejects private endpoints', () => {
  assert.equal(
    instructions({
      systemPrompt: 'Be concise',
      skills: [
        { name: 'Tests', content: 'Run checks', enabled: true },
        { name: 'Hidden', content: 'No', enabled: false },
      ],
    }),
    'Be concise\n\nSkill: Tests\nRun checks',
  );
  assert.equal(
    instructions({ about: 'Ana, a nurse', systemPrompt: 'Be concise' }),
    'About the user:\nAna, a nurse\n\nBe concise',
  );
  for (const url of [
    'http://example.com/mcp',
    'https://127.0.0.1/mcp',
    'https://metadata.google.internal/mcp',
    'https://name:password@example.com/mcp',
  ])
    assert.equal(validMcpUrl(url), false);
  assert.equal(validMcpUrl('https://mcp.example.com/mcp'), true);
});
test('remote MCP proxy rebuilds authorization outside the container and confirms initialization', async () => {
  const old = globalThis.fetch,
    requests = [];
  globalThis.fetch = async (url, opt) => {
    requests.push({ url, opt });
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26', serverInfo: { name: 'Fixture' } },
    });
  };
  try {
    const d = await testMcp(
      { id: 'fixture', name: 'Fixture', url: 'https://mcp.example.com/mcp' },
      'mcp-test-token',
    );
    assert.equal(d.ok, true);
    assert.equal(requests[0].opt.headers.Authorization, 'Bearer mcp-test-token');
    assert.equal(requests[0].opt.redirect, 'manual');
  } finally {
    globalThis.fetch = old;
  }
});
test('research registers several real results and citations only link known sources', async () => {
  const sources = [],
    counts = {};
  const data = await research(
    'web_search',
    { query: 'official docs' },
    {
      key: 'test',
      sources,
      counts,
      upstream: async () =>
        Response.json({
          results: [
            { title: 'One', url: 'https://one.example.com/docs', content: 'A' },
            { title: 'Two', url: 'https://two.example.com/blog', content: 'B' },
          ],
        }),
    },
  );
  assert.equal(data.sources.length, 2);
  assert.equal(counts.searches, 1);
  const html = markdown('Fact [1] and other fact [2]. Fabricated [99].', sources);
  assert.match(html, /data-citation="1"/);
  assert.match(html, /data-citation="2"/);
  assert.doesNotMatch(html, /data-citation="99"/);
  assert.equal(citedSources('Fact [2]', sources)[0].title, 'Two');
});
test('plain chat executes a web tool then returns a cited final answer', async () => {
  let calls = 0,
    executed = false;
  const result = await plainChat({
    model: 'test',
    history: [],
    prompt: 'Research this',
    key: 'test',
    runTool: async name => {
      executed = true;
      assert.equal(name, 'web_search');
      return { sources: [{ id: 1, title: 'Official', url: 'https://example.com/docs' }] };
    },
    upstream: async () =>
      new Response(
        ++calls === 1
          ? 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"web_search","arguments":"{\\"query\\":\\"test\\"}"}}]}}]}\n\n'
          : 'data: {"choices":[{"delta":{"content":"Verified fact [1]."}}]}\n\n',
      ),
  });
  assert.equal(executed, true);
  assert.equal(result.usage.calls, 2);
  assert.equal(result.summary, 'Verified fact [1].');
});
test('conversation rename preserves repository identity and delete rejects active work', async () => {
  const f = fixture({
    session: { repo: 'owner/repo', ref: 'main', model: 'm' },
    job: { status: 'running' },
  });
  const r = await f.obj.fetch(
    new Request('https://internal/session/rename', {
      method: 'POST',
      body: JSON.stringify({ title: 'My research' }),
    }),
  );
  assert.equal(r.status, 200);
  assert.equal((await f.ctx.storage.get('session')).repo, 'owner/repo');
  assert.equal((await f.ctx.storage.get('session')).title, 'My research');
  assert.equal(
    (await f.obj.fetch(new Request('https://internal/session/delete', { method: 'POST' }))).status,
    409,
  );
});
test('prices parse provider tables and count cached tokens once', async () => {
  const { parseOllama, parseOpenRouter, priceOf, tokens, cost } = await import('./prices.mjs');
  const ollama = parseOllama(
    '<table><tr><td>Model</td><td>Input</td><td>Cached input</td><td>Output</td></tr><tr><td><a href="/library/glm-5.3">glm-5.3</a></td><td>$1.40</td><td>$0.26</td><td>$4.40</td></tr><tr><td>glm-5.3 (Off-Peak)</td><td>$0.70</td><td>$0.13</td><td>$2.20</td></tr></table><p>Off-peak pricing apply outside 12:00 and 18:00 UTC on weekdays</p>',
  );
  assert.equal(priceOf(ollama, 'glm-5.3', Date.UTC(2026, 10, 9, 12)).inp, 1.4);
  assert.equal(priceOf(ollama, 'glm-5.3', Date.UTC(2026, 10, 9, 18)).inp, 0.7);
  assert.equal(priceOf(ollama, 'glm-5.3', Date.UTC(2026, 10, 8, 13)).inp, 0.7);
  const router = parseOpenRouter({
    data: [
      {
        id: 'anthropic/claude-opus-5.5',
        pricing: { prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000002' },
      },
    ],
  });
  assert.equal(priceOf(ollama, 'glm-5.3:cloud', Date.UTC(2026, 10, 9, 15)).inp, 1.4);
  assert.equal(priceOf(router, 'anthropic/claude-opus-5-5').out, 20);
  assert.deepEqual(
    tokens({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 40 },
    }),
    { input: 60, cached: 40, write: 0, output: 5 },
  );
  assert.deepEqual(tokens({ input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 5 }), {
    input: 60,
    cached: 40,
    write: 0,
    output: 5,
  });
  assert.equal(
    cost(
      { inp: 1, cached: 0.1, out: 10 },
      { measuredCalls: 1, inputTokens: 1e6, cachedTokens: 5e5, outputTokens: 1e5 },
    ).toFixed(2),
    '1.55',
  );
});
test('wrangler builds the worker bundle', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs'),
    { tmpdir } = await import('node:os');
  const out = mkdtempSync(tmpdir() + '/arno-bundle-');
  try {
    execFileSync(
      new URL('./node_modules/.bin/wrangler', import.meta.url).pathname,
      ['deploy', '--dry-run', '--outdir', out],
      {
        cwd: new URL('.', import.meta.url).pathname,
        stdio: 'pipe',
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      },
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
test('Gemini: index-less tool calls keep their thought signature; thoughts leave the answer', async () => {
  const sse = chunks =>
    new Response(
      chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
    );
  const bodies = [];
  const replies = [
    sse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: 'a',
                  type: 'function',
                  extra_content: { google: { thought_signature: 'sig' } },
                  function: { name: 'web_search', arguments: '{"query":"q"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 40 },
      },
    ]),
    sse([
      { choices: [{ delta: { content: '<thought>weighing it' } }] },
      {
        choices: [{ delta: { content: '</thought>Answer [1]' } }],
        usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 30 },
      },
    ]),
  ];
  const r = await plainChat({
    model: 'gemini-3.8-flash',
    provider: 'gemini',
    key: 'k',
    history: [],
    prompt: 'p',
    runTool: async () => ({ sources: [] }),
    upstream: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      assert.match(url, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/);
      return replies.shift();
    },
  });
  assert.deepEqual(bodies[1].messages.at(-2).tool_calls[0].extra_content, {
    google: { thought_signature: 'sig' },
  });
  assert.equal(r.summary, 'Answer [1]');
  assert.equal(r.reasoning, 'weighing it');
  assert.equal(r.usage.outputTokens, 30 + 10); // thinking counted from total_tokens
});
test('Gemini prices: first tier, dated changes resolved at the turn time', async () => {
  const { parseGemini, priceOf } = await import('./prices.mjs');
  const page = `## Gemini 9 Flash  {% id="gemini-9-flash" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Free of charge
  * $0.75 through December 31, 2026.
  $1.50 starting January 1, 2027.

  ---

  * Output price (including thinking tokens)
  * Free of charge
  * $3.00, prompts <= 200k tokens
  $6.00, prompts > 200k

  ---

  * Context caching price
  * Free of charge
  * $0.075
  $0.50 / 1,000,000 tokens per hour (storage price)
  {% /table %}
  {% /tab %}
  {% tab title="Batch" %}
  * Input price
  * $0.01
  {% /tab %}`;
  const rows = parseGemini(page);
  assert.deepEqual(priceOf(rows, 'gemini/gemini-9-flash', Date.UTC(2026, 11, 31, 23)), {
    inp: 0.75,
    cached: 0.075,
    out: 3,
  });
  assert.equal(priceOf(rows, 'gemini/gemini-9-flash', Date.UTC(2027, 0, 1, 1)).inp, 1.5);
});
/** Streams in the shapes the providers' API references document (no keys:
 * their endpoints answer 401, so these fixtures stand in for real replies). */
const sse = chunks =>
  new Response(
    chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
  );
const delta = (d, extra = {}) => ({
  choices: [{ index: 0, delta: d, finish_reason: null }],
  ...extra,
});
const callDeltas = id => [
  delta({
    tool_calls: [
      { index: 0, id, type: 'function', function: { name: 'web_search', arguments: '' } },
    ],
  }),
  delta({ tool_calls: [{ index: 0, function: { arguments: '{"query":"q"}' } }] }),
];
const BYOK = {
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    fields: { max_tokens: 16384, stream_options: { include_usage: true } },
    // Thinking in reasoning_content; usage rides on the last content chunk.
    rounds: [
      [
        delta({ role: 'assistant', content: '', reasoning_content: 'look it up' }, { usage: null }),
        ...callDeltas('call_00_a'),
        {
          choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 64 },
            prompt_cache_hit_tokens: 64,
            prompt_cache_miss_tokens: 36,
          },
        },
      ],
      [
        delta({ reasoning_content: 'found it' }),
        delta({ content: 'Answer' }),
        {
          choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 10,
            total_tokens: 210,
            prompt_tokens_details: { cached_tokens: 100 },
            prompt_cache_hit_tokens: 100,
            prompt_cache_miss_tokens: 100,
          },
        },
      ],
    ],
    reasoning: 'found it',
    usage: { inputTokens: 300, cachedTokens: 164, cacheWriteTokens: 0, outputTokens: 30 },
  },
  kimi: {
    url: 'https://api.moonshot.ai/v1/chat/completions',
    fields: { max_completion_tokens: 16384, stream_options: { include_usage: true } },
    // A usage-only last chunk with empty choices; cache writes inside prompt_tokens.
    rounds: [
      [
        delta({ role: 'assistant', content: '' }),
        delta({ reasoning_content: 'look it up' }),
        ...callDeltas('web_search:0'),
        {
          choices: [],
          usage: {
            prompt_tokens: 373,
            completion_tokens: 93,
            total_tokens: 466,
            prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 256 },
          },
        },
      ],
      [
        delta({ content: 'Answer' }),
        {
          choices: [],
          usage: {
            prompt_tokens: 400,
            completion_tokens: 7,
            total_tokens: 407,
            prompt_tokens_details: { cached_tokens: 356, cache_write_tokens: 0 },
          },
        },
      ],
    ],
    reasoning: '',
    usage: { inputTokens: 773, cachedTokens: 456, cacheWriteTokens: 256, outputTokens: 100 },
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    fields: { max_tokens: 16384 },
    // Thinking arrives as content chunks; usage in the last chunk unasked.
    rounds: [
      [
        ...callDeltas('Ab3dE5gH7'),
        {
          ...delta({ content: '' }),
          usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 },
        },
      ],
      [
        delta({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'weigh ' }] }] }),
        delta({
          content: [
            { type: 'thinking', thinking: [{ type: 'text', text: 'it' }] },
            { type: 'text', text: 'Ans' },
          ],
        }),
        delta({ content: 'wer' }),
        {
          ...delta({ content: '' }),
          usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
        },
      ],
    ],
    reasoning: 'weigh it',
    usage: { inputTokens: 130, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 39 },
  },
  meta: {
    url: 'https://api.meta.ai/v1/chat/completions',
    fields: { max_completion_tokens: 16384, stream_options: { include_usage: true } },
    // Reasoning stays private; usage only on the final, choice-less chunk.
    rounds: [
      [
        ...callDeltas('call_m1'),
        {
          choices: [],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 12,
            total_tokens: 52,
            completion_tokens_details: { reasoning_tokens: 8 },
            prompt_tokens_details: { cached_tokens: 32 },
          },
        },
      ],
      [
        delta({ content: 'Answer' }),
        {
          choices: [],
          usage: {
            prompt_tokens: 60,
            completion_tokens: 3,
            total_tokens: 63,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        },
      ],
    ],
    reasoning: '',
    usage: { inputTokens: 100, cachedTokens: 72, cacheWriteTokens: 0, outputTokens: 15 },
  },
};
test('DeepSeek, Kimi, Mistral and Meta: endpoint, fields, tool loop and usage', async () => {
  for (const [provider, want] of Object.entries(BYOK)) {
    const bodies = [],
      replies = want.rounds.map(sse),
      searched = [];
    const r = await plainChat({
      model: 'm1',
      provider,
      key: 'sk-' + provider,
      history: [{ prompt: 'earlier', summary: 'said', reasoning: 'thought' }],
      prompt: 'p',
      runTool: async (name, args) => (searched.push([name, args]), { sources: [] }),
      upstream: async (url, init) => {
        assert.equal(url, want.url, provider);
        assert.equal(init.headers.Authorization, 'Bearer sk-' + provider);
        bodies.push(JSON.parse(init.body));
        return replies.shift();
      },
    });
    const [first, second] = bodies,
      { model, messages, stream, tools, ...fields } = first;
    assert.deepEqual(fields, want.fields, provider);
    assert.equal(model, 'm1');
    assert.equal(stream, true);
    assert.equal(tools.length > 0, true);
    assert.deepEqual(searched, [['web_search', { query: 'q' }]], provider);
    const replay = provider === 'deepseek' || provider === 'kimi';
    // DeepSeek needs earlier thinking back once tools are offered; Kimi asks for it.
    assert.equal(messages[1].reasoning_content, replay ? 'thought' : undefined, provider);
    const call = second.messages.at(-2);
    assert.equal(call.tool_calls[0].function.arguments, '{"query":"q"}');
    assert.equal(call.reasoning_content, replay ? 'look it up' : undefined, provider);
    assert.equal(second.messages.at(-1).role, 'tool');
    assert.equal(r.summary, 'Answer', provider);
    assert.equal(r.reasoning, want.reasoning, provider);
    const { inputTokens, cachedTokens, cacheWriteTokens, outputTokens } = r.usage;
    assert.deepEqual(
      { inputTokens, cachedTokens, cacheWriteTokens, outputTokens },
      want.usage,
      provider,
    );
  }
});
test('coding gateway: Mistral gets no stream_options and its thinking chunks become strings', async () => {
  let sent, usage;
  const r = await modelRequest(
    new Request('http://model.internal/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'mistral-large-4',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Hello', reasoning_content: 'greet' },
          { role: 'user', content: 'and?' },
        ],
        stream: true,
      }),
    }),
    {
      provider: 'mistral',
      model: 'mistral-large-4',
      key: 'k',
      authorize: async () => true,
      onUsage: async u => (usage = u),
      upstream: async (url, init) => {
        sent = { url, body: JSON.parse(init.body) };
        return sse(BYOK.mistral.rounds[1]);
      },
    },
  );
  const lines = (await r.text()).split('\n').filter(l => l.startsWith('data: {'));
  assert.equal(sent.url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(sent.body.stream_options, undefined);
  assert.equal(sent.body.max_tokens, 16384);
  assert.deepEqual(sent.body.messages[1], { role: 'assistant', content: 'Hello' });
  assert.deepEqual(JSON.parse(lines[1].slice(6)).choices[0].delta, {
    content: 'Ans',
    reasoning_content: 'it',
  });
  assert.deepEqual(usage, {
    prompt_tokens: 80,
    completion_tokens: 30,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });
});
test('model discovery keeps chat models of DeepSeek, Kimi, Mistral and Meta', async () => {
  const { providerModels } = await import('./account.mjs');
  const lists = {
    'https://api.deepseek.com/models': [
      { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4.1-Flash' },
      { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4-Pro' },
    ],
    'https://api.moonshot.ai/v1/models': [
      { id: 'kimi-k3.1-pro', object: 'model', owned_by: 'moonshot', context_length: 1048576 },
    ],
    'https://api.mistral.ai/v1/models': [
      {
        id: 'mistral-large-4',
        aliases: ['mistral-large-latest'],
        capabilities: { completion_chat: true },
      },
      {
        id: 'mistral-large-latest',
        aliases: ['mistral-large-4'],
        capabilities: { completion_chat: true },
      },
      {
        id: 'mistral-small-latest',
        aliases: ['mistral-small-2603'],
        capabilities: { completion_chat: true },
      },
      { id: 'mistral-embed-2312', capabilities: { completion_chat: false } },
      { id: 'codestral-embed-2505', capabilities: { completion_chat: true } },
      { id: 'mistral-ocr-4-1', capabilities: { completion_chat: false, ocr: true } },
    ],
    'https://api.meta.ai/v1/models': [
      { id: 'muse-spark-1.3' },
      { id: 'muse-wonder-1.0' },
      { id: 'muse-image-1.0' },
      { id: 'muse-voice-transcribe-1.0' },
      { id: 'sam-3.1' },
    ],
  };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer key-0123456789');
    return Response.json({ object: 'list', data: lists[url] });
  };
  try {
    const ids = async p => (await providerModels(p, 'key-0123456789')).map(m => m.id);
    assert.deepEqual(await ids('deepseek'), [
      'deepseek/deepseek-flash',
      'deepseek/deepseek-v4-pro',
    ]);
    assert.equal(
      (await providerModels('deepseek', 'key-0123456789'))[0].name,
      'DeepSeek · DeepSeek-V4.1-Flash',
    );
    assert.deepEqual(await ids('kimi'), ['kimi/kimi-k3.1-pro']);
    // An alias is dropped only when the model it names is listed too.
    assert.deepEqual(await ids('mistral'), [
      'mistral/mistral-large-4',
      'mistral/mistral-small-latest',
    ]);
    assert.deepEqual(await ids('meta'), ['meta/muse-spark-1.3', 'meta/muse-wonder-1.0']);
  } finally {
    globalThis.fetch = real;
  }
});
test('DeepSeek, Mistral and Meta prices from their pages; Kimi via OpenRouter; each kept apart', async () => {
  const { parseDeepSeek, parseMistral, parseMeta, parseOpenRouter, parseOllama, priceOf } =
    await import('./prices.mjs');
  const deepseek = parseDeepSeek(`| MODEL | MODEL | MODEL | deepseek-flash(1) | deepseek-v4-pro |
| --- | --- | --- | --- | --- |
| BASE URL (OpenAI Format) | BASE URL (OpenAI Format) | BASE URL (OpenAI Format) | <https://api.deepseek.com> | <https://api.deepseek.com> |
| PRICING(2) | 1M INPUT TOKENS / (CACHE HIT) | OFF-PEAK | $0.003 | $0.022 |
| PRICING(2) | 1M INPUT TOKENS / (CACHE HIT) | PEAK | $0.006 | $0.044 |
| PRICING(2) | 1M INPUT TOKENS / (CACHE MISS) | OFF-PEAK | $0.15 | $0.66 |
| PRICING(2) | 1M INPUT TOKENS / (CACHE MISS) | PEAK | $0.3 | $1.32 |
| PRICING(2) | 1M OUTPUT TOKENS | OFF-PEAK | $0.6 | $1.98 |
| PRICING(2) | 1M OUTPUT TOKENS | PEAK | $1.2 | $3.96 |

(2) Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.`);
  const monday = h => Date.UTC(2026, 10, 9, h);
  assert.deepEqual(priceOf(deepseek, 'deepseek/deepseek-v4-pro', monday(7)), {
    cached: 0.044,
    inp: 1.32,
    out: 3.96,
    offPeak: { cached: 0.022, inp: 0.66, out: 1.98 },
    peak: [
      [1, 4],
      [6, 10],
    ],
  });
  assert.equal(priceOf(deepseek, 'deepseek/deepseek-flash', monday(4)).inp, 0.15);
  assert.equal(priceOf(deepseek, 'deepseek/deepseek-flash', Date.UTC(2026, 10, 8, 2)).inp, 0.15);
  const mistral = parseMistral(`| Model | API name | Price |
| --- | --- | --- |
| [Mistral Large 4](/models/mistral-large-4-0) | \`mistral-large-4\` | Input $0.7 /M Tokens<br>Cached input $0.07 /M Tokens<br>Output $2.1 /M Tokens |
| [Mistral Small 4](/models/mistral-small-4-0-26-03) | \`mistral-small-2603\` | Input $0.15 /M Tokens<br>Output $0.6 /M Tokens |
| [OCR 4.1](/models/ocr-4-1) | \`mistral-ocr-4-1\` | Input $4 /1000 Pages |
| [Voxtral Mini Transcribe 3](/models/voxtral-mini-transcribe-3-0) | \`voxtral-mini-transcribe-3-0\` | Input $0.0035 /Min |`);
  assert.deepEqual(priceOf(mistral, 'mistral/mistral-large-4'), {
    inp: 0.7,
    cached: 0.07,
    out: 2.1,
  });
  assert.deepEqual(priceOf(mistral, 'mistral/mistral-small-2603'), {
    inp: 0.15,
    cached: 0.15,
    out: 0.6,
  });
  assert.equal(mistral.size, 2);
  const meta = parseMeta(`### Muse Wonder
Model: \`muse-wonder-1.0\`.
| Usage        | Contributor mode (per 1M tokens) | Standard mode (per 1M tokens) |
| :----------- | :------------------------------- | :---------------------------- |
| Cached input | Not available                    | $0.20                         |
| Input        | Not available                    | $4.00                         |
| Output       | Not available                    | $20.00                        |
### Muse Spark
Models: \`muse-spark-1.3\` in Standard mode; \`muse-spark-1.3-contributor\` in Contributor mode.
| Usage        | Contributor mode (per 1M tokens) | Standard mode (per 1M tokens) |
| :----------- | :------------------------------- | :---------------------------- |
| Cached input | $0.002                           | $0.15                         |
| Input        | $0.10                            | $1.25                         |
| Output       | $0.20                            | $4.25                         |
### Muse Image
| Usage           | Price           |
| :-------------- | :-------------- |
| Generated image | $0.01 per image |`);
  assert.deepEqual(priceOf(meta, 'meta/muse-wonder-1.0'), { inp: 4, cached: 0.2, out: 20 });
  assert.deepEqual(priceOf(meta, 'meta/muse-spark-1.3-contributor'), {
    inp: 0.1,
    cached: 0.002,
    out: 0.2,
  });
  assert.equal(priceOf(meta, 'meta/muse-spark-1.3').out, 4.25);
  const price = (prompt, completion, cache) => ({ prompt, completion, input_cache_read: cache });
  const router = parseOpenRouter({
    data: [
      {
        id: 'moonshotai/kimi-k3.1-pro',
        pricing: price('0.000002', '0.00001', '0.0000002'),
        context_length: 1048576,
      },
      { id: 'mistralai/mistral-medium-3-5', pricing: price('0.0000015', '0.0000075') },
      { id: 'deepseek/deepseek-v4-flash', pricing: price('0.000000091', '0.000000182') },
      { id: 'meta-llama/llama-4-scout', pricing: price('0.0000001', '0.0000003') },
    ],
  });
  assert.equal(priceOf(router, 'kimi/kimi-k3.1-pro').inp, 2);
  assert.equal(priceOf(router, 'kimi/kimi-k3.1-pro').cached.toFixed(2), '0.20');
  assert.equal(priceOf(router, 'mistral/mistral-medium-3-5').out, 7.5);
  // OpenRouter's DeepSeek and Llama prices are other hosts', not the maker's.
  assert.equal(priceOf(router, 'deepseek/deepseek-v4-flash'), null);
  assert.equal(priceOf(router, 'meta/llama-4-scout'), null);
  // Ollama's price for an open model never stands in for its maker's.
  const ollama = parseOllama(
    '<table><tr><td>m</td><td>i</td><td>c</td><td>o</td></tr><tr><td>deepseek-v4-pro</td><td>$9</td><td>$9</td><td>$9</td></tr></table>',
  );
  const all = new Map([...ollama, ...deepseek]);
  assert.equal(priceOf(all, 'deepseek-v4-pro:cloud').inp, 9);
  assert.equal(priceOf(all, 'deepseek/deepseek-v4-pro', monday(7)).inp, 1.32);
});

test('markdown images load through the proxy and only over HTTP(S)', () => {
  const html = markdown('![a "cat" & co](https://img.example.com/c.png?x=1&y=2)');
  assert.match(
    html,
    /<img src="\/api\/image\?url=https%3A%2F%2Fimg\.example\.com%2Fc\.png%3Fx%3D1%26y%3D2"/,
  );
  assert.match(html, /alt="a &quot;cat&quot; &amp; co"/);
  assert.match(
    html,
    /<a class="md-image" href="https:\/\/img\.example\.com\/c\.png\?x=1&amp;y=2" target="_blank"/,
  );
  assert.doesNotMatch(html, /<a [^>]*>[^<]*<a /);
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA'])
    assert.doesNotMatch(markdown('![x](' + bad + ')'), /<img|<a /);
});

test('image proxy refuses private hosts, non-images, SVG and private redirects, and passes PNG', async () => {
  const { proxyImage } = await import('./api.mjs');
  const reply =
    (body, type, status = 200, headers = {}) =>
    async () =>
      new Response(body, { status, headers: { 'Content-Type': type, ...headers } });
  const never = async () => assert.fail('upstream must not be called');
  assert.equal((await proxyImage('http://127.0.0.1/x.png', never)).status, 400);
  assert.equal((await proxyImage('file:///etc/passwd', never)).status, 400);
  assert.equal(
    (await proxyImage('https://a.example.com/x', reply('<html>', 'text/html'))).status,
    415,
  );
  assert.equal(
    (await proxyImage('https://a.example.com/x.svg', reply('<svg/>', 'image/svg+xml'))).status,
    415,
  );
  const redirect = reply('', 'text/plain', 302, { Location: 'http://localhost/x.png' });
  assert.equal((await proxyImage('https://a.example.com/x.png', redirect)).status, 400);
  const ok = await proxyImage(
    'https://a.example.com/x.png',
    reply(new Uint8Array([137, 80]), 'image/png'),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Content-Type'), 'image/png');
  assert.equal(ok.headers.get('Cache-Control'), 'private, max-age=86400');
  assert.equal(ok.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(ok.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  assert.equal((await ok.arrayBuffer()).byteLength, 2);
});

test('failed turns stay in the transcript, out of context, until a retry replaces them', async () => {
  const f = fixture({ session: { id: 's', kind: 'chat' } });
  await f.obj.recordFailure({ prompt: 'first try' }, 'boom');
  const [failed] = await f.obj.history(true);
  assert.equal(failed.failed, true);
  assert.equal(failed.error, 'boom');
  assert.deepEqual(await f.obj.history(), []);
  // A retry that fails again replaces the old record rather than adding one.
  await new Promise(r => setTimeout(r, 2));
  await f.obj.recordFailure({ prompt: 'first try', replaces: failed.at }, 'boom again');
  const after = await f.obj.history(true);
  assert.equal(after.length, 1);
  assert.equal(after[0].error, 'boom again');
});
async function vapidKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
}
/** An index object for push tests, reached through env.PROBE. */
function pushIndex(env) {
  const f = fixture();
  env.PROBE = { getByName: () => f.obj };
  return f;
}
test('VAPID JWT is ES256 over the claims and verifies with the served public key', async () => {
  const { vapidJwt, publicKey, pushApiRoutes } = await import('./push.mjs');
  const env = { VAPID_KEY: await vapidKey() },
    jwk = JSON.parse(env.VAPID_KEY);
  const served = await (await pushApiRoutes['GET /api/push/key'](null, env)).json();
  assert.equal(served.key, publicKey(jwk));
  const jwt = await vapidJwt(jwk, 'https://fcm.googleapis.com', 'https://arno.example', 0);
  const [head, claims, signature] = jwt.split('.'),
    bytes = s => Buffer.from(s, 'base64url');
  assert.deepEqual(JSON.parse(bytes(head)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(bytes(claims)), {
    aud: 'https://fcm.googleapis.com',
    exp: 12 * 3600,
    sub: 'https://arno.example',
  });
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(served.key),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  assert.ok(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      bytes(signature),
      new TextEncoder().encode(head + '.' + claims),
    ),
  );
});
test('push subscribe accepts only known push services', async () => {
  const { pushApiRoutes } = await import('./push.mjs');
  const env = {},
    f = pushIndex(env),
    auth = { user: { id: 7 } };
  const subscribe = endpoint =>
    pushApiRoutes['POST /api/push/subscribe'](
      new Request('https://arno.example/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint, keys: {} }),
      }),
      env,
      new URL('https://arno.example/api/push/subscribe'),
      auth,
    );
  for (const bad of [
    'https://169.254.169.254/latest',
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://user@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://fcm.googleapis.com/' + 'x'.repeat(1000),
  ])
    assert.equal((await subscribe(bad)).status, 400, bad);
  assert.equal((await subscribe('https://fcm.googleapis.com/fcm/send/abc')).status, 200);
  assert.equal((await subscribe('https://wns2-par02p.notify.windows.com/w/?token=x')).status, 200);
  const push = await f.ctx.storage.get('push');
  assert.equal(push.origin, 'https://arno.example');
  assert.equal(push.subscriptions.length, 2);
});
test('a push service 410 deletes the subscription; no subscriptions, no push', async () => {
  const { notifyOwner } = await import('./push.mjs');
  const env = { VAPID_KEY: await vapidKey() },
    f = pushIndex(env),
    sent = [];
  const upstream = async (url, init) => {
    sent.push({ url, init });
    return new Response(null, { status: url.includes('gone') ? 410 : 201 });
  };
  const notice = { title: 'T', body: 'B', url: '/?session=x', at: 1 };
  assert.equal(await notifyOwner(env, 7, notice, upstream), 0);
  assert.equal(sent.length, 0);
  assert.equal(await f.ctx.storage.get('notice'), undefined);
  await f.ctx.storage.put('push', {
    origin: 'https://arno.example',
    subscriptions: [
      { endpoint: 'https://fcm.googleapis.com/fcm/send/live', at: 1 },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/gone', at: 2 },
    ],
  });
  assert.equal(await notifyOwner(env, 7, notice, upstream), 1);
  assert.equal(sent.length, 2);
  assert.match(sent[0].init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(sent[0].init.body, undefined);
  assert.deepEqual(
    (await f.ctx.storage.get('push')).subscriptions.map(s => s.endpoint),
    ['https://fcm.googleapis.com/fcm/send/live'],
  );
  assert.deepEqual(await f.ctx.storage.get('notice'), notice);
});
test('turn notice: plain title and body, and a link that reopens the session', async () => {
  const { turnNotice } = await import('./push.mjs');
  const n = turnNotice({ title: 'Fix the **build**' }, 'abc', {
    summary: '## Done\n\nSee [the log](https://x.example) and `make`.',
  });
  assert.equal(n.title, 'Fix the build');
  assert.equal(n.body, 'Done See the log and make.');
  assert.equal(n.url, '/?session=abc');
  assert.equal(turnNotice({}, 'abc', { error: 'boom' }).body, 'boom');
});
test('attachments: chunked round trip, kind and size checks, model input per provider', async () => {
  const { saveAttachment, readAttachment, attachmentsFor, modelInput } =
    await import('./attachments.mjs');
  const map = new Map();
  const storage = {
    get: async k => (Array.isArray(k) ? new Map(k.map(x => [x, map.get(x)])) : map.get(k)),
    put: async records => Object.entries(records).forEach(([k, v]) => map.set(k, v)),
    list: async ({ prefix }) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
  };
  const big = new Uint8Array(1024 * 1024 + 5).map((_, i) => i % 251);
  const image = await saveAttachment(storage, 'pic.png', 'image/png', big);
  assert.equal(image.chunks, 2);
  assert.deepEqual((await readAttachment(storage, image.id)).bytes, big);
  const text = await saveAttachment(storage, '../notes.md', '', new TextEncoder().encode('# hi'));
  assert.equal(text.kind, 'text');
  assert.equal(text.name, '.._notes.md');
  await assert.rejects(
    saveAttachment(storage, 'a.exe', 'application/x-msdownload', new Uint8Array(3)),
  );
  await assert.rejects(
    saveAttachment(storage, 'bad.txt', 'text/plain', new Uint8Array([0xff, 0xfe])),
  );
  await assert.rejects(attachmentsFor(storage, ['00000000-0000-0000-0000-000000000000']));
  const input = await modelInput(
    storage,
    'Look',
    await attachmentsFor(storage, [image.id, text.id]),
  );
  assert.match(input.text, /Attached file \.\._notes\.md:\n```\n# hi\n```/);
  assert.equal(input.images.length, 1);
  assert.equal(atob(input.images[0].data).length, big.length);
  // Each provider gets the image in its own format.
  for (const provider of ['anthropic', 'openai']) {
    let sent;
    await plainChat({
      model: 'm',
      provider,
      key: 'k',
      history: [],
      prompt: 'Look',
      images: [{ type: 'image/png', data: 'AAAA' }],
      upstream: async (url, init) => {
        sent = JSON.parse(init.body).messages.at(-1).content;
        return new Response(
          'data: ' +
            JSON.stringify({
              choices: [{ delta: { content: 'ok' } }],
              delta: { type: 'text_delta', text: 'ok' },
            }) +
            '\n\n',
        );
      },
    });
    if (provider === 'anthropic')
      assert.deepEqual(sent[0], {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      });
    else
      assert.deepEqual(sent[1], {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAAA' },
      });
  }
});
test('artifacts: create, update keeps earlier versions, bad input refused', async () => {
  const { artifactTool, listArtifacts } = await import('./artifacts.mjs');
  const map = new Map();
  const storage = {
    get: async k => map.get(k),
    put: async (k, v) => map.set(k, v),
    list: async ({ prefix }) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
  };
  const touched = [];
  const made = await artifactTool(
    storage,
    'create_artifact',
    { title: 'List', content: '- a' },
    touched,
  );
  await artifactTool(storage, 'update_artifact', { id: made.id, content: '- a\n- b' }, touched);
  const stored = map.get('artifact:' + made.id);
  assert.equal(stored.version, 2);
  assert.equal(stored.title, 'List');
  assert.deepEqual(
    stored.previous.map(p => p.content),
    ['- a'],
  );
  assert.deepEqual(touched, [{ id: made.id, title: 'List', version: 2 }]);
  assert.deepEqual(
    (await listArtifacts(storage)).map(a => a.title),
    ['List'],
  );
  await assert.rejects(artifactTool(storage, 'create_artifact', { title: '', content: 'x' }, []));
  await assert.rejects(artifactTool(storage, 'update_artifact', { id: 'nope', content: 'x' }, []));
});
test('artifact links render as buttons only for a uuid', () => {
  const id = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b';
  const html = markdown('See [Packing <list>](artifact:' + id + ') and [x](artifact:nope).');
  assert.match(
    html,
    new RegExp('<button type="button" class="artifact-link" data-artifact="' + id + '">'),
  );
  assert.match(html, /Packing &lt;list&gt;<\/button>/);
  assert.doesNotMatch(html, /data-artifact="nope"/);
  assert.match(html, /\[x\]\(artifact:nope\)/);
});
test('cost parts: model tokens by kind plus searches; unpriced models still count searches', async () => {
  const { costParts } = await import('./prices.mjs');
  const parts = costParts(
    { inp: 1, cached: 0.1, out: 10 },
    { measuredCalls: 1, inputTokens: 2e6, cachedTokens: 1e6, outputTokens: 1e5 },
    { searches: 3 },
  );
  assert.deepEqual(parts, {
    input: 1,
    cached: 0.1,
    cacheWrite: 0,
    output: 1,
    search: 0.033,
    reads: 0,
  });
  assert.deepEqual(costParts(null, { measuredCalls: 1 }, { searches: 1 }), {
    input: null,
    cached: null,
    cacheWrite: null,
    output: null,
    search: 0.011,
    reads: 0,
  });
});
test('request log: a turn becomes per-request entries; the index keeps them newest first', async () => {
  const f = fixture({ session: { id: 's1', title: 'Trip', ownerId: 'u' } });
  let sent;
  f.obj.env = {
    PROBE: { getByName: () => ({ fetch: async (u, init) => (sent = JSON.parse(init.body)) }) },
  };
  await f.obj.logRequests(
    { id: 's1', title: 'Trip', ownerId: 'u' },
    {
      model: 'm',
      requestLog: [{ at: 1, input: 100, cached: 50, write: 0, output: 10 }],
      webUsage: { searches: 2, reads: 1, searxng: 1 },
    },
    { inp: 1, cached: 0.1, out: 10 },
    { search: 0.011, fetch: 0.001 },
  );
  assert.deepEqual(
    sent.requests.map(r => [r.kind, r.model, r.input, r.cost]),
    [
      ['model', 'm', 150, (100 * 1 + 50 * 0.1 + 10 * 10) / 1e6],
      ['search', 'web_search', null, 0.011],
      ['search', 'web_search', null, 0.011],
      ['search', 'searxng', null, 0],
      ['read', 'web_fetch', null, 0.001],
    ],
  );
  const index = fixture({});
  await index.obj.fetch(
    new Request('https://internal/usage/log', { method: 'POST', body: JSON.stringify(sent) }),
  );
  const list = await (await index.obj.fetch(new Request('https://internal/usage/list'))).json();
  assert.equal(list.requests.length, 5);
  assert.equal(list.requests.at(-1).kind, 'model'); // at: 1 is the oldest
});
test('SearXNG serves web_search with Access headers and costs no Ollama search', async () => {
  const sources = [],
    counts = { searches: 0, searxng: 0, reads: 0 };
  let seen;
  const data = await research(
    'web_search',
    { query: 'raz language' },
    {
      key: 'test',
      search: { url: 'https://search.example.com', auth: 'access', clientId: 'id', secret: 's' },
      sources,
      counts,
      upstream: async (url, init) => {
        seen = { url, init };
        return Response.json({
          results: [{ url: 'https://one.example.com/', title: 'One', content: 'Snippet' }],
        });
      },
    },
  );
  const u = new URL(seen.url);
  assert.equal(u.origin + u.pathname, 'https://search.example.com/search');
  assert.equal(u.searchParams.get('format'), 'json');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(seen.init.headers['CF-Access-Client-Id'], 'id');
  assert.equal(seen.init.headers['CF-Access-Client-Secret'], 's');
  assert.equal(data.sources[0].title, 'One');
  assert.equal(sources[0].excerpt, 'Snippet');
  assert.deepEqual(counts, { searches: 0, searxng: 1, reads: 0 });
});
test('SearXNG failures and empty results fall back to billed Ollama search', async () => {
  for (const answer of [
    () => new Response('format not allowed', { status: 403 }),
    () => Response.json({ results: [] }),
    () => new Response('<html>', { status: 200 }),
  ]) {
    const counts = { searches: 0, searxng: 0, reads: 0 },
      hosts = [];
    const data = await research(
      'web_search',
      { query: 'q' },
      {
        key: 'test',
        search: { url: 'https://search.example.com', auth: 'bearer', secret: 't' },
        sources: [],
        counts,
        upstream: async url => {
          hosts.push(new URL(url).hostname);
          return hosts.length === 1
            ? answer()
            : Response.json({ results: [{ url: 'https://two.example.com/', title: 'Two' }] });
        },
      },
    );
    assert.deepEqual(hosts, ['search.example.com', 'ollama.com']);
    assert.equal(data.sources[0].title, 'Two');
    assert.deepEqual(counts, { searches: 1, searxng: 0, reads: 0 });
  }
});
test('account saves a SearXNG connection sealed and refuses private or plain-HTTP URLs', async () => {
  const f = fixture(),
    env = {
      ACCOUNT_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
      PROBE: { getByName: () => ({ fetch: (url, opt) => f.obj.fetch(new Request(url, opt)) }) },
    };
  const save = body =>
    accountRoute(
      new Request('https://arno.test/api/account/search', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      env,
      1,
    );
  for (const url of [
    'http://search.example.com',
    'https://localhost/',
    'https://127.0.0.1',
    'https://u:p@search.example.com',
  ])
    assert.equal((await save({ url, auth: 'none' })).status, 400, url);
  const r = await save({
    url: 'https://search.example.com/',
    auth: 'access',
    clientId: 'id.access',
    secret: 'client-secret-value',
  });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.equal(text.includes('client-secret-value'), false);
  assert.deepEqual(JSON.parse(text).search, {
    url: 'https://search.example.com',
    auth: 'access',
    clientId: 'id.access',
    hasSecret: true,
  });
  const stored = (await (await f.obj.fetch(new Request('https://internal/profile/get'))).json())
    .search;
  assert.notEqual(stored.secret.value, 'client-secret-value');
  assert.equal((await save({ remove: true })).status, 200);
});
test('deleting the account wipes the index, every session and every recorded sign-in', async () => {
  const { apiRoutes } = await import('./api.mjs');
  const objects = new Map();
  const env = {
    PROBE: {
      getByName: name => {
        if (!objects.has(name)) {
          const f = fixture({});
          f.obj.env = env;
          objects.set(name, f);
        }
        // Like a Durable Object stub: fetch takes a URL and init.
        const { obj } = objects.get(name);
        return {
          ctx: obj.ctx,
          fetch: (u, init) => obj.fetch(u instanceof Request ? u : new Request(u, init)),
        };
      },
    },
  };
  const index = env.PROBE.getByName('index:7');
  await index.fetch(
    new Request('https://internal/logins/add', { method: 'POST', body: '{"id":"old"}' }),
  );
  await index.fetch(
    new Request('https://internal/index/add', {
      method: 'POST',
      body: '{"id":"s1","createdAt":1}',
    }),
  );
  for (const name of ['code:7:s1', 'auth:old', 'auth:now'])
    await env.PROBE.getByName(name).ctx.storage.put('marker', true);
  const auth = { user: { id: 7, login: 'Luis' } };
  const call = body =>
    apiRoutes['POST /api/account/delete'](
      new Request('https://x/api/account/delete', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { Cookie: 'arno_session=now' },
      }),
      env,
      null,
      auth,
    );
  assert.equal((await call({ confirm: 'someone' })).status, 400);
  const r = await call({ confirm: 'luis' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Set-Cookie'), /Max-Age=0/);
  for (const name of ['index:7', 'code:7:s1', 'auth:old', 'auth:now'])
    assert.equal((await objects.get(name).ctx.storage.list({})).size, 0, name + ' emptied');
});
test('models that let the provider train on your data are never offered or run', async () => {
  const { TRAINS_ON_DATA } = await import('./account.mjs');
  const { modelAllowed } = await import('./models.mjs');
  assert.ok(TRAINS_ON_DATA.test('meta/muse-spark-1.3-contributor'));
  assert.equal(await modelAllowed('meta/muse-spark-1.3-contributor'), false);
  assert.equal(await modelAllowed('meta/muse-spark-1.3'), true);
});

/** An outbox over an array, standing in for IndexedDB. */
function memoryOutbox(stored = []) {
  const rows = new Map(stored.map(e => [e.key, e]));
  return new Outbox({
    all: async () => [...rows.values()],
    put: async e => void rows.set(e.key, structuredClone(e)),
    delete: async key => void rows.delete(key),
    clear: async () => rows.clear(),
  });
}

test('outbox: each conversation sends in order, a refused message pauses only its own', async () => {
  const box = memoryOutbox(),
    a1 = await box.add({ kind: 'message', sessionId: 'a', body: { prompt: '1' } }),
    b1 = await box.add({ kind: 'message', sessionId: 'b', body: { prompt: '1' } }),
    a2 = await box.add({ kind: 'message', sessionId: 'a', body: { prompt: '2' } }),
    p = await box.add({ kind: 'profile', sessionId: null, body: {} });
  assert.ok(a1.createdAt < b1.createdAt && b1.createdAt < a2.createdAt);
  assert.deepEqual(
    box.heads().map(e => e.key),
    [a1.key, b1.key, p.key],
  );
  await box.remove(a1.key);
  assert.equal(box.head('a').key, a2.key);
  await box.update(b1.key, { state: 'failed', error: 'No images' });
  assert.equal(box.head('b'), null);
  assert.deepEqual(
    box.heads().map(e => e.key),
    [a2.key, p.key],
  );
  // Reloaded mid-send: the entry is queued again, in its place.
  await box.update(a2.key, { state: 'sending' });
  const again = memoryOutbox(await box.storage.all());
  await again.load();
  assert.equal(again.get(a2.key).state, 'queued');
  assert.deepEqual(
    again.entries.map(e => e.key),
    [b1.key, a2.key, p.key],
  );
});

test('outbox: repeated renames and profile edits merge, keeping the first base', async () => {
  const box = memoryOutbox();
  const first = await box.edit('rename', 's', { title: 'One' }, 'Old');
  await box.add({ kind: 'message', sessionId: 's', body: { prompt: 'hi' } });
  await box.edit('rename', 's', { title: 'Two' }, 'One');
  await box.edit('rename', 't', { title: 'Other' }, 'T');
  await box.edit('profile', null, { about: 'a' }, 5);
  await box.edit('profile', null, { about: 'b' }, 7);
  const renames = box.entries.filter(e => e.kind === 'rename' && e.sessionId === 's');
  assert.equal(renames.length, 1);
  assert.equal(renames[0].key, first.key);
  assert.deepEqual(renames[0].body, { title: 'Two' });
  assert.equal(renames[0].base, 'Old');
  assert.equal(box.head('s').key, first.key); // keeps its place in the line
  const profiles = box.entries.filter(e => e.kind === 'profile');
  assert.equal(profiles.length, 1);
  assert.deepEqual([profiles[0].body, profiles[0].base], [{ about: 'b' }, 5]);
});

test('outbox: an edit clashes only with a change made elsewhere', () => {
  const rename = { kind: 'rename', base: 'Trip' },
    profile = { kind: 'profile', base: 100 };
  assert.equal(conflicted(rename, { title: 'Trip', customTitle: true }), false);
  assert.equal(conflicted(rename, { title: 'Holiday', customTitle: true }), true);
  // The server naming a new chat after its first message is no clash.
  assert.equal(conflicted(rename, { title: 'What should I pack?' }), false);
  assert.equal(conflicted({ kind: 'rename' }, { title: 'X', customTitle: true }), false);
  assert.equal(conflicted(profile, { updatedAt: 100 }), false);
  assert.equal(conflicted(profile, { updatedAt: 200 }), true);
  assert.equal(conflicted({ kind: 'profile', base: 0 }, {}), false);
});

test('outbox: a chat made offline moves its line to the id the server gives it', async () => {
  const box = memoryOutbox(),
    local = 'local-' + crypto.randomUUID();
  assert.ok(isLocal(local) && !isLocal(crypto.randomUUID()));
  const chat = await box.add({ kind: 'chat', sessionId: local, body: { model: 'm' } });
  const m1 = await box.add({ kind: 'message', sessionId: local, body: { prompt: '1' } });
  const other = await box.add({ kind: 'message', sessionId: 'x', body: { prompt: 'x' } });
  const m2 = await box.add({ kind: 'message', sessionId: local, body: { prompt: '2' } });
  assert.equal(box.head(local).key, chat.key); // the chat is made first
  await box.remove(chat.key);
  await box.rewrite(local, 'real');
  assert.deepEqual(box.of(local), []);
  assert.deepEqual(
    box.of('real').map(e => e.key),
    [m1.key, m2.key],
  );
  assert.equal(box.head('real').key, m1.key);
  assert.equal((await box.storage.all()).find(e => e.key === m2.key).sessionId, 'real');
  assert.equal(box.get(other.key).sessionId, 'x');
  await box.dropSession('real');
  assert.deepEqual(
    box.entries.map(e => e.key),
    [other.key],
  );
});
test('creating a chat with a client id twice returns the same chat', async () => {
  const f = fixture({});
  const init = () =>
    f.obj.fetch(
      new Request('https://internal/session/chat-init', {
        method: 'POST',
        body: JSON.stringify({ model: 'mistral-large-4:cloud', ownerId: 7, id: 'x' }),
      }),
    );
  const first = await (await init()).json();
  await new Promise(r => setTimeout(r, 2));
  const second = await (await init()).json();
  assert.equal(second.createdAt, first.createdAt);
});
test('your name reaches the model through the instructions', () => {
  assert.match(
    instructions({ name: 'Luis', about: 'Builds things' }),
    /^The user's name is Luis\.\n\nAbout the user:\nBuilds things/,
  );
  assert.equal(instructions({}), '');
});

test('message options: defaults fill gaps; unknown, mistyped and deep-in-coding are refused', async () => {
  assert.deepEqual(checkOptions(undefined, 'chat'), DEFAULTS);
  assert.deepEqual(checkOptions({ style: 'caveman' }, 'chat'), { ...DEFAULTS, style: 'caveman' });
  for (const bad of [
    { search: 'yes' },
    { effort: 'max' },
    { mode: 'slow' },
    { colour: 'red' },
    [],
    'fast',
  ])
    assert.equal(checkOptions(bad, 'chat'), null);
  assert.equal(checkOptions({ mode: 'deep' }, 'code'), null);
  assert.deepEqual(optionTags({ ...DEFAULTS, mode: 'deep', style: 'caveman', effort: 'high' }), [
    'Deep research',
    'Caveman',
    'Thinking: high',
  ]);
  assert.deepEqual(optionTags({ ...DEFAULTS, search: false }), ['No search']);
  assert.deepEqual(optionTags({ mode: 'fast', search: false, effort: 'off', style: 'normal' }), [
    'Fast',
  ]);
  // enqueue keeps them on the job, and refuses what checkOptions refuses.
  const enqueue = (f, options) =>
    f.obj.fetch(
      new Request('https://internal/session/enqueue', {
        method: 'POST',
        body: JSON.stringify({ id: crypto.randomUUID(), prompt: 'hi', options }),
      }),
    );
  const chat = fixture({ session: { kind: 'chat', model: 'm' } });
  assert.equal((await enqueue(chat, { effort: 'nope' })).status, 400);
  assert.equal((await enqueue(chat, { mode: 'deep' })).status, 202);
  assert.equal((await chat.ctx.storage.get('job')).options.mode, 'deep');
  const code = fixture({ session: { repo: 'a/b', model: 'm' } });
  assert.equal((await enqueue(code, { mode: 'deep' })).status, 400);
});
test('turn plans: fast trims, deep widens, style adds its instruction', () => {
  const fast = turnPlan({ mode: 'fast' }),
    deep = turnPlan({ mode: 'deep', search: false, effort: 'low' });
  assert.equal(fast.effort, 'off');
  assert.equal(fast.maxOutput, 4096);
  assert.match(fast.instructions, /briefly and directly/);
  assert.deepEqual([deep.search, deep.effort, deep.rounds], [true, 'medium', 16]);
  assert.deepEqual(deep.limits, { searches: 10, reads: 20, sources: 60 });
  assert.ok(deep.timeLimit <= 15 * 60000); // a Durable Object alarm's wall-clock limit
  assert.match(deep.instructions, /create_artifact[\s\S]*Research: /);
  assert.equal(turnPlan({ effort: 'high' }).effort, 'high');
  assert.match(turnPlan({ style: 'caveman' }).instructions, /caveman[\s\S]*Me check/);
  assert.match(turnPlan({ style: 'concise' }).instructions, /brief/);
  assert.equal(turnPlan().instructions, '');
});
test('effort per provider: each model gets the nearest value it accepts, auto sends none', () => {
  const effort = (provider, model, level) => {
    const f = requestFields(provider, { model, effort: level });
    delete f.stream_options;
    return f;
  };
  assert.deepEqual(effort('openai', 'gpt-5.1', 'off'), {
    max_completion_tokens: 16384,
    reasoning_effort: 'minimal',
  });
  assert.equal(effort('openai', 'gpt-4o', 'high').reasoning_effort, undefined);
  assert.deepEqual(effort('anthropic', 'claude-sonnet-4-5-20250929', 'high'), {
    max_tokens: 32000,
    thinking: { type: 'enabled', budget_tokens: 24000 },
  });
  assert.equal(effort('anthropic', 'claude-3-7-sonnet-20250219', 'low').max_tokens, 16384);
  assert.deepEqual(effort('anthropic', 'claude-opus-4-6', 'medium'), {
    max_tokens: 16384,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
  });
  assert.equal(effort('anthropic', 'claude-sonnet-5-5', 'low').thinking.display, 'summarized');
  assert.deepEqual(effort('anthropic', 'claude-opus-4-6', 'off'), { max_tokens: 16384 });
  const gemini = (model, level) => effort('gemini', model, level).extra_body.google.thinking_config;
  assert.deepEqual(gemini('gemini-2.5-flash', 'off'), { thinking_budget: 0 });
  assert.deepEqual(gemini('gemini-2.5-pro', 'off'), { thinking_budget: 128 });
  assert.deepEqual(gemini('gemini-3.5-flash', 'off'), { thinking_level: 'minimal' });
  assert.deepEqual(gemini('gemini-3.1-pro-preview', 'off'), { thinking_level: 'low' });
  assert.equal(effort('gemini', 'gemini-3.5-flash', 'high').reasoning_effort, undefined);
  assert.equal(effort('ollama', 'gpt-oss:120b', 'off').reasoning_effort, 'none');
  assert.equal(effort('mistral', 'mistral-large-4-0', 'off').reasoning_effort, 'low');
  assert.equal(effort('mistral', 'mistral-small-2603', 'low').reasoning_effort, 'none');
  assert.deepEqual(effort('deepseek', 'deepseek-v4-pro', 'off').thinking, { type: 'disabled' });
  assert.equal(effort('kimi', 'kimi-k3', 'medium').reasoning_effort, 'high');
  assert.deepEqual(effort('meta', 'muse-spark', 'high'), { max_completion_tokens: 16384 });
  assert.deepEqual(effort('openai', 'gpt-5.1', 'auto'), { max_completion_tokens: 16384 });
  // Gemini chat asks for thoughts inside the same thinking_config.
  const fields = requestFields('gemini', { model: 'gemini-3.5-flash', effort: 'low' });
  assert.equal(fields.extra_body.google.thinking_config.thinking_level, 'low');
});
const claudeStream = events =>
  new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
const THINKING_REPLY = [
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need ' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'a search.' },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'redacted_thinking', data: 'X' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'tu1', name: 'web_search', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"query":"q"}' },
  },
  { type: 'message_delta', usage: { output_tokens: 5 } },
];
test('Anthropic thinking: blocks with their signature go back before tool_use, text is shown', async () => {
  const bodies = [],
    previews = [];
  const replies = [
    claudeStream(THINKING_REPLY),
    claudeStream([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
    ]),
  ];
  const r = await plainChat({
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    effort: 'medium',
    key: 'k',
    history: [],
    prompt: 'p',
    runTool: async () => ({ sources: [] }),
    onProgress: async p => previews.push(p.reasoning),
    upstream: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return replies.shift();
    },
  });
  assert.deepEqual(bodies[0].thinking, { type: 'enabled', budget_tokens: 8192 });
  assert.ok(bodies[0].max_tokens > 8192);
  assert.equal(bodies[0].temperature, undefined);
  assert.deepEqual(bodies[1].messages.at(-2).content, [
    { type: 'thinking', thinking: 'Need a search.', signature: 'SIG' },
    { type: 'redacted_thinking', data: 'X' },
    { type: 'tool_use', id: 'tu1', name: 'web_search', input: { query: 'q' } },
  ]);
  assert.equal(r.summary, 'Done.');
  assert.ok(previews.includes('Need a search.'));
  assert.doesNotMatch(JSON.stringify(previews), /SIG/);
});
test('coding gateway: Claude thinking is kept from a tool call and put back for the runner', async () => {
  let kept, sent;
  const request = messages =>
    new Request('http://model.internal/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages, stream: true }),
    });
  const options = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    key: 'k',
    effort: 'high',
    authorize: async () => true,
    keepThinking: async k => (kept = k),
    recallThinking: async () => kept,
    upstream: async (url, init) => {
      sent = JSON.parse(init.body);
      return claudeStream(THINKING_REPLY);
    },
  };
  await (await modelRequest(request([{ role: 'user', content: 'go' }]), options)).text();
  assert.deepEqual(kept.toolIds, ['tu1']);
  // The runner sends back the call without its thinking.
  const loop = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'web_search', input: {} }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
  ];
  await (await modelRequest(request(loop), options)).text();
  assert.deepEqual(
    sent.messages[1].content.map(b => b.type),
    ['thinking', 'redacted_thinking', 'tool_use'],
  );
  assert.equal(sent.messages[1].content[0].signature, 'SIG');
  // Nothing kept for that call: this request goes without thinking.
  kept = null;
  await (await modelRequest(request(loop), options)).text();
  assert.equal(sent.thinking, undefined);
});
test('search off drops web tools and instructions; deep research budgets reach research()', async () => {
  const bodies = [],
    real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/chat/completions')) {
      bodies.push(JSON.parse(init.body));
      return new Response('data: {"choices":[{"delta":{"content":"Ugh. Done."}}]}\n\n');
    }
    if (String(url).endsWith('/api/show')) return Response.json({ capabilities: ['thinking'] });
    return new Response('{}', { status: 404 });
  };
  try {
    const f = fixture({
      session: { kind: 'chat', model: 'thinker:cloud', title: 'General chat' },
      job: {
        id: 'j',
        status: 'running',
        prompt: 'hi',
        options: { ...DEFAULTS, search: false, style: 'caveman', effort: 'low' },
      },
    });
    f.obj.env = { OLLAMA_API_KEY: 'k' };
    await f.obj.plainTurn(await f.ctx.storage.get('session'), 'hi');
    const names = (bodies[0].tools || []).map(t => t.function.name);
    assert.ok(!names.includes('web_search') && names.includes('create_artifact'));
    assert.doesNotMatch(bodies[0].messages[0].content, /web_search/);
    assert.match(bodies[0].messages[0].content, /caveman/);
    assert.equal(bodies[0].reasoning_effort, 'low');
    const turn = [...(await f.ctx.storage.list({ prefix: 'turn:' })).values()][0];
    assert.equal(turn.options.style, 'caveman');
  } finally {
    globalThis.fetch = real;
  }
  // The deep plan's budget lets research go past the standard three searches.
  const counts = { searches: 3 },
    upstream = async () => Response.json({ results: [] });
  await assert.rejects(
    research('web_search', { query: 'q' }, { key: 'k', sources: [], counts, upstream }),
    /limit of 3 searches/,
  );
  await research(
    'web_search',
    { query: 'q' },
    { key: 'k', sources: [], counts, upstream, limits: turnPlan({ mode: 'deep' }).limits },
  );
  assert.equal(counts.searches, 4);
});
test('coding: search off leaves the web MCP server out of the runner config', async () => {
  const configFor = async plan => {
    let text = '';
    const f = fixture({ session: { model: 'm' } });
    f.obj.env = {};
    f.ctx.container.exec = async () => ({
      stdin: {
        getWriter: () => ({
          write: async b => (text += new TextDecoder().decode(b)),
          close: async () => {},
        }),
      },
      exitCode: Promise.resolve(0),
    });
    await f.obj.writeConfig('m', plan);
    return text;
  };
  assert.match(await configFor(turnPlan()), /mcp = web /);
  assert.doesNotMatch(await configFor(turnPlan({ search: false })), /mcp = web /);
});
test('repository access: GitHub App installations decide what is reachable', async () => {
  const { repoAccess } = await import('./auth.mjs');
  const realFetch = globalThis.fetch;
  const reply = installations => (globalThis.fetch = async () => Response.json({ installations }));
  const auth = { token: 'ghu_x', user: { login: 'me' } };
  try {
    reply([{ account: { login: 'me' }, repository_selection: 'all', html_url: 'https://g/1' }]);
    assert.equal((await repoAccess(auth)).access, 'all');
    reply([
      { account: { login: 'me' }, repository_selection: 'selected', html_url: 'https://g/1' },
    ]);
    assert.deepEqual(await repoAccess(auth), {
      app: true,
      access: 'selected',
      configure: 'https://g/1',
    });
    reply([{ account: { login: 'someone-else' }, repository_selection: 'all' }]);
    assert.equal((await repoAccess(auth)).access, 'public');
    assert.deepEqual(await repoAccess({ token: 'gho_y', githubConnected: true }), {
      app: false,
      access: 'all',
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A pkt-line: four hex digits of length, then the payload.
const pkt = s => (s.length + 4).toString(16).padStart(4, '0') + s;
test('git gateway reaches only the session repository and refuses deleting a branch', async () => {
  const seen = [];
  const upstream = async (url, init) => {
    seen.push({ url, auth: init.headers.get('Authorization') });
    if (init.body) await new Response(init.body).arrayBuffer();
    return new Response('ok', {
      headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
    });
  };
  const opts = { repo: 'o/r', token: 'ghu_x', upstream };
  const get = path => gitProxy(new Request('http://git.internal' + path), opts);
  assert.equal((await get('/o/r.git/info/refs?service=git-upload-pack')).status, 200);
  assert.equal(seen[0].url, 'https://github.com/o/r.git/info/refs?service=git-upload-pack');
  assert.equal(seen[0].auth, 'Basic ' + btoa('x-access-token:ghu_x'));
  assert.equal((await get('/other/r.git/info/refs?service=git-upload-pack')).status, 403);
  assert.equal((await get('/o/r.git/HEAD')).status, 403);
  const push = cmd =>
    gitProxy(
      new Request('http://git.internal/o/r.git/git-receive-pack', {
        method: 'POST',
        body: pkt(cmd + '\0report-status') + '0000PACK...',
      }),
      opts,
    );
  const a = 'a'.repeat(40),
    b = 'b'.repeat(40),
    zero = '0'.repeat(40);
  assert.equal((await push(a + ' ' + b + ' refs/heads/main')).status, 200);
  assert.equal((await push(a + ' ' + zero + ' refs/heads/main')).status, 403);
  assert.equal(seen.length, 2, 'the deletion never reached GitHub');
  assert.equal(refUpdates(new TextEncoder().encode(pkt(a + ' ' + b + ' refs/heads/x'))), null);
});
test('code options reach arno only in coding sessions', () => {
  const o = checkOptions({ approach: 'build', workers: 'off', budget: '3' }, 'code');
  assert.equal(codeSettings('m', o), 'mode = build\nturn_budget = 3\nbuild_budget = 3\n');
  assert.equal(codeSettings('m', DEFAULTS), 'workers = m\nmax_workers = 4\n');
  assert.equal(codeLimits(o).rounds, 400);
  // A chat sent with a coding session's choices keeps the defaults.
  assert.equal(checkOptions({ approach: 'build' }, 'chat').approach, 'auto');
  assert.equal(checkOptions({ budget: '2.50' }, 'code').budget, '2.50');
  assert.equal(checkOptions({ budget: '500' }, 'code'), null);
  assert.equal(checkOptions({ workers: '5' }, 'code'), null);
  // Commands that would undo the host's setup stay out of arno.
  assert.match(hostCommand('/model gpt'), /model button/);
  assert.equal(hostCommand('/compact'), '');
  assert.deepEqual(optionTags(o), ['Build', 'No workers', '$3 budget']);
});
test('serve messages are netstrings of netstrings, read across chunk boundaries', () => {
  const bytes = encode('line', 'hi');
  assert.equal(new TextDecoder().decode(bytes), '12:4:line,2:hi,,');
  const d = decoderOf(),
    two = new Uint8Array([...bytes, ...encode('busy', '1')]);
  assert.deepEqual(d.push(two.subarray(0, 5)), []);
  assert.deepEqual(d.push(two.subarray(5)), [
    ['line', 'hi'],
    ['busy', '1'],
  ]);
  assert.throws(() => decoderOf().push(new TextEncoder().encode('x:')), /malformed/);
});
test('MCP OAuth: discovery, registration, PKCE sign-in, callback and refresh', async () => {
  const env = {
    ACCOUNT_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
  };
  // Durable objects in memory: the pending sign-in and the profile.
  const stores = new Map();
  env.PROBE = {
    getByName: name => ({
      fetch: async (url, opt = {}) => {
        const path = new URL(url).pathname,
          body = opt.body ? JSON.parse(opt.body) : null;
        if (path === '/oauth/put') stores.set(name, body);
        if (path === '/oauth/take') {
          const v = stores.get(name);
          stores.delete(name);
          return v ? Response.json(v) : new Response(null, { status: 404 });
        }
        const p = stores.get(name) || { mcp: [{ id: 'lin', url: 'https://mcp.example.com/mcp' }] };
        if (path === '/profile/get') return Response.json(p);
        if (path === '/profile/mcp-token') {
          p.mcp = p.mcp.map(c => (c.id === body.id && c.url === body.url ? { ...c, ...body } : c));
          stores.set(name, p);
        }
        return new Response(null, { status: 204 });
      },
    }),
  };
  let tokenForm;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://mcp.example.com/mcp')
      return new Response('', {
        status: 401,
        headers: {
          'WWW-Authenticate':
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="read"',
        },
      });
    if (u.endsWith('/.well-known/oauth-protected-resource'))
      return Response.json({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });
    if (u === 'https://auth.example.com/.well-known/oauth-authorization-server')
      return Response.json({
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        code_challenge_methods_supported: ['S256'],
      });
    if (u === 'https://auth.example.com/register') return Response.json({ client_id: 'c1' });
    if (u === 'https://auth.example.com/token') {
      tokenForm = new URLSearchParams(String(init.body));
      return Response.json({
        access_token: tokenForm.get('grant_type') === 'refresh_token' ? 'a2' : 'a1',
        refresh_token: 'r1',
        expires_in: tokenForm.get('grant_type') === 'refresh_token' ? 3600 : 1,
      });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const to = new URL(await startSignIn(env, 7, 'lin', 'https://app.example.com'));
    assert.equal(to.origin + to.pathname, 'https://auth.example.com/authorize');
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(to.searchParams.get('resource'), 'https://mcp.example.com/mcp');
    assert.equal(to.searchParams.get('scope'), 'read');
    const state = to.searchParams.get('state');
    const back = await mcpCallback(
      null,
      env,
      new URL('https://app.example.com/auth/mcp/callback?code=xyz&state=' + state),
    );
    assert.equal(back.headers.get('Location'), '/?mcp=lin');
    assert.equal(tokenForm.get('code_verifier').length, 43);
    // The state is used once.
    const again = await mcpCallback(
      null,
      env,
      new URL('https://app.example.com/auth/mcp/callback?code=xyz&state=' + state),
    );
    assert.match(again.headers.get('Location'), /mcp_error=/);
    // The access token expires within a minute, so the next use refreshes it.
    const connection = stores.get('profile:7').mcp[0];
    assert.equal(connection.oauth, true);
    assert.equal(await mcpBearer(env, 7, connection), 'a2');
    assert.equal(tokenForm.get('grant_type'), 'refresh_token');
    assert.equal(await mcpBearer(env, 7, stores.get('profile:7').mcp[0]), 'a2');
  } finally {
    globalThis.fetch = realFetch;
  }
});
