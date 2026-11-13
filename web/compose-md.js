/** Markdown colouring in the composer: a backdrop behind the textarea shows the same text
 * with code blocks, `code`, headings, bold and quotes coloured (composerHtml in render.mjs).
 * The textarea's own text is transparent, so the backdrop shows through; both use the same
 * font, padding and wrapping, so every glyph sits exactly under its twin. Depends on core and
 * render.mjs. Leaves out anything that would change glyph widths (bold, monospace).
 */
import { prompt } from './core.js';
import { composerHtml } from './render.mjs';

// The backdrop, in a box that wraps the textarea.
const box = document.createElement('div'),
  back = document.createElement('div');
box.className = 'prompt-box';
back.className = 'prompt-back';
back.setAttribute('aria-hidden', 'true');
prompt.before(box);
box.append(back, prompt);

// Redraws the backdrop from the textarea's text and scroll position.
function sync() {
  back.innerHTML = composerHtml(prompt.value);
  back.scrollTop = prompt.scrollTop;
}
prompt.addEventListener('input', sync);
prompt.addEventListener('scroll', () => (back.scrollTop = prompt.scrollTop));
// Text set from code (drafts, suggestions, a cleared box) fires no input event: catch it.
const { get, set } = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
Object.defineProperty(prompt, 'value', {
  get,
  set(v) {
    set.call(this, v);
    sync();
  },
});
// The textarea grows with its text: keep the scroll in step after each resize.
new ResizeObserver(() => (back.scrollTop = prompt.scrollTop)).observe(prompt);
sync();
