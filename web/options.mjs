/** Composer options: the choices a message is sent with, their defaults, the
 * server's strict check, and the tags a turn's footer shows. DOM-free, shared
 * by the browser (web/options.js), the worker (session-routes.mjs) and tests.
 *
 *   search  true | false                          web tools on or off
 *   effort  auto | off | low | medium | high      thinking; auto sends nothing
 *   mode    standard | fast | deep                deep: regular chats only
 *   style   normal | concise | caveman            how the answer is written
 *
 * Coding sessions only (arno's settings; regular chats keep the defaults):
 *   approach  auto | pair | build | review        arno's mode; auto is its chat
 *   workers   off | 1 | 2 | 3 | 4                 workers side by side, at most
 *   budget    auto | dollars, 0.1 to 100          what a message may spend
 *             (the panel offers 1, 3 and 10; /budget sets any)
 */
export const CHOICES = {
  search: [true, false],
  effort: ['auto', 'off', 'low', 'medium', 'high'],
  mode: ['standard', 'fast', 'deep'],
  style: ['normal', 'concise', 'caveman'],
  approach: ['auto', 'pair', 'build', 'review'],
  workers: ['off', '1', '2', '3', '4'],
  budget: ['auto', '1', '3', '10'],
};
export const DEFAULTS = {
  search: true,
  effort: 'auto',
  mode: 'standard',
  style: 'normal',
  approach: 'auto',
  workers: '4',
  budget: 'auto',
};
/** The options only a coding session has. */
export const CODE_ONLY = ['approach', 'workers', 'budget'];

/** Whether a budget is a number of dollars from 0.1 to 100, as text. */
export function budgetOk(value) {
  return (
    typeof value === 'string' &&
    /^\d{1,3}(\.\d{1,2})?$/.test(value) &&
    +value >= 0.1 &&
    +value <= 100
  );
}
/** The options as sent, with missing ones at their defaults; null when any is
 * unknown or out of range, or deep research is asked of a coding session. A
 * regular chat's coding options are put back to their defaults. */
export function checkOptions(value, kind) {
  if (value == null) return { ...DEFAULTS };
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(k => !(k in CHOICES))) return null;
  const o = { ...DEFAULTS, ...value };
  if (
    Object.entries(CHOICES).some(
      ([k, list]) => !list.includes(o[k]) && !(k === 'budget' && budgetOk(o[k])),
    )
  )
    return null;
  if (o.mode === 'deep' && kind !== 'chat') return null;
  if (kind === 'chat') for (const k of CODE_ONLY) o[k] = DEFAULTS[k];
  return o;
}

/** Short labels for a turn's non-default options. Fast implies no thinking and
 * no search, so those are not repeated beside it. */
export function optionTags(o) {
  if (!o) return [];
  const fast = o.mode === 'fast';
  return [
    fast ? 'Fast' : o.mode === 'deep' ? 'Deep research' : '',
    o.style === 'normal' ? '' : o.style[0].toUpperCase() + o.style.slice(1),
    o.effort === 'auto' || (fast && o.effort === 'off') ? '' : 'Thinking: ' + o.effort,
    o.search || fast || o.mode === 'deep' ? '' : 'No search',
    !o.approach || o.approach === 'auto' ? '' : o.approach[0].toUpperCase() + o.approach.slice(1),
    !o.workers || o.workers === '4'
      ? ''
      : o.workers === 'off'
        ? 'No workers'
        : 'Workers: ' + o.workers,
    !o.budget || o.budget === 'auto' ? '' : '$' + o.budget + ' budget',
  ].filter(Boolean);
}
