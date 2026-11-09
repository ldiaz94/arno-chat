/** Offline reading in the system Chromium through Playwright: serves web/ and
 * mocked /api/ replies from a local server (service workers need a secure
 * context, and localhost is one; page.route would not see the worker's own
 * fetches), lets the app warm its cache, then cuts the network and the server,
 * reloads, and checks a conversation never opened online, its image and
 * artifact, the usage page, the banner and the disabled composer render from
 * the device. Back online, the banner goes. */
const { chromium } = require('playwright'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  http = require('node:http'),
  path = require('node:path');

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const one = '11111111-1111-4111-8111-111111111111',
  two = '22222222-2222-4222-8222-222222222222',
  artId = '33333333-3333-4333-8333-333333333333',
  picId = '44444444-4444-4444-8444-444444444444',
  now = Date.now(),
  model = 'mistral-large-4:cloud',
  base = '/api/sessions/' + two;
const row = (id, title) => ({ id, kind: 'chat', title, model, createdAt: now, updatedAt: now });
const artifact = {
  id: artId,
  title: 'Packing list',
  version: 1,
  createdAt: now,
  updatedAt: now,
  content: '# Packing\n\n| Item | Qty |\n| --- | --- |\n| Tent | 1 |',
  previous: [],
};
const sessions = {
  [one]: { ...row(one, 'First chat'), history: [] },
  [two]: {
    ...row(two, 'Camping trip'),
    history: [
      {
        prompt: 'What should I pack?',
        summary: 'Here is your **packing list**.',
        at: now,
        model,
        attachments: [{ id: picId, name: 'tent.png', type: 'image/png', kind: 'image', size: 68 }],
        artifacts: [{ id: artId, title: 'Packing list', version: 1 }],
      },
    ],
  },
};

function api(p) {
  if (p === '/api/me') return { user: { login: 'ldiaz94' } };
  if (p === '/api/models') return { models: [{ id: model, name: 'Mistral Large 4' }] };
  if (p === '/api/sessions')
    return { sessions: [row(two, 'Camping trip'), row(one, 'First chat')] };
  if (p === '/api/account') return { providers: {}, models: [], skills: [], mcp: [] };
  if (p === '/api/usage/requests')
    return {
      requests: [
        { at: now, sessionId: two, title: 'Camping trip', kind: 'model', model, cost: 0.002 },
      ],
    };
  const m = p.match(/^\/api\/sessions\/([0-9a-f-]{36})(\/.*)?$/);
  if (!m || !sessions[m[1]]) return null;
  if (!m[2]) return sessions[m[1]];
  if (m[2] === '/job') return { status: 'idle' };
  if (m[2] === '/artifacts') return { artifacts: m[1] === two ? [artifact] : [] };
  if (m[2] === '/artifacts/' + artId) return artifact;
  return null;
}

function handle(req, res) {
  const p = new URL(req.url, 'http://localhost').pathname;
  if (p === '/api/sessions/' + two + '/attachments/' + picId) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(png);
  }
  if (p.startsWith('/api/')) {
    const d = api(p);
    res.writeHead(d ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(d || { error: 'Not found' }));
  }
  const file = path.join(__dirname, 'web', p === '/' ? 'index.html' : p);
  if (!file.startsWith(path.join(__dirname, 'web')) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(fs.readFileSync(file));
}

/** Starts the server on port (0: any free one); stop() also drops open sockets. */
function serve(port) {
  const server = http.createServer(handle),
    sockets = new Set();
  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise(done =>
    server.listen(port, 'localhost', () =>
      done({
        port: server.address().port,
        stop: () =>
          new Promise(closed => {
            for (const s of sockets) s.destroy();
            server.close(closed);
          }),
      }),
    ),
  );
}

(async () => {
  let server = await serve(0);
  const origin = 'http://localhost:' + server.port;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.goto(origin + '/');
    await page.waitForSelector('[data-session="' + two + '"]');
    // Warming runs once the worker controls the page: wait for the last pieces.
    const warmed = () =>
      page.evaluate(
        async urls => {
          for (const url of urls)
            if (!(await caches.match(url, { cacheName: 'arno-data' }))) return false;
          return true;
        },
        [
          '/api/me',
          '/api/sessions',
          base,
          base + '/artifacts/' + artId,
          base + '/attachments/' + picId,
        ],
      );
    for (let t = Date.now(); !(await warmed()); await new Promise(r => setTimeout(r, 250)))
      assert.ok(Date.now() - t < 30000, 'the cache was not warmed in 30 s');
    assert.equal(await page.locator('#offline-banner').isHidden(), true);

    await context.setOffline(true);
    await server.stop();
    await page.reload();
    await page.waitForSelector('#offline-banner:not([hidden])');
    assert.match(
      await page.textContent('#offline-banner'),
      /Offline · showing saved conversations/,
    );

    await page.click('[data-session="' + two + '"]');
    await page.waitForSelector('#thread .turn');
    assert.match(await page.textContent('#thread'), /What should I pack\?/);
    assert.match(await page.textContent('#thread'), /packing list/);
    await page.waitForFunction(() => document.querySelector('.attach-thumb img')?.naturalWidth > 0);
    assert.equal(await page.isDisabled('#send'), true);
    assert.equal(await page.isDisabled('#attach'), true);
    assert.equal(await page.isDisabled('#model-button'), true);
    assert.equal(await page.getAttribute('#send', 'title'), 'Reconnect to send');

    await page.click('#thread [data-artifact]');
    await page.waitForSelector('#artifact-content table');
    assert.match(await page.textContent('#artifact-content'), /Tent/);
    await page.click('#artifact-dialog [data-close]');

    await page.click('#usage-view');
    await page.waitForSelector('.usage-view');
    assert.match(await page.textContent('#main'), /Camping trip/);

    server = await serve(server.port);
    await context.setOffline(false);
    await page.waitForSelector('#offline-banner', { state: 'hidden' });
    await page.click('[data-session="' + two + '"]');
    await page.waitForSelector('#thread .turn');
    assert.equal(await page.isDisabled('#send'), false);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: precache, warming, offline reload, saved conversation, image, artifact, usage, banner, disabled composer, back online.',
    );
  } catch (e) {
    await page.screenshot({ path: '/tmp/arno-offline-failure.png' }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
