/** A coding session's turn, part of ArnoProbe (probe.mjs): the workspace is
 * started or restored, arno's configuration written, git set up, and the
 * user's line given to `arno --serve` (serve.mjs), whose entries stream to the
 * live view while the model gateway counts the requests; then the diff, the
 * checkout following a pushed branch, the artifacts arno made (collect.mjs),
 * a snapshot, and the turn saved. */
import { json } from '../http.mjs';
import { readAttachment } from '../probe/attachments.mjs';
import { WORKTREE_DIFF } from './publish.mjs';
import { buildPrompt, sessionPrompt } from './context.mjs';
import { serveTurn, replyOf, transcriptOf, activityOf, testsOf, workerOf } from './serve.mjs';
import { sandboxEnv } from './sandbox.mjs';
import { collectArtifacts } from './collect.mjs';
import { citedSources } from '../chat/research.mjs';
import { ASK_TOOL } from '../decisions.mjs';
import { turnPlan, codeLimits } from '../chat/plan.mjs';

export const codeTurn = {
  /** Runs prompt in session's workspace: the turn's result, saved. editAt
   * names the turn an edited or retried message replaces: the workspace goes
   * back to how that turn found it, and it and every later turn are dropped. */
  async codeTurn(session, prompt, editAt) {
    this.inFlight = true;
    try {
      const began = Date.now(),
        turnId = crypto.randomUUID();
      if (editAt) await this.rewind(editAt);
      // How this turn finds the workspace, for an edit or retry of it later.
      const before = (await this.ctx.storage.get('snapshot')) || null;
      await this.phase(this.ctx.container.running ? 'preparing' : 'restoring');
      const workspace = await this.start(session.model);
      if ((await this.ctx.storage.get('job'))?.status === 'cancelled')
        throw Error('Task cancelled');
      const options = (await this.ctx.storage.get('job'))?.options,
        plan = turnPlan(options),
        limits = codeLimits(options);
      await this.writeConfig(session.model, plan, options);
      await this.gitSetup(session);
      const startupMs = Date.now() - began;
      await this.phase('thinking', { workspace, startupMs });
      const previous = (await this.history()).filter(t => !editAt || t.at < editAt);
      // Attached files go into the workspace, outside the repository, and the
      // prompt names them: the prompt is a command-line argument, too small for
      // inlining.
      const attached = (await this.ctx.storage.get('job'))?.attachments || [];
      const paths = [];
      for (const meta of attached) {
        const file = await readAttachment(this.ctx.storage, meta.id),
          path = '/workspace/attachments/' + meta.id.slice(0, 8) + '-' + meta.name;
        if (!file) continue;
        await this.exec(['sh', '-c', 'mkdir -p /workspace/attachments && cat > "$1"', 'sh', path], {
          stdin: new Response(file.bytes).body,
        });
        paths.push(path);
      }
      const note = paths.length
        ? '\n\nAttached files (read them as needed):\n' + paths.join('\n')
        : '';
      // The model gateway reads the turn's options from here (/model-account).
      await this.ctx.storage.put('modelQuota', {
        used: 0,
        rounds: limits.rounds,
        turnId,
        options,
        sources: session.sources || [],
        webCounts: { searches: 0, reads: 0 },
        deadline: Date.now() + limits.timeLimit + 60000,
      });
      const refsBefore = await this.remoteRefs();
      const modelBegan = Date.now();
      const process = await this.ctx.container.exec(
        [
          'timeout',
          '--kill-after=10',
          String(limits.timeLimit / 1000 + 60),
          '/usr/local/bin/arno',
          '--serve',
        ],
        {
          cwd: '/workspace/repo',
          env: {
            XDG_CONFIG_HOME: '/workspace/config',
            XDG_DATA_HOME: '/workspace/data',
            PYTHONDONTWRITEBYTECODE: '1',
            ...sandboxEnv((await this.sandbox(session.ownerId)).cloudflare),
          },
          stdin: 'pipe',
        },
      );
      // arno's standard error (crashes, and what tools print) is kept short.
      let stderr = '';
      const drained = process.stderr
        ?.pipeThrough(new TextDecoderStream())
        .pipeTo(new WritableStream({ write: t => void (stderr = (stderr + t).slice(-10000)) }))
        .catch(() => {});
      const stop = new AbortController(),
        timer = setTimeout(() => stop.abort(), limits.timeLimit);
      let turn;
      try {
        turn = await serveTurn(process, {
          hello: {
            prompt: sessionPrompt(session, await this.sandbox(session.ownerId)),
            // The app's own tool: a question for the user, as a card.
            tools: [
              {
                name: ASK_TOOL.name,
                description: ASK_TOOL.description,
                parameters: ASK_TOOL.inputSchema,
              },
            ],
          },
          conversation: session.arnoConversation,
          // A conversation arno no longer has (or a session from before it kept
          // them) starts again with the earlier turns as context.
          // A command goes as it is.
          line: loaded =>
            prompt.startsWith('/')
              ? prompt
              : loaded
                ? prompt + note
                : buildPrompt(session, previous, prompt + note),
          onEvent: e => {
            const w = workerOf(e);
            if (w) this.worker(w);
            return this.activity(activityOf(e));
          },
          signal: stop.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const exitCode = await Promise.race([
        process.exitCode,
        new Promise(r => setTimeout(() => r(null), 15000)),
      ]);
      await drained;
      if (turn.conversation && turn.conversation !== session.arnoConversation)
        await this.ctx.storage.put('session', {
          ...(await this.ctx.storage.get('session')),
          arnoConversation: turn.conversation,
        });
      const executionMs = Date.now() - modelBegan;
      await this.phase('checkpointing', { workspace, startupMs, executionMs });
      const pushed = await this.followPush(refsBefore);
      const pushes = pushed ? await this.pushedCommits(refsBefore, pushed).catch(() => null) : null;
      // What arno made in its artifacts directory, kept where the app shows it.
      const artifacts = await collectArtifacts(this).catch(e => {
        console.error(JSON.stringify({ event: 'collect_failed', error: String(e) }));
        return [];
      });
      const reply = replyOf(turn),
        failed = !reply && !turn.entries.length;
      // What GitHub does not have yet, after the turn (publish.mjs).
      const diffResult = await this.exec(
        ['node', '-e', WORKTREE_DIFF],
        {
          cwd: '/workspace/repo',
          env: { ARNO_REF: (await this.ctx.storage.get('session')).ref || '' },
        },
        30,
      );
      const result = {
        exitCode: failed ? exitCode || 1 : 0,
        model: session.model,
        summary: (
          (turn.cancelled ? 'Stopped at the time limit. ' : '') +
          (reply || stderr || 'Arno ended without a reply (exit ' + exitCode + ').')
        ).slice(-12000),
        diff: diffResult.stdout.slice(-40000),
        diagnostics: (transcriptOf(turn) + (stderr ? '\n\n' + stderr : '')).slice(-40000),
        arno: turn.stats,
        pushed: pushed || undefined,
        // For the turn's cards: what it pushed, and its last test run.
        commits: pushes?.commits.length ? pushes : undefined,
        tests: testsOf(turn) || undefined,
        decision: turn.decision || undefined,
        timedOut: turn.cancelled || undefined,
        before,
        reasoning:
          this.live?.jobId === (await this.ctx.storage.get('job'))?.id
            ? this.live?.reasoning || ''
            : '',
        timing: { startupMs, executionMs, workspace },
      };
      const q = await this.ctx.storage.get('modelQuota');
      result.usage = {
        calls: q?.used || 0,
        measuredCalls: q?.measuredCalls || 0,
        inputTokens: q?.measuredCalls ? q.inputTokens : null,
        outputTokens: q?.measuredCalls ? q.outputTokens : null,
        cachedTokens: q?.cachedTokens || 0,
        cacheWriteTokens: q?.cacheWriteTokens || 0,
        lastInputTokens: q?.lastInputTokens ?? null,
        ...(q?.byModel && { byModel: q.byModel }),
      };
      result.requestLog = q?.requestLog || [];
      result.sources = citedSources(result.summary, q?.sources || [], previous);
      result.attachments = attached;
      result.artifacts = artifacts;
      result.webUsage = q?.webCounts || { searches: 0, reads: 0 };
      result.options = options;
      const checkpointBegan = Date.now();
      const snapshot = await this.ctx.container.snapshotContainer({});
      result.timing.checkpointMs = Date.now() - checkpointBegan;
      result.timing.totalMs = Date.now() - began;
      await this.saveTurn(result, prompt, snapshot, q?.sources || [], editAt);
      return json(result);
    } finally {
      this.inFlight = false;
      const thinking = await this.ctx.storage.list({ prefix: 'thinking:' });
      await this.ctx.storage.delete(['modelQuota', 'thinking', ...thinking.keys()]);
      await this.ctx.storage.setAlarm(Date.now() + 35 * 60 * 1000);
    }
  },
  /** Puts the workspace back as the turn saved at editAt found it: that
   * turn's starting snapshot (none: a fresh clone), the container stopped so
   * the next start restores it. arno's conversation and staged edits live in
   * the workspace, so they go back too; what was pushed stays on GitHub. */
  async rewind(editAt) {
    const turns = await this.history(true),
      turn = turns.find(t => t.at >= editAt);
    if (!turn) throw Error('That message is no longer saved');
    if (!('before' in turn))
      throw Error(
        'That turn was saved before its workspace could be restored; send a new message instead',
      );
    if (this.ctx.container.running) await this.ctx.container.destroy();
    if (turn.before) await this.ctx.storage.put('snapshot', turn.before);
    else await this.ctx.storage.delete('snapshot');
  },
};
