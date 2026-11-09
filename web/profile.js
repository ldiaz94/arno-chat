/** The account dialog's "You" tab: what the assistant should know about the user, the
 * profile picture, the composer and default model, the home page's widgets, the
 * privacy notice and account deletion. Depends on core, layout, models, home and offline.
 */
import { $, state, esc, api, avatar, toast, copy, modelName } from './core.js';
import { sidebar } from './layout.js';
import { geocode } from './home.js';
import { clearData } from './offline.js';
import { diagnostics, diagnosticsOn, developerOn, setDeveloper, debugReport } from './diag.js';
const PICTURE_SIDE = 256; // pictures are shrunk to this many pixels square before upload
const PICTURE_MAX = 256 * 1024; // the server's size limit, in bytes
const initials = () => (state.user?.login || 'A').slice(0, 2).toUpperCase();
/** The panel's markup. `account` is the profile from GET /api/account. */
export function profilePanel(account) {
  return (
    '<section data-account-panel="you">' +
    '<section class="setting-card"><strong>Picture</strong><div class="picture-row"><span class="avatar picture" id="picture"></span><div class="setting-row"><button id="picture-upload" class="ghost" type="button">Upload</button><input id="picture-file" type="file" hidden accept="image/png,image/jpeg,image/webp"><button id="picture-remove" class="ghost" type="button">Remove</button></div></div><p class="caption" id="picture-status">Shown next to your messages. Large photos are shrunk to 256 × 256 pixels.</p></section>' +
    '<label>Your name<input id="name" class="field" maxlength="80" autocomplete="name" placeholder="What should Arno call you?" value="' +
    esc(account.name) +
    '"></label>' +
    '<label>About you<textarea id="about" class="field" rows="5" maxlength="2000" placeholder="What should the assistant know about you? (name, role, preferences)">' +
    esc(account.about) +
    '</textarea></label><p class="caption">Up to 2,000 characters, sent to every model with each request. Saved with Save preferences.</p>' +
    composerCard(account) +
    homeCard(account.home || {}) +
    PRIVACY +
    '<section class="setting-card"><label class="check"><input type="checkbox" id="developer"> Developer mode</label><p class="caption">Tools for debugging the app on this device.</p><div id="dev-tools" hidden><div class="setting-row"><span>Layout diagnostics: the screen measurements over the app</span><button type="button" id="diag-toggle" class="ghost"></button></div><div class="setting-row"><span>Debug report: measurements and app state, for a bug report</span><button type="button" id="debug-copy" class="ghost">Copy</button></div></div></section>' +
    DANGER +
    '</section>'
  );
}
function composerCard(account) {
  const current = account.defaultModel || '',
    models =
      state.models.some(m => m.id === current) || !current
        ? state.models
        : [{ id: current, name: current }, ...state.models];
  return (
    '<section class="setting-card" id="composer-card"><strong>Composer & defaults</strong>' +
    '<label class="check-label"><input type="radio" name="enter-key" id="enter-sends"' +
    (account.enterSends === true ? ' checked' : '') +
    '> Enter sends · Shift + Enter adds a new line</label>' +
    '<label class="check-label"><input type="radio" name="enter-key" id="enter-line"' +
    (account.enterSends !== true ? ' checked' : '') +
    '> Enter adds a new line · ⌘ / Ctrl + Enter sends</label>' +
    '<label>Default model<select id="default-model" class="field"><option value="">App default</option>' +
    models
      .map(
        m =>
          '<option value="' +
          esc(m.id) +
          '"' +
          (m.id === current ? ' selected' : '') +
          '>' +
          esc(modelName(m.id)) +
          '</option>',
      )
      .join('') +
    '</select></label><p class="caption">New chats and coding sessions start with this model. The send button always sends.</p></section>'
  );
}
let spot = null; // the weather's place as rounded coordinates, from "Use my location"
function homeCard(home) {
  spot = home.lat != null ? { lat: home.lat, lon: home.lon } : null;
  const box = (id, label, on) =>
    '<label class="check-label"><input type="checkbox" id="home-' +
    id +
    '"' +
    (on ? ' checked' : '') +
    '> ' +
    label +
    '</label>';
  return (
    '<section class="setting-card" id="home-card"><strong>Home page</strong><p class="caption">What the Today card on the home pages shows.</p>' +
    box('quote', 'Quote of the day', home.quote !== false) +
    box('fact', 'Interesting fact', home.fact !== false) +
    box('moon', 'Moon phase', home.moon !== false) +
    box('weather', 'Weather (from Open-Meteo)', home.weather === true) +
    '<div id="weather-where"><label>Place<input id="home-place" class="field" maxlength="100" placeholder="A city, e.g. Lisbon" value="' +
    esc(home.place || '') +
    '"></label><div class="setting-row"><button id="home-locate" class="ghost" type="button" data-online="Reconnect to find your location">Use my location</button><span class="caption" id="home-where" role="status"></span></div></div></section>'
  );
}
function showWhere() {
  $('#weather-where').hidden = !$('#home-weather').checked;
  $('#home-where').textContent = spot ? 'Your location, about ' + spot.lat + ', ' + spot.lon : '';
}
/** Asks the browser for the location (only on this click), rounded to ~10 km. */
function locate() {
  const status = $('#home-where');
  if (!navigator.geolocation) return (status.textContent = 'This browser can’t share a location');
  status.textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition(
    p => {
      const round = n => Math.round(n * 10) / 10;
      spot = { lat: round(p.coords.latitude), lon: round(p.coords.longitude) };
      $('#home-place').value = '';
      showWhere();
    },
    () => (status.textContent = 'Location not shared'),
    { maximumAge: 3600000, timeout: 15000 },
  );
}
/** The tab's preferences as Save preferences sends them. */
export async function profilePrefs() {
  const place = $('#home-place').value.trim(),
    weather = $('#home-weather').checked;
  // A typed place is checked now, so a misspelling shows here, not on the home page.
  if (weather && place && !spot && !state.offline) await geocode(place);
  return {
    name: $('#name').value,
    about: $('#about').value,
    enterSends: $('#enter-sends').checked,
    defaultModel: $('#default-model').value,
    home: {
      quote: $('#home-quote').checked,
      fact: $('#home-fact').checked,
      moon: $('#home-moon').checked,
      weather,
      place,
      ...(spot && !place ? spot : {}),
    },
  };
}
const ghub =
  '<a href="https://github.com/settings/applications" target="_blank" rel="noopener noreferrer">github.com/settings/applications</a>';
const PRIVACY =
  '<section class="setting-card privacy" id="privacy"><h3>Privacy &amp; data</h3>' +
  '<p><strong>Your data.</strong> We don’t train on your chats, and we don’t sell or share your data. It’s used only to run the app for you.</p>' +
  '<p><strong>What we keep, only while your account exists:</strong> your conversations (messages, answers, attachments, artifacts, coding workspaces), your settings and profile, your API keys (encrypted), notification subscriptions, and a log of your last 1,000 requests (time, model, tokens, cost and conversation title — not message content).</p>' +
  '<p><strong>What leaves the app:</strong> messages go to the model provider you pick; searches and page reads go to Ollama (or your own SearXNG). Each provider’s terms cover what it receives — for example, Google’s free Gemini tier may use prompts to improve its products.</p>' +
  '<p><strong>Deleting your account</strong> removes all of it at once. Two copies outside our direct control disappear on their own schedule: Cloudflare deletes coding-workspace snapshots within 30 days and error logs within 7 days; data already sent to providers follows their retention. You can also revoke GitHub access at ' +
  ghub +
  '.</p><p><strong>On this device.</strong> To work offline, this device keeps a copy of your conversations; signing out or deleting your account clears it.</p><p><strong>Weather.</strong> If you turn on weather, your browser asks Open-Meteo for your area’s forecast. Only the place you type, or your location rounded to about 10 km, is saved.</p></section>';
const DANGER =
  '<section class="setting-card danger-zone"><h3>Danger zone</h3><button id="delete-start" class="danger" type="button">Delete account</button>' +
  '<div id="delete-confirm" hidden><p>This permanently deletes your conversations, files, artifacts, settings, keys and history. Type your GitHub username to confirm.</p>' +
  '<input id="delete-login" class="field" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="GitHub username">' +
  '<div class="setting-row"><button id="delete-go" class="danger" type="button" disabled>Delete everything</button><button id="delete-cancel" class="ghost" type="button">Cancel</button></div></div>' +
  '<p class="caption" id="delete-status" role="status"></p></section>';
function showPicture() {
  $('#picture').innerHTML = avatar(initials());
  $('#picture-remove').hidden = !state.avatar;
  sidebar();
}
/** Crops the image to a square and shrinks it, trying lower quality until it fits. */
async function shrink(file) {
  const image = await createImageBitmap(file),
    side = Math.min(image.width, image.height),
    canvas = document.createElement('canvas');
  canvas.width = canvas.height = PICTURE_SIDE;
  canvas
    .getContext('2d')
    .drawImage(
      image,
      (image.width - side) / 2,
      (image.height - side) / 2,
      side,
      side,
      0,
      0,
      PICTURE_SIDE,
      PICTURE_SIDE,
    );
  for (const quality of [0.9, 0.75, 0.5]) {
    const blob = await new Promise(done => canvas.toBlob(done, 'image/webp', quality));
    if (blob && blob.size <= PICTURE_MAX) return blob;
  }
  throw Error('That picture is too large');
}
async function upload(file) {
  const status = $('#picture-status');
  status.textContent = 'Uploading…';
  try {
    const blob = await shrink(file),
      r = await fetch('/api/account/avatar', {
        method: 'PUT',
        headers: { 'Content-Type': blob.type },
        body: blob,
      });
    if (!r.ok) throw Error((await r.json().catch(() => ({}))).error || 'Upload failed');
    state.avatar = Date.now();
    showPicture();
    status.textContent = 'Picture updated.';
  } catch (e) {
    status.textContent = e.message || 'Could not read that image';
  }
}
async function removePicture() {
  const r = await fetch('/api/account/avatar', { method: 'DELETE' });
  if (!r.ok) return toast('Could not remove the picture');
  state.avatar = 0;
  showPicture();
  $('#picture-status').textContent = 'Picture removed.';
}
async function deleteAccount() {
  const status = $('#delete-status');
  $('#delete-go').disabled = true;
  status.textContent = 'Deleting…';
  try {
    await api('/api/account/delete', {
      method: 'POST',
      body: JSON.stringify({ confirm: $('#delete-login').value.trim() }),
    });
    status.textContent = 'Account deleted';
    await clearData();
    setTimeout(() => location.assign('/'), 1500);
  } catch (e) {
    status.textContent = e.message;
    $('#delete-go').disabled = false;
  }
}
/** Connects the panel's controls; call once after its markup is in the page. */
export function wireProfile() {
  const toggle = $('#diag-toggle'),
    label = () => (toggle.textContent = diagnosticsOn() ? 'Turn off' : 'Turn on'),
    developer = $('#developer');
  developer.checked = developerOn();
  $('#dev-tools').hidden = !developer.checked;
  developer.onchange = () => {
    setDeveloper(developer.checked);
    $('#dev-tools').hidden = !developer.checked;
    label();
  };
  $('#debug-copy').onclick = async () => copy(await debugReport());
  label();
  toggle.onclick = () => {
    diagnostics(!diagnosticsOn());
    label();
  };
  showPicture();
  showWhere();
  $('#home-weather').onchange = showWhere;
  $('#home-place').oninput = () => {
    spot = null; // a typed place replaces the location
    showWhere();
  };
  $('#home-locate').onclick = locate;
  $('#picture-upload').onclick = () => $('#picture-file').click();
  $('#picture-file').onchange = e => {
    if (e.target.files[0]) upload(e.target.files[0]);
    e.target.value = '';
  };
  $('#picture-remove').onclick = removePicture;
  $('#delete-start').onclick = () => {
    $('#delete-confirm').hidden = false;
    $('#delete-login').focus();
  };
  $('#delete-cancel').onclick = () => {
    $('#delete-confirm').hidden = true;
    $('#delete-login').value = '';
    $('#delete-go').disabled = true;
  };
  $('#delete-login').oninput = e =>
    ($('#delete-go').disabled =
      e.target.value.trim().toLowerCase() !== state.user.login.toLowerCase());
  $('#delete-go').onclick = deleteAccount;
}
