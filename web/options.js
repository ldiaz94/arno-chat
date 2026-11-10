/** The composer's options (web search, mode, thinking, style; in coding
 * sessions also approach, workers and budget): the sliders
 * button, its popover, and the chips for choices that differ from the
 * defaults. Each conversation keeps its own options in localStorage
 * (`options:<id>`); a conversation without any starts from the last ones
 * used (`options:last`). Every message is sent with them (turns.js).
 * Depends on core and options.mjs.
 */
import { $, state, icon, esc } from './core.js';
import { DEFAULTS, checkOptions, optionTags } from './options.mjs';

// The options button, its popover and the composer form.
const button = $('#options-button'),
  panel = $('#options-panel'),
  form = $('#composer');
button.innerHTML = icon('sliders');

// Reads a JSON value from localStorage; null when missing or unusable.
const read = key => {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
};
// Writes a JSON value to localStorage, ignoring failure.
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
// Coding sessions have no kind; a regular chat's is 'chat'.
const kind = () => (state.session && state.session.kind !== 'chat' ? 'code' : 'chat');

/** The open conversation's options; deep research falls back to standard in
 * a coding session, and anything unreadable to the defaults. */
export function messageOptions() {
  const id = state.session?.id,
    saved = (id && read('options:' + id)) || read('options:last') || DEFAULTS,
    o = {
      ...DEFAULTS,
      ...saved,
      ...(saved.mode === 'deep' && kind() !== 'chat' && { mode: 'standard' }),
    };
  return checkOptions(o, kind()) || { ...DEFAULTS };
}
// Keeps the options as this conversation's and as the latest used.
function save(o) {
  if (state.session?.id) write('options:' + state.session.id, o);
  write('options:last', o);
  render();
}
/** Moves a chat made offline's options to the id the server gave it. */
export function moveOptions(from, to) {
  const o = read('options:' + from);
  if (o) write('options:' + to, o);
  try {
    localStorage.removeItem('options:' + from);
  } catch {}
}

/** Whether the current model's provider can honour a thinking effort: the
 * model list says so; a model missing from it is given the benefit. */
function effortAvailable() {
  const model = state.session?.model;
  return state.models.find(m => m.id === model)?.effort !== false;
}

/** One choice. Fast implies no thinking and no search (search can be turned
 * back on); leaving fast undoes what it implied; deep research needs search. */
function choose(key, value) {
  const o = { ...messageOptions(), [key]: value };
  if (key === 'mode') {
    const was = messageOptions().mode;
    if (value === 'fast') Object.assign(o, { effort: 'off', search: false, superSearch: false });
    else if (was === 'fast') {
      if (o.effort === 'off') o.effort = 'auto';
      o.search = true;
    }
    if (value === 'deep') o.search = true;
  }
  if (key === 'search' && !value) {
    if (o.mode === 'deep') o.mode = 'standard';
    o.superSearch = false;
  }
  if (key === 'superSearch' && value) o.search = true;
  save(o);
}

/** A composer line /budget, /workers or /mode, in a coding session, sets the
 * conversation's option instead of going to arno, whose own settings last
 * only the turn's process. Returns what it did, or '' for another line. */
// The three: the option each sets, how its value reads, and what it takes.
const SET = {
  budget: {
    key: 'budget',
    label: 'Budget per message',
    show: v => (v === 'auto' ? 'auto' : '$' + v),
    takes: 'A budget is auto or dollars from 0.1 to 100: /budget 2.50',
  },
  workers: {
    key: 'workers',
    label: 'Workers side by side',
    show: v => v,
    takes: 'Workers: off or 1 to 4',
  },
  mode: {
    key: 'approach',
    label: 'Approach',
    show: v => v,
    takes: 'Approach: auto, pair, build or review',
  },
};
// Applies a /budget, /workers or /mode command to the options. Returns the message to show, or
// '' when the text is not one of those.
export function optionCommand(text) {
  const m = /^\/(budget|workers|mode)(?:\s+\$?(\S+))?\s*$/.exec(text);
  if (!m || kind() === 'chat') return '';
  const set = SET[m[1]],
    raw = (m[2] || '').toLowerCase(),
    // off and none mean no limit for a budget, no workers for workers; chat is arno's auto
    value = { none: 'auto', chat: 'auto', off: set.key === 'budget' ? 'auto' : 'off' }[raw] || raw;
  if (!value) return set.label + ': ' + set.show(messageOptions()[set.key]);
  const o = checkOptions({ ...messageOptions(), [set.key]: value }, 'code');
  if (!o) return set.takes;
  save(o);
  return set.label + ': ' + set.show(value);
}
/** Paints the chips and, when open, the popover from the current options. */
export function render() {
  const o = messageOptions(),
    chat = kind() === 'chat',
    effort = effortAvailable();
  const chips = [
    o.mode !== 'standard' && ['mode', o.mode === 'fast' ? 'Fast' : 'Deep research'],
    o.style !== 'normal' && ['style', o.style === 'concise' ? 'Concise' : 'Caveman'],
    o.effort !== 'auto' && ['effort', 'Thinking: ' + o.effort],
    !o.search && ['search', 'No search'],
    chat && !o.mcp && ['mcp', 'No MCP tools'],
    chat && o.superSearch && ['superSearch', 'Super search'],
    ...(chat
      ? []
      : [
          o.approach !== 'auto' && ['approach', o.approach[0].toUpperCase() + o.approach.slice(1)],
          o.workers !== '4' && [
            'workers',
            o.workers === 'off' ? 'No workers' : 'Workers: ' + o.workers,
          ],
          o.budget !== 'auto' && ['budget', '$' + o.budget + ' budget'],
        ]),
  ].filter(Boolean);
  const box = $('#option-chips');
  box.hidden = !chips.length;
  box.innerHTML = chips
    .map(
      ([key, label]) =>
        '<span class="option-chip">' +
        esc(label) +
        '<button type="button" data-reset="' +
        key +
        '" aria-label="Remove ' +
        esc(label) +
        '">×</button></span>',
    )
    .join('');
  button.classList.toggle('active', chips.length > 0);
  button.title = chips.length ? 'Options: ' + optionTags(o).join(', ') : 'Message options';
  $('#opt-search').checked = o.search;
  $('#opt-mcp').checked = o.mcp;
  $('#opt-super').checked = o.superSearch;
  for (const name of ['mode', 'effort', 'style', 'approach', 'workers', 'budget'])
    for (const input of panel.querySelectorAll('input[name="' + name + '"]'))
      input.checked = input.value === o[name];
  for (const el of panel.querySelectorAll('[data-chat-only]')) el.hidden = !chat;
  for (const el of panel.querySelectorAll('[data-code-only]')) el.hidden = chat;
  $('#opt-approach-note').textContent = {
    auto: '',
    pair: 'Pair: plans with you, then edits in small steps',
    build: 'Build: plans, then leads workers through a larger job (up to 13 minutes)',
    review: 'Review: reports problems by severity, changes nothing',
  }[o.approach];
  for (const input of panel.querySelectorAll('input[name="effort"]')) input.disabled = !effort;
  $('#opt-effort').classList.toggle('disabled', !effort);
  $('#opt-effort-note').textContent = !effort
    ? 'Not available for this model'
    : o.mode === 'deep'
      ? 'Deep research thinks at least at medium where it can'
      : '';
  $('#opt-mode-note').textContent =
    o.mode === 'fast'
      ? 'Fast: thinking off, no web search, short answers'
      : o.mode === 'deep'
        ? 'Deep research: more searches and reads, a report saved as an artifact'
        : '';
}

// Shows or hides the options popover.
function open(show) {
  panel.hidden = !show;
  button.setAttribute('aria-expanded', String(show));
  if (show) {
    render();
    (panel.querySelector('input:checked:not(:disabled)') || $('#opt-search')).focus();
  }
}
button.onclick = () => open(panel.hidden);
panel.onchange = e => {
  const t = e.target;
  if (t.id === 'opt-search') choose('search', t.checked);
  else if (t.id === 'opt-mcp') choose('mcp', t.checked);
  else if (t.id === 'opt-super') choose('superSearch', t.checked);
  else if (t.name) choose(t.name, t.value);
};
$('#option-chips').onclick = e => {
  const key = e.target.closest('[data-reset]')?.dataset.reset;
  if (!key) return;
  // Removing Fast also brings back what it turned off.
  if (key === 'mode') choose('mode', 'standard');
  else choose(key, DEFAULTS[key]);
};
document.addEventListener('pointerdown', e => {
  if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) open(false);
});
form.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || panel.hidden) return;
  e.preventDefault();
  open(false);
  button.focus();
});
