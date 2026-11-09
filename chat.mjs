import { WEB_TOOLS } from './web.mjs';
import { displayDelta } from './gateway.mjs';
import { tokens } from './prices.mjs';
import { PROVIDERS } from './account.mjs';
import { attachedNote } from './attachments.mjs';

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
 * streaming dialect. Credential-bearing headers never enter these results. */
async function readReply(response, onProgress) {
  const reader = response.body.getReader(),
    decoder = new TextDecoder(),
    calls = new Map();
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
  return { summary: shown.text, reasoning: shown.reasoning, calls: [...calls.values()], usage };
}

/** Plain chat is a host-side bounded tool loop, never a coding VM. The same
 * provider adapter supports Ollama/OpenAI function calls and Anthropic tools. */
export async function plainChat({
  model,
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
  const messages = [];
  let size = 0;
  for (const t of history.slice(-20).reverse()) {
    const sourceContext = t.sources?.length
      ? '\nSources for this earlier answer: ' +
        t.sources.map(s => '[' + s.id + '] ' + s.title + ' ' + s.url).join('; ')
      : '';
    const pair = [
      { role: 'user', content: t.prompt + attachedNote(t.attachments) },
      { role: 'assistant', content: t.summary + sourceContext },
    ];
    const length = pair.reduce((n, m) => n + m.content.length, 0);
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
  for (let round = 0; round < 8; round++) {
    await onRound();
    const tools =
      runTool && round < 7
        ? provider === 'anthropic'
          ? toolSpecs.map(t => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            }))
          : toolSpecs.map(t => ({
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
        ...(provider === 'anthropic'
          ? { system: instructions || 'You are a helpful assistant.' }
          : { stream_options: { include_usage: true } }),
        ...(provider === 'openai'
          ? { max_completion_tokens: 16384 }
          : provider === 'gemini'
            ? // Thinking counts against Gemini's output limit, so keep its default,
              // and ask for thoughts, which arrive in content as <thought>…</thought>.
              { extra_body: { google: { thinking_config: { include_thoughts: true } } } }
            : { max_tokens: 16384 }),
      }),
    });
    total.calls++;
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(provider + ' could not complete this chat (' + response.status + ')');
    }
    const reply = await readReply(response, preview =>
      onProgress({ ...preview, round: round + 1 }),
    );
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
    if (!reply.calls.length) {
      if (!reply.summary.trim())
        throw Error('The model returned no text. Try another model or a shorter request.');
      return {
        exitCode: 0,
        model,
        summary: reply.summary.trim(),
        reasoning: reply.reasoning,
        diff: '',
        requestLog,
        usage: {
          ...total,
          inputTokens: total.measuredCalls ? total.inputTokens : null,
          outputTokens: total.measuredCalls ? total.outputTokens : null,
        },
      };
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
          ...(reply.summary ? [{ type: 'text', text: reply.summary }] : []),
          ...parsed.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} })),
        ],
      });
    else
      messages.push({
        role: 'assistant',
        content: reply.summary || null,
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
      try {
        if (!c.args) throw Error('Invalid tool arguments');
        result = await runTool(c.name, c.args);
      } catch (e) {
        result = { error: e.message };
      }
      results.push({ id: c.id, result: JSON.stringify(result) });
    }
    if (provider === 'anthropic')
      messages.push({
        role: 'user',
        content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.result })),
      });
    else
      for (const r of results)
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.result });
  }
  throw Error('Research reached its model-call limit. Narrow the question and try again.');
}
