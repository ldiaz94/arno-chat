import { MODEL_ID, TRAINS_ON_DATA, providerModel } from './account.mjs';
import { prices, priceKey } from './prices.mjs';
export const DEFAULT_MODEL = 'mistral-large-4:cloud';
export const FALLBACK_MODELS = [
  { id: DEFAULT_MODEL, name: 'Mistral Large 4 · Le Chonk' },
  { id: 'devstral-2:123b-cloud', name: 'Devstral 2 · 123B' },
  { id: 'qwen3-coder:480b-cloud', name: 'Qwen3 Coder · 480B' },
];
export async function catalog(upstream = fetch) {
  try {
    const response = await upstream('https://ollama.com/api/tags', {
      signal: AbortSignal.timeout(8000),
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!response.ok) throw Error('Catalog unavailable');
    const data = await response.json();
    const models = data.models
      .filter(
        m =>
          m.capabilities?.includes('completion') &&
          m.capabilities?.includes('tools') &&
          /^[a-z0-9][a-z0-9:._-]{0,120}$/.test(m.name),
      )
      .map(m => ({ id: m.name, name: m.name }));
    if (!models.length) throw Error('Empty catalog');
    const unique = new Map([[DEFAULT_MODEL, FALLBACK_MODELS[0]], ...models.map(m => [m.id, m])]);
    return { models: [...unique.values()], source: 'ollama', fallback: false };
  } catch {
    return { models: FALLBACK_MODELS, source: 'fallback', fallback: true };
  }
}
export async function modelAllowed(model) {
  if (TRAINS_ON_DATA.test(model)) return false;
  if (MODEL_ID.test(model)) return true;
  return (
    (await catalog()).models.some(m => m.id === model) || FALLBACK_MODELS.some(m => m.id === model)
  );
}

const shown = new Map();
/** Ollama's public /api/show for a model, {window, vision}, remembered per
 * isolate; null when it can't be read. */
async function ollamaShow(id, upstream) {
  if (shown.has(id)) return shown.get(id);
  try {
    const r = await upstream('https://ollama.com/api/show', {
      method: 'POST',
      body: JSON.stringify({ model: id }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const data = await r.json(),
      info = data.model_info || {},
      key = Object.keys(info).find(k => k.endsWith('.context_length'));
    const show = {
      window: key ? Number(info[key]) : null,
      vision: !!data.capabilities?.includes('vision'),
    };
    shown.set(id, show);
    return show;
  } catch {
    return null;
  }
}

/** A model's context window in tokens, or null when unknown: Ollama's
 * /api/show for Ollama models, OpenRouter's model list (via the daily price
 * tables) for the others. */
export async function contextWindow(model, upstream = fetch) {
  const { provider, id } = providerModel(model);
  if (provider !== 'ollama') return (await prices(upstream)).get(priceKey(model))?.window ?? null;
  return (await ollamaShow(id, upstream))?.window ?? null;
}

/** Whether a model accepts images: OpenAI, Anthropic and Gemini chat models
 * do; an Ollama model does when /api/show lists "vision". */
export async function acceptsImages(model, upstream = fetch) {
  const { provider, id } = providerModel(model);
  return provider !== 'ollama' || !!(await ollamaShow(id, upstream))?.vision;
}
