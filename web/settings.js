/** Account settings dialog: the You tab (profile.js), instructions, skills, MCP connections,
 * custom models, provider keys with setup guides, the account's own SearXNG web search, and
 * notifications. Offline, Save preferences keeps them in the outbox; keys, connections,
 * the picture and account deletion wait for the network. Depends on core, layout, models,
 * marks, profile, push, offline and outbox.
 */
import { $, state, esc, api, toast, unreachable } from './core.js';
import { fit } from './layout.js';
import { loadModels } from './models.js';
import { providerMark } from './marks.js';
import { profilePanel, wireProfile, profilePrefs } from './profile.js';
import { pushState, enablePush, disablePush } from './push.js';
import { controls } from './offline.js';
import { queueProfile } from './outbox.js';
let account = null;
// What in the dialog needs the network, with the tooltip it shows while offline
// (offline.js's controls() disables what is marked data-online).
const ONLINE_ONLY = [
  [
    '.provider-key, [data-key-save], [data-key-remove], [data-provider-test]',
    'Reconnect to change API keys',
  ],
  [
    '#search-card input, #search-card select, #search-card button',
    'Reconnect to change web search',
  ],
  ['#mcp-cards input, #mcp-cards button, #add-mcp', 'Reconnect to change MCP connections'],
  ['#picture-upload, #picture-remove', 'Reconnect to change your picture'],
  ['#delete-start', 'Reconnect to delete your account'],
];
function onlineOnly() {
  for (const [selector, why] of ONLINE_ONLY)
    for (const n of $('#account-body').querySelectorAll(selector)) n.dataset.online = why;
  controls();
}
function settingsTabs(tab) {
  document
    .querySelectorAll('[data-account-panel]')
    .forEach(p => (p.hidden = p.dataset.accountPanel !== tab));
  document
    .querySelectorAll('[data-account-tab]')
    .forEach(b => b.classList.toggle('selected', b.dataset.accountTab === tab));
}
function skillCard(skill = {}) {
  const node = document.createElement('section');
  node.className = 'setting-card skill-card';
  node.innerHTML =
    '<div class="setting-row"><input class="field skill-name" maxlength="80" placeholder="Skill name" value="' +
    esc(skill.name || '') +
    '"><button type="button" class="ghost remove-setting" aria-label="Remove skill">×</button></div><textarea class="field skill-content" maxlength="4000" rows="4" placeholder="Instructions, conventions, or a reusable workflow">' +
    esc(skill.content || '') +
    '</textarea><label class="check-label"><input class="skill-enabled" type="checkbox" ' +
    (skill.enabled !== false ? 'checked' : '') +
    '> Apply to model requests</label>';
  node.querySelector('.remove-setting').onclick = () => node.remove();
  return node;
}
function mcpCard(c = {}) {
  const node = document.createElement('section');
  node.className = 'setting-card mcp-card';
  node.innerHTML =
    '<div class="setting-row"><strong>Remote MCP connection</strong><button type="button" class="ghost remove-setting" aria-label="Remove MCP connection">×</button></div><div class="setting-grid"><label>ID<input class="field mcp-id" maxlength="30" placeholder="my-server" value="' +
    esc(c.id || '') +
    '"></label><label>Name<input class="field mcp-name" maxlength="80" placeholder="My tools" value="' +
    esc(c.name || '') +
    '"></label></div><label>HTTPS endpoint<input class="field mcp-url" type="url" placeholder="https://example.com/mcp" value="' +
    esc(c.url || '') +
    '"></label><label>Bearer token (optional)<input class="field mcp-token" type="password" autocomplete="new-password" placeholder="' +
    (c.oauth
      ? 'Signed in · paste a token to use it instead'
      : c.hasToken
        ? 'Token saved · leave blank to keep'
        : 'Optional bearer token') +
    '"></label><div class="setting-row"><label class="check-label"><input class="mcp-enabled" type="checkbox" ' +
    (c.enabled ? 'checked' : '') +
    '> Enable for coding sessions</label><span class="mcp-actions"><button class="signin-mcp ghost" type="button">' +
    (c.oauth ? 'Sign in again' : 'Sign in') +
    '</button><button class="test-mcp" type="button">Test</button></span></div><label class="check-label caption"><input type="checkbox" class="mcp-clear"> ' +
    (c.oauth ? 'Sign out (remove the saved sign-in)' : 'Remove saved token') +
    '</label><p class="caption mcp-status">' +
    (c.oauth
      ? 'Signed in with OAuth. The tokens are encrypted, refreshed when they expire, and never sent to the coding container.'
      : c.hasToken
        ? 'Token is encrypted and never sent to the coding container.'
        : 'Servers such as Linear, Notion or Sentry sign in with OAuth: save, then Sign in. Others take a bearer token.') +
    '</p>';
  node.querySelector('.remove-setting').onclick = () => node.remove();
  // OAuth: the saved connection's server sends the browser to its sign-in page,
  // which comes back to /auth/mcp/callback and then to the app (mcpReturn).
  node.querySelector('.signin-mcp').onclick = async e => {
    const id = node.querySelector('.mcp-id').value,
      saved = account.mcp.find(m => m.id === id),
      status = node.querySelector('.mcp-status');
    if (!saved || saved.url !== node.querySelector('.mcp-url').value)
      return (status.textContent = 'Save preferences first, then sign in.');
    e.target.disabled = true;
    status.textContent = 'Finding the server’s sign-in…';
    try {
      const d = await api('/api/account/mcp-oauth', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      location.assign(d.url);
    } catch (err) {
      status.textContent = err.message;
      e.target.disabled = false;
    }
  };
  node.querySelector('.test-mcp').onclick = async e => {
    e.target.disabled = true;
    const status = node.querySelector('.mcp-status');
    status.textContent = 'Testing MCP initialization…';
    try {
      const d = await api('/api/account/mcp-test', {
        method: 'POST',
        body: JSON.stringify({ id: node.querySelector('.mcp-id').value }),
      });
      status.textContent = 'Connected · ' + d.server + ' · protocol ' + d.protocol;
    } catch (e) {
      status.textContent = e.message;
    } finally {
      e.target.disabled = false;
    }
  };
  return node;
}
/** The Connections tab's cards for coding sessions' network: the package
 * registries (always), full internet (a switch) and Cloudflare (a token
 * wrangler uses through the host). */
function sandboxCards() {
  const sb = account.sandbox || {},
    cf = sb.cloudflare;
  return (
    '<section class="setting-card"><strong>Coding sessions’ network</strong><p class="caption">Sessions always reach npm and PyPI, read only, so installs work. Everything else they reach goes through the app: models, MCP servers, and git for the session’s own repository.</p><label class="check-label"><input type="checkbox" id="sandbox-internet"' +
    (sb.internet ? ' checked' : '') +
    '> Full internet access</label><p class="caption">Lets sessions reach any site: other installers, documentation, APIs. A misled agent could then send repository contents anywhere, so turn it on only when you need it. Applies when a workspace next starts (after 30 idle minutes, or in a new session).</p><p class="caption" id="sandbox-status" role="status"></p></section>' +
    '<section class="setting-card"><div class="setting-row"><strong>Cloudflare</strong><span class="tag">' +
    (cf?.saved ? 'Token saved' : 'Not connected') +
    '</span></div><p class="caption">With a Cloudflare API token, <code>npx wrangler deploy</code> works in coding sessions. The token stays in the app: wrangler talks to a gateway that adds it, and only while a turn runs. Use a token limited to what sessions should do, such as Workers Scripts: Edit for one account.</p><label>API token<input id="cf-token" class="field" type="password" autocomplete="new-password" placeholder="' +
    (cf?.saved ? 'Saved · paste a new one to replace it' : 'Cloudflare API token') +
    '"></label><label>Account ID (optional)<input id="cf-account" class="field" maxlength="32" placeholder="32 hexadecimal characters" value="' +
    esc(cf?.accountId || '') +
    '"></label><div class="setting-row"><button id="cf-save" type="button">Save</button><button id="cf-test" type="button" class="ghost"' +
    (cf?.saved ? '' : ' hidden') +
    '>Test</button><button id="cf-remove" type="button" class="ghost"' +
    (cf?.saved ? '' : ' hidden') +
    '>Remove</button></div><p class="caption" id="cf-status" role="status"></p></section>'
  );
}
/** Sends a sandbox setting and says how it went in the status line at. */
async function sandboxSave(body, at) {
  try {
    const d = await api('/api/account/sandbox', { method: 'POST', body: JSON.stringify(body) });
    if (!body.test) account.sandbox = d;
    $(at).textContent = body.test ? 'The token works (' + d.status + ')' : 'Saved';
    return d;
  } catch (e) {
    $(at).textContent = e.message;
  }
}
function wireSandbox() {
  $('#sandbox-internet').onchange = e =>
    sandboxSave({ internet: e.target.checked }, '#sandbox-status');
  $('#cf-save').onclick = async () => {
    const d = await sandboxSave(
      {
        cloudflare: {
          token: $('#cf-token').value.trim(),
          accountId: $('#cf-account').value.trim(),
        },
      },
      '#cf-status',
    );
    if (d) {
      $('#cf-token').value = '';
      $('#cf-test').hidden = $('#cf-remove').hidden = !d.cloudflare?.saved;
    }
  };
  $('#cf-test').onclick = () => sandboxSave({ test: true }, '#cf-status');
  $('#cf-remove').onclick = async () => {
    if (await sandboxSave({ cloudflare: null }, '#cf-status'))
      $('#cf-test').hidden = $('#cf-remove').hidden = true;
  };
}
function customModelCard(m = {}) {
  const node = document.createElement('section');
  node.className = 'setting-row custom-model';
  const parts = (m.id || 'openai/').split('/');
  node.innerHTML =
    '<select class="field custom-provider" aria-label="Model provider">' +
    Object.entries(account.providers)
      .filter(([id]) => id !== 'ollama')
      .map(([id, p]) => '<option value="' + id + '">' + esc(p.label) + '</option>')
      .join('') +
    '</select><input class="field custom-id" aria-label="Model ID" placeholder="Model ID" value="' +
    esc(parts.slice(1).join('/')) +
    '"><input class="field custom-name" aria-label="Model label" placeholder="Label" value="' +
    esc(m.name || '') +
    '"><button class="ghost remove-setting" type="button" aria-label="Remove custom model">×</button>';
  node.querySelector('select').value = parts[0];
  node.querySelector('.remove-setting').onclick = () => node.remove();
  return node;
}
/** Setup guides: collapsed step lists written for someone doing this the first time. */
const link = (url, text) =>
  '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + ' ↗</a>';
const code = (text, lang = 'shell') =>
  '<div class="codeblock"><div class="codehead"><span>' +
  lang +
  '</span><button type="button" class="copy-code">Copy</button></div><pre><code>' +
  esc(text) +
  '</code></pre></div>';
const guide = (title, steps) =>
  '<details class="guide"><summary>' +
  title +
  '</summary><ol class="guide-steps">' +
  steps.map(step => '<li>' + step + '</li>').join('') +
  '</ol></details>';
const keySteps = (where, extra = []) => [
  'Sign in at ' + where + '.',
  'Create a new API key. Give it a name you will recognise, such as “Arno”.',
  'Copy the key. Most sites show it only once, so paste it straight away.',
  'Paste it in the API key field above and press <b>Save key</b>.',
  ...extra,
  'Press <b>Test connection</b>. It should report how many models your key can use.',
];
const PROVIDER_GUIDES = {
  ollama: keySteps(link('https://ollama.com/settings/keys', 'ollama.com › Settings › Keys')),
  openai: keySteps(link('https://platform.openai.com/api-keys', 'platform.openai.com › API keys'), [
    'Set up billing under ' +
      link('https://platform.openai.com/settings/organization/billing/overview', 'Billing') +
      ': the API is paid separately from a ChatGPT subscription, and keys without credit are refused.',
  ]),
  anthropic: keySteps(
    link('https://platform.claude.com/settings/keys', 'platform.claude.com › API keys'),
    [
      'Add credit under Billing in the same console: the API is paid separately from a Claude subscription.',
    ],
  ),
  gemini: keySteps(link('https://aistudio.google.com/apikey', 'Google AI Studio › Get API key'), [
    'The free tier may use your prompts to improve Google’s products (' +
      link('https://aistudio.google.com/docs/terms', 'terms') +
      '). For private work, turn on billing for the key’s project (' +
      link('https://aistudio.google.com/docs/billing', 'billing') +
      ').',
  ]),
  deepseek: keySteps(
    link('https://platform.deepseek.com/api_keys', 'platform.deepseek.com › API keys'),
    [
      'Add funds under ' +
        link('https://platform.deepseek.com/top_up', 'Top up') +
        ': the API draws on a prepaid balance and refuses requests when it runs out. Peak-hour prices are double the off-peak ones (' +
        link('https://api-docs.deepseek.com/quick_start/pricing', 'pricing') +
        ').',
    ],
  ),
  kimi: keySteps(link('https://platform.kimi.ai/console/api-keys', 'platform.kimi.ai › API Keys'), [
    'Top up your account in the same console: the API is pay-as-you-go from a prepaid balance, separate from a Kimi membership, and refuses requests when the balance runs out.',
  ]),
  mistral: keySteps(link('https://console.mistral.ai/api-keys', 'console.mistral.ai › API Keys'), [
    'New accounts start in Free mode with a small monthly allowance. To go beyond it, buy credits and turn on pay-as-you-go under ' +
      link('https://admin.mistral.ai/subscription', 'Admin › Subscription') +
      '.',
  ]),
  meta: keySteps(link('https://dev.meta.ai/', 'dev.meta.ai › API keys'), [
    'Usage is pay-as-you-go (' +
      link('https://dev.meta.ai/docs/pricing-rate-limits', 'pricing') +
      '). Meta’s cheaper “-contributor” models let Meta train on your prompts, so they are not offered here.',
  ]),
};
const SEARCH_GUIDE = guide('How to set up your own SearXNG, step by step', [
  '<b>Run SearXNG with Docker.</b> SearXNG is a free search engine you run yourself; it asks Google, Bing, DuckDuckGo and others for you. Install ' +
    link('https://docs.docker.com/get-started/get-docker/', 'Docker') +
    ', then in a terminal run:' +
    code(
      'mkdir -p searxng/config && cd searxng\ndocker run -d --name searxng -p 127.0.0.1:8888:8080 \\\n  -v "./config/:/etc/searxng/" searxng/searxng',
    ) +
    'It now answers on this computer only, at http://localhost:8888. See ' +
    link('https://docs.searxng.org/admin/installation-docker.html', 'Installation with Docker') +
    '.',
  '<b>Turn on JSON answers.</b> Arno reads results as JSON, which is off by default. On first start SearXNG writes <code>config/settings.yml</code>. Open it, find these keys and set them (keep the rest of the file):' +
    code('search:\n  formats:\n    - html\n    - json\nserver:\n  limiter: false', 'yaml') +
    'The limiter guards public instances from bots; yours is private, so it would only block Arno. Restart and check that JSON comes back:' +
    code("docker restart searxng\ncurl 'http://localhost:8888/search?q=test&format=json'") +
    'See the ' +
    link('https://docs.searxng.org/dev/search_api.html', 'Search API') +
    '.',
  '<b>Reach it from the Internet with Cloudflare Tunnel.</b> Arno runs in Cloudflare, so it cannot see your localhost. ' +
    link(
      'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/',
      'Install cloudflared',
    ) +
    ' on the same computer, then ' +
    link(
      'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/',
      'create a tunnel',
    ) +
    ' in the Cloudflare dashboard with a public hostname in your own domain (for example <code>search.example.com</code>) pointing to <code>http://localhost:8888</code>. Just trying it out? A ' +
    link('https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/', 'quick tunnel') +
    ' needs no account:' +
    code('cloudflared tunnel --url http://localhost:8888') +
    'It prints a temporary trycloudflare.com address that changes every run and is open to anyone, so do not keep it.',
  '<b>Lock it with Cloudflare Access.</b> In Cloudflare Zero Trust, ' +
    link(
      'https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/',
      'add a self-hosted application',
    ) +
    ' for your hostname. Then ' +
    link(
      'https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/',
      'create a service token',
    ) +
    ' and copy its Client ID and Client Secret (the secret is shown only once). Give the application a policy with action <b>Service Auth</b> that includes that token. Choose “Cloudflare Access service token” above and paste both.',
  '<b>Save and Test.</b> Test runs one search and shows how many results came back and how long it took. If your SearXNG is unreachable, errors or finds nothing, Arno falls back to Ollama web search, which is billed per search. Result quality depends on the engines your SearXNG uses (set under <code>engines:</code> in settings.yml).',
]);
const AUTH_LABELS = { access: 'Client Secret', bearer: 'Bearer token' };
function searchCard() {
  return (
    '<details class="setting-card collapsible" id="search-card"><summary class="setting-row"><strong class="provider-name">' +
    providerMark('search', 20) +
    'Web search</strong><span class="tag" id="search-state"></span></summary><p class="caption">Searches go to Ollama web search (billed per search) unless you connect your own SearXNG. Page reading always uses Ollama.</p><label>SearXNG URL<input class="field" id="search-url" type="url" maxlength="500" placeholder="https://search.example.com"></label><label>Authentication<select class="field" id="search-auth"><option value="access">Cloudflare Access service token</option><option value="bearer">Bearer token</option><option value="none">None</option></select></label><label data-auth="access">Client ID<input class="field" id="search-client-id" maxlength="200" autocomplete="off" placeholder="xxxx.access"></label><label data-auth="access bearer"><span id="search-secret-label"></span><input class="field" id="search-secret" type="password" autocomplete="new-password"></label><div class="setting-row"><button id="search-save" type="button">Save</button><button id="search-test" type="button">Test</button><button id="search-remove" class="ghost" type="button">Remove</button></div><p class="caption" id="search-status"></p>' +
    SEARCH_GUIDE +
    '</details>'
  );
}
/** Shows the saved connection: masked secret, fields for its auth type. */
function showSearch(search) {
  $('#search-state').textContent = search ? 'Your SearXNG · connected' : 'Ollama (default)';
  $('#search-url').value = search?.url || '';
  $('#search-auth').value = search?.auth || 'access';
  $('#search-client-id').value = search?.clientId || '';
  $('#search-secret').value = '';
  $('#search-secret').placeholder = search?.hasSecret
    ? 'Saved · leave blank to keep'
    : 'Paste it here';
  $('#search-remove').hidden = !search;
  $('#search-test').hidden = !search;
  showAuth();
}
function showAuth() {
  const auth = $('#search-auth').value;
  document
    .querySelectorAll('#search-card [data-auth]')
    .forEach(n => (n.hidden = !n.dataset.auth.split(' ').includes(auth)));
  $('#search-secret-label').textContent = AUTH_LABELS[auth] || '';
}
async function saveSearch(remove = false) {
  const status = $('#search-status');
  if (remove && !confirm('Remove your SearXNG connection? Searches go back to Ollama.')) return;
  status.textContent = remove ? 'Removing…' : 'Saving…';
  try {
    account = await api('/api/account/search', {
      method: 'POST',
      body: JSON.stringify(
        remove
          ? { remove: true }
          : {
              url: $('#search-url').value,
              auth: $('#search-auth').value,
              clientId: $('#search-client-id').value,
              secret: $('#search-secret').value || undefined,
            },
      ),
    });
    showSearch(account.search);
    status.textContent = remove
      ? 'Removed. Web search uses Ollama.'
      : 'Saved, secret encrypted. Press Test to check it answers.';
  } catch (e) {
    status.textContent = e.message;
  }
}
async function testSearch() {
  const status = $('#search-status');
  status.textContent = 'Searching…';
  try {
    const d = await api('/api/account/search-test', { method: 'POST', body: '{}' });
    status.textContent = 'Connected · ' + d.results + ' results in ' + d.ms + ' ms';
  } catch (e) {
    status.textContent = e.message;
  }
}
async function openAccount() {
  $('#account-body').innerHTML = '<p class="muted">Loading account settings…</p>';
  $('#account-dialog').showModal();
  fit();
  try {
    account = await api('/api/account');
    const providers = Object.entries(account.providers)
      .map(
        ([id, p]) =>
          '<details class="setting-card collapsible"><summary class="setting-row"><strong class="provider-name">' +
          providerMark(id, 20) +
          esc(p.label) +
          '</strong><span class="tag">' +
          (p.saved
            ? 'Personal key saved'
            : p.available
              ? 'Shared deployment key'
              : 'Not configured') +
          '</span></summary><label>API key<input type="password" autocomplete="new-password" class="field provider-key" data-provider-input="' +
          id +
          '" placeholder="' +
          (p.saved ? 'Saved · enter a replacement' : 'Paste your API key') +
          '"></label><div class="setting-row"><button data-key-save="' +
          id +
          '" type="button">Save key</button><button data-provider-test="' +
          id +
          '" type="button">Test connection</button>' +
          (p.saved
            ? '<button data-key-remove="' + id + '" class="ghost" type="button">Remove</button>'
            : '') +
          '</div><p class="caption" data-provider-status="' +
          id +
          '"></p>' +
          guide('How to get a ' + esc(p.label) + ' key', PROVIDER_GUIDES[id] || []) +
          '</details>',
      )
      .join('');
    $('#account-body').innerHTML =
      '<div class="account-tabs"><button data-account-tab="you">You</button><button data-account-tab="providers">Providers</button><button data-account-tab="instructions">Instructions & skills</button><button data-account-tab="mcp">MCP tools</button><button data-account-tab="connections">Connections</button></div>' +
      profilePanel(account) +
      '<section data-account-panel="providers" hidden><p class="caption">Keys are encrypted and kept outside coding workspaces. A provider’s models appear after you save its key. API billing is separate from ChatGPT/Claude app subscriptions.</p>' +
      providers +
      searchCard() +
      '<h3>Custom model IDs</h3><p class="caption">Use this when a provider’s model discovery does not list a model available to your key.</p><div id="custom-models"></div><button id="add-custom-model" type="button" class="ghost">＋ Add model</button></section>' +
      '<section data-account-panel="instructions" hidden><label>Account system prompt<textarea id="system-prompt" class="field" rows="7" maxlength="12000" placeholder="How should Arno work with you?">' +
      esc(account.systemPrompt) +
      '</textarea></label><p class="caption">Applied to new requests in both regular chats and coding sessions. Repository content does not override these account instructions.</p><h3>Reusable skills</h3><div id="skill-cards"></div><button id="add-skill" type="button" class="ghost">＋ Add skill</button></section>' +
      '<section data-account-panel="mcp" hidden><p class="caption">Connect trusted public HTTPS Streamable HTTP MCP servers. Enabled tools are available to Arno coding sessions. Regular chats have built-in web research; custom MCP tools are currently for coding sessions. MCP servers can perform remote actions; enable only servers you trust.</p><div id="mcp-cards"></div><button id="add-mcp" type="button" class="ghost">＋ Add MCP connection</button></section>' +
      '<section data-account-panel="connections" hidden><section class="setting-card"><div class="setting-row"><strong>GitHub</strong><span class="tag">Signed in as ' +
      esc(state.user.login) +
      '</span></div><p class="caption">Signing in does not require repository access. Coding sessions request repo scope separately.</p><a href="/auth/github?repos=1">Connect or refresh repository access ↗</a><p><a href="https://github.com/settings/applications" target="_blank" rel="noopener noreferrer">Review GitHub app and organization authorization ↗</a></p><p class="caption">Coding sessions reach the repositories the Arno GitHub App is installed on; the Code home says how to add more.</p></section>' +
      sandboxCards() +
      '<section class="setting-card"><div class="setting-row"><strong>Notifications</strong><span class="tag" id="push-state"></span></div><label class="check-label"><input id="push-toggle" type="checkbox"> Notify me when a reply is ready</label><p class="caption" id="push-hint"></p></section><section class="setting-card"><strong>Storage & privacy</strong><p class="caption">Chats and account preferences use persistent Cloudflare Durable Objects SQLite storage. API keys and MCP tokens use per-account AES-GCM encryption. This is a private deployment using the owner’s configured providers.</p></section></section>' +
      '<div class="account-save"><span class="caption" id="account-save-status">Provider keys save separately. Save instructions, skills, MCP, and custom models below.</span><button id="save-account" class="primary" type="button">Save preferences</button></div>';
    for (const s of account.skills) $('#skill-cards').append(skillCard(s));
    for (const m of account.mcp) $('#mcp-cards').append(mcpCard(m));
    for (const m of account.models || []) $('#custom-models').append(customModelCard(m));
    $('#add-skill').onclick = () => $('#skill-cards').append(skillCard());
    $('#add-mcp').onclick = () => $('#mcp-cards').append(mcpCard());
    wireSandbox();
    $('#add-custom-model').onclick = () => $('#custom-models').append(customModelCard());
    $('#save-account').onclick = saveAccount;
    $('#account-body')
      .querySelectorAll('[data-account-tab]')
      .forEach(b => (b.onclick = () => settingsTabs(b.dataset.accountTab)));
    $('#account-body')
      .querySelectorAll('[data-key-save]')
      .forEach(b => (b.onclick = () => providerKey(b.dataset.keySave)));
    $('#account-body')
      .querySelectorAll('[data-key-remove]')
      .forEach(b => (b.onclick = () => providerKey(b.dataset.keyRemove, true)));
    $('#account-body')
      .querySelectorAll('[data-provider-test]')
      .forEach(b => (b.onclick = () => testProvider(b.dataset.providerTest)));
    $('#push-toggle').onchange = togglePush;
    $('#search-auth').onchange = showAuth;
    $('#search-save').onclick = () => saveSearch();
    $('#search-remove').onclick = () => saveSearch(true);
    $('#search-test').onclick = testSearch;
    showSearch(account.search);
    wireProfile();
    showPush();
    settingsTabs('you');
    onlineOnly();
  } catch (e) {
    $('#account-body').innerHTML = '<p class="banner">' + esc(e.message) + '</p>';
  }
}
const PUSH_STATES = {
  on: ['On', 'This browser is notified when a reply is ready or a turn fails.'],
  off: ['Off', 'Get a notification when a reply finishes while Arno is not on screen.'],
  blocked: [
    'Blocked',
    'Notifications are blocked for this site; allow them in the browser settings.',
  ],
  unsupported: ['Unsupported', 'This browser does not support web push notifications.'],
  ios: [
    'Home Screen only',
    'On iPhone and iPad, add Arno to the Home Screen (Share › Add to Home Screen) and open it from there.',
  ],
};
async function showPush() {
  const current = await pushState(),
    [tag, hint] = PUSH_STATES[current];
  $('#push-state').textContent = tag;
  $('#push-hint').textContent = hint;
  $('#push-toggle').checked = current === 'on';
  $('#push-toggle').disabled = !['on', 'off'].includes(current);
}
async function togglePush(e) {
  e.target.disabled = true;
  $('#push-hint').textContent = e.target.checked ? 'Turning on…' : 'Turning off…';
  try {
    await (e.target.checked ? enablePush() : disablePush());
    await showPush();
  } catch (error) {
    await showPush();
    $('#push-hint').textContent = error.message;
  }
}
async function providerKey(provider, remove = false) {
  const input = document.querySelector('[data-provider-input="' + provider + '"]'),
    status = document.querySelector('[data-provider-status="' + provider + '"]');
  if (remove && !confirm('Remove your saved ' + provider + ' API key?')) return;
  const key = remove ? null : input.value;
  input.value = '';
  status.textContent = 'Saving encrypted key…';
  try {
    const d = await api('/api/account/key', {
      method: 'POST',
      body: JSON.stringify({ provider, key }),
    });
    account = d;
    status.textContent = remove
      ? 'Personal key removed.'
      : 'Key saved encrypted. Test the connection to verify access.';
    input.placeholder = remove ? 'Paste your API key' : 'Saved · enter a replacement';
    await loadModels();
    toast('Provider settings updated');
  } catch (e) {
    status.textContent = e.message;
  }
}
async function testProvider(provider) {
  const status = document.querySelector('[data-provider-status="' + provider + '"]');
  status.textContent = 'Testing provider access…';
  try {
    const d = await api('/api/account/test', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
    status.textContent = 'Connected · ' + d.models + ' models reported';
  } catch (e) {
    status.textContent = e.message;
  }
}
async function saveAccount() {
  const status = $('#account-save-status'),
    button = $('#save-account');
  button.disabled = true;
  status.textContent = 'Saving preferences…';
  let prefs;
  try {
    prefs = await profilePrefs();
  } catch (e) {
    status.textContent = e.message;
    button.disabled = false;
    return;
  }
  const body = {
    systemPrompt: $('#system-prompt').value,
    ...prefs,
    skills: [...document.querySelectorAll('.skill-card')].map(n => ({
      name: n.querySelector('.skill-name').value,
      content: n.querySelector('.skill-content').value,
      enabled: n.querySelector('.skill-enabled').checked,
    })),
    mcp: [...document.querySelectorAll('.mcp-card')].map(n => ({
      id: n.querySelector('.mcp-id').value,
      name: n.querySelector('.mcp-name').value,
      url: n.querySelector('.mcp-url').value,
      token: n.querySelector('.mcp-token').value || undefined,
      clearToken: n.querySelector('.mcp-clear').checked,
      enabled: n.querySelector('.mcp-enabled').checked,
    })),
    models: [...document.querySelectorAll('.custom-model')].map(n => ({
      id: n.querySelector('.custom-provider').value + '/' + n.querySelector('.custom-id').value,
      name: n.querySelector('.custom-name').value,
    })),
  };
  try {
    try {
      if (state.offline) throw unreachable();
      account = await api('/api/account', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      if (!e.network) throw e;
      // Sent once online, checked against the profile it was edited from. MCP
      // connections can't change offline; their saved tokens stay as they are.
      body.mcp = body.mcp.map(m => ({ ...m, token: undefined, clearToken: false }));
      await queueProfile(body, account.updatedAt || 0);
      state.profile = { ...state.profile, ...prefs }; // applies on this device now
      dispatchEvent(new Event('arno:prefs'));
      status.textContent = 'Saved on this device · sends when online.';
      return;
    }
    document.querySelectorAll('#account-body input[type=password]').forEach(n => (n.value = ''));
    state.profile = account;
    dispatchEvent(new Event('arno:prefs'));
    status.textContent = 'Saved. Instructions, skills, and connections apply to subsequent turns.';
    await loadModels();
    toast('Account preferences saved');
  } catch (e) {
    status.textContent = e.message;
  } finally {
    button.disabled = false;
  }
}
$('#account-settings').onclick = openAccount;
/** Back from an MCP server's OAuth sign-in (?mcp=id or ?mcp_error=why): says
 * how it went and opens the MCP settings. */
export async function mcpReturn() {
  const q = new URLSearchParams(location.search),
    id = q.get('mcp'),
    error = q.get('mcp_error');
  if (!id && !error) return;
  history.replaceState(null, '', location.pathname);
  toast(error ? 'MCP sign-in failed: ' + error : 'Signed in to ' + id);
  await openAccount();
  settingsTabs('mcp');
}
$('#account-dialog').addEventListener('close', () =>
  document.querySelectorAll('#account-body input[type=password]').forEach(n => (n.value = '')),
);
