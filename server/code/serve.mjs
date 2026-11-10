/** The host's side of arno-serve(5): coding turns run `arno --serve` in the
 * container and speak to it in netstrings over its standard input and output.
 *
 *   message = netstring( netstring(verb) netstring(field) ... )
 *   12:4:line,2:hi,,      the line "hi"
 *
 * One process per turn: hello, then /load of the session's conversation when
 * arno still has it, then the user's line; every question is answered yes
 * (the container is the sandbox), and the turn ends at busy 0, with bye.
 * Pictures (image) and viewers are left out: nothing here shows them.
 */
const encoder = new TextEncoder(),
  decoder = new TextDecoder();

/** One netstring of bytes. */
function netstring(bytes) {
  return [encoder.encode(bytes.length + ':'), bytes, encoder.encode(',')];
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
/** A message: the verb and its fields, each a string. */
export function encode(...fields) {
  return concat(netstring(concat(fields.flatMap(f => netstring(encoder.encode(String(f)))))));
}

/** Reads netstrings from bytes as they come: push() takes a chunk and returns
 * the whole messages it completed, each an array of strings, the verb first.
 * A malformed message throws, since nothing after it can be read. */
export function decoderOf() {
  let buffer = new Uint8Array(0);
  // [value, end] of the netstring at `at` in bytes, or null when incomplete.
  const read = (bytes, at) => {
    const colon = bytes.indexOf(58, at); // ':'
    if (colon < 0) {
      if (bytes.length - at > 10) throw Error('arno: malformed message');
      return null;
    }
    const digits = decoder.decode(bytes.subarray(at, colon));
    if (!/^\d{1,9}$/.test(digits)) throw Error('arno: malformed message');
    const end = colon + 1 + Number(digits);
    if (bytes.length <= end) return null;
    if (bytes[end] !== 44) throw Error('arno: malformed message'); // ','
    return [bytes.subarray(colon + 1, end), end + 1];
  };
  return {
    push(chunk) {
      buffer = concat([buffer, chunk]);
      const messages = [];
      for (let whole; (whole = read(buffer, 0));) {
        const [body, next] = whole,
          fields = [];
        for (let at = 0, f; at < body.length; at = f[1]) {
          f = read(body, at);
          if (!f) throw Error('arno: malformed message');
          fields.push(f[0]);
        }
        // An image's bytes stay out of the text: only its entry is kept.
        messages.push(
          fields.map((f, i) =>
            fields[0] && decoder.decode(fields[0]) === 'image' && i === 3 ? '' : decoder.decode(f),
          ),
        );
        buffer = buffer.slice(next);
      }
      return messages;
    },
  };
}

/** Runs one turn over a started `arno --serve` process ({stdin, stdout}
 * streams). hello is the hello's JSON; conversation the id to load, if arno
 * may still have it; line what the user said, or a function of whether the
 * conversation was loaded that gives it. onEvent hears each entry of
 * the turn as it changes; signal stops the turn (cancel), and a second abort
 * after the grace period ends the process. Returns the turn: its
 * conversation id, entries in order, stats, and whether it was cancelled.
 * root is the project, /workspace/repo in the container. */
export async function serveTurn(
  { stdin, stdout },
  { hello, conversation, line, onEvent, signal, root = '/workspace/repo' },
) {
  const writer = stdin.getWriter(),
    reader = stdout.getReader(),
    input = decoderOf(),
    queue = [];
  const send = (...fields) => writer.write(encode(...fields));
  let ended = false;
  // The next message, or null when arno has closed its output.
  const next = async () => {
    while (!queue.length) {
      if (ended) return null;
      const { value, done } = await reader.read();
      if (done) ended = true;
      else queue.push(...input.push(value));
    }
    return queue.shift();
  };
  const turn = { conversation: '', entries: [], stats: null, cancelled: false, errors: [] };
  const entries = new Map(),
    entry = n => entries.get(n);
  let first = Infinity, // index of the turn's own user entry
    busy = false,
    done = false;
  const cancel = () => {
    turn.cancelled = true;
    send('cancel').catch(() => {});
  };
  if (signal?.aborted) return { ...turn, cancelled: true };
  signal?.addEventListener('abort', cancel, { once: true });

  await send('hello', '1', 'Arno Chat', root, JSON.stringify(hello));
  let message;
  // ready, then the conversation loaded when arno has it.
  while ((message = await next()) && message[0] !== 'ready')
    if (message[0] === 'error') throw Error('arno: ' + message[1]);
  if (!message) throw Error('arno ended before it was ready');
  turn.conversation = message[1];
  if (conversation && conversation !== turn.conversation) {
    await send('recent', '200', conversation);
    while ((message = await next()) && message[0] !== 'recent' && message[0] !== 'error');
    const known =
      message?.[0] === 'recent' && JSON.parse(message[1]).some(c => c.id === conversation);
    if (known) {
      await send('line', '/load ' + conversation);
      while ((message = await next()) && !(message[0] === 'status' && message[3] === conversation));
      if (message) turn.conversation = conversation;
    }
  }
  const text = typeof line === 'function' ? line(turn.conversation === conversation) : line;
  // A command (/clear, /compact, /notes, ...) is not a turn: it ends with the
  // status that follows what it said, unless it starts one.
  turn.command = text.startsWith('/');
  await send('line', text);
  while (!done && (message = await next())) {
    const [verb, ...f] = message;
    switch (verb) {
      case 'push':
      case 'tool': {
        const n = Number(f[0]);
        // The first user entry after the line was sent is the line itself.
        if (verb === 'push' && f[1] === 'user' && first === Infinity) first = n;
        if (n <= first) break;
        const e =
          verb === 'push'
            ? { n, kind: f[1], text: f[2], worker: f[3] || '', model: f[4] || '' }
            : {
                n,
                kind: 'tool',
                name: f[1],
                args: f[2],
                result: '',
                worker: f[3] || '',
                model: f[4] || '',
              };
        entries.set(n, e);
        turn.entries.push(e);
        onEvent?.(e);
        break;
      }
      case 'append': {
        const e = entry(Number(f[0]));
        if (e) {
          e.text += f[1];
          onEvent?.(e);
        }
        break;
      }
      case 'done': {
        const e = entry(Number(f[0]));
        if (e) {
          e.result = f[1];
          onEvent?.(e);
        }
        break;
      }
      case 'ask': // the container is the sandbox: every change is the model's to make
        await send('answer', f[0], 'y');
        break;
      case 'call': // no host tools are offered
        await send('result', f[0], 'error: no such tool');
        break;
      case 'status':
        if (f[2]) turn.conversation = f[2];
        if (turn.command && first !== Infinity && !busy) done = true;
        break;
      case 'reset': // the transcript is shown again (/clear, /new, /load): renumbered
        if (first !== Infinity) first = -1;
        break;
      case 'stats':
        try {
          turn.stats = JSON.parse(f[0]);
        } catch {
          turn.stats = null;
        }
        break;
      case 'error':
        turn.errors.push(f[0]);
        if (!busy) done = true; // the line was refused: no turn will run
        break;
      case 'busy':
        if (f[0] === '1') busy = true;
        else if (busy) done = true;
        break;
    }
  }
  signal?.removeEventListener('abort', cancel);
  await send('bye').catch(() => {});
  await writer.close().catch(() => {});
  reader.releaseLock();
  return turn;
}

/** The reply of a turn: the lead's last words, or the last error; for a
 * command, what arno said of it. */
export function replyOf(turn) {
  const lead = turn.entries.filter(e => !e.worker);
  if (turn.command)
    return lead
      .filter(e => e.kind === 'info' || e.kind === 'err')
      .map(e => e.text.trim())
      .join('\n\n');
  const said = lead.filter(e => e.kind === 'asst' && e.text.trim());
  if (said.length) return said[said.length - 1].text.trim();
  const errors = lead.filter(e => e.kind === 'err');
  return errors.length ? errors[errors.length - 1].text : turn.errors.join('\n');
}

/** What the turn did, a line or a few each, for the "Execution details" view:
 * tool calls with their results cut short, workers named, arno's notes. */
export function transcriptOf(turn) {
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + ' …' : s);
  return turn.entries
    .filter(e => e.kind !== 'think' && e.kind !== 'user')
    .map(e => {
      const who = e.worker ? '[worker ' + e.worker + (e.model ? ' · ' + e.model : '') + '] ' : '';
      if (e.kind === 'tool')
        return (
          who +
          '▸ ' +
          e.name +
          ' ' +
          cut(e.args, 400) +
          (e.result ? '\n  ' + cut(e.result, 800).replace(/\n/g, '\n  ') : '')
        );
      if (e.kind === 'asst') return e.text.trim() ? who + cut(e.text.trim(), 1200) : '';
      return who + e.kind + ': ' + cut(e.text, 800);
    })
    .filter(Boolean)
    .join('\n')
    .slice(-30000);
}

/** A short line for the live view: what the turn is doing now. */
export function activityOf(e) {
  const who = e.worker ? 'Worker ' + e.worker + ': ' : '';
  if (e.kind !== 'tool') return '';
  let detail;
  try {
    const a = JSON.parse(e.args || '{}');
    detail = a.command || a.path || a.pattern || a.query || a.name || a.task || '';
  } catch {
    detail = '';
  }
  return (who + e.name + (detail ? ' · ' + String(detail) : '')).slice(0, 160);
}
