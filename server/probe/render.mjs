/** Rendering an artifact's page in a real browser, to see what the user will
 * see: Cloudflare Browser Rendering (the BROWSER binding) through
 * @cloudflare/puppeteer.
 *
 *   html ─► https://artifact.invalid/ (answered from memory, under the page's
 *           own policy) ─► the CDNs and images it loads, from the network
 *        ─► page errors, console errors, failed loads, policy violations
 *        ─► steps, if any (set a value, click, tap, drag, key, wait, scroll)
 *        ─► a JPEG screenshot at phone size (or the viewport asked for)
 *
 * The page runs under PAGE_POLICY from artifacts.mjs, sandbox and all, as in
 * the app, so what is blocked there is blocked here. Rendering is a check, not
 * a step a write depends on: with no binding, or on any failure, the result
 * is {unavailable}. Steps let a check see another state of the page without
 * changing its defaults. Depends on artifacts.mjs. Leaves out Mermaid
 * diagrams, and typing text other than by setting a field's value. */
import { MAX_STEPS, PAGE_POLICY } from './artifacts.mjs';

/** Where the page seems to come from: a name that never resolves, so every
 * request to it is ours to answer. */
const ORIGIN = 'https://artifact.invalid',
  PAGE_URL = ORIGIN + '/';
/** A phone's screen, in CSS pixels, at one device pixel each (a small image). */
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
/** A laptop's screen, for a look at the page wide. */
export const WIDE = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
};
/** How long to wait for the page and its loads to settle, then for its
 * opening animations, and for the whole check, in ms. */
const LOAD_MS = 8000,
  SETTLE_MS = 1500,
  TOTAL_MS = 15000;
/** The longest single wait step and all of them together, the settle after
 * the steps, and the whole check when it has steps, in ms. */
const STEP_WAIT_MS = 3000,
  WAITS_MS = 5000,
  STEPS_SETTLE_MS = 800,
  STEPS_TOTAL_MS = 20000;
/** JPEG quality of the screenshot: enough to read the page, small to send. */
const QUALITY = 55;
/** Most entries kept of each list, and the characters of each. */
const MAX_ITEMS = 20,
  ITEM_LENGTH = 300;
/** Run in the page before its own scripts: what the policy blocks becomes a
 * console error, which is collected with the rest. */
const POLICY_LISTENER =
  "document.addEventListener('securitypolicyviolation',e=>console.error('Blocked by the page policy: '+e.blockedURI+' ('+e.effectiveDirective+')'))";

/** Opens html in a headless browser at phone size (or at viewport, e.g.
 * WIDE), takes steps (see takeStep) if given, and reports what went wrong:
 * {errors, failedLoads: [{url, status}], screenshot (base64 JPEG), ms}, plus
 * stepErrors: [{step, error}] when there were steps, or {unavailable: why}.
 * launch stands in for the browser in tests. */
export async function renderPage(env, html, { launch, steps = [], viewport = VIEWPORT } = {}) {
  const began = Date.now();
  if (!launch) {
    if (!env?.BROWSER) return { unavailable: 'No browser to render with' };
    launch = async () => (await import('@cloudflare/puppeteer')).default.launch(env.BROWSER);
  }
  steps = steps.slice(0, MAX_STEPS);
  const errors = new Set(),
    failed = new Map(),
    stepErrors = [];
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
    await page.setViewport(viewport);
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
    await sleep(SETTLE_MS);
    if (steps.length) {
      // A step that fails is reported, and the rest still run.
      const budget = { waits: WAITS_MS };
      for (const [i, step] of steps.entries())
        await takeStep(page, step, budget).catch(e =>
          stepErrors.push({ step: i, error: String(e.message).slice(0, ITEM_LENGTH) }),
        );
      await sleep(STEPS_SETTLE_MS);
    }
    return page.screenshot({ type: 'jpeg', quality: QUALITY, encoding: 'base64' });
  })();
  const close = () => browser?.close().catch(() => {});
  try {
    const screenshot = await Promise.race([
      work,
      new Promise((_, fail) => {
        const ms = steps.length ? STEPS_TOTAL_MS : TOTAL_MS;
        timer = setTimeout(() => fail(Error('Rendering took too long')), ms);
      }),
    ]);
    await close();
    const result = {
      errors: [...errors],
      failedLoads: [...failed].map(([url, status]) => ({ url: url.slice(0, ITEM_LENGTH), status })),
      screenshot,
      ms: Date.now() - began,
      ...(steps.length && { stepErrors }),
    };
    console.log(
      JSON.stringify({
        event: 'artifact_check',
        ms: result.ms,
        errors: result.errors.length,
        failed: result.failedLoads.length,
        steps: steps.length,
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
/** Takes one step on page, in viewport coordinates where it has them:
 * {set: selector, value} sets a field's value and sends input and change;
 * {click: selector}; {tap: [x, y]}; {drag: [x1, y1, x2, y2]} with the mouse;
 * {key: name}; {wait: ms}, drawn from budget.waits; {scroll: y}. Throws on a
 * selector that matches nothing or a step it does not know. */
async function takeStep(page, step, budget) {
  if ('set' in step)
    return (await found(page, step.set)).evaluate(
      (el, value) => {
        // Through the prototype's setter, so frameworks that track it see it.
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      String(step.value ?? ''),
    );
  if ('click' in step) return (await found(page, step.click)).click();
  if ('tap' in step) return page.touchscreen.tap(...numbers(step.tap, 2));
  if ('drag' in step) {
    const [x1, y1, x2, y2] = numbers(step.drag, 4);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 10 });
    return page.mouse.up();
  }
  if ('key' in step) return page.keyboard.press(String(step.key));
  if ('wait' in step) {
    const ms = Math.max(0, Math.min(Number(step.wait) || 0, STEP_WAIT_MS, budget.waits));
    budget.waits -= ms;
    return sleep(ms);
  }
  if ('scroll' in step)
    return page.evaluate(y => globalThis.scrollTo(0, y), Number(step.scroll) || 0);
  throw Error('Unknown step ' + JSON.stringify(step).slice(0, 80));
}
/** The element selector picks on page; throws when there is none. */
async function found(page, selector) {
  const el = await page.$(String(selector));
  if (!el) throw Error('Nothing matches ' + selector);
  return el;
}
/** list as n numbers; throws unless it is one. */
function numbers(list, n) {
  if (!Array.isArray(list) || list.length !== n || !list.every(Number.isFinite))
    throw Error('Expected ' + n + ' numbers');
  return list;
}
/** Resolves after ms. */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
