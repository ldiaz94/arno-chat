/** The outbox's rules, with no browser in them so Node can test them: what is
 * waiting to be sent while offline, in what order it goes, how repeated edits
 * of one thing merge, and when an edit clashes with one made elsewhere. The
 * entries live in an injected storage (IndexedDB in the browser, see
 * outbox.js; an array in the tests), mirrored here in memory.
 *
 *   entry: { key, kind, sessionId, createdAt, body, base?, attachments?,
 *            state: 'queued' | 'sending' | 'failed', error? }
 *
 *   kind     sessionId          body                    sends
 *   chat     local-<uuid>       { model }               POST /api/chats
 *   message  a session id       { id, prompt }          POST …/messages
 *   rename   a session id       { title }               PATCH /api/sessions/:id
 *   profile  null               the preferences form    POST /api/account
 *
 * Each session's entries form one line, sent strictly in order; a failed
 * entry pauses its line until it is retried or cancelled. The profile has a
 * line of its own. Depends on nothing.
 */

/** True for a conversation made offline that the server does not know yet. */
export const isLocal = id => String(id).startsWith('local-');

/** The line an entry waits in: its session, or the profile's own. */
const line = e => e.sessionId ?? 'profile';

/** Whether the server's current copy changed since the edit was based on it,
 * so sending the edit would silently overwrite someone else's. A rename only
 * clashes with another rename (titles the server gives a new chat don't
 * count); an edit made on an offline chat has nothing to clash with. */
export function conflicted(entry, current) {
  if (entry.base === undefined) return false;
  if (entry.kind === 'rename') return !!current.customTitle && current.title !== entry.base;
  if (entry.kind === 'profile') return (current.updatedAt || 0) !== entry.base;
  return false;
}

// The outbox's entries in memory, in step with the storage. Methods keep each line's order and
// merge repeated edits.
export class Outbox {
  /** storage: { all(), put(entry), delete(key), clear() }, all async. */
  constructor(storage) {
    this.storage = storage;
    this.entries = []; // every entry, oldest first
    this.last = 0; // the newest createdAt, so entries made in one ms keep their order
  }
  /** Reads the stored entries. One left 'sending' (the page closed mid-send) is
   * queued again: the server drops a repeated message by its id. */
  async load() {
    this.entries = (await this.storage.all())
      .map(e => (e.state === 'sending' ? { ...e, state: 'queued' } : e))
      .sort((a, b) => a.createdAt - b.createdAt);
    this.last = this.entries.at(-1)?.createdAt || 0;
  }
  /** The entries of one session, in order. */
  of(sessionId) {
    return this.entries.filter(e => e.sessionId === sessionId);
  }
  get(key) {
    return this.entries.find(e => e.key === key);
  }
  /** Adds an entry at the end of its line and returns it. */
  async add(fields) {
    this.last = Math.max(Date.now(), this.last + 1);
    const entry = { key: crypto.randomUUID(), createdAt: this.last, state: 'queued', ...fields };
    this.entries.push(entry);
    await this.storage.put(entry);
    return entry;
  }
  /** Queues a rename or profile edit. A later edit of the same thing replaces
   * the earlier one's body in its place, keeping the server value the first
   * was based on (the later one was based on our own queued value). */
  async edit(kind, sessionId, body, base) {
    const old = this.entries.find(e => e.kind === kind && e.sessionId === sessionId);
    if (!old) return this.add({ kind, sessionId, body, base });
    return this.update(old.key, { body, state: 'queued', error: undefined });
  }
  /** Changes an entry's fields and returns it. */
  async update(key, patch) {
    const i = this.entries.findIndex(e => e.key === key);
    if (i < 0) return null;
    const entry = (this.entries[i] = { ...this.entries[i], ...patch });
    await this.storage.put(entry); // other changes may move it in this.entries meanwhile
    return entry;
  }
  async remove(key) {
    this.entries = this.entries.filter(e => e.key !== key);
    await this.storage.delete(key);
  }
  /** Drops everything queued for a session (an offline chat deleted). */
  async dropSession(sessionId) {
    for (const e of this.of(sessionId)) await this.remove(e.key);
  }
  /** Moves an offline chat's entries to the id the server gave it. */
  async rewrite(localId, realId) {
    for (const e of this.of(localId)) await this.update(e.key, { sessionId: realId });
  }
  /** The next entry of each line that may be sent now: the first of its line,
   * unless that one failed, which pauses the line. */
  heads() {
    const heads = new Map();
    for (const e of this.entries) if (!heads.has(line(e))) heads.set(line(e), e);
    return [...heads.values()].filter(e => e.state !== 'failed');
  }
  /** The next entry of the line `key` names (a session id or 'profile'), or null. */
  head(key) {
    return this.heads().find(e => line(e) === key) || null;
  }
  async clear() {
    this.entries = [];
    await this.storage.clear();
  }
}
