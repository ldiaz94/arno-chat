/** Model catalog: loading it, the model button and the picker dialog. Depends on core
 * and layout.
 */
import { $, state, esc, icon, modelName, api, toast, showError } from './core.js';
import { busy } from './layout.js';
import { providerMark } from './marks.js';
import { render as renderOptions } from './options.js';
/** The provider that serves (and bills) a model id; ids without a prefix are Ollama's. */
export function providerOf(id) {
  const prefix = String(id).split('/')[0];
  return String(id).includes('/') &&
    ['openai', 'anthropic', 'gemini', 'deepseek', 'kimi', 'mistral', 'meta'].includes(prefix)
    ? prefix
    : 'ollama';
}
/** A model's provider mark followed by its name, as markup. */
export function modelLabel(id) {
  return providerMark(providerOf(id), 16) + '<span>' + esc(modelName(id)) + '</span>';
}
const FALLBACK = 'mistral-large-4:cloud'; // when nothing else names a model
/** The model a new chat or coding session starts with: the one picked on the
 * home page, else the profile's default model. */
export const startModel = () => state.selectedModel || state.profile.defaultModel || FALLBACK;
// Loads the model catalog from the server into state.models.
export async function loadModels() {
  try {
    const d = await api('/api/models');
    state.models = d.models;
    state.fallback = d.fallback;
    if (d.fallback) toast('Live model catalog unavailable. Showing saved models.');
  } catch {
    state.models = [{ id: FALLBACK, name: 'Mistral Large 4 · Le Chonk' }];
  }
}
// Shows the open conversation's model (or the one a new one would use) on the model button.
export function modelButton() {
  const id = state.session?.model || startModel();
  $('#model-button').innerHTML = modelLabel(id) + '<span aria-hidden="true">⌄</span>';
}
/** A setting's pick in progress (pickModel): {current, blank, only, resolve}. */
let pending = null;
// Opens the model picker for a target: a session id, or 'new' for the next new conversation.
export function openModels(target) {
  if (state.busy) return;
  state.modelTarget = target;
  pending = null;
  showPicker('Choose your model', 'Changing models keeps your repository and conversation.');
}
/** Opens the model picker for a setting: current is its value, blank an
 * ['', label] choice for none (or null), only a filter of the models it may
 * be. Resolves to the id picked, or null when closed without one. */
export function pickModel({ title, current = '', blank = null, only = () => true, caption = '' }) {
  return new Promise(resolve => {
    pending = { current, blank, only, resolve };
    showPicker(title, caption);
  });
}
function showPicker(title, caption) {
  $('#model-heading').textContent = title;
  const note = $('#model-dialog .caption');
  note.textContent = caption;
  note.hidden = !caption;
  $('#model-search').value = '';
  renderModels();
  $('#model-dialog').showModal();
  $('#model-search').focus();
}
$('#model-dialog').addEventListener('close', () => {
  pending?.resolve(null);
  pending = null;
});
// Lists the models that match the picker's search box.
export function renderModels() {
  const q = $('#model-search').value.toLowerCase(),
    current = pending ? pending.current : state.session?.model || startModel(),
    listed = pending ? state.models.filter(pending.only) : state.models;
  const models =
    !current || listed.some(m => m.id === current)
      ? listed
      : [{ id: current, name: current }, ...listed];
  const option = (id, label) =>
    '<button class="model-option ' +
    (id === current ? 'selected' : '') +
    '" data-model="' +
    esc(id) +
    '"><span class="model-id">' +
    label +
    '</span>' +
    (id === current ? icon('check') : '') +
    '</button>';
  const blank = pending?.blank;
  $('#model-options').innerHTML =
    (blank && blank[1].toLowerCase().includes(q) ? option('', esc(blank[1])) : '') +
      models
        .filter(m => (m.id + ' ' + m.name).toLowerCase().includes(q))
        .map(m => option(m.id, modelLabel(m.id)))
        .join('') || '<p class="empty">No matching models.</p>';
}
// Applies a picked model to the picker's target; offline it does nothing.
export async function chooseModel(id) {
  if (pending) {
    const { resolve } = pending;
    pending = null;
    $('#model-dialog').close();
    return resolve(id);
  }
  $('#model-dialog').close();
  if (state.offline) return toast('Reconnect to send');
  if (!state.session) {
    state.selectedModel = id;
    $('#home-model').innerHTML = modelLabel(id);
    return;
  }
  // A draft chat isn't on the server yet: it is made with the model picked.
  if (state.session.draft) {
    state.session.model = id;
    modelButton();
    return renderOptions();
  }
  const sid = state.session.id;
  busy(true);
  toast('Saving model selection…');
  try {
    const d = await api('/api/sessions/' + sid + '/model', {
      method: 'POST',
      body: JSON.stringify({ model: id }),
    });
    if (state.session?.id === sid) {
      state.session.model = d.model;
      modelButton();
      renderOptions();
      toast('Model updated for the next turn');
    }
  } catch (e) {
    showError(e);
  } finally {
    busy(false);
  }
}
