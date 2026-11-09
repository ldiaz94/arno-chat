/** HTTP helpers shared by the Worker, its Durable Object and the API routes:
 * security headers, JSON responses, cookies and bounded request bodies. */
export const COOKIE = 'arno_session';
export const MAX_ARCHIVE = 50 * 1024 * 1024;
export const SECURITY = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store',
};

export function json(value, status = 200) {
  return Response.json(value, { status, headers: SECURITY });
}
export function cookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const item of raw.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
export function sessionCookie(value, maxAge = 2592000) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}
export async function boundedJson(request, limit = 12000) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limit) throw new Error('Request is too large');
  const text = await request.text();
  if (text.length > limit) throw new Error('Request is too large');
  return JSON.parse(text);
}
