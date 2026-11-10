/** The model providers the app speaks to: each one's API, models and quirks
 * (PROVIDERS), the fields a request carries for a thinking effort and an
 * output budget (requestFields), model IDs ('provider/model', or an Ollama
 * model alone) and the models a key can list. Depends on nothing. */

/** Each provider's API: where models are listed and where chat requests go,
 * and how a streamed chat request differs between them:
 * - output: the name of the output-token limit, or none to keep the
 *   provider's default (thinking counts against Gemini's limit);
 * - usage: OpenAI's stream_options.include_usage, without which most
 *   OpenAI-compatible streams carry no usage (Mistral rejects the field and
 *   reports usage in its last chunk anyway; Anthropic has its own events);
 * - replay: thinking is sent back as reasoning_content on assistant messages,
 *   which DeepSeek requires once tools are offered (400 otherwise) and Kimi
 *   asks for (Preserved Thinking);
 * - effort: which models take a thinking effort (`models`, all when absent;
 *   Ollama's are those whose /api/show lists "thinking", see models.mjs) and
 *   the fields for a level (off, low, medium, high), each mapped to the
 *   nearest value that model accepts. Without it the choice is not offered.
 * Gemini, DeepSeek, Kimi, Mistral and Meta are reached through their
 * OpenAI-compatible endpoints. Kimi's is the international api.moonshot.ai
 * (api.moonshot.cn serves mainland China); Meta's is Meta Model API, which
 * succeeded the Llama API (api.llama.com). */
export const PROVIDERS = {
  ollama: {
    label: 'Ollama Cloud',
    base: 'https://ollama.com',
    models: '/api/tags',
    chat: '/v1/chat/completions',
    output: 'max_tokens',
    usage: true,
    // Its /v1 takes OpenAI's values; "none" turns thinking off where a model
    // can (gpt-oss can't, and ignores it).
    effort: { fields: level => ({ reasoning_effort: level === 'off' ? 'none' : level }) },
  },
  openai: {
    label: 'OpenAI',
    base: 'https://api.openai.com',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    output: 'max_completion_tokens',
    usage: true,
    // Reasoning models only: others refuse the field.
    effort: {
      models: /^(o[1-9]|gpt-5)/,
      fields: level => ({ reasoning_effort: level === 'off' ? 'minimal' : level }),
    },
  },
  anthropic: {
    label: 'Anthropic',
    base: 'https://api.anthropic.com',
    models: '/v1/models',
    chat: '/v1/messages',
    output: 'max_tokens',
    effort: { models: /^claude-(3-7|(opus|sonnet|haiku|fable|mythos)-\d)/, fields: claudeThinking },
  },
  gemini: {
    label: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com',
    models: '/v1beta/openai/models',
    chat: '/v1beta/openai/chat/completions',
    usage: true,
    effort: { models: /^gemini-(2\.5|[3-9]|flash|pro)/, fields: geminiThinking },
  },
  deepseek: {
    label: 'DeepSeek',
    base: 'https://api.deepseek.com',
    models: '/models',
    chat: '/chat/completions',
    output: 'max_tokens',
    usage: true,
    replay: true,
    // V4 models think by default; reasoning_effort takes low or high.
    effort: {
      models: /^deepseek-(v4|flash)/,
      fields: level =>
        level === 'off'
          ? { thinking: { type: 'disabled' } }
          : { reasoning_effort: level === 'low' ? 'low' : 'high' },
    },
  },
  kimi: {
    label: 'Kimi (Moonshot AI)',
    base: 'https://api.moonshot.ai',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    output: 'max_completion_tokens',
    usage: true,
    replay: true,
    // K3 models take low, high or max; they can't stop thinking.
    effort: {
      models: /^kimi-k3/,
      fields: level => ({ reasoning_effort: ['off', 'low'].includes(level) ? 'low' : 'high' }),
    },
  },
  mistral: {
    label: 'Mistral',
    base: 'https://api.mistral.ai',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    output: 'max_tokens',
    // Large 4 takes low, medium or high; Small and Medium 3.5 high or none.
    effort: {
      models: /^mistral-(large-4|small-2603|medium-3-5)/,
      fields: (level, id) => ({
        reasoning_effort: /large/.test(id)
          ? level === 'off'
            ? 'low'
            : level
          : ['off', 'low'].includes(level)
            ? 'none'
            : 'high',
      }),
    },
  },
  meta: {
    label: 'Meta Model API',
    base: 'https://api.meta.ai',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    output: 'max_completion_tokens',
    usage: true,
  },
};
/** Output tokens allowed per inference request, chat and coding alike. */
export const MAX_OUTPUT = 16384;
/** Whether a provider's model takes a thinking effort (Ollama's: see models.mjs). */
export function effortModel(provider, id) {
  const e = PROVIDERS[provider]?.effort;
  return !!e && (!e.models || e.models.test(id));
}
/** The request fields beside model, messages and tools that provider needs:
 * its output limit, usage reporting, and the turn's effort ('auto' adds none). */
export function requestFields(
  provider,
  { model = '', effort = 'auto', maxOutput = MAX_OUTPUT } = {},
) {
  const p = PROVIDERS[provider];
  return {
    ...(p.output ? { [p.output]: maxOutput } : {}),
    ...(p.usage ? { stream_options: { include_usage: true } } : {}),
    ...(effort !== 'auto' && effortModel(provider, model)
      ? p.effort.fields(effort, model, maxOutput)
      : {}),
  };
}
/** Claude 4.6 and later think adaptively at an effort; earlier models
 * (3.7, 4 to 4.5) take a token budget, which max_tokens must exceed (raised
 * to leave 8,000 for the answer, within Opus's 32,000). 'off' sends nothing:
 * thinking stays off where the model allows it. Claude 5 hides its thinking
 * unless asked for a summary. */
const BUDGET = { low: 2048, medium: 8192, high: 24000 };
function claudeThinking(level, id, maxOutput) {
  if (level === 'off') return {};
  const [, major, minor = 0] = id.match(/-(\d)(?:-(\d)(?!\d))?/) || [],
    adaptive = major >= 5 || (major == 4 && minor >= 6);
  if (!adaptive)
    return {
      thinking: { type: 'enabled', budget_tokens: BUDGET[level] },
      max_tokens: Math.max(maxOutput, BUDGET[level] + 8000),
    };
  return {
    thinking: { type: 'adaptive', ...(major >= 5 ? { display: 'summarized' } : {}) },
    output_config: { effort: level },
  };
}
/** Gemini's effort goes in thinking_config, not reasoning_effort, which the
 * API refuses beside the include_thoughts chat.mjs asks for. 2.5 takes a
 * token budget (Pro can't go to 0); later models a level (Pro can't go to
 * minimal). */
function geminiThinking(level, id) {
  const pro = /pro/.test(id);
  const config = /^gemini-2\.5/.test(id)
    ? { thinking_budget: { off: pro ? 128 : 0, low: 1024, medium: 8192, high: 24576 }[level] }
    : { thinking_level: level === 'off' ? (pro ? 'low' : 'minimal') : level };
  return { extra_body: { google: { thinking_config: config } } };
}
/** Model ids name their provider ("gemini/gemini-3.8-flash"), except Ollama's. */
export const MODEL_ID =
  /^(openai|anthropic|gemini|deepseek|kimi|mistral|meta)\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,120})$/;
/** Models whose provider trains on what you send them; the app never offers or
 * runs them. Meta's "-contributor" models are the only ones marked this way. */
export const TRAINS_ON_DATA = /^meta\/.*-contributor$/;
export function providerModel(value) {
  const m = String(value).match(MODEL_ID);
  return m ? { provider: m[1], id: m[2] } : { provider: 'ollama', id: value };
}

/** Fixed provider origins only. The caller never supplies an arbitrary API URL. */
export async function providerModels(provider, key) {
  const p = PROVIDERS[provider];
  if (!p) throw Error('Unsupported provider');
  if (provider === 'ollama') {
    // /api/tags is public, so discovery alone cannot validate a personal key.
    const check = await fetch('https://ollama.com/v1/chat/completions', {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mistral-large-4:cloud',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!check.ok) {
      await check.body?.cancel();
      throw Error('Ollama rejected the API-key test (' + check.status + ')');
    }
    await check.body?.cancel();
  }
  const headers =
    provider === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { Authorization: 'Bearer ' + key };
  const r = await fetch(p.base + p.models, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw Error(p.label + ' rejected the connection (' + r.status + ')');
  const data = await r.json();
  if (provider === 'ollama')
    return (data.models || [])
      .filter(m => m.capabilities?.includes('completion'))
      .map(m => ({ id: m.name, name: m.name }));
  // Gemini lists "models/gemini-…" and many non-chat models (speech, images, music).
  if (provider === 'gemini')
    data.data = (data.data || [])
      .map(m => ({ ...m, id: String(m.id).replace(/^models\//, '') }))
      .filter(
        m =>
          /^gemini-/.test(m.id) &&
          !/(tts|image|transcribe|robotics|omni|customtools|embedding|live|audio)/.test(m.id),
      );
  // Mistral lists embedding, OCR, moderation and audio models too, flagged by
  // capabilities; a "-latest" alias is dropped when the model it names is listed.
  if (provider === 'mistral') {
    const ids = new Set((data.data || []).map(m => m.id));
    data.data = (data.data || []).filter(
      m =>
        m.capabilities?.completion_chat &&
        !/(embed|ocr|moderation|transcribe|tts)/.test(m.id) &&
        !(/-latest$/.test(m.id) && (m.aliases || []).some(a => ids.has(a))),
    );
  }
  // Meta also lists image generation, speech and segmentation models, and
  // "-contributor" models that let Meta train on prompts: never offered.
  if (provider === 'meta')
    data.data = (data.data || []).filter(
      m => !/(image|voice|transcribe|^sam)/.test(m.id) && !TRAINS_ON_DATA.test('meta/' + m.id),
    );
  return (data.data || [])
    .filter(
      m =>
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,120}$/.test(m.id) &&
        (provider !== 'openai' ||
          (/^(gpt-|chatgpt-|o[1-9])/.test(m.id) &&
            !/(audio|realtime|transcrib|tts|image|codex|gpt-5.*-pro)/.test(m.id))),
    )
    .map(m => ({
      id: provider + '/' + m.id,
      name: p.label + ' · ' + (m.display_name || m.name || m.id),
    }));
}
