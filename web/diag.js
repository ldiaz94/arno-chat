/** Layout diagnostics: a small overlay listing the viewport measurements, for
 * debugging the app installed on a phone, where there are no developer tools.
 * Part of Developer mode (You tab), with a copyable debug report; both are
 * remembered on this device. Depends on nothing.
 */
const KEY = 'arno:diagnostics',
  DEVELOPER = 'arno:developer';
// Whether a flag is set in localStorage; false when storage is unavailable.
const stored = key => {
  try {
    return !!localStorage.getItem(key);
  } catch {
    return false;
  }
};
// Sets or clears a flag in localStorage.
const store = (key, on) => {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // private mode: lasts for this visit only
  }
};

/** Developer mode shows the debugging tools in the You tab; off, they hide
 * and the overlay goes. Remembered on this device. */
export const developerOn = () => stored(DEVELOPER);
// Turns Developer mode on or off; off also hides the overlay.
export function setDeveloper(on) {
  store(DEVELOPER, on);
  if (!on) diagnostics(false);
}

/** Text for a bug report: the layout measurements plus the app's state. */
export async function debugReport() {
  const caches_ = await (window.caches?.keys() || Promise.resolve([]));
  return [
    ...measure().map(([k, v]) => k + ': ' + v),
    'online: ' + navigator.onLine,
    'service worker: ' + (navigator.serviceWorker?.controller ? 'active' : 'none'),
    'caches: ' + caches_.join(', '),
    'theme: ' + (document.body.classList.contains('light') ? 'light' : 'dark'),
    'agent: ' + navigator.userAgent,
    'at: ' + new Date().toISOString(),
  ].join('\n');
}
// The overlay element and its refresh timer, while shown.
let box = null,
  timer = null;

/** Size and computed style of a throwaway fixed element styled with css. */
function probe(css) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;left:0;top:0;' + css;
  document.body.append(d);
  const rect = d.getBoundingClientRect(),
    style = getComputedStyle(d),
    padding = [style.paddingTop, style.paddingBottom];
  d.remove();
  return { rect, padding };
}

/** Where an element's top and bottom are, or '-'. */
function span(selector) {
  const r = document.querySelector(selector)?.getBoundingClientRect();
  return r ? Math.round(r.top) + '→' + Math.round(r.bottom) : '-';
}

// The measurements the overlay lists, as [name, value] pairs.
function measure() {
  const v = window.visualViewport,
    units = u => Math.round(probe('height:100' + u).rect.height),
    insets = probe(
      'padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom) 0;height:0',
    ).padding;
  return [
    ['mode', matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'],
    ['iOS', navigator.userAgent.match(/OS (\d+[_\d]*)/)?.[1]?.replace(/_/g, '.') || '-'],
    ['screen', screen.width + '×' + screen.height + ' @' + devicePixelRatio + 'x'],
    ['avail', screen.availHeight + (navigator.standalone ? ' (home screen)' : '')],
    ['inner', innerWidth + '×' + innerHeight],
    [
      'client scroll',
      document.documentElement.clientHeight + ' ' + document.documentElement.scrollHeight,
    ],
    ['visual', v ? Math.round(v.height) + ' at ' + Math.round(v.offsetTop) : '-'],
    // Scrolled or zoomed behind the fixed layout, taps miss (layout.js settle).
    [
      'scroll zoom',
      Math.round(scrollX) +
        ',' +
        Math.round(scrollY) +
        ' ×' +
        (v
          ? v.scale.toFixed(2) + ' at ' + Math.round(v.offsetLeft) + ',' + Math.round(v.offsetTop)
          : '-'),
    ],
    [
      'orientation',
      screen.orientation?.type ||
        (matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape'),
    ],
    ['vh dvh lvh svh', [units('vh'), units('dvh'), units('lvh'), units('svh')].join(' ')],
    ['insets top bottom', insets.join(' ')],
    ['shell', span('#shell')],
    ['top bar', span('.topbar')],
    ['composer', span('#composer-wrap')],
    [
      'html body',
      [document.documentElement, document.body].map(e => getComputedStyle(e).height).join(' '),
    ],
  ];
}

// Redraws the overlay.
function render() {
  if (box)
    box.innerHTML = measure()
      .map(([k, v]) => '<div><b>' + k + '</b> ' + v + '</div>')
      .join('');
}

/** Turns the overlay on or off, and remembers the choice on this device. */
export function diagnostics(on) {
  store(KEY, on);
  if (!on) {
    box?.remove();
    box = null;
    clearInterval(timer);
    return;
  }
  if (box) return;
  box = document.createElement('div');
  box.className = 'diagnostics';
  document.body.append(box);
  render();
  timer = setInterval(render, 1000);
}

// Whether the overlay is showing.
export const diagnosticsOn = () => !!box;

/** Shows the overlay at start when it was left on. */
export function startDiagnostics() {
  if (developerOn() && stored(KEY)) diagnostics(true);
}
