/** ArnoProbe, the one Durable Object class. Its name picks its role: a session
 * ('code:<user>:<id>'), a user's index and profile ('index:<user>') or a sign-in
 * record ('auth:<id>'). Requests dispatch by "METHOD /path" (or "* /path" for any
 * method) to the route tables; a turn runs from alarm(), not from the request
 * that queued it.
 *
 *   request -> fetch() -> ROUTES[...]   store-routes    index, profile, auth
 *                                       gateway-routes  calls from the gateways
 *                                       session-routes  session lifecycle
 *                                       ../push.mjs, ../code/code-routes.mjs
 *   alarm() -> /session/run -> chatTurn (../chat/turn.mjs) or codeTurn (../code/turn.mjs)
 *
 * The methods those use come from live.mjs (the live view), records.mjs
 * (transcript, cost, notices), the turns and ../code/workspace.mjs, mixed in
 * at the bottom. Depends on those modules and ../push.mjs. Leaves out the
 * HTTP edge: worker.js routes requests here. */
import { DurableObject } from 'cloudflare:workers';
import { storeRoutes } from './store-routes.mjs';
import { gatewayRoutes } from './gateway-routes.mjs';
import { sessionRoutes } from './session-routes.mjs';
import { codeRoutes } from '../code/code-routes.mjs';
import { pushRoutes } from '../push.mjs';

import { live } from './live.mjs';
import { records } from './records.mjs';
import { chatTurn } from '../chat/turn.mjs';
import { workspace } from '../code/workspace.mjs';
import { codeTurn } from '../code/turn.mjs';

/** Every route table, merged into one lookup by "METHOD /path". */
const ROUTES = {
  ...storeRoutes,
  ...pushRoutes,
  ...gatewayRoutes,
  ...sessionRoutes,
  ...codeRoutes,
};

/** The Durable Object: one instance per session, user index or sign-in record. */
export class ArnoProbe extends DurableObject {
  /** Find the route for this request and call it with this = the instance; 404 when none. */
  async fetch(request) {
    const url = new URL(request.url);
    const route = ROUTES[request.method + ' ' + url.pathname] ?? ROUTES['* ' + url.pathname];
    return route ? route.call(this, request, url) : new Response('Not found', { status: 404 });
  }
  /** Alarms own the long-running turn, not the submitting browser request.
   * Mark running before execution; an interrupted alarm must not silently replay
   * commands with side effects. Cancelled jobs remain cancelled on every path. */
  async alarm() {
    const job = await this.ctx.storage.get('job');
    if (job?.status === 'queued') {
      await this.ctx.storage.put('job', { ...job, status: 'running' });
      try {
        const r = await this.fetch(
          new Request('https://internal/session/run', {
            method: 'POST',
            body: JSON.stringify({ prompt: job.prompt, editAt: job.editAt }),
          }),
        );
        const result = await r.json();
        const ok = r.ok && (!result.exitCode || result.exitCode === 0);
        if (!ok && !result.error) result.error = result.summary || 'The coding task failed.';
        const current = await this.ctx.storage.get('job');
        if (!ok && current?.status !== 'cancelled') await this.recordFailure(job, result.error);
        if (current?.status !== 'cancelled')
          await this.ctx.storage.put('job', {
            ...current,
            ...job,
            status: ok ? 'completed' : 'failed',
            result,
            finishedAt: Date.now(),
          });
        if (current?.status !== 'cancelled') {
          await this.touch();
          await this.notify(result);
        }
      } catch (e) {
        const current = await this.ctx.storage.get('job');
        if (current?.status === 'cancelled') {
          if (this.ctx.container?.running) await this.ctx.container.destroy();
        } else {
          // A chat's errors are written for the user (chat.mjs); a coding task's may not be.
          const chat = (await this.ctx.storage.get('session'))?.kind === 'chat',
            error = chat
              ? e.message || 'This chat turn failed.'
              : 'The coding task failed. Your last checkpoint is preserved.';
          await this.recordFailure(job, error, e);
          await this.ctx.storage.put('job', { ...job, status: 'failed', result: { error } });
          await this.notify({ error });
        }
      }
      await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
      return;
    }
    if (job?.status === 'running') {
      const error = 'The task was interrupted. Retry from the last saved checkpoint.';
      await this.recordFailure(job, error);
      await this.ctx.storage.put('job', { ...job, status: 'failed', result: { error } });
      await this.notify({ error });
    }
    await this.ctx.storage.delete('modelQuota');
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}

// The methods, by what they are for; each group says so at its top.
Object.assign(ArnoProbe.prototype, live, records, chatTurn, codeTurn, workspace);
