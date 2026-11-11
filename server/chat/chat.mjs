/** A regular chat's model loop, run on the Worker with no container:
 *
 *   history + prompt → request → stream (readReply) → tool calls?
 *        ↑                                               yes: runTool, add results
 *        └───────────────────────────────────────────────┘  no: the answer
 *
 * One streaming request per round, in the provider's own dialect (Anthropic,
 * or the OpenAI-style one the others speak), for at most `rounds` rounds.
 * Depends on research.mjs (default tools), gateways/model.mjs (stream
 * decoding), prices.mjs, providers.mjs and probe/attachments.mjs. The tools
 * themselves are chosen by turn.mjs. Leaves out saving the turn. */
import { WEB_TOOLS } from './research.mjs';
import { displayDelta, mistralDeltas } from '../gateways/model.mjs';
import { tokens } from '../prices.mjs';
import { PROVIDERS, MAX_OUTPUT, requestFields, effortModel } from '../providers.mjs';
import { attachedNote } from '../probe/attachments.mjs';

/** Gemini streams its thoughts as a leading <thought>…</thought> in the text;
 * move them to the reasoning, as other providers report it. */
function visible(text, reasoning) {
  if (!text.startsWith('<thought>')) return { text, reasoning };
  const end = text.indexOf('</thought>');
  return end < 0
    ? { text: '', reasoning: reasoning + text.slice(9) }
    : { text: text.slice(end + 10), reasoning: reasoning + text.slice(9, end) };
}

/** The most bytes one streamed reply may take. The wire costs far more than its
 * text (a JSON event per few characters), so 16,000 tokens of thinking can pass
 * 2 MB; the text itself is held to 60,000 characters below. */
const MAX_STREAM = 32e6;
/** Decode text, native tool calls, and reported usage from either provider's
 * streaming dialect. Credential-bearing headers never enter these results.
 * Anthropic's content blocks are kept in `blocks`, in the order they came:
 * with tools, the next request must send the thinking blocks (with their
 * signatures, or redacted) back unchanged and in place, and a model that
 * thinks between calls interleaves them with text and tool_use. Only
 * thinking text is ever shown.
 * `finish` is why the reply ended (finish_reason or stop_reason), `complete`
 * whether the stream said it had (that, [DONE] or message_stop): a stream
 * cut short says neither. */
async function readReply(body, onProgress) {
  const reader = body.getReader(),
    decoder = new TextDecoder(),
    calls = new Map(),
    blocks = new Map();
  let buffer = '',
    summary = '',
    reasoning = '',
    usage = null,
    size = 0,
    last = 0,
    finish = null,
    ended = false,
    lastLine = '';
  const line = s => {
    if (s.trim()) lastLine = s;
    if (!s.startsWith('data:')) return;
    if (s.slice(5).trim() === '[DONE]') return void (ended = true);
    let v;
    try {
      v = JSON.parse(s.slice(5).trim());
    } catch {
      return;
    }
    finish = v.choices?.[0]?.finish_reason || v.delta?.stop_reason || finish;
    if (v.type === 'message_stop') ended = true;
    const u = v.message?.usage || v.usage;
    if (u) usage = { ...(usage || {}), ...u };
    const delta = displayDelta(v);
    summary += delta.text;
    reasoning = (reasoning + delta.reasoning).slice(0, 12000);
    for (const c of v.choices?.[0]?.delta?.tool_calls || []) {
      // Gemini sends each call whole, without an index, and with a thought
      // signature in extra_content that must be sent back with the call.
      const key = c.index ?? c.id ?? calls.size;
      const old = calls.get(key) || { id: '', name: '', arguments: '' };
      if (c.id) old.id = c.id;
      if (c.function?.name) old.name = c.function.name;
      if (c.extra_content) old.extra_content = c.extra_content;
      old.arguments += c.function?.arguments || '';
      calls.set(key, old);
    }
    if (v.type === 'content_block_start' && v.content_block?.type === 'tool_use')
      calls.set(v.index, {
        id: v.content_block.id,
        name: v.content_block.name,
        arguments: '',
        input: v.content_block.input,
      });
    if (v.type === 'content_block_delta' && v.delta?.partial_json) {
      const c = calls.get(v.index);
      if (c) c.arguments += v.delta.partial_json;
    }
    if (v.type === 'content_block_start' && v.content_block)
      blocks.set(v.index, { ...v.content_block });
    const block = v.type === 'content_block_delta' && blocks.get(v.index);
    if (block?.type === 'text' && v.delta.type === 'text_delta')
      block.text = (block.text || '') + v.delta.text;
    if (block?.type === 'thinking' && v.delta.type === 'thinking_delta')
      block.thinking = (block.thinking || '') + v.delta.thinking;
    if (block?.type === 'thinking' && v.delta.type === 'signature_delta')
      block.signature = (block.signature || '') + v.delta.signature;
    if (summary.length > 60000) throw Error('Chat response exceeded its display limit');
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_STREAM)
        throw Error(
          "The model's reply passed " +
            MAX_STREAM / 1e6 +
            ' MB, too long to keep. Try again, or ask for less at once.',
        );
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const s of lines) line(s);
      if (Date.now() - last >= 200) {
        last = Date.now();
        await onProgress(visible(summary, reasoning));
      }
    }
    line(buffer + decoder.decode());
    await onProgress({ ...visible(summary, reasoning), final: true });
  } finally {
    reader.releaseLock();
  }
  const shown = visible(summary, reasoning);
  return {
    summary: shown.text,
    reasoning: shown.reasoning,
    calls: [...calls.values()],
    blocks: [...blocks].sort(([a], [b]) => a - b).map(([, b]) => b),
    usage,
    finish,
    complete: ended || !!finish,
    bytes: size,
    tail: (buffer || lastLine).slice(-200), // the stream's last line, for a cut one's log
  };
}

/** Plain chat is a host-side bounded tool loop, never a coding VM. The same
 * provider adapter supports Ollama/OpenAI function calls and Anthropic tools.
 * The last of its `rounds` model requests offers no tools and asks for the
 * answer; if none comes, the latest text said is the answer, marked as cut
 * short. `effort` and `maxOutput` come from the turn's plan (plan.mjs).
 * runTool(name, args) runs one tool call; onRound(round) and onProgress report
 * the turn as it goes; upstream stands in for fetch in tests. Returns the answer,
 * usage and request log.
 *
 * A tool's result may carry images ({type, data, caption}: a screenshot of a
 * page it made), kept out of its JSON and shown to the model after the
 * round's results; only the latest KEEP_SHOTS stay in the conversation.
 * review(answer), when given, sees each answer before it is returned and may
 * send it back with {text, images}: the model is told that and asked again,
 * while a round is left for it to act.
 *
 * Resumable: before each round the loop hands its state to checkpoint (the
 * messages so far, the counts, the round), and from yieldAt on (or once the
 * signal is aborted) it stops there, throwing an error marked yielded, rather
 * than start another. Called again with that state as resume, it carries on
 * from the same round; a round cut off mid-call is asked again. */
export async function plainChat({
  model,
  rounds = 12,
  effort = 'auto',
  maxOutput,
  history,
  prompt,
  images = [],
  toolSpecs = WEB_TOOLS,
  key,
  provider = 'ollama',
  instructions = '',
  signal,
  runTool,
  review = null,
  onRound = async () => {},
  onProgress = async () => {},
  upstream = fetch,
  resume = null,
  checkpoint = async () => {},
  yieldAt = Infinity,
}) {
  const replay = PROVIDERS[provider].replay,
    messages = resume ? resume.messages : opening();
  // The conversation the turn opens with: earlier turns (up to 32,000
  // characters of them), this message with its images, the instructions.
  function opening() {
    const messages = [];
    let size = 0;
    for (const t of history.slice(-20).reverse()) {
      const sourceContext = t.sources?.length
        ? '\nSources for this earlier answer: ' +
          t.sources.map(s => '[' + s.id + '] ' + s.title + ' ' + s.url).join('; ')
        : '';
      const pair = [
        { role: 'user', content: t.prompt + attachedNote(t.attachments) },
        {
          role: 'assistant',
          content: t.summary + sourceContext,
          ...(replay ? { reasoning_content: t.reasoning || '' } : {}),
        },
      ];
      const length = pair.reduce(
        (n, m) => n + m.content.length + (m.reasoning_content?.length || 0),
        0,
      );
      if (size + length > 32000) break;
      messages.unshift(...pair);
      size += length;
    }
    // Images ride with this message only, in each provider's own format.
    messages.push({
      role: 'user',
      content: !images.length
        ? prompt
        : provider === 'anthropic'
          ? [...imageParts(images, provider), { type: 'text', text: prompt }]
          : [{ type: 'text', text: prompt }, ...imageParts(images, provider)],
    });
    if (instructions && provider !== 'anthropic')
      messages.unshift({ role: 'system', content: instructions });
    return messages;
  }
  if (!key) throw Error('Save an API key for ' + provider + ' in Account settings');
  const endpoint = PROVIDERS[provider].base + PROVIDERS[provider].chat;
  const total = {
    calls: 0,
    measuredCalls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  };
  // One entry per model request, for the account's request log.
  const requestLog = [];
  // One entry per tool call, {tool, ok, ms}, for the turn's log line.
  const toolLog = [];
  // Tools whose limit this turn has reached (an error marked limit): no longer
  // offered, as some models keep calling them anyway.
  const spentTools = new Set();
  // The request's fields at a thinking effort. Gemini's thoughts arrive in
  // content as <thought>…</thought>, asked for beside the effort's own thinking_config.
  const fieldsAt = level => {
    const f = requestFields(provider, { model, effort: level, maxOutput });
    if (provider === 'gemini') {
      const config = f.extra_body?.google?.thinking_config || {};
      f.extra_body = { google: { thinking_config: { ...config, include_thoughts: true } } };
    }
    return f;
  };
  let fields = fieldsAt(effort),
    rethought = false, // whether a round was asked again with less thinking
    recut = false, // whether a round cut short by the provider was asked again
    said = ''; // the latest text the model wrote beside its tool calls
  if (resume) {
    Object.assign(total, resume.total);
    requestLog.push(...resume.requestLog);
    toolLog.push(...resume.toolLog);
    for (const t of resume.spentTools) spentTools.add(t);
    ({ rethought, recut, said } = resume);
    if (rethought) fields = fieldsAt('off');
  }
  // What a later call needs to carry on from round: everything above that changes.
  const state = round => ({
    round,
    messages,
    total,
    requestLog,
    toolLog,
    spentTools: [...spentTools],
    rethought,
    recut,
    said,
  });
  // The answer, with the turn's usage: on a cut-short turn, what was said last.
  const answer = (summary, reasoning) => ({
    exitCode: 0,
    model,
    summary,
    reasoning,
    diff: '',
    requestLog,
    toolLog,
    usage: {
      ...total,
      inputTokens: total.measuredCalls ? total.inputTokens : null,
      outputTokens: total.measuredCalls ? total.outputTokens : null,
    },
  });
  try {
    return await loop();
  } catch (e) {
    if (e.yielded) throw e; // not a failure: the turn goes on in the next call
    // What the turn spent so far rides on its error, to be charged (records.mjs).
    e.spent = answer('', '');
    throw e;
  }
  // The rounds, until an answer.
  async function loop() {
    for (let round = resume?.round || 0; round < rounds; round++) {
      await checkpoint(state(round));
      if (Date.now() >= yieldAt || signal?.aborted)
        throw Object.assign(Error('This turn goes on in its next run'), { yielded: true });
      await onRound(round);
      if (runTool && round && round === rounds - 1) nudge(messages, provider);
      const offered = toolSpecs.filter(t => !spentTools.has(t.name));
      const tools =
        runTool && round < rounds - 1 && offered.length
          ? provider === 'anthropic'
            ? offered.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema,
              }))
            : offered.map(t => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              }))
          : undefined;
      const asked = Date.now();
      const response = await upstream(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers:
          provider === 'anthropic'
            ? {
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
              }
            : { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          tools,
          ...fields,
          ...(provider === 'anthropic'
            ? {
                system: instructions || 'You are a helpful assistant.',
                // Each round re-reads the turn so far from the cache.
                cache_control: { type: 'ephemeral' },
              }
            : {}),
        }),
      });
      total.calls++;
      if (!response.ok) {
        // The provider's reason ({error: {message}} in every dialect we
        // speak) says what to fix; the status alone doesn't.
        const said = await response.text().catch(() => '');
        let reason = '';
        try {
          reason = String(JSON.parse(said).error?.message || '').slice(0, 300);
        } catch {
          // Not JSON: the log keeps the body.
        }
        console.log(
          JSON.stringify({
            event: 'chat_http_error',
            provider,
            model,
            status: response.status,
            body: said.slice(0, 1000),
          }),
        );
        throw Error(
          provider +
            ' could not complete this chat (' +
            response.status +
            (reason ? ': ' + reason : '') +
            ')',
        );
      }
      const body =
        provider === 'mistral' ? response.body.pipeThrough(mistralDeltas()) : response.body;
      const reply = await readReply(body, preview => onProgress({ ...preview, round: round + 1 }));
      if (reply.usage) {
        const t = tokens(reply.usage);
        total.measuredCalls++;
        total.inputTokens += t.input + t.cached + t.write;
        total.cachedTokens += t.cached;
        total.cacheWriteTokens += t.write;
        total.outputTokens += t.output;
        total.lastInputTokens = t.input + t.cached + t.write;
        requestLog.push({ at: Date.now(), ...t });
      }
      if (reply.summary.trim() && reply.calls.length) said = reply.summary.trim();
      // The provider's stream ended before the reply said it had: ask the
      // round once more, then fail rather than keep a fragment as the answer.
      if (!reply.complete) {
        console.log(
          JSON.stringify({
            event: 'stream_cut',
            provider,
            model,
            round: round + 1,
            text: reply.summary.length,
            calls: reply.calls.length,
            reasoning: reply.reasoning.length,
            bytes: reply.bytes,
            ms: Date.now() - asked,
            tail: reply.tail,
            again: !recut,
          }),
        );
        if (recut)
          throw Error(
            provider + ' cut its reply off before it finished, twice. Try again, or another model.',
          );
        recut = true;
        // A cut that came while writing a tool call or a long reply will likely
        // come again: ask for the work in smaller pieces.
        if (reply.calls.length || reply.summary.length > LONG_REPLY)
          tell(messages, provider, CUT_ADVICE);
        round--;
        continue;
      }
      // All of the output went on thinking (seen with DeepSeek's flash models at
      // the provider's default effort): ask the same round again, not thinking (low still
      // spent it all).
      const spent = reply.usage && tokens(reply.usage).output >= (maxOutput || MAX_OUTPUT);
      if (
        !reply.calls.length &&
        !reply.summary.trim() &&
        spent &&
        !rethought &&
        effort !== 'off' &&
        effortModel(provider, model)
      ) {
        console.log(JSON.stringify({ event: 'rethink', provider, model, round: round + 1 }));
        fields = fieldsAt('off');
        rethought = true;
        round--;
        continue;
      }
      if (!reply.calls.length || round === rounds - 1) {
        if (!reply.calls.length && reply.summary.trim()) {
          const text = reply.summary.trim(),
            back = review && round < rounds - FIX_ROUNDS ? await review(text) : null;
          if (!back) return answer(text, reply.reasoning);
          // Sent back: the answer stays in the conversation, then why.
          messages.push({
            role: 'assistant',
            content: text,
            ...(replay ? { reasoning_content: reply.reasoning } : {}),
          });
          tell(messages, provider, back.text, back.images);
          said = text;
          continue;
        }
        if (said) return answer(said + CUT_SHORT, reply.reasoning);
        console.log(
          JSON.stringify({
            event: 'empty_reply',
            provider,
            model,
            round: round + 1,
            rounds,
            calls: reply.calls.length,
            reasoning: reply.reasoning?.length || 0,
            output: reply.usage ? tokens(reply.usage).output : null,
          }),
        );
        throw Error(
          round === rounds - 1
            ? 'Research ran out of model calls before an answer. Try Super search, or narrow the question.'
            : 'The model returned no text. Try another model or a shorter request.',
        );
      }
      if (!runTool) throw Error('This response requested unavailable tools');
      const parsed = reply.calls.map(c => {
        try {
          return { ...c, args: c.arguments ? JSON.parse(c.arguments) : c.input || {} };
        } catch {
          return { ...c, args: null };
        }
      });
      if (provider === 'anthropic')
        messages.push({
          role: 'assistant',
          content: reply.blocks
            .filter(b => b.type !== 'text' || b.text?.trim())
            .map(b => {
              if (b.type !== 'tool_use') return b;
              const c = parsed.find(c => c.id === b.id);
              return { type: 'tool_use', id: b.id, name: b.name, input: c?.args || {} };
            }),
        });
      else
        messages.push({
          role: 'assistant',
          content: reply.summary || null,
          ...(replay ? { reasoning_content: reply.reasoning } : {}),
          tool_calls: reply.calls.map(c => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments || JSON.stringify(c.input || {}) },
            ...(c.extra_content ? { extra_content: c.extra_content } : {}),
          })),
        });
      const results = [],
        shots = [];
      for (const c of parsed) {
        let result;
        const began = Date.now();
        try {
          if (!c.args) throw Error('Invalid tool arguments');
          result = await runTool(c.name, c.args);
          toolLog.push({ tool: c.name, ok: !result?.error, ms: Date.now() - began });
          if (Array.isArray(result?.images)) {
            const { images, ...rest } = result;
            shots.push(...images);
            result = rest;
          }
        } catch (e) {
          toolLog.push({ tool: c.name, ok: false, ms: Date.now() - began, error: e.message });
          if (e.limit) spentTools.add(c.name);
          console.log(
            JSON.stringify({ event: 'tool_error', model, tool: c.name, error: e.message }),
          );
          result = { error: e.message };
        }
        results.push({ id: c.id, result: JSON.stringify(result) });
      }
      if (provider === 'anthropic')
        messages.push({
          role: 'user',
          content: results.map(r => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.result,
          })),
        });
      else
        for (const r of results)
          messages.push({ role: 'tool', tool_call_id: r.id, content: r.result });
      if (shots.length) tell(messages, provider, '', shots);
    }
  }
}
/** images ({type, data}) as message parts, in the provider's own format. */
function imageParts(images, provider) {
  return images.map(i =>
    provider === 'anthropic'
      ? { type: 'image', source: { type: 'base64', media_type: i.type, data: i.data } }
      : { type: 'image_url', image_url: { url: 'data:' + i.type + ';base64,' + i.data } },
  );
}
/** Screenshots a conversation keeps at once: each is some hundreds of tokens
 * and tens of kilobytes of saved state, and the latest is the one that counts. */
const KEEP_SHOTS = 2;
/** A screenshot's caption, which marks the image after it as one (a tool's,
 * not the user's). */
const SHOT_CAPTION = /^Screenshot of .*, rendered at /;
/** Tells the model text, with images ({type, data, caption}) each after its
 * caption, as a user message; Anthropic's joins the tool results' turn when
 * that is the last. Earlier screenshots are left out first, so that no more
 * than KEEP_SHOTS remain, except for Anthropic: its thinking blocks are bound
 * to the conversation before them, so an edit there fails the next request
 * (400, "bound to a different conversation"), and it would void the cache. */
function tell(messages, provider, text, images = []) {
  const shown = [];
  if (provider !== 'anthropic')
    for (const m of messages)
      if (Array.isArray(m.content))
        m.content.forEach((part, i) => {
          const image = /^image/.test(m.content[i + 1]?.type);
          if (image && SHOT_CAPTION.test(part.text || '')) shown.push([m.content, i + 1]);
        });
  for (const [content, i] of shown.slice(0, Math.max(0, shown.length + images.length - KEEP_SHOTS)))
    content[i] = { type: 'text', text: '(an earlier screenshot, left out)' };
  const parts = [
    ...(text ? [{ type: 'text', text }] : []),
    ...images.flatMap(i => [{ type: 'text', text: i.caption }, ...imageParts([i], provider)]),
  ];
  const last = messages.at(-1);
  if (provider === 'anthropic' && last?.role === 'user' && Array.isArray(last.content))
    last.content.push(...parts);
  else messages.push({ role: 'user', content: images.length ? parts : text });
}
/** Rounds an answer sent back (a review's defects, a claim to check) needs
 * left to act on it: an edit, a check, the answer. With fewer, the answer
 * stands rather than ending in "I ran out of tool calls". */
const FIX_ROUNDS = 4;
/** Replies longer than this, in characters, count as long when cut off. */
const LONG_REPLY = 8000;
/** Said when a reply cut off by the provider is asked again. */
const CUT_ADVICE =
  'Your last reply was cut off by the provider before it finished (a single reply may run only about 3 minutes). Do it in smaller steps: change an artifact with edits, or build a large page as a working skeleton and add sections with update_artifact append.';
/** Added to a turn's answer when its model calls ran out before it finished. */
const CUT_SHORT =
  '\n\n*Stopped at this turn’s research limit, so this may be incomplete. Super search allows more.*';
/** Before the last model request (which offers no tools): asks for the answer
 * now, from what was found. Anthropic's goes beside the tool results, in the
 * same user turn. */
function nudge(messages, provider) {
  const text =
    'This turn has no tool calls left. Answer now from what you found, and say what you could not check.';
  const last = messages.at(-1);
  if (
    last?.content === text ||
    (Array.isArray(last?.content) && last.content.at(-1)?.text === text)
  )
    return; // asked already, before a round asked again
  if (provider === 'anthropic' && Array.isArray(last?.content))
    last.content.push({ type: 'text', text });
  else messages.push({ role: 'user', content: text });
}
