/** A regular chat's turn, part of ArnoProbe (probe/probe.mjs): the tool loop
 * of chat.mjs with web research (research.mjs), artifacts (probe/artifacts.mjs),
 * the owner's MCP tools for chats (chat-mcp.mjs), memory (memory.mjs), and
 * the wait for the owner's Allow before an MCP action. The turn's budgets
 * come from plan.mjs. There is no container. Leaves out coding turns (code/turn.mjs).
 *
 * A turn has no time limit. A Durable Object alarm may run for 15 minutes,
 * so a long turn runs as a chain of them:
 *
 *   alarm → plainTurn ─ round ─ round ─ … ─ (9 min) save, yield ─┐
 *   alarm → plainTurn(resume) ─ round ─ … ─ answer ◄─────────────┘
 *
 * Before each round the loop's state is saved ('chat-resume', in parts: a
 * value holds at most 128 KiB); a model call still running at 12 minutes is
 * stopped and its round asked again in the next alarm. Tools are never cut
 * off, so no action runs twice. An alarm the platform ends anyway is retried,
 * and finds the same state.
 *
 * An html page the model writes is opened in a browser (probe/render.mjs) and
 * what failed goes back with the tool's result, with a screenshot for a model
 * that sees images. Before the answer is kept, the turn reviews it: an answer
 * that says an artifact changed when none did is sent back once, and a page
 * written this turn goes to a reviewer (review.mjs: the owner's review model,
 * or the chat's own) with screenshots at phone size and wide, once (twice, if
 * the model changed it after the first); the defects it finds go back to the
 * model to fix. The reviews' cost joins the turn's (probe/records.mjs). */
import { json } from '../http.mjs';
import { plainChat } from './chat.mjs';
import { modelInput } from '../probe/attachments.mjs';
import { profile, credential, instructions, searchConnection } from '../account.mjs';
import { providerModel } from '../providers.mjs';
import { chatMcpTools, callChatMcp } from './chat-mcp.mjs';
import { WEB_INSTRUCTIONS, WEB_TOOLS, research, citedSources } from './research.mjs';
import { turnPlan } from './plan.mjs';
import { effortSupported, seesScreenshots } from '../models.mjs';
import { IMAGE_TOOLS, findImage } from './images.mjs';
import { MEMORY_TOOLS, memoryMode, memoryInstructions, memoryTool } from './memory.mjs';
import { RENAME_TOOL, nameInstructions, newName } from './title.mjs';
import { ASK_TOOL, ASKED, decisionOf } from '../decisions.mjs';
import { renderArtifact, WIDE } from '../probe/render.mjs';
import { reviewPage, fixRequest } from './review.mjs';
import { prices, priceOf, cost } from '../prices.mjs';
import {
  ARTIFACT_INSTRUCTIONS,
  ARTIFACT_TOOLS,
  artifactTool,
  artifactList,
  listArtifacts,
  findArtifact,
  getArtifact,
} from '../probe/artifacts.mjs';

/** The chat turn's methods, mixed into ArnoProbe (probe.mjs). */
export const chatTurn = {
  /** Asks the owner to allow an MCP action in a chat, and waits up to three
   * minutes for Allow or Deny (POST /session/approve); a Stop ends the wait.
   * The question rides on the job, which the browser polls. */
  async approve(jobId, what, args) {
    const id = crypto.randomUUID(),
      until = Date.now() + 3 * 60000;
    const job = await this.ctx.storage.get('job');
    if (job?.id !== jobId || job.status !== 'running') return false;
    await this.ctx.storage.put('job', {
      ...job,
      stage: 'approval',
      approval: { id, what, args: JSON.stringify(args, null, 2).slice(0, 4000) },
    });
    let decision = null;
    while (decision === null && Date.now() < until) {
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
    return decision === true;
  },
  /** Saves a chat turn's state to carry on from: JSON in parts of RESUME_PART
   * characters (at most 4 bytes each, within a value's 128 KiB). */
  async saveResume(state) {
    const text = JSON.stringify(state),
      parts = {};
    for (let i = 0; i * RESUME_PART < text.length; i++)
      parts['chat-resume:' + String(i).padStart(4, '0')] = text.slice(
        i * RESUME_PART,
        (i + 1) * RESUME_PART,
      );
    await this.clearResume();
    const entries = Object.entries(parts);
    for (let i = 0; i < entries.length; i += 128)
      await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
  },
  /** The saved state of the job's turn, or null. */
  async loadResume(jobId) {
    const parts = await this.ctx.storage.list({ prefix: 'chat-resume:' });
    if (!parts.size) return null;
    const state = JSON.parse([...parts.values()].join(''));
    return state.jobId === jobId ? state : null;
  },
  /** Forgets a turn's saved state. */
  async clearResume() {
    const keys = [...(await this.ctx.storage.list({ prefix: 'chat-resume:' })).keys()];
    for (let i = 0; i < keys.length; i += 128)
      await this.ctx.storage.delete(keys.slice(i, i + 128));
  },
  /** editAt names the turn an edited message replaces: it and every later
   * turn are left out of the context, and dropped once the new answer saves.
   * The job's options (web/options.mjs) set its tools, effort and budgets. */
  async plainTurn(session, prompt, editAt) {
    this.inFlight = true;
    this.chatAbort = new AbortController();
    const job = await this.ctx.storage.get('job'),
      plan = turnPlan(job?.options),
      saved = await this.loadResume(job?.id),
      now = Date.now(),
      began = saved?.began || now;
    // This alarm's share of the turn: a model call still going at 12 minutes
    // is stopped (`stopped`), to be asked again in the next one.
    let stopped = false;
    this.chatTimer = setTimeout(() => {
      stopped = true;
      this.chatAbort?.abort();
    }, ALARM_CALL_LIMIT);
    try {
      await this.phase('thinking', { workspace: 'chat', startupMs: 0 });
      const p = await profile(this.env, session.ownerId),
        selected = providerModel(session.model);
      const sources = saved?.sources || [...(session.sources || [])],
        counts = saved?.counts || { searches: 0, searxng: 0, reads: 0 },
        webKey = await credential(this.env, session.ownerId, p, 'ollama'),
        search = await searchConnection(this.env, session.ownerId, p);
      const previous = await this.contextTurns(editAt);
      const jobId = job?.id,
        attached = job?.attachments || [],
        input = saved
          ? { text: prompt, images: [] } // the saved messages hold them
          : await modelInput(this.ctx.storage, prompt, attached),
        artifacts = saved?.artifacts || [],
        listed = await listArtifacts(this.ctx.storage),
        vision = await seesScreenshots(session.model),
        // What the turn's review has done (see review below), kept across
        // alarms; spent holds each reviewer call's {model, usage, cost}.
        guard = { claimed: false, reviews: 0, reviewed: '', spent: [], checks: 0, ...saved?.guard };
      // Checks of pages this alarm, by 'id:version', the steps taken and the
      // size, so the review reuses the check made when the page was written.
      const checks = new Map();
      // An artifact's page rendered, after steps if any, at phone size or wide.
      const rendered = async (a, steps = [], wide = false) => {
        const key =
          a.id +
          ':' +
          a.version +
          (steps.length ? ':' + JSON.stringify(steps) : '') +
          (wide ? ':wide' : '');
        if (!checks.has(key))
          checks.set(
            key,
            await renderArtifact(this.env, a, { steps, ...(wide && { viewport: WIDE }) }),
          );
        return checks.get(key);
      };
      // An artifact's page rendered, as shown to the model (shownCheck).
      const checked = async (a, unavailable, steps = []) =>
        shownCheck(a, await rendered(a, steps), { vision, unavailable });
      // Whether this turn is about an artifact: one exists, or the user names one.
      const inPlay = listed.length > 0 || ABOUT_ARTIFACT.test(prompt);
      // The owner's MCP connections marked for chats, unless this message
      // turned them off (web/options.mjs).
      const mcp =
        job?.options?.mcp === false
          ? { specs: [], calls: new Map(), failures: [] }
          : await chatMcpTools(this.env, session.ownerId, p, this.ctx.storage);
      // The tools and instructions the turn began with, kept when it goes on
      // in a later alarm: rebuilt, they would name newer artifact versions or
      // another MCP tool list, and a changed prefix voids the cache (and
      // Claude's thinking blocks, which are bound to it).
      const toolSpecs = saved?.toolSpecs || [
          ...(plan.search ? WEB_TOOLS : []),
          ...ARTIFACT_TOOLS,
          ...IMAGE_TOOLS,
          ASK_TOOL,
          RENAME_TOOL,
          ...(memoryMode(p) === 'off' ? [] : MEMORY_TOOLS),
          ...mcp.specs,
        ],
        told =
          saved?.instructions ||
          [
            instructions(p),
            nameInstructions(session),
            memoryInstructions(p),
            plan.search ? WEB_INSTRUCTIONS : '',
            ARTIFACT_INSTRUCTIONS,
            artifactList(listed),
            mcp.specs.length ? MCP_INSTRUCTIONS : '',
            mcp.failures.length ? 'Unavailable connections: ' + mcp.failures.join('; ') : '',
            plan.instructions,
          ]
            .filter(Boolean)
            .join('\n\n');
      // A question the model put to the user (decisions.mjs), for the card.
      let decision = null;
      const result = await plainChat({
        model: selected.id,
        provider: selected.provider,
        history: previous,
        prompt: input.text,
        images: input.images,
        rounds: plan.rounds,
        maxOutput: plan.maxOutput,
        effort: (await effortSupported(session.model)) ? plan.effort : 'auto',
        toolSpecs,
        key: await credential(this.env, session.ownerId, p, selected.provider),
        instructions: told,
        signal: this.chatAbort.signal,
        resume: saved?.chat,
        yieldAt: now + ALARM_YIELD,
        checkpoint: chat =>
          this.saveResume({
            jobId,
            began,
            sources,
            counts,
            artifacts,
            guard,
            chat,
            toolSpecs,
            instructions: told,
          }),
        onRound: async round => {
          await this.phase('thinking', { workspace: 'chat', startupMs: 0 });
          if (round) await this.activity('Thinking (step ' + (round + 1) + ')');
        },
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
          if (name === 'ask_user') {
            decision = decisionOf(args);
            await this.activity('Asking you');
            return ASKED;
          }
          await this.activity(toolStep(name, args, [...artifacts, ...listed]));
          if (name === 'rename_chat') {
            const title = newName(args);
            await this.retitle(title);
            return { renamed: title };
          }
          if (MEMORY_TOOLS.some(t => t.name === name))
            return memoryTool(this.env, session.ownerId, name, args);
          if (name === 'find_image') return findImage(args.query);
          if (name === 'check_artifact') {
            if (guard.checks >= MAX_CHECKS)
              throw Object.assign(
                Error(
                  'This turn has used its ' +
                    MAX_CHECKS +
                    ' page checks. Rely on what they showed, and say in your answer what you could not check.',
                ),
                { limit: true }, // the tool is spent: chat.mjs stops offering it
              );
            guard.checks++;
            return checked(
              await findArtifact(this.ctx.storage, args.id),
              true,
              Array.isArray(args.steps) ? args.steps : [],
            );
          }
          if (/_artifact$/.test(name)) {
            const done = await artifactTool(this.ctx.storage, name, args, artifacts);
            if (name === 'read_artifact' || done.kind !== 'html') return done;
            return { ...done, ...(await checked(await getArtifact(this.ctx.storage, done.id))) };
          }
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
        review: async answer => {
          const claim = claimCheck(guard, answer, { inPlay, changed: artifacts.length > 0 });
          if (claim) return { text: claim };
          // The page written last this turn: reviewed once, and once more only
          // if the model changed it after the first review.
          const page = artifacts
              .filter(a => a.kind === 'html')
              .sort((a, b) => a.updatedAt - b.updatedAt)
              .at(-1),
            key = page && page.id + ':' + page.version;
          if (!page || key === guard.reviewed) return null;
          if (guard.reviews && (guard.reviews >= 2 || !guard.reviewed.startsWith(page.id + ':')))
            return null;
          const model = p.reviewModel || session.model,
            reviewer = providerModel(model);
          await this.activity('Reviewing “' + page.title + '” with ' + reviewer.id);
          const a = await getArtifact(this.ctx.storage, page.id),
            phone = shownCheck(a, await rendered(a), { vision: true });
          if (!phone.check) return null; // nothing rendered, nothing to compare
          const wide = shownCheck(a, await rendered(a, [], true), { vision: true, wide: true }),
            shots = [...phone.images, ...(wide.images || [])];
          guard.reviews++;
          guard.reviewed = key;
          const sees = await seesScreenshots(model),
            began = Date.now(),
            r = await reviewPage({
              model: reviewer.id,
              provider: reviewer.provider,
              key: await credential(this.env, session.ownerId, p, reviewer.provider),
              effort: (await effortSupported(model)) ? 'low' : 'auto',
              request: prompt,
              previous: previous.at(-1)?.prompt,
              page: a,
              check: phone.check,
              images: sees ? shots : [],
              signal: this.chatAbort.signal,
            }),
            spent = r.usage && cost(priceOf(await prices(), model), r.usage);
          if (r.usage) guard.spent.push({ model, usage: r.usage, cost: spent });
          console.log(
            JSON.stringify({
              event: 'artifact_review',
              model,
              ms: Date.now() - began,
              defects: r.count,
              cost: spent ?? null,
              ...(r.error && { error: r.error }),
            }),
          );
          if (!r.defects) return null;
          return { text: fixRequest(a, r.defects), images: vision ? shots : [] };
        },
      }).catch(async e => {
        const cancelled = (await this.ctx.storage.get('job'))?.status === 'cancelled';
        // This alarm's share is used up (or a call ran too long): the next one
        // carries on from the state saved before the round.
        if (!cancelled && (e.yielded || stopped))
          throw Object.assign(Error('This turn goes on in its next run'), { yielded: true });
        // A failed turn is charged for what it spent: its model calls at the
        // session's model, its web calls and page reviews too.
        if (e.spent)
          Object.assign(e.spent, { model: session.model, webUsage: counts, reviews: guard.spent });
        throw e;
      });
      await this.clearResume();
      result.model = session.model;
      result.attachments = attached;
      result.artifacts = artifacts;
      if (decision) result.decision = decision;
      result.sources = citedSources(result.summary, sources, previous);
      result.webUsage = counts;
      result.reviews = guard.spent;
      result.options = job?.options;
      if ((await this.ctx.storage.get('job'))?.status === 'cancelled')
        throw Object.assign(Error('Chat cancelled'), { spent: result });
      result.timing = {
        workspace: 'chat',
        startupMs: 0,
        executionMs: Date.now() - began,
        checkpointMs: 0,
        totalMs: Date.now() - began,
      };
      await this.phase('saving', { workspace: 'chat' });
      if ((await this.ctx.storage.get('job'))?.status === 'cancelled')
        throw Object.assign(Error('Chat cancelled'), { spent: result });
      const { toolLog } = result;
      delete result.toolLog; // for the log line, not the saved turn
      await this.saveTurn(result, prompt, null, sources, editAt);
      logTurn(session, job, result, toolLog);
      await this.nameIfNew(prompt, result.summary || '');
      return json(result);
    } finally {
      clearTimeout(this.chatTimer);
      this.chatAbort = null;
      this.inFlight = false;
    }
  },
};

/** How long one alarm runs a turn's rounds before yielding to the next, and
 * when it stops a model call still running; an alarm may run for 15 minutes. */
const ALARM_YIELD = 9 * 60000,
  ALARM_CALL_LIMIT = 12 * 60000;
/** Characters in each saved part of a turn's state. */
const RESUME_PART = 30000;
/** What the model is told when a chat has MCP tools. */
const MCP_INSTRUCTIONS =
  'Tools named <connection>__<tool> reach services the user connected (MCP). Use them when the question is about those services. A tool that changes something waits for the user to allow it; if the user does not, say so and do not try again.';

/** A short line for the live view saying what chat tool `name` does with
 * args; known holds the artifacts it may name by id ({id, title}). */
export function toolStep(name, args = {}, known = []) {
  const title = '“' + (args.title || known.find(a => a.id === args.id)?.title || args.id) + '”';
  const host = () => {
    try {
      return new URL(args.url).hostname.replace(/^www\./, '');
    } catch {
      return 'a page';
    }
  };
  const line =
    {
      web_search: () => 'Searching “' + args.query + '”',
      web_read: () => 'Reading ' + host(),
      find_image: () => 'Finding images of “' + args.query + '”',
      remember: () => 'Remembering “' + args.title + '”',
      recall: () => 'Recalling ' + (args.ids?.length || 0) + ' memories',
      forget: () => 'Forgetting a memory',
      rename_chat: () => 'Renaming the chat “' + args.name + '”',
      create_artifact: () => 'Writing ' + title,
      update_artifact: () => 'Editing ' + title,
      read_artifact: () => 'Reading ' + title,
      check_artifact: () =>
        'Checking ' +
        title +
        ' in a browser' +
        (args.steps?.length ? ' (' + args.steps.length + ' steps)' : ''),
    }[name]?.() || name;
  return line.slice(0, 120);
}
/** What the model is given of artifact a's rendered page r (renderArtifact's):
 * the check, and the screenshot as an image when it can see one (vision),
 * captioned with its size (wide, or phone). When nothing could be rendered:
 * {check: {unavailable}} if unavailable is asked for, else {}. */
function shownCheck(a, r, { vision, unavailable, wide }) {
  if (r.unavailable) return unavailable ? { check: { unavailable: r.unavailable } } : {};
  const caption =
    'Screenshot of ' +
    a.title +
    ' v' +
    a.version +
    ', rendered at ' +
    (wide ? WIDE.width + '×' + WIDE.height : 'phone size') +
    (r.stepErrors ? ', after the steps' : '');
  return {
    check: {
      ok: !r.errors.length && !r.failedLoads.length,
      errors: r.errors,
      failedLoads: r.failedLoads,
      ...(r.stepErrors?.length && { stepErrors: r.stepErrors }),
    },
    images: vision && r.screenshot ? [{ type: 'image/jpeg', data: r.screenshot, caption }] : [],
  };
}
/** check_artifact calls a turn may make: enough to look at a few states, not
 * so many that testing spends the turn's rounds (a model once used 9 trying
 * to drag a pendulum exactly to rest). Checks after writes don't count. */
const MAX_CHECKS = 6;
/** A prompt that names an artifact, or the kind of thing one holds. */
const ABOUT_ARTIFACT = /\b(artifact|page|app|game|site|website|chart|diagram|drawing|svg|html)\b/i;
/** An answer that says it changed something: "I updated / added / fixed …",
 * "it is now live", "now has", "is now v3", or one opening with "Done".
 * Kept narrow, as it sends a right answer back too when it matches one: it
 * wants the first person or a plain statement that the thing changed. */
const CLAIMS_CHANGE =
  /\bI(?:'ve| have)? (?:just )?(?:updated|added|fixed|rebuilt|built|created|made|changed|shipped|rewrote|redesigned|replaced|removed|implemented)\b|\b(?:is|are) (?:now )?live\b|\bnow (?:has|have|shows|includes)\b|\b(?:now|is|to) v\d+\b|^\s*done\b/im;
/** Sent back with an answer that says an artifact changed when none did. */
const CLAIM_CHECK =
  'Your answer says the artifact changed, but no create_artifact or update_artifact call succeeded this turn. Make the change now with the tool, or correct your answer to say it was not made.';
/** What to send back with an answer that claims an artifact changed in a turn
 * about artifacts when nothing was written (changed false); null otherwise.
 * Once a turn: guard.claimed remembers it. */
export function claimCheck(guard, answer, { inPlay, changed }) {
  if (guard.claimed || changed || !inPlay || !CLAIMS_CHANGE.test(answer)) return null;
  guard.claimed = true;
  return CLAIM_CHECK;
}

/** One line in the Worker's log for each finished chat turn: what it ran on,
 * how long and how much, the tools it called (by name, with failures), the
 * artifacts it made or changed and the size of the answer. */
function logTurn(session, job, result, toolLog = []) {
  const tools = {};
  for (const t of toolLog) {
    const n = (tools[t.tool] ||= { calls: 0, failed: 0, ms: 0 });
    n.calls++;
    n.failed += Number(!t.ok);
    n.ms += t.ms;
  }
  console.log(
    JSON.stringify({
      event: 'turn_done',
      session: session.id,
      model: session.model,
      options: job?.options,
      ms: result.timing.totalMs,
      calls: result.usage.calls,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cost: result.usage.cost,
      searches: result.webUsage?.searches,
      reads: result.webUsage?.reads,
      tools,
      artifacts: result.artifacts.map(a => ({ id: a.id, kind: a.kind, version: a.version })),
      answerChars: result.summary.length,
      cutShort: /research limit/.test(result.summary.slice(-160)),
    }),
  );
}
