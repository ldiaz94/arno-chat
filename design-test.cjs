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
  // A failure closes the browser and exits non-zero rather than hanging.
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      // The service worker's own fetches would bypass the page.route mocks below;
      // offline-test.cjs covers it.
      serviceWorkers: 'block',
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
      approved = null, // the chat's answer to its MCP action's question
      renamed = '',
      chatModel = null;
    const id = '11111111-1111-1111-1111-111111111111',
      oldChat = '44444444-4444-4444-4444-444444444444';
    const answer =
      '## What this repository does\n\nThis is **rlsp**, a library for the [Raz language](https://github.com/ldiaz94/raz).\n\n- Wire framing\n- Protocol types\n- Client sessions\n\n```raz\nmodule Example;\n(* Says hello. *)\nproc main*;\nbegin\n    Out.str("hi", LEN(s), nil);\nend main;\nend Example.\n```\n\n```js\nconst greeting = `hello ${name}`; // a deliberately long line that must scroll inside its block and never widen the page at all\n```\n\n| Module | Role |\n| --- | --- |\n| LspWire | Framing |';
    const diff =
      'diff --git a/src/demo.raz b/src/demo.raz\n--- a/src/demo.raz\n+++ b/src/demo.raz\n@@ -1,3 +1,3 @@\n module Demo;\n-proc old(): INT; (* gone *)\n+proc new(): BOOL; (* "kept" *)\n end Demo.';
    // A raz file for the file view: keywords, types, a comment over lines, a long line.
    const demoRaz =
      '(* Demo: a module to show the file view.\n   Its comment runs over two lines. *)\nmodule Demo;\nimport Out;\n\nconst Greeting = "hello, <world> & friends";\n\nproc main*;\nvar i: INT; ok: BOOL;\nbegin\n    for i := 0 to 9 do\n        Out.str(Greeting); Out.int(i); Out.ln(); (* a long line that must scroll sideways while its number stays put, even on the widest of desktop screens we test *)\n    end;\n    ok := LEN(Greeting) > 0;\nend main;\n\nend Demo.\n';
    const artId = '33333333-3333-4333-8333-333333333333';
    const artifact = {
      id: artId,
      title: 'Packing list',
      version: 2,
      createdAt: Date.now() - 9e5,
      updatedAt: Date.now(),
      content:
        '# Packing\n\n| Item | Qty |\n| --- | --- |\n| Tent, 2-person | 1 |\n| Socks | 4 |\n',
      previous: [
        { version: 1, title: 'Packing list', content: 'First draft', updatedAt: Date.now() - 9e5 },
      ],
    };
    const turn = {
      prompt: 'What does this repo do?',
      summary:
        'safety: auto, working on a copy at /cache\n' +
        answer +
        '\n\nSee the original specification [1]. Notes: https://example.com/guide/start.\n\n![Diagram](https://example.com/img/diagram.png)\n\nSee [Packing list](artifact:' +
        artId +
        ').',
      artifacts: [{ id: artId, title: 'Packing list', version: 2 }],
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
        cost: 0.035,
        costParts: {
          input: 0.004,
          cached: 0,
          cacheWrite: 0,
          output: 0.008,
          search: 0.022,
          reads: 0.001,
        },
      },
    };
    // Both themes, without the theme button the modal code dialog covers.
    const shot = async name => {
      for (const light of [false, true]) {
        await page.evaluate(l => document.body.classList.toggle('light', l), light);
        await page.waitForTimeout(250); // let the buttons' colour transition finish
        await page.screenshot({
          path: '/tmp/arno-' + name + (light ? '-light' : '-dark') + '.png',
        });
      }
      await page.evaluate(() => document.body.classList.remove('light'));
    };
    // The code dialog (open, any tab) at one width: a highlighted file with sticky line
    // numbers, the Wrap toggle, a highlighted diff, and nothing wider than the page.
    const codeChecks = async width => {
      const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page.locator('[data-file="src/demo.raz"]').click();
      await page.locator('.source-lines .hl-k', { hasText: 'module' }).waitFor();
      assert.equal(await page.locator('.source-lines .sl').count(), demoRaz.split('\n').length);
      assert.equal(await page.locator('.source-lines .sl').nth(1).locator('.hl-c').count(), 1);
      assert.match(await page.locator('.filehead').innerText(), /demo\.raz[\s\S]*raz/);
      assert.ok(await fits());
      const scroller = page.locator('.source-scroll');
      assert.ok(await scroller.evaluate(n => n.scrollWidth > n.clientWidth), 'long lines scroll');
      await shot('code-file-' + width);
      await scroller.evaluate(n => (n.scrollLeft = 200));
      // the numbers stay at the left edge while the lines scroll
      assert.ok(
        await page.evaluate(() => {
          const box = document.querySelector('.source-scroll').getBoundingClientRect(),
            n = getComputedStyle(document.querySelector('.sl'), '::before');
          return n.position === 'sticky' && box.width > 0;
        }),
      );
      await page.screenshot({ path: '/tmp/arno-code-file-' + width + '-scrolled.png' });
      await page.locator('.filehead .wrap-toggle').click();
      assert.equal(await page.evaluate(() => localStorage.getItem('codeWrap')), '1');
      assert.ok(await scroller.evaluate(n => n.scrollWidth <= n.clientWidth), 'wrapped lines fit');
      await shot('code-file-' + width + '-wrap');
      await page.locator('.filehead .wrap-toggle').click();
      assert.equal(await page.evaluate(() => document.body.classList.contains('code-wrap')), false);
      await page.getByRole('button', { name: 'Changes', exact: true }).click();
      await page.locator('.panel-diff .add .hl-t', { hasText: 'BOOL' }).waitFor();
      assert.equal(await page.locator('.panel-diff .remove .hl-c').count(), 1);
      assert.ok(await fits());
      await shot('code-diff-' + width);
      // History: the checkout's commits, the unpushed one marked; one opens with its patch.
      await page.getByRole('button', { name: 'History', exact: true }).click();
      await page.locator('.commit-row').first().waitFor();
      assert.equal(await page.locator('.commit-row .local-tag').count(), 1);
      assert.match(await page.locator('.history-note').innerText(), /2 files/);
      assert.ok(await fits());
      await shot('code-history-' + width);
      await page.locator('.commit-row').first().click();
      await page.locator('.commit-view h3', { hasText: 'Add the framing tests' }).waitFor();
      await page.locator('.panel-diff .add').first().waitFor();
      await page.locator('.history-back').click();
      await page.locator('.commit-row').first().waitFor();
    };
    // The answer's raz and JS code blocks: highlighted, the long line scrolling inside its
    // block, and the header's Wrap toggle.
    const chatCode = async width => {
      const blocks = page.locator('.codeblock');
      await blocks.first().scrollIntoViewIfNeeded();
      assert.equal(await blocks.nth(0).locator('.hl-k', { hasText: 'proc' }).count(), 1);
      assert.equal(await blocks.nth(0).locator('.hl-b', { hasText: 'LEN' }).count(), 1);
      assert.equal(await blocks.nth(1).locator('.hl-k', { hasText: 'const' }).count(), 1);
      assert.equal(await blocks.nth(1).locator('.hl-c').count(), 1);
      const pre = blocks.nth(1).locator('pre');
      assert.ok(await pre.evaluate(n => n.scrollWidth > n.clientWidth), 'long line scrolls');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await shot('chat-code-' + width);
      await blocks.nth(1).locator('.wrap-toggle').click();
      assert.ok(await pre.evaluate(n => n.scrollWidth <= n.clientWidth), 'wrapped line fits');
      await blocks.nth(1).locator('.wrap-toggle').click();
      assert.ok(await pre.evaluate(n => n.scrollWidth > n.clientWidth));
    };
    // Static files come from web/ as Cloudflare would serve them; /api/ is mocked below.
    await page.route(
      u => u.origin === 'https://arno.test' && !u.pathname.startsWith('/api/'),
      async r => {
        const p = new URL(r.request().url()).pathname,
          file = p === '/' ? '/index.html' : p;
        // A live fetch still in flight when the browser closes is not a failure.
        if (live)
          return r
            .fetch({ url: live + p })
            .then(response => r.fulfill({ response }))
            .catch(() => {});
        r.fulfill({
          contentType: types[require('node:path').extname(file)],
          body: fs.readFileSync(__dirname + '/web' + file),
        });
      },
    );
    let deleted = null;
    let preferences = {
      systemPrompt: '',
      about: '',
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
      if (u.pathname === '/api/account/avatar')
        return route.fulfill({ status: 404, json: { error: 'No picture' } });
      // A conversation whose delete the server refuses (the sidebar's edit mode).
      if (route.request().method() === 'DELETE' && u.pathname.endsWith('/' + oldChat))
        return route.fulfill({ status: 500, json: { error: 'Storage unavailable' } });
      if (u.pathname === '/api/account/delete') {
        deleted = route.request().postDataJSON();
        return route.fulfill({ json: { deleted: true } });
      }
      if (u.pathname.endsWith('/artifacts/' + artId)) d = artifact;
      else if (u.pathname.endsWith('/artifacts')) d = { artifacts: [artifact] };
      else if (u.pathname === '/api/usage/requests')
        d = {
          requests: [
            ['model', 'kimi-k3.1-pro', 1200, 600, 80, 0.004],
            ['search', 'web_search', null, null, null, 0.01],
            ['read', 'web_fetch', null, null, null, 0.005],
          ].map(([kind, m, input, cached, output, cost], i) => ({
            at: Date.now() - i * 3600000,
            sessionId: '11111111-1111-1111-1111-111111111111',
            title: 'Usage <b>fixture</b>',
            kind,
            model: m,
            input,
            cached,
            output,
            cost,
          })),
        };
      else if (u.pathname === '/api/usage/ollama')
        d = {
          balance: {
            included: {
              balance_usd: 59.34,
              allowance_usd: 60,
              period: { from: Date.now() - 86400000, until: Date.now() + 86400000 * 20 },
            },
            purchased: { balance_usd: 0 },
          },
          usage: {
            buckets: [{ groups: [{ model: 'web_search', usage_usd: 0.02 }] }],
          },
          source: 'account',
        };
      else if (u.pathname === '/api/me') d = { user: { login: 'ldiaz94' } };
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
      else if (u.pathname === '/api/account/search') {
        const b = route.request().postDataJSON();
        preferences.search = b.remove
          ? null
          : { url: b.url, auth: b.auth, clientId: b.clientId || '', hasSecret: !!b.secret };
        d = preferences;
      } else if (u.pathname === '/api/account/search-test') d = { ok: true, results: 9, ms: 412 };
      else if (u.pathname === '/api/chats') {
        chatModel = route.request().postDataJSON().model;
        plain = true;
        submitted = null;
        d = {
          id: '22222222-2222-2222-2222-222222222222',
          kind: 'chat',
          repo: 'General chat',
          title: 'General chat',
          model,
        };
      } else if (u.pathname.endsWith('/history'))
        d = {
          uncommitted: 2,
          commits: [
            {
              sha: 'c'.repeat(40),
              author: 'ldiaz94',
              at: Date.now() - 60000,
              subject: 'Add the framing tests',
              refs: 'HEAD -> feat',
              local: true,
            },
            {
              sha: 'd'.repeat(40),
              author: 'Luis',
              at: Date.now() - 86400000 * 3,
              subject: 'Wire framing',
              refs: 'origin/main, main',
              local: false,
            },
          ],
        };
      else if (u.pathname.endsWith('/commit'))
        d = {
          sha: 'c'.repeat(40),
          author: 'ldiaz94',
          at: Date.now() - 60000,
          message: 'Add the framing tests\n\nCovers split frames.',
          patch:
            'diff --git a/t.raz b/t.raz\n--- a/t.raz\n+++ b/t.raz\n@@ -1 +1,2 @@\n module T;\n+(* split frames *)\n',
        };
      else if (u.pathname.endsWith('/files'))
        d =
          u.searchParams.get('path') === 'src/demo.raz'
            ? { directory: false, path: 'src/demo.raz', content: demoRaz, bytes: demoRaz.length }
            : u.searchParams.get('path')
              ? {
                  directory: false,
                  path: 'README.md',
                  content: '# Example\nRegular source text',
                  bytes: 30,
                }
              : {
                  directory: true,
                  path: '',
                  entries: [
                    { name: 'README.md', path: 'README.md', directory: false },
                    { name: 'demo.raz', path: 'src/demo.raz', directory: false },
                  ],
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
          json: {
            id: 'att-1',
            name: 'dot.png',
            type: 'image/png',
            size: png.length,
            kind: 'image',
          },
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
          ? plain && (plainPolls++ < 2 || approved === null)
            ? {
                id: submitted.id,
                prompt: submitted.prompt,
                status: 'running',
                // After two polls the chat asks to run an MCP action.
                ...(plainPolls > 2
                  ? {
                      stage: 'approval',
                      approval: {
                        id: 'ap1',
                        what: 'Linear · create_issue',
                        args: '{\n  "title": "Fix"\n}',
                      },
                    }
                  : { stage: 'thinking' }),
                createdAt: Date.now(),
              }
            : {
                id: submitted.id,
                prompt: submitted.prompt,
                status: 'completed',
                result: {
                  ...turn,
                  summary: 'Recovered after lost response',
                  options: submitted.options,
                },
                finishedAt: Date.now(),
              }
          : { status: 'idle' };
      else if (u.pathname.endsWith('/approve')) {
        approved = route.request().postDataJSON();
        d = { ok: true };
      } else if (u.pathname.endsWith('/model')) {
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
        d = {
          sessions: [
            { id, repo: session.repo, ref: 'main', createdAt: Date.now() },
            {
              id: oldChat,
              kind: 'chat',
              repo: 'General chat',
              title: 'Old chat',
              createdAt: Date.now() - 60000,
            },
          ],
        };
      else if (u.pathname.startsWith('/api/sessions/')) {
        if (route.request().method() === 'PATCH') renamed = route.request().postDataJSON().title;
        d =
          route.request().method() === 'DELETE'
            ? { deleted: true }
            : plain && !u.pathname.includes(id)
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
    // Chat mode first: its home greets, shows the today card (weather off by
    // default) and lists only chats.
    await page
      .getByRole('heading', { name: /^Good (morning|afternoon|evening), ldiaz94$|^Still up/ })
      .waitFor();
    for (const tile of ['moon', 'quote', 'fact'])
      assert.equal(await page.locator('.today-' + tile).count(), 1, tile);
    assert.equal(await page.locator('.today-weather').count(), 0);
    assert.equal(await page.locator('.today-moon svg path').count(), 1);
    const quote = await page.locator('[data-today="quote"]').textContent();
    await page.locator('[data-another="quote"]').click();
    assert.notEqual(await page.locator('[data-today="quote"]').textContent(), quote);
    await page.screenshot({ path: '/tmp/arno-chat-home-mobile.png', fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const listed = () =>
      page.locator('.session-item').evaluateAll(ns => ns.map(n => n.dataset.session));
    assert.deepEqual(await listed(), [oldChat]);
    await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
    await page.locator('[data-mode="code"]').click();
    await page.getByRole('heading', { name: 'Start from a repository' }).waitFor();
    assert.deepEqual(await listed(), [id]);
    assert.equal(await page.locator('#new-chat').isHidden(), true);
    await page.locator('#overlay').click({ position: { x: 370, y: 400 } });
    await page.getByPlaceholder('Search all accessible repositories').fill('target');
    await page.getByRole('heading', { name: 'ldiaz94/target-repo' }).waitFor();
    assert.ok(checked.includes(3));
    await page.screenshot({ path: '/tmp/arno-home-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
    await page.locator('.session-item[data-session="' + id + '"]').click();
    await page.getByRole('heading', { name: 'What this repository does' }).waitFor();
    assert.equal(await page.locator('.prose strong').first().textContent(), 'rlsp');
    await chatCode('390');
    assert.equal(await page.locator('.prose script').count(), 0);
    assert.equal(await page.locator('.artifact-card').textContent(), 'Packing listv2');
    await page.locator('.prose .artifact-link').click();
    await page.locator('#artifact-content table').waitFor();
    await page.getByRole('button', { name: 'Download .csv' }).waitFor();
    assert.equal(await page.locator('#artifact-heading').textContent(), 'Packing list');
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    );
    await page.locator('#artifact-versions').selectOption('1');
    await page.getByText('First draft').waitFor();
    assert.ok(await page.getByRole('button', { name: 'Download .csv' }).isHidden());
    await page.getByRole('button', { name: 'Close artifact' }).click();
    await page.locator('.artifact-card').click();
    await page.locator('#artifact-content table').waitFor();
    await page.getByRole('button', { name: 'Close artifact' }).click();
    await page.locator('.prose .citation').click();
    await page.getByRole('heading', { name: 'Language Server Protocol specification' }).waitFor();
    await page.screenshot({ path: '/tmp/arno-citations-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Close sources' }).click();
    await page.getByRole('button', { name: 'Change model' }).click();
    assert.equal(
      await page.locator('#model-options .model-option').count(),
      await page.locator('#model-options .model-option svg.pmark').count(),
    );
    assert.ok((await page.locator('#model-options .model-option svg.pmark').count()) >= 2);
    await page.screenshot({ path: '/tmp/arno-models-mobile.png' });
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
    await info.getByRole('heading', { name: 'Artifacts' }).waitFor();
    assert.ok((await info.locator('[data-artifact]').textContent()).includes('Packing list'));
    await info.locator('[data-artifact]').click();
    await page.locator('#artifact-content table').waitFor();
    await page.getByRole('button', { name: 'Close artifact' }).click();
    await info.getByRole('heading', { name: 'Repository identity' }).waitFor();
    assert.match(await info.locator('.cost-table').innerText(), /Web searches\s+\$0\.02/);
    await page.screenshot({ path: '/tmp/arno-usage-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Close usage' }).click();
    await page.getByRole('button', { name: /^Conversation details/ }).press('Enter');
    await info.getByRole('heading', { name: 'Context' }).waitFor();
    // Artifacts come first; sections fold, and the device remembers which.
    await info.locator('[data-section="Artifacts"]').waitFor();
    assert.equal(
      await info.locator('.info-section').first().getAttribute('data-section'),
      'Artifacts',
    );
    const sourcesFold = info.locator('[data-section="Sources"]');
    assert.equal(await sourcesFold.getAttribute('open'), null);
    await sourcesFold.locator('summary').click();
    await info.locator('[data-info-source]').first().waitFor();
    await info.locator('[data-section="Usage"] > summary').click();
    await page.getByRole('button', { name: 'Close usage' }).click();
    await page.getByRole('button', { name: /^Conversation details/ }).press('Enter');
    await info.locator('[data-section="Artifacts"]').waitFor();
    assert.equal(await sourcesFold.getAttribute('open'), '');
    assert.equal(await info.locator('[data-section="Usage"]').getAttribute('open'), null);
    await page.screenshot({ path: '/tmp/arno-details-folded.png' });
    await page.getByRole('button', { name: 'Close usage' }).click();
    await page.getByRole('button', { name: 'Browse code and changes' }).click();
    await page.locator('[data-file="README.md"]').click();
    await page.locator('.source-lines').getByText('Regular source text').waitFor();
    await codeChecks('390');
    await page.getByRole('button', { name: 'Close code' }).click();
    await page.screenshot({ path: '/tmp/arno-chat-mobile.png', fullPage: true });
    // Scrolled up, a button jumps back to the bottom and resumes following.
    await page.evaluate(() =>
      document.querySelector('#main').scrollTo({ top: 0, behavior: 'instant' }),
    );
    await page.locator('#jump-bottom').waitFor();
    await page.screenshot({ path: '/tmp/arno-jump-mobile.png' });
    await page.locator('#jump-bottom').click();
    await page.locator('#jump-bottom').waitFor({ state: 'hidden' });
    assert.ok(
      await page.evaluate(() => {
        const m = document.querySelector('#main');
        return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
      }),
    );
    // The brand goes back to the home page; the conversation reopens from the list.
    await page.evaluate(() => document.querySelector('#brand').click());
    await page.locator('.today-tile').first().waitFor();
    await page.evaluate(sid => document.querySelector('[data-session="' + sid + '"]').click(), id);
    await page.locator('#thread .turn').first().waitFor();
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
    await page.setViewportSize({ width: 1440, height: 1000 });
    await chatCode('1440');
    await page.getByRole('button', { name: 'Browse code and changes' }).click();
    await codeChecks('1440');
    await page.getByRole('button', { name: 'Close code' }).click();
    await page.setViewportSize({ width: 3440, height: 1440 });
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
    // Settings: Enter adds a new line, and new chats start with Kimi.
    await page.getByRole('button', { name: 'Account settings', exact: true }).click();
    await page.locator('#enter-line').check();
    await page.locator('#default-model').selectOption('kimi-k3.1-pro');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#account-save-status').textContent.startsWith('Saved.'),
    );
    assert.equal(preferences.enterSends, false);
    assert.equal(preferences.defaultModel, 'kimi-k3.1-pro');
    await page.getByRole('button', { name: 'Close account settings' }).click();
    await page.locator('[data-mode="chat"]').click();
    await page.locator('#home-prompt').waitFor();
    assert.equal(await page.locator('.home-hint').textContent(), '⌘ / Ctrl + Enter to send');
    await page.locator('#home-prompt').fill('Hello');
    await page.locator('#home-prompt').press('Enter');
    assert.equal(await page.locator('#home-prompt').inputValue(), 'Hello\n');
    assert.equal(chatModel, null, 'Enter must not start a chat');
    await page.getByRole('button', { name: 'New chat', exact: false }).click();
    await page.getByRole('heading', { name: 'A little space to think.' }).waitFor();
    assert.equal(chatModel, 'kimi-k3.1-pro');
    // The new chat has no activity yet: the older chat stays first until a turn ends.
    assert.deepEqual(await listed(), [oldChat, '22222222-2222-2222-2222-222222222222']);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('Message', { exact: true }).fill('Tell me something interesting');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    assert.equal(submitted, null, 'Enter adds a new line');
    assert.equal(
      await page.getByLabel('Message', { exact: true }).inputValue(),
      'Tell me something interesting\n',
    );
    await page
      .locator('#attach-input')
      .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
    await page.locator('#attach-chips .attach-chip:not(.uploading) .attach-name').waitFor();
    assert.equal(await page.locator('#attach-chips .attach-name').innerText(), 'dot.png');
    assert.equal(uploadHeaders['x-filename'], 'dot.png');
    // Options: the popover fits the phone, picks go to chips, Escape closes it.
    const panel = page.locator('#options-panel'),
      pick = text => panel.locator('label', { hasText: text }).click();
    await page.getByRole('button', { name: 'Message options' }).click();
    await panel.waitFor();
    const box = await panel.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'Options popover fits at 390px');
    await pick('Deep research');
    await pick('Caveman');
    await page.keyboard.press('Escape');
    assert.equal(await panel.isHidden(), true);
    const chips = () =>
      page.locator('#option-chips .option-chip').evaluateAll(ns => ns.map(n => n.firstChild.data));
    assert.deepEqual(await chips(), ['Deep research', 'Caveman']);
    await page.getByLabel('Message', { exact: true }).press('Control+Enter');
    await page.locator('#thread .turn.user .attach-thumb img').waitFor();
    assert.deepEqual(submitted.attachments, ['att-1']);
    assert.deepEqual(submitted.options, {
      search: true,
      effort: 'auto',
      mode: 'deep',
      style: 'caveman',
      mcp: true,
      approach: 'auto',
      workers: '4',
      budget: 'auto',
    });
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
    // The chat asks before an MCP action; Allow answers it, and the turn goes on.
    await page.locator('#approval').waitFor();
    assert.match(
      await page.locator('#approval').innerText(),
      /Linear · create_issue[\s\S]*"title": "Fix"/,
    );
    await page.screenshot({ path: '/tmp/arno-approval-mobile.png' });
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await page.getByText('Allowed · running').waitFor();
    assert.deepEqual(approved, { id: 'ap1', allow: true });
    await page.getByText('Recovered after lost response', { exact: true }).waitFor();
    assert.equal(await page.locator('#approval').count(), 0);
    assert.equal(await page.locator('#live-response').count(), 0);
    if (submitted.options)
      assert.deepEqual(await page.locator('.turn-footer .option-tag').allInnerTexts(), [
        'Deep research',
        'Caveman',
      ]);
    // The finished turn moved the chat to the top.
    assert.deepEqual(await listed(), ['22222222-2222-2222-2222-222222222222', oldChat]);
    await page.getByRole('button', { name: 'Session actions' }).click();
    page.once('dialog', d => d.accept('Research notes'));
    await page.getByRole('button', { name: 'Rename conversation', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('#title').textContent === 'Research notes',
    );
    await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
    // Edit mode: a conversation whose delete fails stays listed and picked; Escape leaves.
    await page.locator('#list-edit').click();
    await page.locator('.session-item[data-session="' + oldChat + '"]').click();
    assert.equal(await page.locator('#bulk-delete').textContent(), 'Delete selected (1)');
    page.once('dialog', d => d.accept());
    await page.locator('#bulk-delete').click();
    await page.getByText('0 deleted · 1 could not be deleted').waitFor();
    assert.ok((await listed()).includes(oldChat));
    assert.equal(
      await page
        .locator('.session-item[data-session="' + oldChat + '"]')
        .getAttribute('aria-pressed'),
      'true',
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#bulk-bar').isHidden(), true);
    assert.equal(await page.locator('.session-pick').count(), 0);
    await page.getByRole('button', { name: 'Account settings', exact: true }).click();
    // The You tab opens first: picture (initials, no photo), about text and privacy notice.
    assert.equal(await page.locator('#picture').textContent(), 'LD');
    assert.equal(await page.locator('#picture img').count(), 0);
    assert.equal(await page.locator('#picture-remove').isHidden(), true);
    for (const text of [
      'We don’t train on your chats',
      'a log of your last 1,000 requests',
      'Cloudflare deletes coding-workspace snapshots within 30 days',
    ])
      assert.ok((await page.locator('#privacy').textContent()).includes(text), text);
    assert.equal(
      await page
        .locator('#privacy a[href="https://github.com/settings/applications"]')
        .getAttribute('target'),
      '_blank',
    );
    await page.locator('#about').fill('Ana, a nurse who likes short answers');
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
    assert.equal(preferences.about, 'Ana, a nurse who likes short answers');
    assert.equal(preferences.skills[0].enabled, true);
    await page.getByRole('button', { name: 'Providers', exact: true }).click();
    // Provider and search cards start collapsed; the header row opens them.
    assert.equal(await page.locator('#account-dialog details.collapsible[open]').count(), 0);
    await page.screenshot({ path: '/tmp/arno-providers-mobile.png' });
    await page.locator('details:has([data-provider-input="openai"]) > summary').click();
    await page.locator('[data-provider-input="openai"]').fill('sk-test-placeholder');
    await page.locator('[data-key-save="openai"]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-provider-status="openai"]').textContent.includes('Key saved'),
    );
    assert.equal(await page.locator('[data-provider-input="openai"]').inputValue(), '');
    assert.equal(await page.locator('.setting-card .guide').count(), 4); // 3 providers + search
    assert.equal(await page.locator('#search-state').textContent(), 'Ollama (default)');
    await page.locator('#search-card > summary').click();
    await page.locator('#search-card .guide summary').click();
    await page.getByText('Turn on JSON answers.').waitFor();
    await page.locator('#search-url').fill('https://search.example.com');
    await page.locator('#search-client-id').fill('abc.access');
    await page.locator('#search-secret').fill('secret-value');
    await page.locator('#search-save').click();
    await page.waitForFunction(
      () => document.querySelector('#search-state').textContent === 'Your SearXNG · connected',
    );
    assert.equal(preferences.search.clientId, 'abc.access');
    assert.equal(await page.locator('#search-secret').inputValue(), '');
    assert.equal(
      await page.locator('#search-secret').getAttribute('placeholder'),
      'Saved · leave blank to keep',
    );
    await page.locator('#search-test').click();
    await page.getByText('Connected · 9 results in 412 ms', { exact: true }).waitFor();
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
    await page.locator('[data-account-tab="connections"]').click();
    await page.locator('#sandbox-internet').waitFor();
    await page.locator('#cf-token').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/arno-connections-mobile.png' });
    await page.locator('[data-account-tab="you"]').click();
    await page.getByRole('button', { name: 'Close account settings' }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-mode="code"]').click();
    await page.locator('[data-session-menu="' + id + '"]').click();
    page.once('dialog', d => d.accept());
    await page.locator('#list-delete').click();
    await page.waitForFunction(
      id => !document.querySelector('[data-session-menu="' + id + '"]'),
      id,
    );
    await page.locator('#usage-view').click();
    await page.getByText('$59.34 of $60.00 left').waitFor();
    assert.equal(await page.locator('#recent-requests tbody tr').count(), 3);
    assert.ok(
      (await page.locator('#recent-requests tbody tr').first().textContent()).includes('<$0.01'),
    );
    await page.getByRole('button', { name: 'Search & reads' }).click();
    assert.equal(await page.locator('#recent-requests tbody tr').count(), 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.locator('#title').textContent(), 'Usage');
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
    // Account deletion needs the GitHub login typed first.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Account settings', exact: true }).click();
    await page.locator('#delete-start').click();
    assert.equal(await page.locator('#delete-go').isDisabled(), true);
    await page.locator('#delete-login').fill('someone-else');
    assert.equal(await page.locator('#delete-go').isDisabled(), true);
    await page.locator('#delete-login').fill('LDiaz94');
    assert.equal(await page.locator('#delete-go').isDisabled(), false);
    await page.locator('#delete-go').click();
    await page.getByText('Account deleted', { exact: true }).waitFor();
    assert.deepEqual(deleted, { confirm: 'LDiaz94' });
    // A link to a coding session opens Code mode, whatever mode was last used.
    await page.goto('https://arno.test/?session=' + id);
    await page.getByRole('heading', { name: 'What this repository does' }).waitFor();
    assert.equal(await page.locator('[data-mode="code"]').getAttribute('aria-pressed'), 'true');
    // A coding session starts from the last options, without deep research.
    await page.getByRole('button', { name: 'Message options' }).click();
    assert.equal(
      await page.locator('#options-panel label', { hasText: 'Deep research' }).isHidden(),
      true,
    );
    assert.deepEqual(await chips(), ['Caveman']);
    // Coding options: approach, workers and budget, then /budget typed.
    await page
      .locator('#options-panel label')
      .filter({ hasText: /^Build$/ })
      .click();
    await page.locator('#options-panel label').filter({ hasText: /^2$/ }).click();
    await page.screenshot({ path: '/tmp/arno-code-options.png' });
    await page.keyboard.press('Escape');
    await page.getByLabel('Message', { exact: true }).fill('/budget 2.50');
    await page.getByLabel('Message', { exact: true }).press('Control+Enter');
    assert.deepEqual(await chips(), ['Caveman', 'Build', 'Workers: 2', '$2.50 budget']);
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), '');
    // Typing / lists the commands; Tab or Enter puts the picked one in, a tap too.
    const composer = page.getByLabel('Message', { exact: true }),
      names = () => page.locator('#command-list .command-name').allInnerTexts();
    await composer.pressSequentially('/c');
    assert.deepEqual(
      (await names()).map(n => n.split(' ')[0]),
      ['/compact', '/clear'],
    );
    await page.screenshot({ path: '/tmp/arno-commands.png' });
    await composer.press('ArrowDown');
    await composer.press('Tab');
    assert.equal(await composer.inputValue(), '/clear ');
    assert.equal(await page.locator('#command-list').isHidden(), true);
    await composer.fill('');
    await composer.pressSequentially('/mo');
    await composer.press('Enter'); // chooses, does not send
    assert.equal(await composer.inputValue(), '/mode ');
    await composer.pressSequentially('review');
    await composer.press('Control+Enter');
    assert.ok((await chips()).includes('Review'));
    await composer.pressSequentially('/us');
    await page.locator('#command-list [data-command="usage"]').click();
    assert.equal(await composer.inputValue(), '/usage ');
    // A regular chat suggests nothing.
    await composer.fill('');
  } finally {
    await browser.close();
  }
  console.log(
    'PASS: Chat/Code modes and lists, home today card, Enter and default-model settings, sidebar order, page-three search, session drawer, Markdown/code/table rendering, model change, usage, reviewed publishing, dropped-response recovery, themes, composer options, mobile/keyboard/desktop overflow.',
  );
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
