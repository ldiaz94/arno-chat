/** Composer attachments: files and images are uploaded to the open session as soon as they
 * are picked, pasted or dropped, shown as chips above the prompt, and sent by id with the
 * message. Offline (or in a chat made offline) a picked file stays on the device, kept by
 * the outbox until it can be uploaded. A file picked in a new chat first makes the chat.
 * Also renders attachments of saved messages. Depends on core, sessions and queue.mjs.
 */
import { $, state, esc, icon, toast, showError, unreachable } from './core.js';
import { isLocal } from './queue.mjs';
import { persist } from './sessions.js';

// Most files that may be attached to one message.
const MaxFiles = 8;
// Bytes in a megabyte.
const MB = 1024 * 1024;
// The server's size limits (server/probe/attachments.mjs), checked here for files kept offline.
const LIMITS = { image: 5 * MB, text: MB };
// Chips of the composer: { key, sid, name, size, kind, type, id?, file?, preview?, status }.
// status is 'uploading' or 'ready'; preview is an object URL for a picked image; file is
// the picked file while it is not uploaded (offline).
let chips = [];

// A byte count as text: "312 B", "4.2 KB" or "1.1 MB".
export function bytes(n) {
  return n < 1024
    ? n + ' B'
    : n < 1048576
      ? (n / 1024).toFixed(1) + ' KB'
      : (n / 1048576).toFixed(1) + ' MB';
}
// The address of a saved attachment.
const url = (sid, id) => '/api/sessions/' + sid + '/attachments/' + id;

/** HTML for the attachments of a saved message: image thumbnails that open full size,
 * and file chips that download. */
export function attachmentsHtml(sid, list) {
  return (list || [])
    .map(a =>
      a.kind === 'image'
        ? '<a class="attach-thumb" href="' +
          url(sid, a.id) +
          '" target="_blank" rel="noopener"><img src="' +
          url(sid, a.id) +
          '" alt="' +
          esc(a.name) +
          '" loading="lazy" decoding="async"></a>'
        : '<a class="attach-chip" href="' +
          url(sid, a.id) +
          '" download="' +
          esc(a.name) +
          '"><span class="attach-name">' +
          esc(a.name) +
          '</span><small>' +
          bytes(a.size) +
          '</small></a>',
    )
    .join('');
}

// Redraws the chips above the prompt.
function render() {
  const box = $('#attach-chips');
  box.hidden = !chips.length;
  box.innerHTML = chips
    .map(c => {
      const src = c.preview || (c.kind === 'image' && c.id ? url(c.sid, c.id) : '');
      return (
        '<span class="attach-chip' +
        (c.status === 'uploading' ? ' uploading' : '') +
        '">' +
        (c.status === 'uploading'
          ? '<span class="spinner"></span>'
          : src
            ? '<img src="' + src + '" alt="">'
            : '') +
        '<span class="attach-name">' +
        esc(c.name) +
        '</span><small>' +
        bytes(c.size) +
        '</small><button type="button" class="attach-remove" data-key="' +
        c.key +
        '" aria-label="Remove ' +
        esc(c.name) +
        '">×</button></span>'
      );
    })
    .join('');
}

// Forgets a chip and frees its image preview.
function drop(c) {
  if (c.preview) URL.revokeObjectURL(c.preview);
  chips = chips.filter(x => x !== c);
}

/** Uploads a file to a conversation and returns its metadata. Errors carry the
 * reply's `status`, or `network` when there was no network. */
export async function uploadFile(sid, file) {
  let r;
  try {
    r = await fetch('/api/sessions/' + sid + '/attachments', {
      method: 'POST',
      body: file,
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
      },
    });
  } catch {
    throw unreachable();
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(Error(d.error || 'Upload failed'), { status: r.status });
  return { id: d.id, name: d.name, size: d.size, kind: d.kind, type: file.type };
}

// Uploads one picked file to the open session (or keeps it for the outbox when offline) and
// shows its chip.
async function upload(file) {
  if (!(await persist())) return;
  const sid = state.session.id,
    kind = file.type.startsWith('image/') ? 'image' : 'text',
    chip = {
      key: crypto.randomUUID(),
      sid,
      name: file.name,
      size: file.size,
      kind,
      type: file.type,
      status: 'uploading',
      preview: kind === 'image' ? URL.createObjectURL(file) : '',
    };
  // Offline the file waits on the device; the outbox uploads it before its message.
  if (state.offline || isLocal(sid)) {
    if (file.size > LIMITS[kind]) {
      if (chip.preview) URL.revokeObjectURL(chip.preview);
      return toast(
        (kind === 'image' ? 'Images' : 'Text files') +
          ' are limited to ' +
          LIMITS[kind] / MB +
          ' MB',
      );
    }
    chips.push(Object.assign(chip, { file, status: 'ready' }));
    return render();
  }
  chips.push(chip);
  render();
  try {
    Object.assign(chip, await uploadFile(sid, file), { status: 'ready' });
  } catch (e) {
    drop(chip);
    showError(e);
  }
  if (!chips.includes(chip)) return render(); // removed or the session changed meanwhile
  if (chip.sid !== state.session?.id) drop(chip);
  render();
}

/** Upload the given files to the open conversation. */
export function addFiles(files) {
  if (!state.session) return;
  for (const file of files) {
    if (chips.length >= MaxFiles) return toast('At most ' + MaxFiles + ' attachments per message');
    upload(file);
  }
}

// Whether any file is still being uploaded.
export const uploading = () => chips.some(c => c.status === 'uploading');

/** Take the ready attachments for sending: returns their metadata and empties the chips. */
export function takeReady() {
  const ready = chips
    .filter(c => c.status === 'ready')
    .map(({ id, name, type, size, kind, file }) => ({ id, name, type, size, kind, file }));
  clearAttachments();
  return ready;
}

/** Put attachments back in the composer (a rejected send). */
export function restore(list) {
  if (chips.length || !state.session) return;
  chips = list.map(a => ({
    ...a,
    key: crypto.randomUUID(),
    sid: state.session.id,
    status: 'ready',
  }));
  render();
}

// Empties the chips, for example when the conversation changes.
export function clearAttachments() {
  for (const c of chips) if (c.preview) URL.revokeObjectURL(c.preview);
  chips = [];
  render();
}

// Files carried by a paste or drop event, if any.
const filesOf = data => [...(data?.files || [])];

// The paperclip button and the hidden file input behind it.
const attachButton = $('#attach'),
  input = $('#attach-input');
attachButton.innerHTML = icon('clip');
attachButton.onclick = () => input.click();
input.onchange = () => {
  addFiles([...input.files]);
  input.value = '';
};
$('#attach-chips').onclick = e => {
  const key = e.target.closest('.attach-remove')?.dataset.key,
    chip = chips.find(c => c.key === key);
  if (chip) {
    drop(chip);
    render();
  }
};
$('#prompt').addEventListener('paste', e => {
  const files = filesOf(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
// Drag and drop onto the page; the depth counter copes with enter/leave of children.
let depth = 0;
// Whether a drag carries files, as opposed to text or a link.
const hasFiles = e => e.dataTransfer?.types?.includes('Files');
document.addEventListener('dragenter', e => {
  if (!hasFiles(e) || !state.session) return;
  depth++;
  document.body.classList.add('drop-active');
});
document.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  depth = Math.max(0, depth - 1);
  if (!depth) document.body.classList.remove('drop-active');
});
document.addEventListener('dragover', e => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  document.body.classList.remove('drop-active');
  addFiles(filesOf(e.dataTransfer));
});
