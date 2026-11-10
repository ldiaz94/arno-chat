/** HTTP helpers shared by the Worker, its Durable Object and the API routes:
 * security headers, JSON responses, cookies and bounded request bodies. */
/** Name of the sign-in cookie. */
export const COOKIE = 'arno_session';
/** Headers added to every response: strict CSP, no framing, no caching. */
export const SECURITY = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store',
};

/** A JSON response with the security headers. */
export function json(value, status = 200) {
  return Response.json(value, { status, headers: SECURITY });
}
/** The named cookie's decoded value from the request, or an empty string. */
export function cookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const item of raw.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
/** A Set-Cookie value for the sign-in cookie; maxAge 0 clears it. */
export function sessionCookie(value, maxAge = 2592000) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
/** True unless the request names an Origin other than this site's own (CSRF guard). */
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}
/** Parses the request body as JSON; throws when it is over limit characters. */
export async function boundedJson(request, limit = 12000) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limit) throw new Error('Request is too large');
  const text = await request.text();
  if (text.length > limit) throw new Error('Request is too large');
  return JSON.parse(text);
}
