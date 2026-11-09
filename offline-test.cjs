/** Offline reading in the system Chromium through Playwright: serves web/ and
 * mocked /api/ replies from a local server (service workers need a secure
 * context, and localhost is one; page.route would not see the worker's own
 * fetches), lets the app warm its cache, then cuts the network and the server,
 * reloads, and checks a conversation never opened online, its image and
 * artifact, the usage page, the banner and the disabled composer render from
 * the device. Then, still offline, it queues two messages in a chat, a rename,
 * and a new chat with a message, reloads, and checks they wait with badges and a
 * count in the banner; back online (the server restarted), they reach the
 * server in order with their client ids, the new chat made first, and the
 * badges and the banner go. */
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
  fresh = '55555555-5555-4555-8555-555555555555', // the chat the server makes for the offline one
  now = Date.now(),
  model = 'mistral-large-4:cloud',
  base = '/api/sessions/' + two;
const row = (id, title, at = now) => ({
  id,
  kind: 'chat',
  title,
  model,
  createdAt: at,
  updatedAt: at,
});
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
  [one]: { ...row(one, 'First chat', now - 1), history: [] },
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

const TURN_MS = 1500; // how long a mocked turn runs
// What the app sent, in order: { what: 'chat' | 'message' | 'rename', sid, body }.
const received = [];
const jobs = {}; // each conversation's latest turn, by session id
let refusedBusy = 0; // messages sent while a turn ran (the app should wait instead)
let refuseChats = 1; // the first offline chat is refused once, to test Retry

/** The writes the outbox sends. Returns [status, reply], or null. */
function write(method, p, body) {
  if (method === 'POST' && p === '/api/chats') {
    if (refuseChats-- > 0) return [400, { error: 'Unsupported model' }];
    sessions[fresh] = { ...row(fresh, 'General chat'), history: [] };
    received.push({ what: 'chat', body });
    return [201, sessions[fresh]];
  }
  const m = p.match(/^\/api\/sessions\/([0-9a-f-]{36})(\/messages)?$/),
    s = m && sessions[m[1]];
  if (!s) return null;
  if (method === 'PATCH' && !m[2]) {
    Object.assign(s, { title: body.title, customTitle: true });
    received.push({ what: 'rename', sid: m[1], body });
    return [200, s];
  }
  if (method !== 'POST' || !m[2]) return null;
  const current = jobs[m[1]];
  if (current?.id === body.id) return [202, current];
  if (current?.status === 'running') {
    refusedBusy++;
    return [409, { error: 'A turn is already running' }];
  }
  received.push({ what: 'message', sid: m[1], body });
  jobs[m[1]] = { id: body.id, prompt: body.prompt, status: 'running', createdAt: Date.now() };
  return [202, jobs[m[1]]];
}

/** A conversation's job, finishing it once it has run TURN_MS. */
function job(id) {
  const j = jobs[id],
    s = sessions[id];
  if (j?.status === 'running' && Date.now() - j.createdAt >= TURN_MS) {
    const at = Date.now(),
      summary = 'Noted: ' + j.prompt;
    s.history.push({ prompt: j.prompt, summary, at, model });
    Object.assign(j, { status: 'completed', finishedAt: at, result: { summary } });
    s.updatedAt = at;
  }
  return j || { status: 'idle' };
}

function api(p) {
  if (p === '/api/me') return { user: { login: 'ldiaz94' } };
  if (p === '/api/models') return { models: [{ id: model, name: 'Mistral Large 4' }] };
  if (p === '/api/sessions')
    return {
      sessions: Object.values(sessions)
        .map(s => ({ ...s, history: undefined }))
        .sort((a, b) => b.createdAt - a.createdAt),
    };
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
  if (m[2] === '/job') return job(m[1]);
  if (m[2] === '/artifacts') return { artifacts: m[1] === two ? [artifact] : [] };
  if (m[2] === '/artifacts/' + artId) return artifact;
  return null;
}

async function handle(req, res) {
  const p = new URL(req.url, 'http://localhost').pathname;
  if (req.method !== 'GET') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const [status, d] = write(req.method, p, JSON.parse(raw || '{}')) || [404, { error: 'No' }];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(d));
  }
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
    // Sending and attaching go to the outbox; changing the model needs the network.
    assert.equal(await page.isDisabled('#send'), false);
    assert.equal(await page.isDisabled('#attach'), false);
    assert.equal(await page.isDisabled('#model-button'), true);
    assert.equal(
      await page.getAttribute('#model-button', 'title'),
      'Reconnect to change the model',
    );

    await page.click('#thread [data-artifact]');
    await page.waitForSelector('#artifact-content table');
    assert.match(await page.textContent('#artifact-content'), /Tent/);
    await page.click('#artifact-dialog [data-close]');

    await page.click('#usage-view');
    await page.waitForSelector('.usage-view');
    assert.match(await page.textContent('#main'), /Camping trip/);

    // The outbox: two messages in this chat, a rename, a new chat with a message.
    const banner = () => page.textContent('#offline-banner');
    await page.click('[data-session="' + two + '"]');
    await page.waitForSelector('#thread .turn');
    for (const text of ['Offline one', 'Offline two']) {
      await page.fill('#prompt', text);
      await page.click('#send');
    }
    await page.waitForFunction(() => document.querySelectorAll('.turn.queued').length === 2);
    assert.match(
      await page.textContent('.turn.queued .queued-badge'),
      /Queued · sends when online/,
    );
    assert.match(await banner(), /Offline · 2 waiting to send/);
    page.once('dialog', d => d.accept('Renamed offline'));
    await page.click('[data-session-menu="' + one + '"]');
    await page.click('#list-rename');
    await page.waitForSelector('[data-session="' + one + '"] >> text=Renamed offline');
    await page.click('#new-chat');
    await page.waitForSelector('.session-item.active >> text=Queued');
    await page.waitForSelector('#thread .starter');
    await page.fill('#prompt', 'Hello from a new chat');
    await page.click('#send');
    await page.waitForSelector('.turn.queued');
    assert.match(await banner(), /Offline · 4 waiting to send/);
    // They survive a reload: the new chat opens again with its message waiting.
    await page.reload();
    await page.waitForSelector('.turn.queued >> text=Hello from a new chat');
    await page.click('[data-session="' + two + '"]');
    await page.waitForFunction(() => document.querySelectorAll('.turn.queued').length === 2);
    assert.match(await banner(), /Offline · 4 waiting to send/);
    const ids = await page.evaluate(
      () =>
        new Promise(done => {
          indexedDB.open('arno').onsuccess = e =>
            (e.target.result.transaction('outbox').objectStore('outbox').getAll().onsuccess = r =>
              done(
                r.target.result
                  .filter(x => x.kind === 'message')
                  .sort((a, b) => a.createdAt - b.createdAt)
                  .map(x => x.body.id),
              ));
        }),
    );
    assert.equal(ids.length, 3);

    server = await serve(server.port);
    await context.setOffline(false);
    // Back online: everything is sent, this chat's messages one turn at a time.
    await page.waitForFunction(() => !document.querySelector('.turn.queued'), null, {
      timeout: 30000,
    });
    // The server refuses the offline chat once: the sidebar says so, and opening
    // it shows why, with Retry; retrying creates it and sends its message.
    await page.waitForSelector('.session-item .failed-mark', { timeout: 30000 });
    await page.click('.session-item:has(.failed-mark)');
    await page.waitForSelector('.failure >> text=Unsupported model');
    await page.click('[data-chat-retry]');
    for (let t = Date.now(); received.length < 5; await new Promise(r => setTimeout(r, 100)))
      assert.ok(Date.now() - t < 30000, 'not everything was sent: ' + JSON.stringify(received));
    const sent = sid => received.filter(r => r.what === 'message' && r.sid === sid);
    assert.deepEqual(
      sent(two).map(r => [r.body.prompt, r.body.id]),
      [
        ['Offline one', ids[0]],
        ['Offline two', ids[1]],
      ],
    );
    assert.deepEqual(
      sent(fresh).map(r => [r.body.prompt, r.body.id]),
      [['Hello from a new chat', ids[2]]],
    );
    assert.ok(
      received.findIndex(r => r.what === 'chat') < received.indexOf(sent(fresh)[0]),
      'the new chat is made before its message',
    );
    assert.deepEqual(
      received.find(r => r.what === 'rename'),
      {
        what: 'rename',
        sid: one,
        body: { title: 'Renamed offline' },
      },
    );
    assert.equal(refusedBusy, 0);
    await page.waitForSelector('.failure', { state: 'detached' });
    await page.click('[data-session="' + two + '"]');
    await page.waitForSelector('#thread .turn.assistant >> text=Noted: Offline two');
    await page.waitForSelector('[data-session="' + fresh + '"]');
    assert.equal(await page.locator('.queued-mark').count(), 0);
    await page.waitForSelector('#offline-banner', { state: 'hidden' });
    await page.click('[data-session="' + two + '"]');
    await page.waitForSelector('#thread .turn');
    assert.equal(await page.isDisabled('#send'), false);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: precache, warming, offline reload, saved conversation, image, artifact, usage, banner, model disabled, outbox (queued messages, rename, new chat, reload, flush in order, refused chat retried), back online.',
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
