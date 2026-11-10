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

/** Decode text, native tool calls, and reported usage from either provider's
 * streaming dialect. Credential-bearing headers never enter these results.
 * Anthropic's thinking blocks (thinking with its signature, or redacted) are
 * kept whole in `thinking`: with tools, the next request must send them back
 * unchanged before the tool_use blocks. Only thinking text is ever shown. */
async function readReply(body, onProgress) {
  const reader = body.getReader(),
    decoder = new TextDecoder(),
    calls = new Map(),
    thinking = new Map();
  let buffer = '',
    summary = '',
    reasoning = '',
    usage = null,
    size = 0,
    last = 0;
  const line = s => {
    if (!s.startsWith('data:')) return;
    let v;
    try {
      v = JSON.parse(s.slice(5).trim());
    } catch {
      return;
    }
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
    if (v.type === 'content_block_start' && /thinking$/.test(v.content_block?.type))
      thinking.set(v.index, { ...v.content_block });
    const block = v.type === 'content_block_delta' && thinking.get(v.index);
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
      if (size > 2000000) throw Error('Oversized provider response');
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
    thinking: [...thinking.values()],
    usage,
  };
}

/** Plain chat is a host-side bounded tool loop, never a coding VM. The same
 * provider adapter supports Ollama/OpenAI function calls and Anthropic tools.
 * The last of its `rounds` model requests offers no tools and asks for the
 * answer; if none comes, the latest text said is the answer, marked as cut
 * short. `effort` and
 * `maxOutput` come from the turn's plan (plan.mjs). runTool(name, args) runs
 * one tool call; onRound and onProgress report the turn as it goes; upstream
 * stands in for fetch in tests. Returns the answer, usage and request log. */
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
  onRound = async () => {},
  onProgress = async () => {},
  upstream = fetch,
}) {
  const messages = [],
    replay = PROVIDERS[provider].replay;
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
        ? [
            ...images.map(i => ({
              type: 'image',
              source: { type: 'base64', media_type: i.type, data: i.data },
            })),
            { type: 'text', text: prompt },
          ]
        : [
            { type: 'text', text: prompt },
            ...images.map(i => ({
              type: 'image_url',
              image_url: { url: 'data:' + i.type + ';base64,' + i.data },
            })),
          ],
  });
  if (instructions && provider !== 'anthropic')
    messages.unshift({ role: 'system', content: instructions });
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
    rethought = false; // whether a round was asked again with less thinking
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
  let said = ''; // the latest text the model wrote beside its tool calls
  try {
    return await loop();
  } catch (e) {
    // What the turn spent so far rides on its error, to be charged (records.mjs).
    e.spent = answer('', '');
    throw e;
  }
  // The rounds, until an answer.
  async function loop() {
    for (let round = 0; round < rounds; round++) {
      await onRound();
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
            ? { system: instructions || 'You are a helpful assistant.' }
            : {}),
        }),
      });
      total.calls++;
      if (!response.ok) {
        await response.body?.cancel();
        throw Error(provider + ' could not complete this chat (' + response.status + ')');
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
        if (!reply.calls.length && reply.summary.trim())
          return answer(reply.summary.trim(), reply.reasoning);
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
          content: [
            ...reply.thinking,
            ...(reply.summary ? [{ type: 'text', text: reply.summary }] : []),
            ...parsed.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} })),
          ],
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
      const results = [];
      for (const c of parsed) {
        let result;
        const began = Date.now();
        try {
          if (!c.args) throw Error('Invalid tool arguments');
          result = await runTool(c.name, c.args);
          toolLog.push({ tool: c.name, ok: !result?.error, ms: Date.now() - began });
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
    }
  }
}
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
