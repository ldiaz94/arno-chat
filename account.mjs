/** Account preferences and envelope encryption.
 * Provider/MCP secrets are encrypted with AES-GCM and user/field-bound AAD.
 * Only masked connection metadata is ever returned by public GET routes.
 */
/** Each provider's API: where models are listed and where chat requests go.
 * Gemini is reached through its OpenAI-compatible endpoint. */
export const PROVIDERS = {
  ollama: {
    label: 'Ollama Cloud',
    base: 'https://ollama.com',
    models: '/api/tags',
    chat: '/v1/chat/completions',
  },
  openai: {
    label: 'OpenAI',
    base: 'https://api.openai.com',
    models: '/v1/models',
    chat: '/v1/chat/completions',
  },
  anthropic: {
    label: 'Anthropic',
    base: 'https://api.anthropic.com',
    models: '/v1/models',
    chat: '/v1/messages',
  },
  gemini: {
    label: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com',
    models: '/v1beta/openai/models',
    chat: '/v1beta/openai/chat/completions',
  },
};
/** Model ids name their provider ("gemini/gemini-3.8-flash"), except Ollama's. */
export const MODEL_ID = /^(openai|anthropic|gemini)\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,120})$/;
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
  };
}
export function validMcpUrl(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.hostname.includes('.') &&
      !/^[\d.]+$/.test(u.hostname) &&
      !u.hostname.includes(':') &&
      !/(^|\.)(localhost|local|internal|invalid|test)$/.test(u.hostname)
    );
  } catch {
    return false;
  }
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
  return (data.data || [])
    .filter(
      m =>
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,120}$/.test(m.id) &&
        (provider !== 'openai' ||
          (/^(gpt-|chatgpt-|o[1-9])/.test(m.id) &&
            !/(audio|realtime|transcrib|tts|image|codex|gpt-5.*-pro)/.test(m.id))),
    )
    .map(m => ({ id: provider + '/' + m.id, name: p.label + ' · ' + (m.display_name || m.id) }));
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
    } else if (u.pathname.endsWith('/test')) {
      const key = await credential(env, userId, p, body.provider);
      if (!key) throw Error('Save an API key first');
      const models = await providerModels(body.provider, key);
      return Response.json({ ok: true, models: models.length });
    } else {
      if (typeof body.systemPrompt !== 'string' || body.systemPrompt.length > 12000)
        throw Error('System prompt must be at most 12,000 characters');
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
        if (!MODEL_ID.test(m.id))
          throw Error('Custom model IDs use openai/, anthropic/ or gemini/ before the model id');
        return { id: m.id, name: String(m.name || m.id).slice(0, 120) };
      });
      await save({ systemPrompt: body.systemPrompt, skills, mcp, models });
    }
    return Response.json(publicProfile(env, await profile(env, userId)));
  } catch (e) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
