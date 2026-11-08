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

export async function modelRequest(request, { key, model, authorize, upstream = fetch }) {
  const url = new URL(request.url);
  if (url.hostname !== 'model.internal' || url.port || url.search ||
      url.pathname !== '/v1/chat/completions' || request.method !== 'POST') {
    return new Response('Denied', { status: 403 });
  }
  if (!key) return new Response('Ollama credential is not configured', { status: 503 });
  let body;
  try { body = await readBounded(request.body); }
  catch { return new Response('Invalid or oversized JSON body', { status: 400 }); }
  if (!body || body.model !== model || !Array.isArray(body.messages) ||
      body.messages.length > 200 || body.stream !== true) {
    return new Response('Unsupported model or request', { status: 400 });
  }
  const payload = { model, messages: body.messages, stream: true, max_tokens: 4096 };
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 64) {
      return new Response('Invalid tools', { status: 400 });
    }
    payload.tools = body.tools;
  }
  if (!await authorize()) return new Response('Task model request limit reached', { status: 429 });
  let response;
  try {
    response = await upstream('https://ollama.com/v1/chat/completions', {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90000)
    });
  } catch {
    return new Response('Ollama request failed', { status: 502 });
  }
  if (!response.ok) {
    if (response.body) await response.body.cancel();
    return new Response('Ollama rejected the request', { status: 502 });
  }
  return new Response(response.body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }
  });
}

