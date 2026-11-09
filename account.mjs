/** Account preferences and envelope encryption.
 * Provider/MCP secrets are encrypted with AES-GCM and user/field-bound AAD.
 * Only masked connection metadata is ever returned by public GET routes.
 */
import { publicWebUrl, searxngSearch } from './web.mjs';
/** Each provider's API: where models are listed and where chat requests go,
 * and how a streamed chat request differs between them:
 * - output: the name of the output-token limit, or none to keep the
 *   provider's default (thinking counts against Gemini's limit);
 * - usage: OpenAI's stream_options.include_usage, without which most
 *   OpenAI-compatible streams carry no usage (Mistral rejects the field and
 *   reports usage in its last chunk anyway; Anthropic has its own events);
 * - replay: thinking is sent back as reasoning_content on assistant messages,
 *   which DeepSeek requires once tools are offered (400 otherwise) and Kimi
 *   asks for (Preserved Thinking).
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
  },
  openai: {
    label: 'OpenAI',
    base: 'https://api.openai.com',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    output: 'max_completion_tokens',
    usage: true,
  },
  anthropic: {
    label: 'Anthropic',
    base: 'https://api.anthropic.com',
    models: '/v1/models',
    chat: '/v1/messages',
    output: 'max_tokens',
  },
  gemini: {
    label: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com',
    models: '/v1beta/openai/models',
    chat: '/v1beta/openai/chat/completions',
    usage: true,
  },
  deepseek: {
    label: 'DeepSeek',
    base: 'https://api.deepseek.com',
    models: '/models',
    chat: '/chat/completions',
    output: 'max_tokens',
    usage: true,
    replay: true,
  },
  kimi: {
    label: 'Kimi (Moonshot AI)',
    base: 'https://api.moonshot.ai',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    output: 'max_completion_tokens',
    usage: true,
    replay: true,
  },
  mistral: {
    label: 'Mistral',
    base: 'https://api.mistral.ai',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    output: 'max_tokens',
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
/** The request fields beside model, messages and tools that provider needs. */
export function requestFields(provider) {
  const p = PROVIDERS[provider];
  return {
    ...(p.output ? { [p.output]: MAX_OUTPUT } : {}),
    ...(p.usage ? { stream_options: { include_usage: true } } : {}),
  };
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
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function encryptionKey(env) {
  if (!env.ACCOUNT_ENCRYPTION_KEY) throw Error('Account encryption is not configured');
  return crypto.subtle.importKey('raw', bytes(env.ACCOUNT_ENCRYPTION_KEY), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
export async function seal(env, userId, field, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    key = await encryptionKey(env);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(userId + ':' + field) },
    key,
    new TextEncoder().encode(value),
  );
  return { iv: b64(iv), value: b64(new Uint8Array(encrypted)) };
}
export async function unseal(env, userId, field, record) {
  if (!record) return '';
  const key = await encryptionKey(env),
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes(record.iv),
        additionalData: new TextEncoder().encode(userId + ':' + field),
      },
      key,
      bytes(record.value),
    );
  return new TextDecoder().decode(plain);
}
export async function profile(env, userId) {
  if (!userId) return { systemPrompt: '', skills: [], mcp: [], keys: {}, models: [] };
  const r = await env.PROBE.getByName('profile:' + userId).fetch('https://internal/profile/get');
  return r.json();
}
export function instructions(p) {
  return [
    p.about ? 'About the user:\n' + p.about : '',
    p.systemPrompt || '',
    ...(p.skills || []).filter(s => s.enabled).map(s => 'Skill: ' + s.name + '\n' + s.content),
  ]
    .filter(Boolean)
    .join('\n\n');
}
export async function credential(env, userId, p, provider) {
  const own = await unseal(env, userId, 'provider:' + provider, p.keys?.[provider]);
  return own || (provider === 'ollama' ? env.OLLAMA_API_KEY || '' : '');
}
export function publicProfile(env, p) {
  return {
    systemPrompt: p.systemPrompt || '',
    about: p.about || '',
    updatedAt: p.updatedAt || 0, // when preferences were last saved; offline edits compare it
    skills: p.skills || [],
    models: p.models || [],
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([id, v]) => [
        id,
        {
          label: v.label,
          saved: !!p.keys?.[id],
          available: !!p.keys?.[id] || (id === 'ollama' && !!env.OLLAMA_API_KEY),
        },
      ]),
    ),
    mcp: (p.mcp || []).map(({ token, ...m }) => ({ ...m, hasToken: !!token })),
    search: p.search
      ? {
          url: p.search.url,
          auth: p.search.auth,
          clientId: p.search.clientId || '',
          hasSecret: !!p.search.secret,
        }
      : null,
  };
}
/** The account's own SearXNG, with its secret unsealed, or null. */
export async function searchConnection(env, userId, p) {
  if (!p.search) return null;
  const { secret, ...rest } = p.search;
  return { ...rest, secret: await unseal(env, userId, 'search:secret', secret) };
}
/** Checks and seals a search connection; a blank secret keeps the saved one
 * while the URL and auth type stay the same. */
async function searchRecord(env, userId, body, old) {
  const url = typeof body.url === 'string' ? body.url.trim().replace(/\/+$/, '') : '';
  if (url.length > 500 || !validMcpUrl(url))
    throw Error('SearXNG needs a public HTTPS URL without credentials or query parameters');
  if (!['none', 'access', 'bearer'].includes(body.auth)) throw Error('Unknown authentication type');
  const line = (v, max) => typeof v === 'string' && v.length <= max && !/[\r\n]/.test(v);
  if (body.secret && !line(body.secret, 2000))
    throw Error('The secret must be a single line up to 2,000 characters');
  if (body.auth === 'access' && !(line(body.clientId, 200) && body.clientId.trim()))
    throw Error('Cloudflare Access needs the service token Client ID');
  const keep = old && old.url === url && old.auth === body.auth ? old.secret : null,
    secret = body.secret
      ? await seal(env, userId, 'search:secret', body.secret.trim())
      : body.auth === 'none'
        ? null
        : keep;
  if (body.auth !== 'none' && !secret)
    throw Error(body.auth === 'access' ? 'Paste the Client Secret' : 'Paste the bearer token');
  return {
    url,
    auth: body.auth,
    clientId: body.auth === 'access' ? body.clientId.trim() : undefined,
    secret,
  };
}
/** MCP servers and SearXNG: public HTTPS without credentials, query or fragment. */
export function validMcpUrl(value) {
  if (!publicWebUrl(value)) return false;
  const u = new URL(value);
  return u.protocol === 'https:' && !u.search && !u.hash;
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
export async function accountRoute(request, env, userId) {
  const u = new URL(request.url),
    p = await profile(env, userId),
    object = env.PROBE.getByName('profile:' + userId);
  const save = patch =>
    object.fetch('https://internal/profile/patch', { method: 'POST', body: JSON.stringify(patch) });
  if (request.method === 'GET') return Response.json(publicProfile(env, p));
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 64000)
    return Response.json({ error: 'Account settings are too large' }, { status: 413 });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'Invalid settings' }, { status: 400 });
  }
  try {
    if (u.pathname.endsWith('/key')) {
      if (!PROVIDERS[body.provider]) throw Error('Unsupported provider');
      if (
        body.key !== null &&
        (typeof body.key !== 'string' ||
          body.key.length < 10 ||
          body.key.length > 500 ||
          /[\r\n]/.test(body.key))
      )
        throw Error('Enter a valid API key');
      const encrypted =
        body.key === null
          ? null
          : await seal(env, userId, 'provider:' + body.provider, body.key.trim());
      await object.fetch('https://internal/profile/key', {
        method: 'POST',
        body: JSON.stringify({ provider: body.provider, value: encrypted }),
      });
    } else if (u.pathname.endsWith('/search')) {
      await save({ search: body.remove ? null : await searchRecord(env, userId, body, p.search) });
    } else if (u.pathname.endsWith('/search-test')) {
      const search = await searchConnection(env, userId, p);
      if (!search) throw Error('Save a SearXNG connection first');
      const start = Date.now(),
        results = await searxngSearch(search, 'searxng');
      return Response.json({ ok: true, results: results.length, ms: Date.now() - start });
    } else if (u.pathname.endsWith('/test')) {
      const key = await credential(env, userId, p, body.provider);
      if (!key) throw Error('Save an API key first');
      const models = await providerModels(body.provider, key);
      return Response.json({ ok: true, models: models.length });
    } else {
      if (typeof body.systemPrompt !== 'string' || body.systemPrompt.length > 12000)
        throw Error('System prompt must be at most 12,000 characters');
      const about = body.about ?? p.about ?? '';
      if (typeof about !== 'string' || about.length > 2000)
        throw Error('About you must be at most 2,000 characters');
      if (!Array.isArray(body.skills) || body.skills.length > 10)
        throw Error('At most 10 skills are supported');
      const skills = body.skills.map(s => {
        if (
          typeof s.name !== 'string' ||
          s.name.length > 80 ||
          typeof s.content !== 'string' ||
          s.content.length > 4000
        )
          throw Error('Each skill needs a name and up to 4,000 instruction characters');
        return { name: s.name, content: s.content, enabled: !!s.enabled };
      });
      if (!Array.isArray(body.mcp) || body.mcp.length > 6)
        throw Error('At most 6 remote MCP connections are supported');
      const mcp = [];
      for (const c of body.mcp) {
        if (c.id === 'web' || !/^[a-z][a-z0-9_-]{0,29}$/.test(c.id) || !validMcpUrl(c.url))
          throw Error(
            'MCP needs a short lowercase ID (web is reserved) and a public HTTPS URL without credentials/query parameters',
          );
        const old = p.mcp?.find(m => m.id === c.id);
        if (
          c.token &&
          (typeof c.token !== 'string' || c.token.length > 2000 || /[\r\n]/.test(c.token))
        )
          throw Error('MCP token must be a single line up to 2,000 characters');
        const token = c.clearToken
          ? null
          : c.token
            ? await seal(env, userId, 'mcp:' + c.id, c.token)
            : old?.token || null;
        mcp.push({
          id: c.id,
          name: String(c.name || c.id).slice(0, 80),
          url: c.url,
          enabled: !!c.enabled,
          token,
        });
      }
      if (new Set(mcp.map(m => m.id)).size !== mcp.length) throw Error('MCP IDs must be unique');
      const models = (body.models || []).slice(0, 20).map(m => {
        if (TRAINS_ON_DATA.test(m.id))
          throw Error('Models that let the provider train on your data are not allowed');
        if (!MODEL_ID.test(m.id))
          throw Error(
            'Custom model IDs start with a provider: openai/, anthropic/, gemini/, deepseek/, kimi/, mistral/ or meta/',
          );
        return { id: m.id, name: String(m.name || m.id).slice(0, 120) };
      });
      await save({
        systemPrompt: body.systemPrompt,
        about,
        skills,
        mcp,
        models,
        updatedAt: Date.now(),
      });
    }
    return Response.json(publicProfile(env, await profile(env, userId)));
  } catch (e) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
