/** What a chat remembers about its user across conversations, kept like a
 * small library: every chat's instructions list each memory's title, and the
 * model reads the facts behind the titles it needs with the recall tool.
 *
 *   profile:<user> object
 *     profile.memories   [{id, title, at}]   the titles, shown in every chat
 *     'memory:<id>'      the fact itself     read by recall
 *
 *   chat turn ─► remember / recall / forget ─► /profile/memory (one transaction)
 *
 * The profile's 'memory' setting says who decides: 'asked' (the default)
 * saves only when the user asks, 'auto' lets the model save on its own as
 * well, 'off' shows and saves nothing. Depends on nothing else in the app.
 * Leaves out search by meaning (the model picks by title) and coding
 * sessions, where arno keeps its own memory (/remember). */

/** The setting's choices, the default first. */
export const MEMORY_MODES = ['asked', 'auto', 'off'];
/** Most memories kept, characters in a title and in a fact, and facts one
 * recall reads. */
export const MAX_MEMORIES = 1000,
  MAX_TITLE = 100,
  MAX_FACT = 1000,
  MAX_RECALL = 10;

/** The tools offered to the model, in the shape MCP lists them. */
export const MEMORY_TOOLS = [
  {
    name: 'remember',
    description:
      'Save a fact about the user to remember in every future chat: who they are, their preferences, their projects. Future chats see only the title, so make it say what the fact is about. Never save passwords, keys or other secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the fact is about, a few words' },
        fact: { type: 'string', description: 'The fact, up to ' + MAX_FACT + ' characters' },
      },
      required: ['title', 'fact'],
    },
  },
  {
    name: 'recall',
    description:
      'Read remembered facts by id, when their titles look relevant to the conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Up to ' + MAX_RECALL },
      },
      required: ['ids'],
    },
  },
  {
    name: 'forget',
    description:
      'Forget a remembered fact that is wrong, outdated or that the user asks you to forget. To change one, forget it and remember the new one.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The memory’s id, as listed' } },
      required: ['id'],
    },
  },
];

/** The memory setting of profile p. */
export const memoryMode = p => (MEMORY_MODES.includes(p.memory) ? p.memory : MEMORY_MODES[0]);

/** What the model is told of memory for profile p: when to save, and each
 * memory's id and title; '' when memory is off. */
export function memoryInstructions(p) {
  const mode = memoryMode(p);
  if (mode === 'off') return '';
  const titles = (p.memories || []).map(m => '- [' + m.id + '] ' + m.title).join('\n');
  return [
    mode === 'auto'
      ? 'Memory: you may save facts about the user with the remember tool, when they ask you to remember something and, on your own, when you learn something lasting that will help in later chats (who they are, preferences, ongoing projects). Not passing details of one task. Mention briefly when you save one.'
      : 'Memory: save a fact with the remember tool only when the user asks you to remember something.',
    'Use forget when a remembered fact turns out wrong or the user asks.',
    titles
      ? 'What you remember about the user, by title; read the facts with recall when a title bears on the conversation:\n' +
        titles
      : 'You remember nothing yet.',
  ].join(' ');
}

/** Text s with its spaces collapsed, checked to be there and at most max
 * characters; what names it in an error. */
function clean(s, max, what) {
  const text = String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw Error('The ' + what + ' is empty');
  if (text.length > max) throw Error('A ' + what + ' is at most ' + max + ' characters');
  return text;
}

/** The titles after a change ({add: {title, fact}} or {remove: id}), and
 * what that change stores and deletes: {memories, put: {key: fact},
 * drop: [key]}. Past MAX_MEMORIES the oldest go. Throws on a bad fact or an
 * unknown id. */
export function changeMemories(memories = [], { add, remove }, now = Date.now()) {
  if (remove) {
    if (!memories.some(m => m.id === remove)) throw Error('No memory has id ' + remove);
    return { memories: memories.filter(m => m.id !== remove), put: {}, drop: ['memory:' + remove] };
  }
  const title = clean(add?.title, MAX_TITLE, 'title'),
    fact = clean(add?.fact, MAX_FACT, 'fact');
  // Ids are the time in base 36, moved on past any taken in the same millisecond.
  let t = now;
  while (memories.some(m => m.id === t.toString(36))) t++;
  const id = t.toString(36),
    all = [...memories, { id, title, at: now }],
    kept = all.slice(-MAX_MEMORIES);
  return {
    memories: kept,
    put: { ['memory:' + id]: fact },
    drop: all.slice(0, all.length - kept.length).map(m => 'memory:' + m.id),
  };
}

/** Ask the profile object of user userId for a memory change ({add},
 * {remove} or {recall: ids}); returns its answer, throwing its error. */
async function memoryCall(env, userId, change) {
  const r = await env.PROBE.getByName('profile:' + userId).fetch(
    'https://internal/profile/memory',
    { method: 'POST', body: JSON.stringify(change) },
  );
  const answer = await r.json();
  if (answer.error) throw Error(answer.error);
  return answer;
}

/** Run a memory tool for user userId; returns what the model is given. */
export async function memoryTool(env, userId, name, args) {
  if (name === 'recall') {
    const ids = Array.isArray(args.ids) ? args.ids : [];
    return recallMemories(env, userId, ids.slice(0, MAX_RECALL).map(String));
  }
  if (name === 'forget') {
    await memoryCall(env, userId, { remove: String(args.id || '') });
    return 'Forgotten.';
  }
  const { id } = await memoryCall(env, userId, { add: { title: args.title, fact: args.fact } });
  return 'Remembered, as ' + id + '.';
}

/** The facts of user userId's memories ids, as {id, title, fact}. */
export const recallMemories = async (env, userId, ids) =>
  (await memoryCall(env, userId, { recall: ids })).facts;

/** Forget user userId's memory id. */
export const forgetMemory = (env, userId, id) => memoryCall(env, userId, { remove: id });
