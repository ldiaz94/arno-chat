/** Sealing secrets at rest: AES-GCM with the deployment's key
 * (ACCOUNT_ENCRYPTION_KEY), each sealed for one account and one field (the
 * additional data), so a sealed value cannot be moved to another account or
 * used as another field. API keys, MCP and Cloudflare tokens, the SearXNG
 * secret and coding sessions' GitHub tokens are kept this way. */
/** Bytes to base64 text. */
const b64 = bytes => btoa(String.fromCharCode(...bytes));
/** Base64 text to bytes. */
const bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
/** The AES-GCM key from the environment; throws when it is not configured. */
async function encryptionKey(env) {
  if (!env.ACCOUNT_ENCRYPTION_KEY) throw Error('Account encryption is not configured');
  return crypto.subtle.importKey('raw', bytes(env.ACCOUNT_ENCRYPTION_KEY), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
/** Encrypts value for one account and field; returns {iv, value} as base64. */
export async function seal(env, userId, field, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    key = await encryptionKey(env);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(userId + ':' + field) },
    key,
    new TextEncoder().encode(value),
  );
  return { iv: b64(iv), value: b64(new Uint8Array(encrypted)) };
}
/** Decrypts a record made by seal for the same account and field; '' for no record, throws on a mismatch. */
export async function unseal(env, userId, field, record) {
  if (!record) return '';
  const key = await encryptionKey(env),
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes(record.iv),
        additionalData: new TextEncoder().encode(userId + ':' + field),
      },
      key,
      bytes(record.value),
    );
  return new TextDecoder().decode(plain);
}
