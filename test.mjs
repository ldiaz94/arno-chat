import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { catalog } from './models.mjs';
import { markdown, cleanOutput } from './web/render.mjs';
import { buildPrompt } from './context.mjs';
import { validateFiles } from './publish.mjs';
import { usageStream, modelRequest, displayDelta } from './gateway.mjs';
import { plainChat } from './chat.mjs';
import { validPath } from './files.mjs';
import {
  seal,
  unseal,
  publicProfile,
  instructions,
  validMcpUrl,
  accountRoute,
} from './account.mjs';
import { testMcp } from './mcp.mjs';
import { research, citedSources } from './web.mjs';
import { ArnoProbe, default as worker } from './worker.js';
test('browser scripts parse', () => {
  const dir = new URL('./web/', import.meta.url).pathname;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.js')))
    execFileSync(process.execPath, ['--check', dir + f]);
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
    },
    container: {
      running: false,
      images: { runner: 'pinned' },
      start: o => starts.push(o),
      interceptOutboundHttp: async () => {},
      setInactivityTimeout: async () => {},
    },
    exports: { ModelGateway: () => ({}), McpGateway: () => ({}) },
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
  const r = await f.obj.fetch(new Request('https://internal/session/get'));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).history, [{ prompt: 'hello', summary: 'done' }]);
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
test('new session import pins the branch revision before requesting its archive', async () => {
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
    assert.ok(seen.some(url => url.endsWith('/tarball/' + sha)));
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
