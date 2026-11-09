import { tokens } from './prices.mjs';
import { PROVIDERS } from './account.mjs';
const MAX_BODY = 1024 * 1024;

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
export function usageStream(onUsage, onProgress = async () => {}) {
  const decoder = new TextDecoder();
  let buffer = '',
    usage = null,
    text = '',
    reasoning = '',
    last = 0,
    dirty = false;
  const read = line => {
    if (!line.startsWith('data:')) return;
    try {
      const data = JSON.parse(line.slice(5).trim());
      const u = data.message?.usage || data.usage;
      if (u) usage = { ...(usage || {}), ...u };
      const d = displayDelta(data);
      text = (text + d.text).slice(0, 16000);
      reasoning = (reasoning + d.reasoning).slice(0, 12000);
      dirty ||= !!(d.text || d.reasoning);
    } catch {}
  };
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
    async transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) read(line);
      if (buffer.length > 65536) buffer = '';
      await publish(false);
    },
    async flush() {
      buffer += decoder.decode();
      read(buffer);
      await publish(true);
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
export async function modelRequest(
  request,
  {
    key,
    model,
    provider = 'ollama',
    instructions = '',
    authorize,
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
  if (
    !body ||
    body.model !== model ||
    !Array.isArray(body.messages) ||
    body.messages.length > 200 ||
    body.stream !== true
  ) {
    return new Response('Unsupported model or request', { status: 400 });
  }
  const payload = { model, messages: body.messages, stream: true, max_tokens: 4096 };
  if (provider === 'openai') {
    delete payload.max_tokens;
    payload.max_completion_tokens = 4096;
  }
  // Thinking counts against Gemini's output limit; keep its default.
  if (provider === 'gemini') delete payload.max_tokens;
  if (provider === 'anthropic') {
    const original =
      typeof body.system === 'string'
        ? [{ type: 'text', text: body.system }]
        : Array.isArray(body.system)
          ? body.system
          : [];
    payload.system = [...(instructions ? [{ type: 'text', text: instructions }] : []), ...original];
  } else {
    payload.stream_options = { include_usage: true };
    if (instructions)
      payload.messages = [{ role: 'system', content: instructions }, ...body.messages];
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
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    return new Response(provider + ' request failed', { status: 502 });
  }
  if (!response.ok) {
    if (response.body) await response.body.cancel();
    return new Response(provider + ' rejected the request', { status: 502 });
  }
  return new Response(
    response.body?.pipeThrough(
      usageStream(async usage => {
        try {
          await onUsage(usage);
        } catch {
          console.error('usage_record_failed');
        }
      }, onProgress),
    ),
    {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
    },
  );
}
