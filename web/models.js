/** Model catalog: loading it, the model button and the picker dialog. Depends on core
 * and layout.
 */
import { $, state, esc, icon, modelName, api, toast, showError } from './core.js';
import { busy } from './layout.js';
import { providerMark } from './marks.js';
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
export async function loadModels() {
  try {
    const d = await api('/api/models');
    state.models = d.models;
    state.fallback = d.fallback;
    if (d.fallback) toast('Live model catalog unavailable. Showing saved models.');
  } catch {
    state.models = [{ id: 'mistral-large-4:cloud', name: 'Mistral Large 4 · Le Chonk' }];
  }
}
export function modelButton() {
  const id = state.session?.model || state.selectedModel || 'mistral-large-4:cloud';
  $('#model-button').innerHTML = modelLabel(id) + '<span aria-hidden="true">⌄</span>';
}
export function openModels(target) {
  if (state.busy) return;
  state.modelTarget = target;
  $('#model-search').value = '';
  renderModels();
  $('#model-dialog').showModal();
  $('#model-search').focus();
}
export function renderModels() {
  const q = $('#model-search').value.toLowerCase(),
    current = state.session?.model || state.selectedModel || 'mistral-large-4:cloud';
  const models = state.models.some(m => m.id === current)
    ? state.models
    : [{ id: current, name: current }, ...state.models];
  $('#model-options').innerHTML =
    models
      .filter(m => (m.id + ' ' + m.name).toLowerCase().includes(q))
      .map(
        m =>
          '<button class="model-option ' +
          (m.id === current ? 'selected' : '') +
          '" data-model="' +
          esc(m.id) +
          '"><span class="model-id">' +
          modelLabel(m.id) +
          '</span>' +
          (m.id === current ? icon('check') : '') +
          '</button>',
      )
      .join('') || '<p class="empty">No matching models.</p>';
}
export async function chooseModel(id) {
  $('#model-dialog').close();
  if (!state.session) {
    state.selectedModel = id;
    $('#home-model').innerHTML = modelLabel(id);
    return;
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
      toast('Model updated for the next turn');
    }
  } catch (e) {
    showError(e);
  } finally {
    busy(false);
  }
}
