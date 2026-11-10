/** MCP tools in regular chats: the connections the owner marked "Use in
 * chats" give their tools to the chat's own tool loop (chat.mjs), called from
 * the Worker through the same proxy and tokens as coding sessions (mcp.mjs,
 * mcp-oauth.mjs). There is no container in a chat.
 *
 *   a turn starts  → each connection's tools, listed at most every 10 minutes
 *   the model calls  linear__list_issues  → the tool list_issues of 'linear'
 *   a tool its server does not mark read-only waits for the owner's Allow
 *
 * Tool names are the connection's ID, two underscores and the tool's name,
 * kept to what every provider accepts (letters, digits, _ and -, 64 at most).
 * Depends on mcp.mjs and mcp-oauth.mjs. Leaves out resources and prompts. */
import { proxyMcp } from './mcp.mjs';
import { mcpBearer } from './mcp-oauth.mjs';

const LIST_FOR = 10 * 60 * 1000; // how long a connection's tool list is kept
const MAX_TOOLS = 40; // tools offered from all connections, at most
const MAX_RESULT = 20000; // characters of a tool's answer the model reads

/** One JSON-RPC request through the proxy: its result, and the session id the
 * server gave. A streamed answer (SSE) is read until the reply with id. */
async function rpc(connection, token, method, params, session) {
  const response = await proxyMcp(
    new Request('http://mcp.internal/' + connection.id, {
      method: 'POST',
      headers: session ? { 'mcp-session-id': session } : {},
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    connection,
    token,
  );
  if (response.status === 401) throw Error(connection.name + ': sign in again in Settings');
  if (!response.ok) throw Error(connection.name + ' refused the request (' + response.status + ')');
  const next = response.headers.get('mcp-session-id') || session,
    text = await response.text();
  let reply = null;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    for (const line of text.split('\n'))
      if (line.startsWith('data:'))
        try {
          const d = JSON.parse(line.slice(5));
          if (d.id === 1) reply = d;
        } catch {}
  } else
    try {
      reply = JSON.parse(text);
    } catch {}
  if (!reply) throw Error(connection.name + ' gave no answer');
  if (reply.error) throw Error(connection.name + ': ' + (reply.error.message || 'error'));
  return { result: reply.result, session: next };
}

/** Opens an MCP session with the server: its session id, if it keeps one. */
async function open(connection, token) {
  const { session } = await rpc(connection, token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'arno-chat', version: '1' },
  });
  // The initialized notification has no reply; the proxy passes it on.
  await proxyMcp(
    new Request('http://mcp.internal/' + connection.id, {
      method: 'POST',
      headers: session ? { 'mcp-session-id': session } : {},
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }),
    connection,
    token,
  ).then(r => r.body?.cancel());
  return session;
}

/** The name a provider is given for tool of connection. */
export function toolName(connection, tool) {
  return (connection.id + '__' + tool.replace(/[^A-Za-z0-9_-]/g, '_')).slice(0, 64);
}

/** The chat's MCP tools: specs for the model, and for each name what it calls
 * and whether it only reads. store keeps tool lists ('mcpTools:<id>') for
 * LIST_FOR; a connection that fails is left out, with why in failures. */
export async function chatMcpTools(env, ownerId, p, store) {
  const specs = [],
    calls = new Map(),
    failures = [];
  for (const connection of (p.mcp || []).filter(c => c.chats)) {
    const key = 'mcpTools:' + connection.id + ':' + connection.url;
    const kept = await store.get(key);
    let tools = kept?.at > Date.now() - LIST_FOR ? kept.tools : null;
    if (!tools)
      try {
        const token = await mcpBearer(env, ownerId, connection),
          session = await open(connection, token);
        tools = (await rpc(connection, token, 'tools/list', {}, session)).result?.tools || [];
        await store.put(key, { at: Date.now(), tools });
      } catch (e) {
        failures.push(e.message);
        continue;
      }
    for (const t of tools) {
      if (specs.length >= MAX_TOOLS || !t?.name) break;
      const name = toolName(connection, t.name);
      specs.push({
        name,
        description: ('[' + connection.name + '] ' + (t.description || t.name)).slice(0, 1000),
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
      });
      calls.set(name, {
        connection,
        tool: t.name,
        readOnly: t.annotations?.readOnlyHint === true,
      });
    }
  }
  return { specs, calls, failures };
}

/** Calls a chat MCP tool: what it said, as text for the model. */
export async function callChatMcp(env, ownerId, { connection, tool }, args) {
  const token = await mcpBearer(env, ownerId, connection),
    session = await open(connection, token),
    { result } = await rpc(
      connection,
      token,
      'tools/call',
      { name: tool, arguments: args },
      session,
    );
  const text = (result?.content || [])
    .map(c => (c.type === 'text' ? c.text : '[' + c.type + ']'))
    .join('\n')
    .slice(0, MAX_RESULT);
  return result?.isError ? { error: text || 'The tool failed' } : { result: text };
}
