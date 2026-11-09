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

const button = $('#options-button'),
  panel = $('#options-panel'),
  form = $('#composer');
button.innerHTML = icon('sliders');

const read = key => {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
};
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
    if (value === 'fast') Object.assign(o, { effort: 'off', search: false });
    else if (was === 'fast') {
      if (o.effort === 'off') o.effort = 'auto';
      o.search = true;
    }
    if (value === 'deep') o.search = true;
  }
  if (key === 'search' && !value && o.mode === 'deep') o.mode = 'standard';
  save(o);
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
    ...(chat
      ? []
      : [
          o.approach !== 'auto' && ['approach', o.approach[0].toUpperCase() + o.approach.slice(1)],
          !o.workers && ['workers', 'No workers'],
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
  $('#opt-workers').checked = o.workers;
  for (const name of ['mode', 'effort', 'style', 'approach', 'budget'])
    for (const input of panel.querySelectorAll('input[name="' + name + '"]'))
      input.checked = input.value === o[name];
  panel.querySelector('[data-chat-only]').hidden = !chat;
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
  else if (t.id === 'opt-workers') choose('workers', t.checked);
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
