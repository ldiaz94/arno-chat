/** Files and images attached to messages, kept in the session's own Durable
 * Object storage, so only that session can reach them and deleting the
 * session deletes them:
 *
 *   file:<id>       {id, name, type, size, kind, chunks}
 *   file:<id>:<n>   the bytes, in 1 MiB chunks (a stored value may be 2 MB)
 *
 * An image goes to the model as an image; a text file is inlined as text.
 * Left out: PDFs and other binary documents, and resending earlier turns'
 * images (later turns see "[attached: name]"). Depends on no other app module.
 */
/** One mebibyte. */
const MB = 1024 * 1024;
/** Size of one stored piece of a file. */
const CHUNK = MB;
/** Largest image, text file, total per session (bytes) and files per message. */
export const LIMITS = { image: 5 * MB, text: MB, session: 100 * MB, perMessage: 8 };
/** Image types models accept. */
const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
/** Media types treated as text. */
const TEXT_TYPE = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|x-sh|sql))/;
/** File extensions treated as text when the media type is vague. */
const TEXT_NAME =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|cfg|conf|log|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|swift|php|sh|bash|zsh|sql|r|lua|pl|ex|exs|hs|ml|scala|clj|raz|cn|pas|diff|patch)$/i;

/** 'image', 'text', or null when the file can't be attached. */
export function kindOf(type, name) {
  if (IMAGE.test(type)) return 'image';
  if (TEXT_TYPE.test(type) || TEXT_NAME.test(name)) return 'text';
  return null;
}

/** Store an upload; throws a user-facing Error when it can't be attached. */
export async function saveAttachment(storage, name, type, bytes) {
  // Control characters and path separators never reach a file name.
  name = String(name || 'file')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/\0-\x1f]/g, '_')
    .slice(0, 200);
  const kind = kindOf(type, name);
  if (!kind) throw Error('Attach images (PNG, JPEG, WebP, GIF) or text and code files');
  if (bytes.byteLength > LIMITS[kind])
    throw Error(
      (kind === 'image' ? 'Images' : 'Text files') + ' are limited to ' + LIMITS[kind] / MB + ' MB',
    );
  if (kind === 'text') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw Error(name + ' is not UTF-8 text');
    }
  }
  const used = [...(await storage.list({ prefix: 'file:' })).values()]
    .filter(v => v?.id)
    .reduce((n, v) => n + v.size, 0);
  if (used + bytes.byteLength > LIMITS.session)
    throw Error('This conversation has reached its ' + LIMITS.session / MB + ' MB of attachments');
  const id = crypto.randomUUID(),
    chunks = Math.ceil(bytes.byteLength / CHUNK) || 1,
    meta = {
      id,
      name,
      type: kind === 'text' ? 'text/plain' : type,
      size: bytes.byteLength,
      kind,
      chunks,
    };
  const records = { ['file:' + id]: meta };
  for (let n = 0; n < chunks; n++)
    records['file:' + id + ':' + n] = bytes.slice(n * CHUNK, (n + 1) * CHUNK);
  await storage.put(records);
  return meta;
}

/** An attachment's metadata and bytes, or null. */
export async function readAttachment(storage, id) {
  const meta = await storage.get('file:' + id);
  if (!meta?.id) return null;
  const parts = await storage.get(
    Array.from({ length: meta.chunks }, (_, n) => 'file:' + id + ':' + n),
  );
  const bytes = new Uint8Array(meta.size);
  let at = 0;
  for (let n = 0; n < meta.chunks; n++) {
    const part = new Uint8Array(parts.get('file:' + id + ':' + n));
    bytes.set(part, at);
    at += part.byteLength;
  }
  return { meta, bytes };
}

/** Metadata for a message's attachment ids, all of which must exist here. */
export async function attachmentsFor(storage, ids) {
  if (ids == null) return [];
  if (
    !Array.isArray(ids) ||
    ids.length > LIMITS.perMessage ||
    ids.some(id => !/^[0-9a-f-]{36}$/.test(id))
  )
    throw Error('Attach up to ' + LIMITS.perMessage + ' files per message');
  const metas = await Promise.all(ids.map(id => storage.get('file:' + id)));
  if (metas.some(m => !m?.id)) throw Error('An attachment is missing; attach it again');
  return metas;
}

/** What a model receives for a message's attachments: text files inlined
 * after the prompt, images as base64 for the provider's own image format. */
export async function modelInput(storage, prompt, metas = []) {
  let text = prompt;
  const images = [];
  for (const meta of metas) {
    const file = await readAttachment(storage, meta.id);
    if (!file) continue;
    if (meta.kind === 'text')
      text +=
        '\n\nAttached file ' +
        meta.name +
        ':\n```\n' +
        new TextDecoder().decode(file.bytes) +
        '\n```';
    else {
      let binary = '';
      for (let i = 0; i < file.bytes.length; i += 0x8000)
        binary += String.fromCharCode(...file.bytes.subarray(i, i + 0x8000));
      images.push({ type: meta.type, name: meta.name, data: btoa(binary) });
    }
  }
  return { text, images };
}

/** How an earlier turn's attachments appear in later context. */
export function attachedNote(metas = []) {
  return metas.length ? '\n[attached: ' + metas.map(m => m.name).join(', ') + ']' : '';
}
