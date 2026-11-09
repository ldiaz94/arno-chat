/** Run against the local web/ files (or, with ARNO_TEST_LIVE=1, the deployed
 * ones) with API fixtures. This tests the browser
 * contract, including responses that fail after a task has been accepted. */
const { chromium } = require('playwright'),
  assert = require('node:assert/strict'),
  fs = require('node:fs');
(async () => {
  const live =
    process.env.ARNO_TEST_LIVE === '1' ? 'https://arno-compat-probe.lucelad.workers.dev' : null;
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  let uploadHeaders = null,
    submitted = null,
    checked = [],
    published = false,
    model = 'mistral-large-4:cloud',
    plain = false,
    plainPolls = 0,
    renamed = '';
  const id = '11111111-1111-1111-1111-111111111111';
  const answer =
    '## What this repository does\n\nThis is **rlsp**, a library for the [Raz language](https://github.com/ldiaz94/raz).\n\n- Wire framing\n- Protocol types\n- Client sessions\n\n```raz\nMODULE Example;\nEND Example.\n```\n\n| Module | Role |\n| --- | --- |\n| LspWire | Framing |';
  const diff =
    'diff --git a/src/demo.raz b/src/demo.raz\n--- a/src/demo.raz\n+++ b/src/demo.raz\n@@ -1 +1 @@\n-old\n+new';
  const turn = {
    prompt: 'What does this repo do?',
    summary:
      'safety: auto, working on a copy at /cache\n' +
      answer +
      '\n\nSee the original specification [1]. Notes: https://example.com/guide/start.\n\n![Diagram](https://example.com/img/diagram.png)',
    sources: [
      {
        id: 1,
        title: 'Language Server Protocol specification',
        url: 'https://microsoft.github.io/language-server-protocol/',
        excerpt: 'The protocol specifies communication between editors and language servers.',
        retrievedAt: Date.now(),
      },
    ],
    model,
    at: Date.now(),
    diff,
    usage: {
      calls: 2,
      measuredCalls: 2,
      inputTokens: 4200,
      outputTokens: 350,
      lastInputTokens: 3200,
    },
    timing: {
      startupMs: 150,
      executionMs: 5600,
      checkpointMs: 900,
      totalMs: 6650,
      workspace: 'warm',
    },
  };
  const session = {
    repo: 'ldiaz94/rlsp',
    remoteUrl: 'https://github.com/ldiaz94/rlsp',
    ref: 'main',
    sourceSha: 'a'.repeat(40),
    model,
    workspaceState: 'warm',
    contextWindow: 4000,
    history: [turn],
    stats: {
      turns: 1,
      calls: 2,
      inputTokens: 4200,
      outputTokens: 350,
      measuredCalls: 2,
      totalMs: 6650,
    },
  };
  // Static files come from web/ as Cloudflare would serve them; /api/ is mocked below.
  await page.route(
    u => u.origin === 'https://arno.test' && !u.pathname.startsWith('/api/'),
    async r => {
      const p = new URL(r.request().url()).pathname,
        file = p === '/' ? '/index.html' : p;
      if (live) return r.fulfill({ response: await r.fetch({ url: live + p }) });
      r.fulfill({
        contentType: types[require('node:path').extname(file)],
        body: fs.readFileSync(__dirname + '/web' + file),
      });
    },
  );
  let preferences = {
    systemPrompt: '',
    skills: [],
    mcp: [],
    models: [],
    providers: {
      ollama: { label: 'Ollama Cloud', available: true, saved: false },
      openai: { label: 'OpenAI', available: false, saved: false },
      anthropic: { label: 'Anthropic', available: false, saved: false },
    },
  };
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url());
    let d;
    if (u.pathname === '/api/me') d = { user: { login: 'ldiaz94' } };
    else if (u.pathname === '/api/account') {
      if (route.request().method() === 'POST')
        preferences = { ...preferences, ...route.request().postDataJSON() };
      d = preferences;
    } else if (u.pathname === '/api/account/key') {
      const b = route.request().postDataJSON();
      preferences.providers[b.provider].saved = !!b.key;
      d = preferences;
    } else if (u.pathname === '/api/account/test') d = { ok: true, models: 3 };
    else if (u.pathname === '/api/account/mcp-test')
      d = { ok: true, protocol: '2025-03-26', server: 'Fixture' };
    else if (u.pathname === '/api/chats') {
      plain = true;
      submitted = null;
      d = {
        id: '22222222-2222-2222-2222-222222222222',
        kind: 'chat',
        repo: 'General chat',
        title: 'General chat',
        model,
      };
    } else if (u.pathname.endsWith('/files'))
      d = u.searchParams.get('path')
        ? {
            directory: false,
            path: 'README.md',
            content: '# Example\nRegular source text',
            bytes: 30,
          }
        : {
            directory: true,
            path: '',
            entries: [{ name: 'README.md', path: 'README.md', directory: false }],
          };
    else if (u.pathname === '/api/models')
      d = {
        models: [
          { id: model, name: 'Mistral Large 4 · Le Chonk' },
          { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' },
        ],
      };
    else if (u.pathname.endsWith('/attachments')) {
      uploadHeaders = route.request().headers();
      await route.fulfill({
        status: 201,
        json: { id: 'att-1', name: 'dot.png', type: 'image/png', size: png.length, kind: 'image' },
      });
      return;
    } else if (u.pathname.endsWith('/attachments/att-1')) {
      await route.fulfill({ contentType: 'image/png', body: png });
      return;
    } else if (u.pathname.endsWith('/messages')) {
      submitted = route.request().postDataJSON();
      await route.abort('failed');
      return;
    } else if (u.pathname.endsWith('/events')) {
      const preview = {
        jobId: submitted?.id,
        round: 1,
        text: 'A **streamed answer**',
        reasoning: 'A model-provided explanation <script>never HTML</script>',
        updatedAt: 2,
      };
      await route.fulfill({
        contentType: 'text/event-stream',
        body: [preview, { ...preview, text: 'Older partial text', updatedAt: 1 }]
          .map(p => 'event: preview\ndata: ' + JSON.stringify(p) + '\n\n')
          .join(''),
      });
      return;
    } else if (u.pathname.endsWith('/job'))
      d = submitted
        ? plain && plainPolls++ < 2
          ? {
              id: submitted.id,
              prompt: submitted.prompt,
              status: 'running',
              stage: 'thinking',
              createdAt: Date.now(),
            }
          : {
              id: submitted.id,
              prompt: submitted.prompt,
              status: 'completed',
              result: { ...turn, summary: 'Recovered after lost response' },
              finishedAt: Date.now(),
            }
        : { status: 'idle' };
    else if (u.pathname.endsWith('/model')) {
      model = route.request().postDataJSON().model;
      d = { model };
    } else if (u.pathname.endsWith('/changes'))
      d = {
        repo: 'ldiaz94/rlsp',
        ref: 'main',
        sourceSha: 'a'.repeat(40),
        digest: 'reviewed',
        files: [{ path: 'src/demo.raz', bytes: 100 }],
      };
    else if (u.pathname.endsWith('/publish')) {
      published = true;
      assert.equal(route.request().postDataJSON().digest, 'reviewed');
      d = { url: 'https://github.com/ldiaz94/rlsp/pull/1' };
    } else if (u.pathname === '/api/sessions')
      d = { sessions: [{ id, repo: session.repo, ref: 'main', createdAt: Date.now() }] };
    else if (u.pathname.startsWith('/api/sessions/')) {
      if (route.request().method() === 'PATCH') renamed = route.request().postDataJSON().title;
      d =
        route.request().method() === 'DELETE'
          ? { deleted: true }
          : plain
            ? {
                kind: 'chat',
                repo: 'General chat',
                title: renamed || 'General chat',
                model,
                history: [],
              }
            : { ...session, title: renamed || undefined, model };
    } else {
      const n = Number(u.searchParams.get('page'));
      checked.push(n);
      d = {
        repos:
          n === 3
            ? [
                {
                  full_name: 'ldiaz94/target-repo',
                  private: true,
                  default_branch: 'main',
                  description: 'A repository beyond the first two pages.',
                },
              ]
            : [],
        scanned: 100,
        nextPage: n < 3 ? n + 1 : null,
      };
    }
    await route.fulfill({ json: d });
  });
  await page.goto('https://arno.test/');
  await page.getByPlaceholder('Search all accessible repositories').fill('target');
  await page.getByRole('heading', { name: 'ldiaz94/target-repo' }).waitFor();
  assert.ok(checked.includes(3));
  await page.screenshot({ path: '/tmp/arno-home-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  await page.locator('[data-session]').click();
  await page.getByRole('heading', { name: 'What this repository does' }).waitFor();
  assert.equal(await page.locator('.prose strong').first().textContent(), 'rlsp');
  assert.equal(await page.locator('.prose script').count(), 0);
  await page.locator('.prose .citation').click();
  await page.getByRole('heading', { name: 'Language Server Protocol specification' }).waitFor();
  await page.screenshot({ path: '/tmp/arno-citations-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Close sources' }).click();
  await page.getByRole('button', { name: 'Change model' }).click();
  await page.getByRole('button', { name: 'Kimi K3.1 Pro' }).click();
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  await page.getByRole('button', { name: 'Usage and session details' }).click();
  await page.getByText('4,200', { exact: true }).waitFor();
  const info = page.locator('#usage-dialog');
  await info.getByText('3,200 of 4,000 tokens (80%)').waitFor();
  assert.equal(await info.locator('.meter').getAttribute('aria-valuenow'), '80');
  await info.getByRole('heading', { name: 'Sources' }).waitFor();
  assert.ok(
    (await info.locator('[data-info-source]').textContent()).includes('microsoft.github.io'),
  );
  assert.equal(
    await info.locator('a[href="https://example.com/guide/start"]').getAttribute('rel'),
    'noopener noreferrer',
  );
  assert.equal(await info.locator('.info-images img').count(), 1);
  await info.getByRole('heading', { name: 'Repository identity' }).waitFor();
  await page.screenshot({ path: '/tmp/arno-usage-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Close usage' }).click();
  await page.getByRole('button', { name: /^Conversation details/ }).press('Enter');
  await info.getByRole('heading', { name: 'Context' }).waitFor();
  await page.getByRole('button', { name: 'Close usage' }).click();
  await page.getByRole('button', { name: 'Browse code and changes' }).click();
  await page.locator('[data-file="README.md"]').click();
  await page.locator('.source-lines').getByText('Regular source text').waitFor();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.locator('.panel-diff .add').waitFor();
  await page.getByRole('button', { name: 'Close code' }).click();
  await page.screenshot({ path: '/tmp/arno-chat-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('button', { name: 'Review and publish' }).click();
  await page.locator('#publish-title').fill('Improve example');
  await page.getByRole('button', { name: 'Create branch & pull request' }).click();
  await page.getByRole('link', { name: 'Open on GitHub' }).waitFor();
  assert.ok(published);
  await page.getByRole('button', { name: 'Close publishing' }).click();
  await page.getByRole('button', { name: 'Close actions' }).click();
  await page.getByLabel('Message', { exact: true }).fill('Continue with the fix');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Recovered after lost response', { exact: true }).waitFor();
  for (const size of [
    { width: 360, height: 780 },
    { width: 390, height: 380 },
    { width: 844, height: 390 },
    { width: 1440, height: 1000 },
    { width: 2560, height: 1440 },
    { width: 3440, height: 1440 },
  ]) {
    await page.setViewportSize(size);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(
      await page.evaluate(
        () =>
          document.querySelector('.workspace').scrollWidth <=
          document.querySelector('.workspace').clientWidth,
      ),
    );
  }
  await page.screenshot({ path: '/tmp/arno-chat-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Browse code and changes' }).click();
  await page.locator('[data-file="README.md"]').click();
  await page.locator('.source-lines').getByText('Regular source text').waitFor();
  await page.screenshot({ path: '/tmp/arno-ultrawide-code.png', fullPage: true });
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector('.workspace').scrollWidth <=
        document.querySelector('.workspace').clientWidth,
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#code-dialog').evaluate(n => n.matches(':modal')), true);
  await page.setViewportSize({ width: 3440, height: 1440 });
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Close code' }).click();
  await page.getByRole('button', { name: 'Toggle color theme' }).click();
  await page.screenshot({ path: '/tmp/arno-chat-light.png', fullPage: true });
  await page.getByRole('button', { name: 'New chat', exact: false }).click();
  await page.getByRole('heading', { name: 'A little space to think.' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Message', { exact: true }).fill('Tell me something interesting');
  await page
    .locator('#attach-input')
    .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await page.locator('#attach-chips .attach-chip:not(.uploading) .attach-name').waitFor();
  assert.equal(await page.locator('#attach-chips .attach-name').innerText(), 'dot.png');
  assert.equal(uploadHeaders['x-filename'], 'dot.png');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#thread .turn.user .attach-thumb img').waitFor();
  assert.deepEqual(submitted.attachments, ['att-1']);
  assert.equal(await page.locator('#attach-chips .attach-chip').count(), 0);
  await page.locator('.chat-activity').waitFor();
  await page.locator('#live-response .prose strong').waitFor();
  assert.equal(await page.locator('#live-response .prose strong').innerText(), 'streamed answer');
  assert.equal(await page.locator('#live-response .model-thinking').getAttribute('open'), null);
  await page.locator('#live-response .model-thinking summary').click();
  assert.match(
    await page.locator('#live-response .thinking-text').innerText(),
    /<script>never HTML<\/script>/,
  );
  assert.equal(await page.locator('#live-response script').count(), 0);
  await page.screenshot({ path: '/tmp/arno-streaming-mobile.png', fullPage: true });
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.chat-activity .steps').count(), 0);
  assert.equal(
    await page.getByLabel('Message', { exact: true }).getAttribute('placeholder'),
    'Message Arno…',
  );
  await page.screenshot({ path: '/tmp/arno-plain-thinking.png', fullPage: true });
  await page.getByText('Recovered after lost response', { exact: true }).waitFor();
  assert.equal(await page.locator('#live-response').count(), 0);
  await page.getByRole('button', { name: 'Session actions' }).click();
  page.once('dialog', d => d.accept('Research notes'));
  await page.getByRole('button', { name: 'Rename conversation', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('#title').textContent === 'Research notes',
  );
  await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  await page.getByRole('button', { name: 'Instructions & skills' }).click();
  await page.locator('#system-prompt').fill('Be concise');
  await page.getByRole('button', { name: 'Add skill', exact: false }).click();
  await page.locator('.skill-name').fill('Test discipline');
  await page.locator('.skill-content').fill('Run checks before finishing');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await page.waitForFunction(() =>
    document.querySelector('#account-save-status').textContent.startsWith('Saved.'),
  );
  assert.equal(preferences.systemPrompt, 'Be concise');
  assert.equal(preferences.skills[0].enabled, true);
  await page.getByRole('button', { name: 'Providers', exact: true }).click();
  await page.locator('[data-provider-input="openai"]').fill('sk-test-placeholder');
  await page.locator('[data-key-save="openai"]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-provider-status="openai"]').textContent.includes('Key saved'),
  );
  assert.equal(await page.locator('[data-provider-input="openai"]').inputValue(), '');
  await page.getByRole('button', { name: 'MCP tools', exact: true }).click();
  await page.getByRole('button', { name: 'Add MCP connection', exact: false }).click();
  await page.locator('.mcp-id').fill('fixture');
  await page.locator('.mcp-url').fill('https://mcp.example.com/mcp');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await page.waitForFunction(() =>
    document.querySelector('#account-save-status').textContent.startsWith('Saved.'),
  );
  await page.locator('.test-mcp').click();
  await page.getByText('Connected · Fixture · protocol 2025-03-26', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/arno-account-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator('#account-dialog').boundingBox();
  assert.ok(
    bounds.width >= 388 && bounds.height >= 842,
    'Mobile account settings should use the full viewport',
  );
  await page.screenshot({ path: '/tmp/arno-account-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Close account settings' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-session-menu="' + id + '"]').click();
  page.once('dialog', d => d.accept());
  await page.locator('#list-delete').click();
  await page.waitForFunction(id => !document.querySelector('[data-session-menu="' + id + '"]'), id);
  assert.deepEqual(errors, []);
  await page.evaluate(() => {
    const span = document.createElement('span');
    span.className = 'spinner';
    document.querySelector('#main').append(span);
  });
  const spinner = await page
    .locator('#main>.spinner')
    .evaluate(n => ({ w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height }));
  assert.ok(
    spinner.w >= 14 && Math.abs(spinner.w - spinner.h) < 1,
    'Standalone loading indicator must remain a circle',
  );
  await browser.close();
  console.log(
    'PASS: page-three search, session drawer, Markdown/code/table rendering, model change, usage, reviewed publishing, dropped-response recovery, themes, mobile/keyboard/desktop overflow.',
  );
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
