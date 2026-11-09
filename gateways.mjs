/** Outbound gateways for the untrusted container: model and MCP traffic is
 * intercepted and mediated here, with the account's credentials. Reached
 * through ctx.exports, so worker.js re-exports both classes. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { modelRequest } from './gateway.mjs';
import {
  profile,
  credential,
  instructions,
  providerModel,
  unseal,
  searchConnection,
} from './account.mjs';
import { proxyMcp } from './mcp.mjs';
import { WEB_INSTRUCTIONS, webMcp } from './web.mjs';

export class ModelGateway extends WorkerEntrypoint {
  async fetch(request) {
    const task = this.env.PROBE.get(this.env.PROBE.idFromString(this.ctx.props.task));
    const { ownerId } = await (await task.fetch('https://internal/model-account')).json();
    const preferences = await profile(this.env, ownerId),
      selection = providerModel(this.ctx.props.model);
    let turnId, round;
    return modelRequest(request, {
      key: await credential(this.env, ownerId, preferences, selection.provider),
      model: selection.id,
      provider: selection.provider,
      instructions: [instructions(preferences), WEB_INSTRUCTIONS].filter(Boolean).join('\n\n'),
      authorize: async () => {
        const r = await task.fetch('https://internal/model-permit', { method: 'POST' });
        turnId = r.headers.get('X-Turn-Id');
        round = Number(r.headers.get('X-Model-Round'));
        return r.ok;
      },
      onUsage: usage =>
        task.fetch('https://internal/model-usage', {
          method: 'POST',
          body: JSON.stringify({ turnId, usage }),
        }),
      onProgress: preview =>
        task.fetch('https://internal/model-progress', {
          method: 'POST',
          body: JSON.stringify({ turnId, round, ...preview }),
        }),
    });
  }
}
/** Account-approved MCP traffic is mediated outside the untrusted VM. */
export class McpGateway extends WorkerEntrypoint {
  async fetch(request) {
    const task = this.env.PROBE.get(this.env.PROBE.idFromString(this.ctx.props.task)),
      url = new URL(request.url),
      id = url.pathname.slice(1);
    if (url.hostname !== 'mcp.internal' || !/^[a-z][a-z0-9_-]{0,29}$/.test(id))
      return new Response('Denied', { status: 403 });
    const r = await task.fetch('https://internal/mcp-permit', { method: 'POST' });
    if (!r.ok) return new Response('MCP task limit reached', { status: 429 });
    const { ownerId } = await r.json(),
      p = await profile(this.env, ownerId),
      connection = p.mcp?.find(m => m.id === id && m.enabled);
    if (id === 'web')
      return webMcp(request, {
        task,
        key: await credential(this.env, ownerId, p, 'ollama'),
        search: await searchConnection(this.env, ownerId, p),
      });
    if (!connection) return new Response('MCP connection not enabled', { status: 403 });
    const token = await unseal(this.env, ownerId, 'mcp:' + id, connection.token);
    return proxyMcp(request, connection, token);
  }
}
