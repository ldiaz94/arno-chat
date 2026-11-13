/** An account's profile and its settings: name and about-you, instructions
 * and skills, the home page, provider keys, SearXNG, MCP connections, custom
 * models, the composer's defaults and chat memory (chat/memory.mjs). The
 * profile lives in its own Durable Object ('profile:<user>'); secrets in it
 * are sealed (secrets.mjs), and the browser only ever gets whether each is
 * saved (publicProfile).
 *
 *   browser ─► api.mjs ─► accountRoute ─► checks ─► profile:<user> object
 *
 * Depends on providers.mjs, secrets.mjs, models.mjs, chat/research.mjs and
 * code/sandbox.mjs. Leaves out the routing (api.mjs) and the object's own
 * storage (probe/). */
import { publicWebUrl, searxngSearch } from './chat/research.mjs';
import { publicSandbox } from './code/sandbox.mjs';
import { modelAllowed } from './models.mjs';
import { PROVIDERS, providerModels, MODEL_ID, TRAINS_ON_DATA } from './providers.mjs';
import { seal, unseal } from './secrets.mjs';
import { MEMORY_MODES, memoryMode, recallMemories, forgetMemory } from './chat/memory.mjs';
/** The user's saved profile, or an empty one when nobody is signed in. */
export async function profile(env, userId) {
  if (!userId) return { systemPrompt: '', skills: [], mcp: [], keys: {}, models: [] };
  const r = await env.PROBE.getByName('profile:' + userId).fetch('https://internal/profile/get');
  return r.json();
}
/** The profile as text for the system prompt: name, about-you, the custom
 * prompt and the enabled skills. */
export function instructions(p) {
  return [
    p.name ? "The user's name is " + p.name + '.' : '',
    p.about ? 'About the user:\n' + p.about : '',
    p.systemPrompt || '',
    ...(p.skills || []).filter(s => s.enabled).map(s => 'Skill: ' + s.name + '\n' + s.content),
  ]
    .filter(Boolean)
    .join('\n\n');
}
/** The user's API key for a provider, unsealed; Ollama falls back to the
 * deployment's own key, other providers to none ('' when absent). */
export async function credential(env, userId, p, provider) {
  const own = await unseal(env, userId, 'provider:' + provider, p.keys?.[provider]);
  return own || (provider === 'ollama' ? env.OLLAMA_API_KEY || '' : '');
}
/** How the app looks, as saved: each setting's choices, the first the
 * default. meters: the composer's context and cost (taking turns on a
 * phone, side by side, one, or none); thinking: the model's, under an
 * answer; stats: the time, tokens and cost under an answer; width: the
 * transcript's; follow: scroll with an answer as it streams; closeOnSave:
 * close Settings once Save preferences has saved. */
const DISPLAY = {
  meters: ['alternate', 'both', 'context', 'cost', 'off'],
  thinking: ['folded', 'open', 'hidden'],
  stats: [true, false],
  width: ['readable', 'wide'],
  follow: [true, false],
  closeOnSave: [true, false],
};
/** Checks the display settings; throws on anything malformed. */
export function displaySettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid display settings');
  return Object.fromEntries(
    Object.entries(DISPLAY).map(([key, choices]) => {
      const v = value[key] ?? choices[0];
      if (!choices.includes(v)) throw Error('Invalid display setting: ' + key);
      return [key, v];
    }),
  );
}
/** The home page's widgets as saved: which are on, and where the weather is
 * for (a typed place, or coordinates rounded to about 10 km). */
const HOME = { quote: true, fact: true, moon: true, weather: false, place: '' };
/** Checks the home page settings; throws on anything malformed. */
export function homeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid home page settings');
  const home = {};
  for (const [key, fallback] of Object.entries(HOME)) {
    const v = value[key] ?? fallback;
    if (typeof v !== typeof fallback) throw Error('Invalid home page settings');
    home[key] = v;
  }
  if (home.place.length > 100) throw Error('The place name must be at most 100 characters');
  if (value.lat != null || value.lon != null) {
    const { lat, lon } = value;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      throw Error('Invalid location');
    home.lat = Math.round(lat * 10) / 10;
    home.lon = Math.round(lon * 10) / 10;
  }
  return home;
}
/** The profile as the browser may see it: secrets become flags (saved,
 * hasToken, hasSecret) and each provider says whether it is usable. */
export function publicProfile(env, p) {
  return {
    systemPrompt: p.systemPrompt || '',
    name: p.name || '',
    about: p.about || '',
    home: p.home || HOME,
    display: displaySettings(p.display || {}),
    memory: memoryMode(p), // who saves memories: 'asked', 'auto' or 'off' (chat/memory.mjs)
    memories: p.memories || [],
    enterSends: p.enterSends ?? false, // false (default): Enter adds a line, Ctrl/⌘+Enter sends; true: Enter sends
    defaultModel: p.defaultModel || '', // '' : the app's own default
    reviewModel: p.reviewModel || '', // '' : each chat's own model reviews its pages
    workerModel: p.workerModel || '', // '' : a coding turn's workers run on its own model
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
    mcp: (p.mcp || []).map(({ token, ...m }) => ({ ...m, hasToken: !!token, oauth: !!m.oauth })),
    sandbox: publicSandbox(p),
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
/** Handles /api/account[/key|/memory|/search|/search-test|/test] for one user:
 * GET returns the public profile; POST saves settings, stores or removes a
 * key, reads or forgets a memory, or tests a key or SearXNG. Returns a Response (400 with the message when
 * anything is invalid, 413 when the body is over 64 KB). */
export async function accountRoute(request, env, userId) {
  const u = new URL(request.url),
    p = await profile(env, userId),
    object = env.PROBE.getByName('profile:' + userId);
  const save = patch =>
    object.fetch('https://internal/profile/patch', { method: 'POST', body: JSON.stringify(patch) });
  if (request.method === 'GET') return Response.json(publicProfile(env, p));
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 1500000)
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
    } else if (u.pathname.endsWith('/memory')) {
      if (body.recall)
        return Response.json((await recallMemories(env, userId, [String(body.recall)]))[0] || {});
      await forgetMemory(env, userId, String(body.remove || ''));
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
      if (typeof body.systemPrompt !== 'string' || body.systemPrompt.length > 40000)
        throw Error('System prompt must be at most 40,000 characters');
      const name = String(body.name ?? p.name ?? '').trim();
      if (name.length > 80) throw Error('Names are limited to 80 characters');
      const about = body.about ?? p.about ?? '';
      if (typeof about !== 'string' || about.length > 8000)
        throw Error('About you must be at most 8,000 characters');
      const home = homeSettings(body.home ?? p.home ?? HOME),
        display = displaySettings(body.display ?? p.display ?? {}),
        memory = body.memory ?? memoryMode(p),
        enterSends = body.enterSends ?? p.enterSends ?? false,
        defaultModel = body.defaultModel ?? p.defaultModel ?? '',
        reviewModel = body.reviewModel ?? p.reviewModel ?? '',
        workerModel = body.workerModel ?? p.workerModel ?? '';
      if (typeof enterSends !== 'boolean') throw Error('Invalid Enter key setting');
      if (!MEMORY_MODES.includes(memory)) throw Error('Invalid memory setting');
      if (
        typeof defaultModel !== 'string' ||
        (defaultModel && defaultModel !== p.defaultModel && !(await modelAllowed(defaultModel)))
      )
        throw Error('Unsupported default model');
      if (
        typeof reviewModel !== 'string' ||
        (reviewModel && reviewModel !== p.reviewModel && !(await modelAllowed(reviewModel)))
      )
        throw Error('Unsupported review model');
      if (
        typeof workerModel !== 'string' ||
        (workerModel && workerModel !== p.workerModel && !(await modelAllowed(workerModel)))
      )
        throw Error('Unsupported worker model');
      if (!Array.isArray(body.skills) || body.skills.length > 20)
        throw Error('At most 20 skills are supported');
      const skills = body.skills.map(s => {
        if (
          typeof s.name !== 'string' ||
          s.name.length > 80 ||
          typeof s.content !== 'string' ||
          s.content.length > 40000
        )
          throw Error('Each skill needs a name and up to 40,000 instruction characters');
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
        // A token is for the URL it was given or signed in to: a new URL drops it.
        const kept = old && old.url === c.url && !c.clearToken;
        const token = c.token
          ? await seal(env, userId, 'mcp:' + c.id, c.token)
          : kept
            ? old.token || null
            : null;
        mcp.push({
          id: c.id,
          name: String(c.name || c.id).slice(0, 80),
          url: c.url,
          enabled: !!c.enabled,
          chats: !!c.chats,
          token,
          oauth: !c.token && kept && !!old.oauth,
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
        name,
        about,
        home,
        display,
        memory,
        enterSends,
        defaultModel,
        reviewModel,
        workerModel,
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
