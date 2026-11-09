/** The account dialog's "You" tab: what the assistant should know about the user, the
 * profile picture, the privacy notice and account deletion. Depends on core, layout and offline.
 */
import { $, state, esc, api, avatar, toast } from './core.js';
import { sidebar } from './layout.js';
import { clearData } from './offline.js';
const PICTURE_SIDE = 256; // pictures are shrunk to this many pixels square before upload
const PICTURE_MAX = 256 * 1024; // the server's size limit, in bytes
const initials = () => (state.user?.login || 'A').slice(0, 2).toUpperCase();
/** The panel's markup. `account` is the profile from GET /api/account. */
export function profilePanel(account) {
  return (
    '<section data-account-panel="you">' +
    '<section class="setting-card"><strong>Picture</strong><div class="picture-row"><span class="avatar picture" id="picture"></span><div class="setting-row"><button id="picture-upload" class="ghost" type="button">Upload</button><input id="picture-file" type="file" hidden accept="image/png,image/jpeg,image/webp"><button id="picture-remove" class="ghost" type="button">Remove</button></div></div><p class="caption" id="picture-status">Shown next to your messages. Large photos are shrunk to 256 × 256 pixels.</p></section>' +
    '<label>About you<textarea id="about" class="field" rows="5" maxlength="2000" placeholder="What should the assistant know about you? (name, role, preferences)">' +
    esc(account.about) +
    '</textarea></label><p class="caption">Up to 2,000 characters, sent to every model with each request. Saved with Save preferences.</p>' +
    PRIVACY +
    DANGER +
    '</section>'
  );
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
  '.</p><p><strong>On this device.</strong> To work offline, this device keeps a copy of your conversations; signing out or deleting your account clears it.</p></section>';
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
  showPicture();
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
