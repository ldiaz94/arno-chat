import { MODEL_ID, providerModel } from './account.mjs';
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
  if (MODEL_ID.test(model)) return true;
  return (
    (await catalog()).models.some(m => m.id === model) || FALLBACK_MODELS.some(m => m.id === model)
  );
}

const windows = new Map();
/** A model's context window in tokens, or null when unknown: Ollama's public
 * /api/show for Ollama models (remembered per isolate), OpenRouter's model
 * list (via the daily price tables) for the others. */
export async function contextWindow(model, upstream = fetch) {
  const { provider, id } = providerModel(model);
  if (provider !== 'ollama') return (await prices(upstream)).get(priceKey(model))?.window ?? null;
  if (windows.has(id)) return windows.get(id);
  try {
    const r = await upstream('https://ollama.com/api/show', {
      method: 'POST',
      body: JSON.stringify({ model: id }),
      signal: AbortSignal.timeout(5000),
    });
    const info = r.ok ? (await r.json()).model_info || {} : {};
    const key = Object.keys(info).find(k => k.endsWith('.context_length'));
    const window = key ? Number(info[key]) : null;
    if (r.ok) windows.set(id, window);
    return window;
  } catch {
    return null;
  }
}
