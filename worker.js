/** The Worker entry: sign-in under /auth/, then the signed-in /api/* routes.
 * The Durable Object and gateway classes live in their own modules and are
 * re-exported here for the runtime. */
import { SECURITY, json, sameOrigin } from './http.mjs';
import { currentAuth, handleOAuth, repoAccess } from './auth.mjs';
import { apiRoutes, sessionPaths } from './api.mjs';

export { ArnoProbe } from './session.mjs';
export {
  ModelGateway,
  McpGateway,
  GitGateway,
  RegistryGateway,
  CloudflareGateway,
} from './gateways.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/auth/')) {
        const response = await handleOAuth(request, env, url);
        if (response) return response;
      }
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
      const allowed = (env.ALLOWED_GITHUB_LOGINS || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
      if (allowed.length && !allowed.includes(auth.user.login?.toLowerCase()))
        return json({ error: 'This private deployment is restricted to its owner.' }, 403);
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
