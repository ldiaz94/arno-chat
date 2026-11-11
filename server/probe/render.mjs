/** Rendering an artifact's page in a real browser, to see what the user will
 * see: Cloudflare Browser Rendering (the BROWSER binding) through
 * @cloudflare/puppeteer.
 *
 *   html ─► https://artifact.invalid/ (answered from memory, under the page's
 *           own policy) ─► the CDNs and images it loads, from the network
 *        ─► page errors, console errors, failed loads, policy violations
 *        ─► a JPEG screenshot at phone size
 *
 * The page runs under PAGE_POLICY from artifacts.mjs, sandbox and all, as in
 * the app, so what is blocked there is blocked here. Rendering is a check, not
 * a step a write depends on: with no binding, or on any failure, the result
 * is {unavailable}. Depends on artifacts.mjs. Leaves out Mermaid diagrams and
 * interaction (clicks, typing): only the page as it first shows. */
import { PAGE_POLICY } from './artifacts.mjs';

/** Where the page seems to come from: a name that never resolves, so every
 * request to it is ours to answer. */
const ORIGIN = 'https://artifact.invalid',
  PAGE_URL = ORIGIN + '/';
/** A phone's screen, in CSS pixels, at one device pixel each (a small image). */
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
/** How long to wait for the page and its loads to settle, then for its
 * opening animations, and for the whole check, in ms. */
const LOAD_MS = 8000,
  SETTLE_MS = 1500,
  TOTAL_MS = 15000;
/** JPEG quality of the screenshot: enough to read the page, small to send. */
const QUALITY = 55;
/** Most entries kept of each list, and the characters of each. */
const MAX_ITEMS = 20,
  ITEM_LENGTH = 300;
/** Run in the page before its own scripts: what the policy blocks becomes a
 * console error, which is collected with the rest. */
const POLICY_LISTENER =
  "document.addEventListener('securitypolicyviolation',e=>console.error('Blocked by the page policy: '+e.blockedURI+' ('+e.effectiveDirective+')'))";

/** Opens html in a headless browser at phone size and reports what went
 * wrong: {errors, failedLoads: [{url, status}], screenshot (base64 JPEG), ms},
 * or {unavailable: why}. launch stands in for the browser in tests. */
export async function renderPage(env, html, { launch } = {}) {
  const began = Date.now();
  if (!launch) {
    if (!env?.BROWSER) return { unavailable: 'No browser to render with' };
    launch = async () => (await import('@cloudflare/puppeteer')).default.launch(env.BROWSER);
  }
  const errors = new Set(),
    failed = new Map();
  let browser, timer;
  // Each list deduplicated and capped.
  const noteError = text => {
    if (errors.size < MAX_ITEMS) errors.add(String(text).slice(0, ITEM_LENGTH));
  };
  const noteFailed = (url, status) => {
    if (isFavicon(url)) return;
    if (failed.size < MAX_ITEMS && !failed.has(url)) failed.set(url, status);
  };
  const work = (async () => {
    browser = await launch();
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.evaluateOnNewDocument(POLICY_LISTENER);
    page.on('pageerror', e => noteError(e.message + lineOf(e)));
    page.on('console', m => {
      if (m.type() === 'error' && !isFavicon(m.location?.()?.url || '')) noteError(m.text());
    });
    page.on('requestfailed', r => noteFailed(r.url(), r.failure()?.errorText || 'failed'));
    page.on('response', r => r.status() >= 400 && noteFailed(r.url(), r.status()));
    await page.setRequestInterception(true);
    page.on('request', r => {
      if (r.url() === PAGE_URL)
        r.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: { 'Content-Security-Policy': PAGE_POLICY },
          body: html,
        });
      // Anything else of the page's own is missing in the app too.
      else if (r.url().startsWith(ORIGIN)) r.respond({ status: 404, body: '' });
      else r.continue();
    });
    // A page whose loads never settle is still looked at as it stands.
    await page.goto(PAGE_URL, { waitUntil: 'networkidle0', timeout: LOAD_MS }).catch(() => {});
    await new Promise(r => setTimeout(r, SETTLE_MS));
    return page.screenshot({ type: 'jpeg', quality: QUALITY, encoding: 'base64' });
  })();
  const close = () => browser?.close().catch(() => {});
  try {
    const screenshot = await Promise.race([
      work,
      new Promise((_, fail) => {
        timer = setTimeout(() => fail(Error('Rendering took too long')), TOTAL_MS);
      }),
    ]);
    await close();
    const result = {
      errors: [...errors],
      failedLoads: [...failed].map(([url, status]) => ({ url: url.slice(0, ITEM_LENGTH), status })),
      screenshot,
      ms: Date.now() - began,
    };
    console.log(
      JSON.stringify({
        event: 'artifact_check',
        ms: result.ms,
        errors: result.errors.length,
        failed: result.failedLoads.length,
      }),
    );
    return result;
  } catch (e) {
    // Closed once the work stops, even work given up on mid-launch.
    work.then(close, close);
    console.log(
      JSON.stringify({ event: 'artifact_check', ms: Date.now() - began, error: e.message }),
    );
    return { unavailable: 'Could not render the page: ' + e.message };
  } finally {
    clearTimeout(timer);
  }
}
/** Whether url is the favicon the browser asks for of its own accord; the
 * app shows none, so its 404 (and the console line about it) is no fault. */
function isFavicon(url) {
  return url.endsWith('/favicon.ico');
}
/** ' (line n)' from an uncaught error's stack, for the page's own code; ''
 * when it came from elsewhere or has no line. */
function lineOf(e) {
  const at = new RegExp(PAGE_URL.replace(/[.]/g, '\\.') + ':(\\d+):').exec(e.stack || '');
  return at ? ' (line ' + at[1] + ')' : '';
}

/** What a check found in an artifact's page, rendered: an html page as it is,
 * an SVG drawing on a page of its own; {unavailable} for other kinds. */
export async function renderArtifact(env, a, options) {
  if (a.kind === 'html') return renderPage(env, a.content, options);
  if (a.kind === 'svg')
    return renderPage(
      env,
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0">' +
        a.content,
      options,
    );
  return { unavailable: 'Only html and svg artifacts can be checked' };
}
