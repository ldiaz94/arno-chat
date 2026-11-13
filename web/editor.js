/** The full-screen editor for long Markdown fields (skills, the account
 * system prompt): the source and how it reads side by side on a wide
 * screen, one at a time with a switch on a phone. It edits a copy and
 * writes it back to the field it was opened from when it closes, however
 * it closes, so nothing typed is lost; the field's own input event tells
 * its owner. */
import { markdown } from './render.mjs';

// The dialog, made the first time it is needed, and the field it edits.
let dialog, field;

// The source, the preview and the switch between them, in the dialog.
const part = selector => dialog.querySelector(selector);

// Shows the source ('edit') or the preview ('preview'); on a wide screen
// both show, and only the switch's label changes.
function setMode(mode) {
  dialog.dataset.mode = mode;
  part('.text-editor-mode').textContent = mode === 'edit' ? 'Preview' : 'Edit';
  if (mode === 'edit') part('textarea').focus();
}

// The preview, made again from the source.
function refresh() {
  part('.text-editor-preview').innerHTML = markdown(part('textarea').value);
}

// The source, back into the field, if it changed.
function writeBack() {
  const text = part('textarea').value;
  if (field.value === text) return;
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

// Makes the dialog and wires it.
function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'modal text-editor';
  dialog.setAttribute('aria-labelledby', 'text-editor-title');
  dialog.innerHTML =
    '<div class="modal-head"><h2 id="text-editor-title"></h2><div class="text-editor-tools">' +
    '<button type="button" class="ghost text-editor-mode"></button>' +
    '<button type="button" class="primary text-editor-done">Done</button></div></div>' +
    '<div class="text-editor-body"><textarea class="field" aria-label="Markdown source"></textarea>' +
    '<div class="prose text-editor-preview"></div></div>';
  part('textarea').oninput = refresh;
  part('.text-editor-mode').onclick = () =>
    setMode(dialog.dataset.mode === 'edit' ? 'preview' : 'edit');
  part('.text-editor-done').onclick = () => dialog.close();
  dialog.addEventListener('close', writeBack);
  document.body.append(dialog);
}

/** Opens the editor on a textarea, titled title: on its preview if it
 * has text, ready to type if it is empty. */
export function openEditor(textarea, title) {
  if (!dialog) build();
  field = textarea;
  part('h2').textContent = title;
  const source = part('textarea');
  source.maxLength = textarea.maxLength;
  source.placeholder = textarea.placeholder;
  source.value = textarea.value;
  refresh();
  dialog.showModal();
  setMode(textarea.value ? 'preview' : 'edit');
}
