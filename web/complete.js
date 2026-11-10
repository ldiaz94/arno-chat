/** Slash-command suggestions under the composer's text: typing '/' in a coding
 * session lists the commands that match (commands.mjs); arrows or a tap pick
 * one, Tab or Enter puts it in, Escape closes. Depends on core and
 * commands.mjs.
 */
import { $, state, esc, prompt } from './core.js';
import { suggest } from './commands.mjs';

// The suggestion list, put just above the prompt.
const box = document.createElement('div');
box.id = 'command-list';
box.className = 'command-list';
box.setAttribute('role', 'listbox');
box.setAttribute('aria-label', 'Commands');
box.hidden = true;
$('#composer').prepend(box);
prompt.setAttribute('aria-controls', 'command-list');

let shown = [], // the commands listed
  at = 0; // the one picked

// Which command set applies: a coding session's or a chat's.
const kind = () => (state.session && state.session.kind !== 'chat' ? 'code' : 'chat');

// Lists the commands matching what is typed; hides the list when none do.
function render() {
  shown = suggest(prompt.value, kind());
  box.hidden = !shown.length;
  prompt.setAttribute('aria-expanded', String(!!shown.length));
  if (!shown.length) return prompt.removeAttribute('aria-activedescendant');
  at = Math.min(at, shown.length - 1);
  box.innerHTML = shown
    .map(
      ([name, hint, what, where], i) =>
        '<div role="option" id="command-' +
        name +
        '" data-command="' +
        name +
        '" aria-selected="' +
        (i === at) +
        '"><span class="command-name">/' +
        esc(name) +
        (hint ? ' <span class="command-hint">' + esc(hint) + '</span>' : '') +
        '</span><span class="command-what">' +
        esc(what) +
        (where === 'app' ? ' · this conversation’s options' : '') +
        '</span></div>',
    )
    .join('');
  prompt.setAttribute('aria-activedescendant', 'command-' + shown[at][0]);
  box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}
/** Puts the command name in the composer, with a space for its argument. */
function choose(name) {
  prompt.value = '/' + name + ' ';
  prompt.dispatchEvent(new Event('input')); // the draft and the box's height
  prompt.focus();
  box.hidden = true;
  shown = [];
}
prompt.addEventListener('input', () => {
  at = 0;
  render();
});
// Before the composer's own keys (app.js): while the list shows, the arrows
// move, Tab and Enter choose, Escape closes.
prompt.addEventListener(
  'keydown',
  e => {
    if (box.hidden || !shown.length) return;
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (move) at = (at + move + shown.length) % shown.length;
    else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) choose(shown[at][0]);
    else if (e.key === 'Escape') box.hidden = true;
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (move) render();
  },
  true,
);
// pointerdown, not click: the text keeps its focus.
box.addEventListener('pointerdown', e => {
  const item = e.target.closest('[data-command]');
  if (!item) return;
  e.preventDefault();
  choose(item.dataset.command);
});
prompt.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 150));
