/** The model gateway's work: a request from the coding container, checked,
 * rewritten and sent to the provider with the owner's key:
 *
 *   container → modelRequest → provider → stream → usageStream → container
 *                 (checks, plan)            (counts tokens, reports progress,
 *                                            keeps Claude's thinking)
 *
 * The container never holds the key and cannot change the model, the effort
 * or the output limit. The stream helpers here are also used by chat/chat.mjs.
 * Depends on prices.mjs and providers.mjs. Leaves out whose account it is and
 * the turn's quota, which gateways.mjs asks the session for. */
import { tokens } from '../prices.mjs';
import { PROVIDERS, requestFields } from '../providers.mjs';
// A long coding conversation, sent whole each step, with its tools: arno's
// prune keeps history near 200 KB, so this is a ceiling, not a working size.
const MAX_BODY = 8 * 1024 * 1024;

/** How long a provider may take to start answering, in ms. */
const HEADERS_MS = 90000;
/** Reads a JSON request body, refusing more than MAX_BODY bytes. */
async function readBounded(body) {
  if (!body) throw new Error('missing body');
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new Error('body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Only provider-designated display fields cross into the UI. Never expose
 * tool arguments, signatures, encrypted reasoning, request bodies or headers. */
export function displayDelta(data) {
  const d = data.choices?.[0]?.delta || data.delta || {};
  return {
    text: typeof d.content === 'string' ? d.content : typeof d.text === 'string' ? d.text : '',
    reasoning:
      typeof d.reasoning_content === 'string'
        ? d.reasoning_content
        : typeof d.reasoning === 'string'
          ? d.reasoning
          : d.type === 'thinking_delta' && typeof d.thinking === 'string'
            ? d.thinking
            : '',
  };
}
/** Mistral streams thinking as a list of content chunks ({type: "thinking",
 * thinking: [{type: "text", text}]} and {type: "text", text}) where others
 * stream strings; rewrite such deltas as content and reasoning_content, so
 * the runner and the display read Mistral like the rest. Other lines pass
 * unchanged. */
export function mistralDeltas() {
  const decoder = new TextDecoder(),
    encoder = new TextEncoder();
  let buffer = '';
  const rewrite = line => {
    if (!line.startsWith('data:')) return line;
    try {
      const data = JSON.parse(line.slice(5)),
        d = data.choices?.[0]?.delta;
      if (!Array.isArray(d?.content)) return line;
      const text = list => list.map(c => (typeof c.text === 'string' ? c.text : '')).join('');
      const reasoning = text(
        d.content.filter(c => c.type === 'thinking').flatMap(c => c.thinking || []),
      );
      d.content = text(d.content.filter(c => c.type === 'text'));
      if (reasoning) d.reasoning_content = reasoning;
      return 'data: ' + JSON.stringify(data);
    } catch {
      return line;
    }
  };
  return new TransformStream({
    /** Rewrites the complete lines of a chunk, holding back a partial one. */
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (lines.length) controller.enqueue(encoder.encode(lines.map(rewrite).join('\n') + '\n'));
      // A line this long is not a delta worth rewriting; pass it on as it is.
      if (buffer.length > 65536) {
        controller.enqueue(encoder.encode(buffer));
        buffer = '';
      }
    },
    /** Passes on what is left at the end. */
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
    },
  });
}
/** Claude's thinking blocks in a streamed reply, whole (text and signature,
 * or redacted data), and the ids of the tool calls they came before. */
function thinkingBlocks() {
  const blocks = new Map(),
    toolIds = [];
  return {
    /** Takes one decoded stream event. */
    read(data) {
      const start = data.type === 'content_block_start' && data.content_block;
      if (/thinking$/.test(start?.type)) blocks.set(data.index, { ...start });
      if (start?.type === 'tool_use') toolIds.push(start.id);
      const block = data.type === 'content_block_delta' && blocks.get(data.index);
      if (block?.type === 'thinking' && data.delta.type === 'thinking_delta')
        block.thinking = (block.thinking || '') + data.delta.thinking;
      if (block?.type === 'thinking' && data.delta.type === 'signature_delta')
        block.signature = (block.signature || '') + data.delta.signature;
    },
    /** What was kept: the blocks, and the tool call ids that followed. */
    result: () => ({ toolIds, blocks: [...blocks.values()] }),
  };
}
/** The runner drops Claude's thinking blocks, but with thinking on, the
 * assistant message that called tools must start with them, unchanged. Put
 * back the ones the gateway kept (saved: [{toolIds, blocks}], this turn's
 * replies) in every reply of the turn, not only the last: Claude's thinking
 * is bound to the conversation before it, so a reply that loses its blocks
 * on a later request voids every block after it. Replies of earlier turns
 * stay without, as in every request of this one. Without the last reply's
 * blocks, this request goes without thinking, which the API allows. */
export function replayThinking(payload, saved) {
  const kept = Array.isArray(saved) ? saved : saved ? [saved] : [],
    last = payload.messages.findLast(m => m.role === 'assistant');
  let missing = false;
  payload.messages = payload.messages.map(m => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    if (m.content.some(b => /thinking$/.test(b.type))) return m;
    const ids = m.content.filter(b => b.type === 'tool_use').map(b => b.id);
    if (!ids.length) return m;
    const found = kept.find(k => k.blocks?.length && ids.every(id => k.toolIds.includes(id)));
    if (found) return { ...m, content: [...found.blocks, ...m.content] };
    if (m === last) missing = true;
    return m;
  });
  if (missing) {
    delete payload.thinking;
    delete payload.output_config;
  }
}
/** A pass-through stream over a reply: the bytes go on unchanged while it
 * counts the reported usage (onUsage at the end), shows text and reasoning
 * as they come (onProgress, at most every 200 ms), and, if onThinking is
 * given, hands over Claude's thinking blocks with the tool calls after them. */
export function usageStream(onUsage, onProgress = async () => {}, onThinking) {
  const decoder = new TextDecoder(),
    thinking = thinkingBlocks();
  let buffer = '',
    usage = null,
    text = '',
    reasoning = '',
    last = 0,
    dirty = false;
  // Takes one line of the stream: usage, thinking and display text.
  const read = line => {
    if (!line.startsWith('data:')) return;
    try {
      const data = JSON.parse(line.slice(5).trim());
      const u = data.message?.usage || data.usage;
      if (u) usage = { ...(usage || {}), ...u };
      if (onThinking) thinking.read(data);
      const d = displayDelta(data);
      text = (text + d.text).slice(0, 16000);
      reasoning = (reasoning + d.reasoning).slice(0, 12000);
      dirty ||= !!(d.text || d.reasoning);
    } catch {}
  };
  // Shows the text so far; force ignores the 200 ms pause.
  const publish = async force => {
    if ((dirty || force) && (text || reasoning) && (force || Date.now() - last >= 200)) {
      last = Date.now();
      dirty = false;
      try {
        await onProgress({ text, reasoning, final: force });
      } catch {
        console.error('live_preview_failed');
      }
    }
  };
  return new TransformStream({
    /** Passes the chunk on, then reads its lines and shows progress. */
    async transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) read(line);
      if (buffer.length > 65536) buffer = '';
      await publish(false);
    },
    /** At the end: the last preview, the kept thinking and the usage. */
    async flush() {
      buffer += decoder.decode();
      read(buffer);
      await publish(true);
      const kept = thinking.result();
      if (onThinking && kept.blocks.length && kept.toolIds.length) await onThinking(kept);
      if (usage) {
        const t = tokens(usage);
        await onUsage({
          prompt_tokens: t.input + t.cached + t.write,
          completion_tokens: t.output,
          cached_tokens: t.cached,
          cache_write_tokens: t.write,
        });
      }
    },
  });
}
/** Answers one request from the container: only POST to model.internal's chat
 * path is let through; the model, effort and output limit are the session's,
 * the instructions are added, and the owner's key goes on. authorize() asks
 * the session to allow another request. Returns the provider's stream, or an
 * error response. upstream stands in for fetch in tests. */
export async function modelRequest(
  request,
  {
    key,
    model,
    provider = 'ollama',
    instructions = '',
    effort = 'auto',
    alternates = {},
    maxOutput,
    authorize,
    recallThinking = async () => null,
    keepThinking = async () => {},
    onUsage = async () => {},
    onProgress = async () => {},
    upstream = fetch,
  },
) {
  const url = new URL(request.url);
  if (
    url.hostname !== 'model.internal' ||
    url.port ||
    url.search ||
    url.pathname !== (provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions') ||
    request.method !== 'POST'
  ) {
    return new Response('Denied', { status: 403 });
  }
  if (!key)
    return new Response('Save an API key for ' + provider + ' in Account settings', {
      status: 503,
    });
  let body;
  try {
    body = await readBounded(request.body);
  } catch {
    return new Response('Invalid or oversized JSON body', { status: 400 });
  }
  // The model is the session's, whatever the runner names (a conversation
  // arno loads may still name the model it was started on), unless it names
  // one of alternates ({id: effort}): the owner's worker model. A long
  // session may hold thousands of messages; the size bound above is the
  // real limit.
  if (!body || !Array.isArray(body.messages) || body.messages.length > 5000 || body.stream !== true)
    return new Response(
      'Unsupported request: ' +
        (!Array.isArray(body?.messages)
          ? 'no messages'
          : body.messages.length > 5000
            ? body.messages.length + ' messages; use /compact or /clear'
            : 'not streamed'),
      { status: 400 },
    );
  const chosen = Object.hasOwn(alternates, body.model) ? body.model : model;
  const payload = {
    model: chosen,
    messages: body.messages,
    stream: true,
    ...requestFields(provider, {
      model: chosen,
      effort: chosen === model ? effort : alternates[chosen],
      maxOutput,
    }),
  };
  // The runner sends back the thinking it read, which mistralDeltas made
  // reasoning_content; Mistral refuses unknown message fields.
  if (provider === 'mistral')
    payload.messages = payload.messages.map(m => {
      const copy = { ...m };
      delete copy.reasoning_content;
      return copy;
    });
  // A reply cut off mid-stream leaves an assistant message with nothing in
  // it, which every provider refuses for the rest of the session.
  payload.messages = payload.messages.filter(
    m => m.role !== 'assistant' || m.content?.length || m.tool_calls?.length,
  );
  if (provider === 'anthropic') {
    const original =
      typeof body.system === 'string'
        ? [{ type: 'text', text: body.system }]
        : Array.isArray(body.system)
          ? body.system
          : [];
    payload.system = [...(instructions ? [{ type: 'text', text: instructions }] : []), ...original];
    if (payload.thinking) replayThinking(payload, await recallThinking());
  } else {
    if (instructions)
      payload.messages = [{ role: 'system', content: instructions }, ...payload.messages];
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 64) {
      return new Response('Invalid tools', { status: 400 });
    }
    payload.tools = body.tools;
  }
  if (!(await authorize()))
    return new Response('Task model request limit reached', { status: 429 });
  let response;
  // The provider has HEADERS_MS to answer; the reply then streams for as long
  // as it takes (the turn's own time limit bounds it). A timeout on the whole
  // fetch cut long replies, a model thinking and then writing a file, at 90 s
  // and the turn ended "without a reply".
  const waiting = new AbortController(),
    timer = setTimeout(() => waiting.abort(), HEADERS_MS);
  try {
    const endpoint = PROVIDERS[provider].base + PROVIDERS[provider].chat;
    response = await upstream(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers:
        provider === 'anthropic'
          ? {
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            }
          : { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: waiting.signal,
    });
  } catch {
    return new Response(provider + ' request failed', { status: 502 });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    // The provider's reason goes to the log and to the runner, which shows
    // it; the status alone left a turn ending "without a reply".
    const said = await response.text().catch(() => '');
    console.log(
      JSON.stringify({
        event: 'model_http_error',
        provider,
        model,
        status: response.status,
        body: said.slice(0, 1000),
      }),
    );
    let reason = '';
    try {
      reason = String(JSON.parse(said).error?.message || '').slice(0, 300);
    } catch {
      // Not JSON: the log keeps the body.
    }
    return new Response(
      provider + ' rejected the request (' + response.status + (reason ? ': ' + reason : '') + ')',
      { status: 502 },
    );
  }
  const stream =
    provider === 'mistral' ? response.body?.pipeThrough(mistralDeltas()) : response.body;
  return new Response(
    stream?.pipeThrough(
      usageStream(
        async usage => {
          try {
            await onUsage(usage, chosen);
          } catch {
            console.error('usage_record_failed');
          }
        },
        onProgress,
        provider === 'anthropic' ? keepThinking : undefined,
      ),
    ),
    {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
    },
  );
}
