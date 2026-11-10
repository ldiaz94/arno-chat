import { validMcpUrl } from './account.mjs';
/** Forward only MCP protocol traffic to an account-approved HTTPS endpoint.
 * Authorization and session headers are rebuilt outside the coding container.
 */
export async function proxyMcp(request, connection, token) {
  if (!validMcpUrl(connection.url) || !['POST', 'GET', 'DELETE'].includes(request.method))
    return new Response('Denied', { status: 403 });
  const headers = { Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = 'Bearer ' + token;
  for (const name of ['mcp-session-id', 'mcp-protocol-version']) {
    const v = request.headers.get(name);
    if (v && v.length < 500) headers[name] = v;
  }
  let body;
  if (request.method === 'POST') {
    body = await request.text();
    if (body.length > 1000000) return new Response('Oversized MCP request', { status: 413 });
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return new Response('Invalid MCP JSON', { status: 400 });
    }
    if (
      ![
        'initialize',
        'notifications/initialized',
        'notifications/cancelled',
        'tools/list',
        'tools/call',
        'ping',
      ].includes(data.method)
    )
      return new Response('Unsupported MCP method', { status: 403 });
    headers['Content-Type'] = 'application/json';
  }
  // 30 s for the server to start answering; a tool's streamed answer may go on
  // (the turn's own time limit ends it).
  const stop = new AbortController(),
    timer = setTimeout(() => stop.abort(), 30000);
  let response;
  try {
    response = await fetch(connection.url, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      signal: stop.signal,
    });
  } catch {
    return new Response('MCP connection failed', { status: 502 });
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return new Response('MCP redirects are disabled. Use the final endpoint URL.', { status: 502 });
  }
  const out = new Headers({
    'Content-Type': response.headers.get('Content-Type') || 'application/json',
    'Cache-Control': 'no-store',
  });
  for (const name of ['mcp-session-id', 'mcp-protocol-version']) {
    const v = response.headers.get(name);
    if (v) out.set(name, v);
  }
  return new Response(response.body, { status: response.status, headers: out });
}
export async function testMcp(connection, token) {
  const init = await proxyMcp(
    new Request('http://mcp.internal/' + connection.id, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'arno-chat', version: '1' },
        },
      }),
    }),
    connection,
    token,
  );
  if (!init.ok) throw Error('MCP connection rejected (' + init.status + '). Check URL and token.');
  // A valid initialize response establishes an actual protocol connection.
  const reader = init.body.getReader(),
    decoder = new TextDecoder();
  let text = '',
    size = 0,
    result;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1000000) throw Error('Oversized MCP initialize response');
      text += decoder.decode(value, { stream: true });
      if (init.headers.get('content-type')?.includes('text/event-stream')) {
        for (const line of text.split('\n'))
          if (line.startsWith('data:'))
            try {
              const d = JSON.parse(line.slice(5));
              if (d.id === 1) result = d;
            } catch {}
        if (result) {
          await reader.cancel();
          break;
        }
      }
    }
    if (!result)
      try {
        result = JSON.parse(text);
      } catch {}
  } finally {
    reader.releaseLock();
  }
  if (!result?.result?.protocolVersion)
    throw Error('Endpoint did not return an MCP initialize response');
  const session = init.headers.get('mcp-session-id');
  if (session)
    await proxyMcp(
      new Request('http://mcp.internal/' + connection.id, {
        method: 'DELETE',
        headers: { 'mcp-session-id': session },
      }),
      connection,
      token,
    );
  return {
    ok: true,
    protocol: result.result.protocolVersion,
    server: result.result.serverInfo?.name || connection.name,
  };
}
