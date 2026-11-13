/** The account dialog's "You" tab: what the assistant should know about the
 * user, the profile picture, the composer and default model, display, memory,
 * the home page's widgets, the privacy notice and account deletion. Depends on
 * core, layout, models, home and offline.
 */
import { $, state, esc, api, avatar, toast, copy, display } from './core.js';
import { modelLabel, pickModel } from './models.js';
import { sidebar } from './layout.js';
import { geocode } from './home.js';
import { clearData } from './offline.js';
import { diagnostics, diagnosticsOn, developerOn, setDeveloper, debugReport } from './diag.js';
import { appVersion, checkForUpdate } from './update.js';
const PICTURE_SIDE = 256; // pictures are shrunk to this many pixels square before upload
const PICTURE_MAX = 256 * 1024; // the server's size limit, in bytes
// Two capital letters for the profile picture when there is none.
const initials = () => (state.user?.login || 'A').slice(0, 2).toUpperCase();
/** One setting as a row: the label and a one-line hint on the left, the
 * control on the right (stacked on a phone). `hint` and `control` are markup;
 * `forId` ties the label to its control; `wide` stacks a big control (a
 * text area) under the label even on a wide screen. */
export function pref(label, hint, control, { forId = '', wide = false } = {}) {
  const name = forId
    ? `<label class="pref-label" for="${forId}">${label}</label>`
    : `<span class="pref-label">${label}</span>`;
  return (
    `<div class="pref${wide ? ' wide' : ''}"><div class="pref-text">${name}` +
    (hint ? `<span class="pref-hint">${hint}</span>` : '') +
    `</div><div class="pref-control">${control}</div></div>`
  );
}
/** A pill group of 2 or 3 radio choices: {label, name, choices: [value,
 * words, extra attributes], current}. Real radio inputs, so keys work. */
export function segmented({ label, name, choices, current }) {
  return (
    `<div class="seg" role="radiogroup" aria-label="${esc(label)}">` +
    choices
      .map(
        ([value, words, attrs = '']) =>
          `<label><input type="radio" name="${name}" value="${value}" ${attrs}` +
          (String(value) === String(current) ? ' checked' : '') +
          `><span>${esc(words)}</span></label>`,
      )
      .join('') +
    '</div>'
  );
}
/** An on/off switch: a checkbox that looks like one. */
const toggle = (id, on) =>
  `<input type="checkbox" role="switch" id="${id}"${on ? ' checked' : ''}>`;
/** Rows under a heading; `note` is a short aside, `kind` an extra class. */
export function group(title, id, rows, { note = '', kind = '' } = {}) {
  return (
    `<section class="pref-group ${kind}" id="${id}"><h3>${title}` +
    (note ? ` <small>${note}</small>` : '') +
    `</h3>${rows}</section>`
  );
}
// What filterPrefs hides: a setting row, or a card with no rows in it; and those still shown.
const ITEMS = '.pref, .setting-card:not(:has(.pref))';
const SHOWN = '.pref:not(.pref-miss), .setting-card:not(:has(.pref)):not(.pref-miss)';
/** Hides the settings whose words lack `query`, and the groups left empty;
 * an empty query shows everything. It covers every tab, so a tab switch
 * needs no re-run. */
export function filterPrefs(query) {
  const q = query.trim().toLowerCase();
  for (const panel of document.querySelectorAll('[data-account-panel]')) {
    for (const n of panel.querySelectorAll(ITEMS))
      n.classList.toggle('pref-miss', q !== '' && !n.textContent.toLowerCase().includes(q));
    for (const g of panel.querySelectorAll('.pref-group'))
      g.classList.toggle('pref-miss', !g.querySelector(SHOWN));
    if (!panel.hidden) $('#pref-none').hidden = q === '' || !!panel.querySelector(SHOWN);
  }
}
/** The panel's markup. `account` is the profile from GET /api/account. */
export function profilePanel(account) {
  return (
    '<section data-account-panel="you">' +
    profileGroup(account) +
    composerCard(account) +
    displayCard(display(account)) +
    memoryCard(account) +
    homeCard(account.home || {}) +
    moreGroup() +
    '</section>'
  );
}
// The profile: picture, name and what the assistant should know.
function profileGroup(account) {
  const buttons =
    '<span class="avatar picture" id="picture"></span><button id="picture-upload" class="ghost" type="button">Upload</button><input id="picture-file" type="file" hidden accept="image/png,image/jpeg,image/webp"><button id="picture-remove" class="ghost" type="button">Remove</button>';
  return group(
    'Profile',
    'profile-card',
    pref(
      'Picture',
      '<span id="picture-status">Shown next to your messages; shrunk to 256 × 256.</span>',
      buttons,
    ) +
      pref(
        'Your name',
        'What Arno calls you.',
        `<input id="name" class="field" maxlength="80" autocomplete="name" placeholder="Your name" value="${esc(account.name)}">`,
        { forId: 'name' },
      ) +
      pref(
        'About you',
        'Sent to every model with each request. Up to 8,000 characters.',
        `<textarea id="about" class="field" rows="4" maxlength="8000" placeholder="Name, role, preferences…">${esc(account.about)}</textarea>`,
        { forId: 'about', wide: true },
      ),
  );
}
// The About, Developer mode, Privacy and Delete account block: rarely used, so last and quiet.
function moreGroup() {
  const tools = (label, control) => pref(label, '', control);
  return (
    group(
      'About and account',
      'more-card',
      pref(
        'Version',
        '<span id="about-build"></span>',
        '<span id="about-version" class="pref-hint"></span><button type="button" id="update-check" class="ghost">Check for updates</button>',
      ) +
        pref(
          'Developer mode',
          'Tools for debugging the app on this device.',
          toggle('developer', false),
          { forId: 'developer' },
        ) +
        '<div id="dev-tools" hidden>' +
        tools(
          'Layout diagnostics',
          '<button type="button" id="diag-toggle" class="ghost"></button>',
        ) +
        tools('Debug report', '<button type="button" id="debug-copy" class="ghost">Copy</button>') +
        tools(
          'GitHub connection check',
          '<button type="button" id="github-check" class="ghost">Check</button>',
        ) +
        '<pre id="github-check-out" class="debug-out" hidden></pre></div>',
      { kind: 'quiet' },
    ) +
    PRIVACY +
    DANGER
  );
}
/** A model setting's button: the model chosen (its provider's mark and
 * name) or blank's label, opening the model picker (models.js pickModel)
 * when pressed; its value is in data-value. */
function modelField(id, chosen, blank) {
  return (
    '<button type="button" class="field model-field" id="' +
    id +
    '" data-value="' +
    esc(chosen) +
    '" data-blank="' +
    esc(blank) +
    '">' +
    (chosen ? modelLabel(chosen) : '<span>' + esc(blank) + '</span>') +
    '<span aria-hidden="true">⌄</span></button>'
  );
}
/** What each model setting's picker is called, the models it offers, and the
 * note it shows (a model setting's detail lives here, not in the form). */
const MODEL_FIELDS = {
  'default-model': { title: 'Default model' },
  'review-model': {
    title: 'Review model',
    only: m => m.vision,
    caption:
      'Only models that see images are listed: the review looks at screenshots. A stronger model catches more; it costs one extra call per page.',
  },
  'worker-model': {
    title: 'Worker model',
    caption:
      'The model a coding turn hands steps to (reading, searching, mechanical edits), as cheap as will do; the session’s model stays the lead and takes the hard steps. It must be on the session’s provider, else workers use the session’s model.',
  },
};
// A model setting's button opens the picker; the model picked is shown and kept.
document.addEventListener('click', async e => {
  const field = e.target.closest('.model-field');
  if (!field) return;
  const { title, only, caption } = MODEL_FIELDS[field.id];
  const id = await pickModel({
    title,
    current: field.dataset.value,
    blank: ['', field.dataset.blank],
    only,
    caption,
  });
  if (id == null) return;
  field.dataset.value = id;
  field.innerHTML =
    (id ? modelLabel(id) : '<span>' + esc(field.dataset.blank) + '</span>') +
    '<span aria-hidden="true">⌄</span>';
});
// The composer settings: send key and the three model settings.
function composerCard(account) {
  const model = (id, label, hint, blank, value) =>
    pref(label, hint, modelField(id, value || '', blank), { forId: id });
  return group(
    'Composer and models',
    'composer-card',
    pref(
      'Enter key',
      'The other combination, ⌘ / Ctrl + Enter or Shift + Enter, does the opposite.',
      segmented({
        label: 'Enter key',
        name: 'enter-key',
        current: account.enterSends === true ? 'send' : 'line',
        choices: [
          ['send', 'Sends', 'id="enter-sends"'],
          ['line', 'New line', 'id="enter-line"'],
        ],
      }),
    ) +
      model(
        'default-model',
        'Default model',
        'New chats and sessions start with this one.',
        'App default',
        account.defaultModel,
      ) +
      model(
        'review-model',
        'Review model',
        'Checks built pages with screenshots. Only models that see images.',
        'Same as the chat',
        account.reviewModel,
      ) +
      model(
        'worker-model',
        'Worker model',
        'Does a coding turn’s routine steps; cheap will do.',
        'Same as the session',
        account.workerModel,
      ),
  );
}
/** The Display settings: [key, label, its choices as [value, words], a hint];
 * the first choice is the default (server/account.mjs DISPLAY). Two or
 * three choices are a pill group, more a list. */
const DISPLAY_ROWS = [
  [
    'meters',
    'Composer meters',
    [
      ['alternate', 'Context and cost, taking turns on a phone'],
      ['both', 'Context and cost, side by side'],
      ['context', 'Context only'],
      ['cost', 'Cost only'],
      ['off', 'Neither'],
    ],
    'Beside the model: how full its context is, and the cost.',
  ],
  [
    'thinking',
    'Model thinking',
    [
      ['folded', 'Folded'],
      ['open', 'Open'],
      ['hidden', 'Hidden'],
    ],
    'How the reasoning shows under an answer.',
  ],
  [
    'stats',
    'Under each answer',
    [
      [true, 'Time, tokens, cost'],
      [false, 'Nothing'],
    ],
    '',
  ],
  [
    'width',
    'Conversation width',
    [
      ['readable', 'Readable column'],
      ['wide', 'Full window'],
    ],
    '',
  ],
  [
    'follow',
    'While an answer streams',
    [
      [true, 'Scroll with it'],
      [false, 'Stay put'],
    ],
    'Stay put leaves a ↓ button to jump to the end.',
  ],
];
// One display setting's control: a pill group, or a list for five choices.
function displayControl(key, label, choices, current) {
  if (choices.length <= 3)
    return segmented({
      label,
      name: 'display-' + key,
      current,
      choices: choices.map(([v, words]) => [v, words, `data-display="${key}"`]),
    });
  return (
    `<select class="field" id="display-${key}" data-display="${key}">` +
    choices
      .map(
        ([v, words]) =>
          `<option value="${v}"${current === v ? ' selected' : ''}>${esc(words)}</option>`,
      )
      .join('') +
    '</select>'
  );
}
// The display settings, a row each.
function displayCard(d) {
  return group(
    'Display',
    'display-card',
    DISPLAY_ROWS.map(([key, label, choices, hint]) =>
      pref(label, esc(hint), displayControl(key, label, choices, d[key]), {
        forId: choices.length > 3 ? 'display-' + key : '',
      }),
    ).join(''),
    { note: 'on every device you sign in on' },
  );
}
/** The Display settings' choices, as saved: true and false back to booleans. */
function displayPrefs() {
  const chosen = [...document.querySelectorAll('[data-display]')].filter(
    n => n.type !== 'radio' || n.checked,
  );
  return Object.fromEntries(
    chosen.map(n => [
      n.dataset.display,
      n.value === 'true' ? true : n.value === 'false' ? false : n.value,
    ]),
  );
}
let spot = null; // the weather's place as rounded coordinates, from "Use my location"
// The home page settings: which widgets show and where the weather is.
function homeCard(home) {
  spot = home.lat != null ? { lat: home.lat, lon: home.lon } : null;
  const box = (id, label, hint, on) =>
    pref(label, hint, toggle('home-' + id, on), { forId: 'home-' + id });
  return group(
    'Home page',
    'home-card',
    box('quote', 'Quote of the day', '', home.quote !== false) +
      box('fact', 'Interesting fact', '', home.fact !== false) +
      box('moon', 'Moon phase', '', home.moon !== false) +
      box('weather', 'Weather', 'From Open-Meteo.', home.weather === true) +
      '<div id="weather-where">' +
      pref(
        'Place',
        '<span id="home-where" role="status"></span>',
        `<input id="home-place" class="field" maxlength="100" placeholder="A city, e.g. Lisbon" value="${esc(home.place || '')}"><button id="home-locate" class="ghost" type="button" data-online="Reconnect to find your location">Use my location</button>`,
        { forId: 'home-place' },
      ) +
      '</div>',
    { note: 'the Today card' },
  );
}
// Shows or hides the weather's place line and describes the chosen place.
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
    defaultModel: $('#default-model').dataset.value,
    reviewModel: $('#review-model').dataset.value,
    workerModel: $('#worker-model').dataset.value,
    display: displayPrefs(),
    memory: $('#memory-mode').value,
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
// A link to the GitHub applications page, where access is revoked.
const ghub =
  '<a href="https://github.com/settings/applications" target="_blank" rel="noopener noreferrer">github.com/settings/applications</a>';
// The privacy notice, as markup: folded, as it is long and read once.
const PRIVACY =
  '<details class="pref-more setting-card privacy" id="privacy"><summary>Privacy &amp; data</summary>' +
  '<p><strong>Your data.</strong> We don’t train on your chats, and we don’t sell or share your data. It’s used only to run the app for you.</p>' +
  '<p><strong>What we keep, only while your account exists:</strong> your conversations (messages, answers, attachments, artifacts, coding workspaces), your settings and profile, your API keys (encrypted), notification subscriptions, and a log of your last 1,000 requests (time, model, tokens, cost and conversation title — not message content).</p>' +
  '<p><strong>What leaves the app:</strong> messages go to the model provider you pick; searches and page reads go to Ollama (or your own SearXNG). Each provider’s terms cover what it receives — for example, Google’s free Gemini tier may use prompts to improve its products.</p>' +
  '<p><strong>Deleting your account</strong> removes all of it at once. Two copies outside our direct control disappear on their own schedule: Cloudflare deletes coding-workspace snapshots within 30 days and error logs within 7 days; data already sent to providers follows their retention. You can also revoke GitHub access at ' +
  ghub +
  '.</p><p><strong>On this device.</strong> To work offline, this device keeps a copy of your conversations; signing out or deleting your account clears it.</p><p><strong>Weather.</strong> If you turn on weather, your browser asks Open-Meteo for your area’s forecast. Only the place you type, or your location rounded to about 10 km, is saved.</p></details>';
// The account deletion row, with its confirmation, as markup.
const DANGER =
  '<section class="pref-group quiet danger-zone">' +
  pref(
    'Delete account',
    'Removes everything, for good.',
    '<button id="delete-start" class="danger" type="button">Delete account</button>',
  ) +
  '<div id="delete-confirm" hidden><p>This permanently deletes your conversations, files, artifacts, settings, keys and history. Type your GitHub username to confirm.</p>' +
  '<input id="delete-login" class="field" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="GitHub username">' +
  '<div class="setting-row"><button id="delete-go" class="danger" type="button" disabled>Delete everything</button><button id="delete-cancel" class="ghost" type="button">Cancel</button></div></div>' +
  '<p class="caption" id="delete-status" role="status"></p></section>';
// Shows the profile picture (or initials) and its Remove button.
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
// Shrinks a picked picture, uploads it and shows it.
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
// Deletes the profile picture on the server.
async function removePicture() {
  const r = await fetch('/api/account/avatar', { method: 'DELETE' });
  if (!r.ok) return toast('Could not remove the picture');
  state.avatar = 0;
  showPicture();
  $('#picture-status').textContent = 'Picture removed.';
}
// Deletes the account after the typed confirmation, then reloads.
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
/** The About card: the version this device runs and the server's build. */
async function showVersion() {
  const v = await appVersion(),
    b = state.build || {};
  $('#about-version').textContent =
    'Arno Chat ' + (v ? v.replace(/^v/, 'version ') : '(no offline copy)');
  $('#about-build').textContent = b.commit
    ? 'Server build ' + b.commit + (b.deployed ? ', deployed ' + b.deployed : '')
    : '';
}
/** Connects the panel's controls; call once after its markup is in the page. */
export function wireProfile() {
  showVersion();
  $('#update-check').onclick = async () => {
    const b = $('#update-check');
    b.disabled = true;
    b.textContent = 'Checking…';
    const waiting = await checkForUpdate();
    b.disabled = false;
    b.textContent = 'Check for updates';
    toast(waiting ? 'A new version is ready: tap Update' : 'You have the latest version');
  };
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
  $('#github-check').onclick = async () => {
    const out = $('#github-check-out');
    out.hidden = false;
    out.textContent = 'Checking…';
    try {
      out.textContent = JSON.stringify(await api('/api/github/check'), null, 2);
    } catch (e) {
      out.textContent = e.message;
    }
  };
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
  wireMemories();
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
/** The Memory setting's choices (server/chat/memory.mjs MEMORY_MODES). */
const MEMORY_CHOICES = [
  ['asked', 'Only when I ask'],
  ['auto', 'When I ask, and on its own'],
  ['off', 'Off'],
];
// The Memory group: who saves memories, and each saved one by title, opening
// to its fact and a Forget button.
function memoryCard(account) {
  const list = account.memories || [];
  const mode =
    '<select class="field" id="memory-mode">' +
    MEMORY_CHOICES.map(
      ([v, words]) =>
        `<option value="${v}"${account.memory === v ? ' selected' : ''}>${words}</option>`,
    ).join('') +
    '</select>';
  return group(
    'Memory',
    'memory-card',
    pref(
      'Save memories',
      'Facts chats remember about you. Say “remember that …” to add one.',
      mode,
      { forId: 'memory-mode' },
    ) +
      (list.length
        ? '<ul class="memory-list">' +
          list
            .map(
              m =>
                '<li><details data-memory="' +
                esc(m.id) +
                '"><summary>' +
                esc(m.title) +
                '</summary><p class="memory-fact"></p><button type="button" class="ghost" data-forget="' +
                esc(m.id) +
                '">Forget</button></details></li>',
            )
            .join('') +
          '</ul>'
        : '<p class="caption">Nothing remembered yet.</p>'),
  );
}
// A memory opened shows its fact, read once; a Forget button forgets its
// memory at once, without Save preferences.
function wireMemories() {
  for (const d of document.querySelectorAll('[data-memory]'))
    d.ontoggle = async () => {
      const fact = d.querySelector('.memory-fact');
      if (!d.open || fact.textContent) return;
      try {
        const m = await api('/api/account/memory', {
          method: 'POST',
          body: JSON.stringify({ recall: d.dataset.memory }),
        });
        fact.textContent = m.fact || 'Not found.';
      } catch (e) {
        toast(e.message);
      }
    };
  for (const b of document.querySelectorAll('[data-forget]'))
    b.onclick = async () => {
      try {
        await api('/api/account/memory', {
          method: 'POST',
          body: JSON.stringify({ remove: b.dataset.forget }),
        });
        b.closest('li').remove();
      } catch (e) {
        toast(e.message);
      }
    };
}
