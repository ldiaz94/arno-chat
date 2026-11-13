/** The Worker entry point.
 *
 *   /auth/*  -> auth.mjs (GitHub sign-in, MCP OAuth callback)
 *   /api/*   -> same-origin and sign-in checks, then api.mjs routes,
 *               then sessions-api.mjs (per-session paths)
 *   /admin/* -> admin.mjs (read-only storage, behind ADMIN_TOKEN)
 *   other    -> 404 (the page itself is served as a static asset)
 *
 * The Durable Object class (probe/probe.mjs) and the gateway classes
 * (gateways/gateways.mjs) are re-exported here because the runtime looks
 * for them in the entry module. Leaves out all route logic. */
import { SECURITY, json, sameOrigin } from './http.mjs';
import { currentAuth, handleOAuth, repoAccess, admitted, NOT_ADMITTED } from './auth.mjs';
import { apiRoutes } from './api.mjs';
import { sessionPaths } from './sessions-api.mjs';
import { adminRoute } from './admin.mjs';

export { ArnoProbe } from './probe/probe.mjs';
export {
  ModelGateway,
  McpGateway,
  GitGateway,
  GithubGateway,
  RegistryGateway,
  CloudflareGateway,
} from './gateways/gateways.mjs';

/** The Worker's module interface: one fetch handler for every request. */
export default {
  /** Routes one request; any thrown error becomes a logged 500. */
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/auth/')) {
        const response = await handleOAuth(request, env, url);
        if (response) return response;
      }
      if (url.pathname.startsWith('/admin/')) return await adminRoute(request, env, url);
      if (!url.pathname.startsWith('/api/'))
        return new Response('Not found', { status: 404, headers: SECURITY });
      if (!sameOrigin(request)) return json({ error: 'Cross-origin request denied' }, 403);
      const auth = await currentAuth(request, env);
      if (url.pathname === '/api/me')
        return json({
          user: auth?.user || null,
          githubConnected: auth?.githubConnected ?? null,
          repoAccess: auth ? await repoAccess(auth) : null,
          scopes: auth?.scopes || null,
          githubConfigured: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
          // Set by npm run deploy: the commit deployed and when.
          build: { commit: env.BUILD || null, deployed: env.DEPLOYED || null },
        });
      if (!auth) return json({ error: 'Sign in required' }, 401);
      if (!admitted(env, auth.user.login)) return json({ error: NOT_ADMITTED }, 403);
      const route =
        apiRoutes[request.method + ' ' + url.pathname] ?? apiRoutes['* ' + url.pathname];
      if (route) return await route(request, env, url, auth);
      const response = await sessionPaths(request, env, url, auth);
      if (response) return response;
      return new Response('Not found', { status: 404, headers: SECURITY });
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'request_error', path: url.pathname, error: String(error) }),
      );
      const message = String(error.message || error);
      return json(
        { error: message.startsWith('GitHub rejected publishing') ? message : 'Request failed' },
        500,
      );
    }
  },
};
