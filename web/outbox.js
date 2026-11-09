/** The outbox: what the user does with no network waits on this device and is
 * sent once the network is back. Messages (with the files picked for them), new
 * chats, renames and saved preferences are kept in IndexedDB (database 'arno',
 * store 'outbox'); queue.mjs holds the rules (order, merging, clashes).
 *
 *   offline: send ──> outbox ──> "Queued · sends when online" in the thread
 *   online:  per conversation, oldest first, one turn at a time:
 *            chat ─POST /api/chats─> real id ─> its messages and renames
 *            message ─upload files─> POST …/messages ─> wait for the job
 *            rename, profile ─GET current─> changed elsewhere? ask ─> PATCH/POST
 *
 * Conversations send in parallel; a message the server refuses (a 400) pauses
 * its own conversation until it is retried, edited or cancelled. Sending starts
 * when the network comes back, when the app starts and when it comes to the
 * front: there is no Background Sync, so the app must be open (as on iPhone,
 * which has none). Depends on core, layout, thread, turns, attach, models,
 * offline and queue.mjs.
 */
import { Outbox, isLocal, conflicted } from './queue.mjs';
import { $, state, esc, api, toast, showError } from './core.js';
import { sidebar, title, bump } from './layout.js';
import { message, failure, scrollDown } from './thread.js';
import { watchJob } from './turns.js';
import { uploadFile, bytes } from './attach.js';
import { moveOptions } from './options.js';
import { loadModels } from './models.js';
import { banner } from './offline.js';

const JOB_POLL = 2000; // ms between checks of a conversation's running turn
const JOB_POLLS = 900; // checks before giving up on a turn that never ends (30 min)
const NEW_CHAT_TITLE = 'General chat'; // the name the server gives a new chat
// The badge of a waiting message, by its state.
const BADGE = { queued: 'Queued · sends when online', sending: 'Sending…', failed: 'Not sent' };

/** The IndexedDB store, behind the storage interface queue.mjs expects. */
function database() {
  let db;
  const open = () =>
    (db ||= new Promise((done, fail) => {
      const r = indexedDB.open('arno', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'key' });
      r.onsuccess = () => done(r.result);
      r.onerror = () => fail(r.error);
    }));
  const run = async (mode, act) => {
    const t = (await open()).transaction('outbox', mode),
      request = act(t.objectStore('outbox'));
    return new Promise((done, fail) => {
      t.oncomplete = () => done(request.result);
      t.onerror = t.onabort = () => fail(t.error);
    });
  };
  return {
    all: () => run('readonly', s => s.getAll()),
    put: e => run('readwrite', s => s.put(e)),
    delete: key => run('readwrite', s => s.delete(key)),
    clear: () => run('readwrite', s => s.clear()),
  };
}

const outbox = new Outbox(database());
let loaded = false; // the stored entries are read (startOutbox)
const lines = new Map(); // line (session id or 'profile') -> its running sender
let pass = null; // { done } while sending: entries sent so far, for the banner

/** Whether a conversation has entries waiting (of the given kind, or any). */
export const waiting = (id, kind) =>
  outbox.entries.some(e => e.sessionId === id && (!kind || e.kind === kind));

/** What the banner shows: entries waiting, and progress while sending. */
export function outboxStatus() {
  const left = outbox.entries.filter(e => e.kind !== 'chat' && e.state !== 'failed').length;
  return { waiting: left, sending: !!pass, done: pass?.done || 0, total: (pass?.done || 0) + left };
}

/** A chat made offline, shaped like a session from the server, or null. */
export function localChat(id) {
  const e = outbox.entries.find(x => x.kind === 'chat' && x.sessionId === id);
  if (!e) return null;
  const rename = outbox.entries.find(x => x.kind === 'rename' && x.sessionId === id);
  return {
    id,
    kind: 'chat',
    model: e.body.model,
    title: rename?.body.title || NEW_CHAT_TITLE,
    createdAt: e.createdAt,
    updatedAt: e.createdAt,
    history: [],
  };
}

/** Reads the outbox at boot: chats made offline join the session list, waiting
 * renames show their new names. Sending starts with the next flush(). */
export async function startOutbox() {
  try {
    await outbox.load();
    loaded = true;
  } catch {
    return; // no IndexedDB (a private window in some browsers): nothing waits
  }
  const local = outbox.entries.filter(e => e.kind === 'chat').map(e => localChat(e.sessionId));
  state.sessions = [...local.reverse(), ...state.sessions.filter(s => !isLocal(s.id))];
  for (const e of outbox.entries)
    if (e.kind === 'rename')
      state.sessions = state.sessions.map(s =>
        s.id === e.sessionId ? { ...s, title: e.body.title } : s,
      );
  banner();
}

/** Keeps a message to send later. body is { id, prompt }; attachments are
 * uploaded ones ({ id, … }) or files picked offline ({ file, … }). */
export async function queueMessage(sessionId, body, attachments = []) {
  try {
    await outbox.add({
      kind: 'message',
      sessionId,
      body: { id: body.id, prompt: body.prompt },
      attachments,
    });
  } catch (e) {
    return showError(e);
  }
  showQueued();
  scrollDown(true);
  flush();
}

/** Makes a chat on this device, to be made on the server once online; returns
 * its session list row. */
export async function queueChat(model) {
  const id = 'local-' + crypto.randomUUID();
  await outbox.add({ kind: 'chat', sessionId: id, body: { model } });
  return localChat(id);
}

/** Keeps a rename to send later; base is the name it replaces, to spot a
 * rename made meanwhile on another device. */
export async function queueRename(id, newTitle, base) {
  await outbox.edit('rename', id, { title: newTitle }, isLocal(id) ? undefined : base);
  banner();
  flush();
}

/** Keeps saved preferences to send later; base is the profile's updatedAt. */
export async function queueProfile(body, base) {
  await outbox.edit('profile', null, body, base);
  banner();
  flush();
}

/** Why a chat made offline couldn't be created on the server, or null. */
export function chatFailure(id) {
  const e = outbox.entries.find(x => x.kind === 'chat' && x.sessionId === id);
  return e?.state === 'failed' ? e.error || 'The server refused it.' : null;
}

/** Tries creating a failed offline chat again; its waiting messages follow. */
export async function retryChat(id) {
  const e = outbox.entries.find(x => x.kind === 'chat' && x.sessionId === id);
  if (!e) return;
  await outbox.update(e.key, { state: 'queued', error: undefined });
  banner();
  flush();
}

/** Drops a chat made offline, with everything waiting for it. */
export async function dropSession(id) {
  await outbox.dropSession(id);
  banner();
}

/** Deletes everything waiting (sign-out, account deletion). */
export async function clearOutbox() {
  try {
    await outbox.clear();
  } catch {
    // No IndexedDB: nothing was kept.
  }
}

/** Object URLs and chips for the files of a waiting message. */
function filesHtml(list) {
  return list
    .map(a =>
      a.kind === 'image' && a.file
        ? '<span class="attach-thumb"><img src="' +
          URL.createObjectURL(a.file) +
          '" alt="' +
          esc(a.name) +
          '"></span>'
        : '<span class="attach-chip"><span class="attach-name">' +
          esc(a.name) +
          '</span><small>' +
          bytes(a.size) +
          '</small></span>',
    )
    .join('');
}

/** One waiting message in the thread: badge, Edit and Cancel; a refused one
 * also gets the failure card with Retry, Edit and Cancel. */
function showEntry(e, box) {
  const node = message('You', e.body.prompt);
  node.classList.add('queued');
  node.querySelector('.edit-message')?.remove();
  node
    .querySelector('.spacer')
    .insertAdjacentHTML(
      'afterend',
      '<span class="queued-badge">' +
        BADGE[e.state] +
        '</span>' +
        (e.state === 'queued'
          ? '<button type="button" class="edit-message">Edit</button><button type="button" class="edit-message">Cancel</button>'
          : ''),
    );
  if (e.attachments?.length)
    node.insertAdjacentHTML(
      'beforeend',
      '<div class="message-attachments">' + filesHtml(e.attachments) + '</div>',
    );
  box.append(node);
  const [edit, cancel] = node.querySelectorAll('.turn-header button');
  if (edit) edit.onclick = () => editEntry(node, e.key);
  if (cancel) cancel.onclick = () => cancelEntry(e.key);
  if (e.state !== 'failed') return;
  const card = failure(e.body.prompt, e.error);
  card
    .querySelector('.failure-actions')
    .insertAdjacentHTML(
      'afterbegin',
      '<button type="button" class="ghost">Cancel</button><button type="button">Edit</button>',
    );
  const [drop, change, retry] = card.querySelectorAll('button');
  drop.onclick = () => cancelEntry(e.key);
  change.onclick = () => editEntry(node, e.key);
  retry.onclick = () => retryEntry(e.key);
  box.append(card);
}

/** Shows the open conversation's waiting messages at the end of its thread,
 * and refreshes the banner and the session list's marks. */
export function showQueued() {
  banner();
  sidebar();
  const thread = $('#thread');
  if (!thread || !state.session) return;
  thread.querySelector(':scope > .outbox-items')?.remove();
  const list = outbox.of(state.session.id).filter(e => e.kind === 'message');
  if (!list.length) return;
  thread.querySelector('.starter')?.remove();
  const box = document.createElement('div');
  box.className = 'outbox-items';
  thread.append(box);
  for (const e of list) showEntry(e, box);
}

/** Edits a waiting message's text in place; saving queues it again. */
function editEntry(node, key) {
  const e = outbox.get(key);
  if (!e || e.state === 'sending') return;
  const box = node.querySelector('.user-content');
  box.innerHTML =
    '<textarea class="edit-box" rows="3"></textarea><div class="edit-actions"><button type="button">Cancel</button><button type="button" class="primary">Save</button></div>';
  const area = box.querySelector('textarea'),
    [cancel, save] = box.querySelectorAll('button');
  area.value = e.body.prompt;
  area.focus();
  cancel.onclick = showQueued;
  save.onclick = async () => {
    const text = area.value.trim(),
      now = outbox.get(key);
    if (!text) return;
    if (!now || now.state === 'sending') return toast('This message is already sending');
    await outbox.update(key, {
      body: { ...now.body, prompt: text },
      state: 'queued',
      error: undefined,
    });
    showQueued();
    flush();
  };
}

async function retryEntry(key) {
  await outbox.update(key, { state: 'queued', error: undefined });
  showQueued();
  flush();
}

async function cancelEntry(key) {
  if (outbox.get(key)?.state === 'sending') return toast('This message is already sending');
  await outbox.remove(key);
  showQueued();
}

/** Sends whatever waits, each conversation's line in order, the lines in
 * parallel. Does nothing offline or before the outbox is read. */
export function flush() {
  if (state.offline || !state.user || !loaded) return;
  for (const head of outbox.heads()) {
    const line = head.sessionId ?? 'profile';
    if (!lines.has(line)) sendLine(line);
  }
}

/** Sends one line's entries until it is empty, paused or the network goes. A
 * chat made offline renames its line to the id the server gives it. */
function sendLine(line) {
  pass ||= { done: 0 };
  const run = (async () => {
    try {
      for (let e; !state.offline && (e = outbox.head(line));) {
        const next = await deliver(e);
        if (!next) break;
        line = next; // createChat moved the line in `lines` already
      }
    } finally {
      lines.delete(line);
      if (!lines.size) finished();
      banner();
    }
  })();
  lines.set(line, run);
  banner();
}

function finished() {
  const done = pass?.done || 0;
  pass = null;
  if (!done) return;
  toast(
    outbox.entries.some(e => e.state === 'failed')
      ? 'Sent ' + done + ' waiting · some could not be sent'
      : 'Sent everything that was waiting',
  );
}

/** Sends one entry. Returns the line to go on with, or null to stop (no
 * network, a server error, or a choice left open): the entry waits again. */
async function deliver(e) {
  const line = e.sessionId ?? 'profile';
  try {
    if (e.kind === 'chat') return await createChat(e);
    if (e.kind === 'message') await sendMessage(e);
    else await sendEdit(e);
    pass.done++;
    return line;
  } catch (err) {
    const later = !err.status || err.status >= 500 || [401, 408, 429].includes(err.status);
    if (later) await outbox.update(e.key, { state: 'queued' });
    else if (e.kind === 'message' || e.kind === 'chat') {
      await outbox.update(e.key, { state: 'failed', error: err.message });
      if (e.kind === 'chat') toast('A chat made offline could not be created: ' + err.message);
    } else {
      await outbox.remove(e.key);
      toast((e.kind === 'rename' ? 'Rename' : 'Preferences') + ' not saved: ' + err.message);
    }
    showQueued();
    return later ? null : line;
  }
}

/** Makes an offline chat on the server and moves its line to the real id. */
async function createChat(e) {
  const local = e.sessionId,
    s = await api('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ ...e.body, id: local.replace(/^local-/, '') }),
    });
  // The line goes on under the real id; no second sender may start it meanwhile.
  lines.set(s.id, lines.get(local));
  lines.delete(local);
  await outbox.remove(e.key);
  await outbox.rewrite(local, s.id);
  const renamed = outbox.entries.find(x => x.kind === 'rename' && x.sessionId === s.id),
    row = { ...s, title: renamed?.body.title ?? s.title };
  state.sessions = state.sessions.map(r => (r.id === local ? row : r));
  if (state.session?.id === local) {
    state.session = { ...state.session, ...row, history: state.session.history };
    sessionStorage.setItem('session:chat', s.id);
    const draft = sessionStorage.getItem('draft:' + local);
    if (draft) sessionStorage.setItem('draft:' + s.id, draft);
  }
  sessionStorage.removeItem('draft:' + local);
  moveOptions(local, s.id);
  showQueued();
  return s.id;
}

/** Uploads a message's files, sends it (waiting while another turn runs), and
 * waits for its turn to finish, following it live when it is on screen. */
async function sendMessage(e) {
  const sid = e.sessionId;
  e = await outbox.update(e.key, { state: 'sending' });
  showQueued();
  for (const a of e.attachments || [])
    if (!a.id) {
      Object.assign(a, await uploadFile(sid, a.file));
      await outbox.update(e.key, { attachments: e.attachments }); // a retry won't upload it again
    }
  e = outbox.get(e.key);
  const files = e.attachments || [],
    body = { ...e.body, ...(files.length ? { attachments: files.map(a => a.id) } : {}) };
  for (;;)
    try {
      await api('/api/sessions/' + sid + '/messages', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      break;
    } catch (err) {
      if (err.status !== 409) throw err; // 409: another turn is running
      await settle(sid);
    }
  await outbox.remove(e.key);
  bump(sid); // sent: the conversation moves to the top of the list
  showQueued();
  if (state.session?.id === sid) {
    const gen = state.generation;
    message('You', body.prompt, {
      attachments: files.map(({ id, name, type, size, kind }) => ({ id, name, type, size, kind })),
    });
    await watchJob(sid, gen, body);
  }
  await settle(sid);
}

/** Waits until the conversation has no turn queued or running. */
async function settle(sid) {
  for (let i = 0; i < JOB_POLLS; i++) {
    const job = await api('/api/sessions/' + sid + '/job');
    if (!['queued', 'running'].includes(job.status)) return;
    await new Promise(done => setTimeout(done, JOB_POLL));
  }
  throw Error('The previous turn is still running');
}

/** Sends a rename or saved preferences; when the server's copy changed since
 * the edit was based on it, asks whose to keep. */
async function sendEdit(e) {
  const rename = e.kind === 'rename',
    path = rename ? '/api/sessions/' + e.sessionId : '/api/account';
  await outbox.update(e.key, { state: 'sending' });
  const current = await api(path, { fresh: true });
  if (conflicted(e, current)) {
    const choice = await ask(
      rename
        ? 'The conversation “' +
            e.body.title +
            '” was renamed “' +
            current.title +
            '” on another device.'
        : 'Your preferences were changed on another device.',
    );
    if (!choice) throw Error('Waiting for your choice'); // asked again next time
    if (choice === 'theirs') {
      await outbox.remove(e.key);
      if (rename) showTitle(e.sessionId, current.title);
      return;
    }
  }
  const latest = outbox.get(e.key) || e,
    d = await api(path, { method: rename ? 'PATCH' : 'POST', body: JSON.stringify(latest.body) });
  await outbox.remove(e.key);
  if (rename) showTitle(e.sessionId, d.title);
  else loadModels(); // custom models may have changed
}

function showTitle(id, name) {
  state.sessions = state.sessions.map(s => (s.id === id ? { ...s, title: name } : s));
  if (state.session?.id === id) {
    state.session.title = name;
    title(name, $('#subtitle').textContent); // a coding session's line is rebuilt
  }
  sidebar();
}

let asking = Promise.resolve(); // one question at a time
/** Asks whether to keep this device's edit or the other device's; resolves
 * 'mine', 'theirs', or '' when the dialog is dismissed. */
function ask(text) {
  const question = asking.then(
    () =>
      new Promise(done => {
        const dialog = $('#conflict-dialog');
        $('#conflict-text').textContent = text;
        dialog.returnValue = '';
        dialog.addEventListener('close', () => done(dialog.returnValue), { once: true });
        dialog.showModal();
      }),
  );
  asking = question;
  return question;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') flush();
});
