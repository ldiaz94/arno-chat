/** Account settings dialog: instructions, skills, MCP connections, custom models and
 * provider keys. Depends on core, layout and models.
 */
import { $, state, esc, api, toast } from './core.js';
import { fit } from './layout.js';
import { loadModels } from './models.js';
let account = null;
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
    (c.hasToken ? 'Token saved · leave blank to keep' : 'Optional bearer token') +
    '"></label><div class="setting-row"><label class="check-label"><input class="mcp-enabled" type="checkbox" ' +
    (c.enabled ? 'checked' : '') +
    '> Enable for coding sessions</label><button class="test-mcp" type="button">Test</button></div><label class="check-label caption"><input type="checkbox" class="mcp-clear"> Remove saved token</label><p class="caption mcp-status">' +
    (c.hasToken
      ? 'Token is encrypted and never sent to the coding container.'
      : 'Save settings before testing this connection.') +
    '</p>';
  node.querySelector('.remove-setting').onclick = () => node.remove();
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
function customModelCard(m = {}) {
  const node = document.createElement('section');
  node.className = 'setting-row custom-model';
  const parts = (m.id || 'openai/').split('/');
  node.innerHTML =
    '<select class="field custom-provider" aria-label="Model provider"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option></select><input class="field custom-id" aria-label="Model ID" placeholder="Model ID" value="' +
    esc(parts.slice(1).join('/')) +
    '"><input class="field custom-name" aria-label="Model label" placeholder="Label" value="' +
    esc(m.name || '') +
    '"><button class="ghost remove-setting" type="button" aria-label="Remove custom model">×</button>';
  node.querySelector('select').value = parts[0];
  node.querySelector('.remove-setting').onclick = () => node.remove();
  return node;
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
          '<section class="setting-card"><div class="setting-row"><strong>' +
          esc(p.label) +
          '</strong><span class="tag">' +
          (p.saved
            ? 'Personal key saved'
            : p.available
              ? 'Shared deployment key'
              : 'Not configured') +
          '</span></div><label>API key<input type="password" autocomplete="new-password" class="field provider-key" data-provider-input="' +
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
          '"></p></section>',
      )
      .join('');
    $('#account-body').innerHTML =
      '<div class="account-tabs"><button data-account-tab="providers">Providers</button><button data-account-tab="instructions">Instructions & skills</button><button data-account-tab="mcp">MCP tools</button><button data-account-tab="connections">Connections</button></div>' +
      '<section data-account-panel="providers"><p class="caption">Keys are encrypted and kept outside coding workspaces. OpenAI, Anthropic and Google Gemini models appear after you save a key. API billing is separate from ChatGPT/Claude app subscriptions.</p>' +
      providers +
      '<h3>Custom model IDs</h3><p class="caption">Use this when a provider’s model discovery does not list a model available to your key.</p><div id="custom-models"></div><button id="add-custom-model" type="button" class="ghost">＋ Add model</button></section>' +
      '<section data-account-panel="instructions" hidden><label>Account system prompt<textarea id="system-prompt" class="field" rows="7" maxlength="12000" placeholder="How should Arno work with you?">' +
      esc(account.systemPrompt) +
      '</textarea></label><p class="caption">Applied to new requests in both regular chats and coding sessions. Repository content does not override these account instructions.</p><h3>Reusable skills</h3><div id="skill-cards"></div><button id="add-skill" type="button" class="ghost">＋ Add skill</button></section>' +
      '<section data-account-panel="mcp" hidden><p class="caption">Connect trusted public HTTPS Streamable HTTP MCP servers. Enabled tools are available to Arno coding sessions. Regular chats have built-in web research; custom MCP tools are currently for coding sessions. MCP servers can perform remote actions; enable only servers you trust.</p><div id="mcp-cards"></div><button id="add-mcp" type="button" class="ghost">＋ Add MCP connection</button></section>' +
      '<section data-account-panel="connections" hidden><section class="setting-card"><div class="setting-row"><strong>GitHub</strong><span class="tag">Signed in as ' +
      esc(state.user.login) +
      '</span></div><p class="caption">Signing in does not require repository access. Coding sessions request repo scope separately.</p><a href="/auth/github?repos=1">Connect or refresh repository access ↗</a><p><a href="https://github.com/settings/applications" target="_blank" rel="noopener noreferrer">Review GitHub app and organization authorization ↗</a></p><p class="caption">If only 17 repositories are visible, reconnect with repo scope and approve organization SSO/access. The app can only list repositories GitHub authorizes for this token.</p></section><section class="setting-card"><strong>Storage & privacy</strong><p class="caption">Chats and account preferences use persistent Cloudflare Durable Objects SQLite storage. API keys and MCP tokens use per-account AES-GCM encryption. This is a private deployment using the owner’s configured providers.</p></section></section>' +
      '<div class="account-save"><span class="caption" id="account-save-status">Provider keys save separately. Save instructions, skills, MCP, and custom models below.</span><button id="save-account" class="primary" type="button">Save preferences</button></div>';
    for (const s of account.skills) $('#skill-cards').append(skillCard(s));
    for (const m of account.mcp) $('#mcp-cards').append(mcpCard(m));
    for (const m of account.models || []) $('#custom-models').append(customModelCard(m));
    $('#add-skill').onclick = () => $('#skill-cards').append(skillCard());
    $('#add-mcp').onclick = () => $('#mcp-cards').append(mcpCard());
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
    settingsTabs('providers');
  } catch (e) {
    $('#account-body').innerHTML = '<p class="banner">' + esc(e.message) + '</p>';
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
  const body = {
    systemPrompt: $('#system-prompt').value,
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
    account = await api('/api/account', { method: 'POST', body: JSON.stringify(body) });
    document.querySelectorAll('#account-body input[type=password]').forEach(n => (n.value = ''));
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
$('#account-dialog').addEventListener('close', () =>
  document.querySelectorAll('#account-body input[type=password]').forEach(n => (n.value = '')),
);
