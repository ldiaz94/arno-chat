/** Layout diagnostics: a small overlay listing the viewport measurements, for
 * debugging the app installed on a phone, where there are no developer tools.
 * Switched on from the You tab and remembered on this device. Depends on
 * nothing.
 */
const KEY = 'arno:diagnostics';
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

function render() {
  if (box)
    box.innerHTML = measure()
      .map(([k, v]) => '<div><b>' + k + '</b> ' + v + '</div>')
      .join('');
}

/** Turns the overlay on or off, and remembers the choice on this device. */
export function diagnostics(on) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: the overlay still shows for this visit
  }
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

export const diagnosticsOn = () => !!box;

/** Shows the overlay at start when it was left on. */
export function startDiagnostics() {
  try {
    if (localStorage.getItem(KEY)) diagnostics(true);
  } catch {
    // no storage: stays off
  }
}
