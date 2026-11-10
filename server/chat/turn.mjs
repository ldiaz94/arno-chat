/** A regular chat's turn, part of ArnoProbe (probe.mjs): the tool loop of
 * chat.mjs with web research, artifacts and the owner's MCP tools for chats,
 * and the wait for the owner's Allow before an MCP action. No container. */
import { json } from '../http.mjs';
import { plainChat } from './chat.mjs';
import { modelInput } from '../probe/attachments.mjs';
import { profile, credential, instructions, searchConnection } from '../account.mjs';
import { providerModel } from '../providers.mjs';
import { chatMcpTools, callChatMcp } from './chat-mcp.mjs';
import { WEB_INSTRUCTIONS, WEB_TOOLS, research, citedSources } from './research.mjs';
import { turnPlan } from './plan.mjs';
import { effortSupported } from '../models.mjs';
import { ARTIFACT_INSTRUCTIONS, ARTIFACT_TOOLS, artifactTool } from '../probe/artifacts.mjs';

export const chatTurn = {
  /** Asks the owner to allow an MCP action in a chat, and waits up to three
   * minutes for Allow or Deny (POST /session/approve); the turn's clock stops
   * meanwhile. The question rides on the job, which the browser polls. */
  async approve(jobId, what, args) {
    const id = crypto.randomUUID(),
      asked = Date.now(),
      until = asked + 3 * 60000;
    const job = await this.ctx.storage.get('job');
    if (job?.id !== jobId || job.status !== 'running') return false;
    await this.ctx.storage.put('job', {
      ...job,
      stage: 'approval',
      approval: { id, what, args: JSON.stringify(args, null, 2).slice(0, 4000) },
    });
    clearTimeout(this.chatTimer);
    let decision = null;
    while (decision === null && Date.now() < until && !this.chatAbort?.signal.aborted) {
      await new Promise(r => setTimeout(r, 1000));
      const now = await this.ctx.storage.get('job');
      if (now?.id !== jobId || now.status !== 'running') break;
      if (now.approval?.id === id && typeof now.approval.allow === 'boolean')
        decision = now.approval.allow;
    }
    const now = await this.ctx.storage.get('job');
    if (now?.id === jobId && now.status === 'running') {
      const rest = { ...now, stage: 'thinking' };
      delete rest.approval;
      await this.ctx.storage.put('job', rest);
    }
    // The clock goes on from where it stopped.
    this.chatDeadline += Date.now() - asked;
    this.chatTimer = setTimeout(
      () => this.chatAbort?.abort(),
      Math.max(0, this.chatDeadline - Date.now()),
    );
    return decision === true;
  },
  /** editAt names the turn an edited message replaces: it and every later
   * turn are left out of the context, and dropped once the new answer saves.
   * The job's options (web/options.mjs) set its tools, effort and budgets. */
  async plainTurn(session, prompt, editAt) {
    this.inFlight = true;
    this.chatAbort = new AbortController();
    const job = await this.ctx.storage.get('job'),
      plan = turnPlan(job?.options),
      began = Date.now();
    // The turn's clock; a wait for the owner's Allow (approve) stops it.
    this.chatDeadline = began + plan.timeLimit;
    this.chatTimer = setTimeout(() => this.chatAbort?.abort(), plan.timeLimit);
    try {
      await this.phase('thinking', { workspace: 'chat', startupMs: 0 });
      const p = await profile(this.env, session.ownerId),
        selected = providerModel(session.model);
      const sources = [...(session.sources || [])],
        counts = { searches: 0, searxng: 0, reads: 0 },
        webKey = await credential(this.env, session.ownerId, p, 'ollama'),
        search = await searchConnection(this.env, session.ownerId, p);
      const previous = (await this.history()).filter(t => !editAt || t.at < editAt);
      const jobId = job?.id,
        attached = job?.attachments || [],
        input = await modelInput(this.ctx.storage, prompt, attached),
        artifacts = [];
      // The owner's MCP connections marked for chats, unless this message
      // turned them off (web/options.mjs).
      const mcp =
        job?.options?.mcp === false
          ? { specs: [], calls: new Map(), failures: [] }
          : await chatMcpTools(this.env, session.ownerId, p, this.ctx.storage);
      const result = await plainChat({
        model: selected.id,
        provider: selected.provider,
        history: previous,
        prompt: input.text,
        images: input.images,
        rounds: plan.rounds,
        maxOutput: plan.maxOutput,
        effort: (await effortSupported(session.model)) ? plan.effort : 'auto',
        toolSpecs: [...(plan.search ? WEB_TOOLS : []), ...ARTIFACT_TOOLS, ...mcp.specs],
        key: await credential(this.env, session.ownerId, p, selected.provider),
        instructions: [
          instructions(p),
          plan.search ? WEB_INSTRUCTIONS : '',
          ARTIFACT_INSTRUCTIONS,
          mcp.specs.length ? MCP_INSTRUCTIONS : '',
          mcp.failures.length ? 'Unavailable connections: ' + mcp.failures.join('; ') : '',
          plan.instructions,
        ]
          .filter(Boolean)
          .join('\n\n'),
        signal: this.chatAbort.signal,
        onRound: () => this.phase('thinking', { workspace: 'chat', startupMs: 0 }),
        onProgress: preview => this.progress({ ...preview, jobId }),
        runTool: async (name, args) => {
          const remote = mcp.calls.get(name);
          if (remote) {
            const what = remote.connection.name + ' · ' + remote.tool;
            if (!remote.readOnly && !(await this.approve(jobId, what, args)))
              return { error: 'The user did not allow this action. Do not try it again.' };
            await this.activity(what);
            return callChatMcp(this.env, session.ownerId, remote, args);
          }
          if (/_artifact$/.test(name)) return artifactTool(this.ctx.storage, name, args, artifacts);
          await this.phase(name === 'web_search' ? 'searching' : 'reading', { workspace: 'chat' });
          const data = await research(name, args, {
            key: webKey,
            search,
            sources,
            counts,
            limits: plan.limits,
          });
          await this.phase('thinking', {
            workspace: 'chat',
            webCounts: { ...counts },
            sourceCount: sources.length,
          });
          return data;
        },
      });
      result.model = session.model;
      result.attachments = attached;
      result.artifacts = artifacts;
      result.sources = citedSources(result.summary, sources, previous);
      result.webUsage = counts;
      result.options = job?.options;
      if ((await this.ctx.storage.get('job'))?.status === 'cancelled')
        throw Error('Chat cancelled');
      result.timing = {
        workspace: 'chat',
        startupMs: 0,
        executionMs: Date.now() - began,
        checkpointMs: 0,
        totalMs: Date.now() - began,
      };
      await this.phase('saving', { workspace: 'chat' });
      if ((await this.ctx.storage.get('job'))?.status === 'cancelled')
        throw Error('Chat cancelled');
      await this.saveTurn(result, prompt, null, sources, editAt);
      const current = await this.ctx.storage.get('session');
      if (
        current.title === 'General chat' &&
        !current.customTitle &&
        session.ownerId &&
        session.id
      ) {
        const meta = { ...current, title: prompt.slice(0, 70) };
        await this.ctx.storage.put('session', meta);
        await this.env.PROBE.getByName('index:' + session.ownerId).fetch(
          'https://internal/index/add',
          { method: 'POST', body: JSON.stringify(meta) },
        );
      }
      return json(result);
    } finally {
      clearTimeout(this.chatTimer);
      this.chatAbort = null;
      this.inFlight = false;
    }
  },
};

/** What the model is told when a chat has MCP tools. */
const MCP_INSTRUCTIONS =
  'Tools named <connection>__<tool> reach services the user connected (MCP). Use them when the question is about those services. A tool that changes something waits for the user to allow it; if the user does not, say so and do not try again.';
