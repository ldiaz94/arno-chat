/** A name for a new chat (turn.mjs): one call, with no tools and no thinking,
 * to the chat's own model, given the first message and the start of the
 * answer. The model is asked a direct question and puts the name in
 * <name> tags, so one that reasons aloud first (Claude 5 with thinking off
 * does) still gives a name that can be found. A name the user gave is never
 * replaced (customTitle) by the namer.
 *
 * During a chat the model can rename it with rename_chat, and is told to when
 * the topic changes; a name the user gave changes only if they ask.
 * Depends on chat.mjs. */
import { plainChat } from './chat.mjs';

/** What the model is told. */
const NAMER =
  'You name conversations for a list of chats. Reply with the name inside <name></name> tags: 2 to 6 words, in the language of the message, sentence case, no quotes, no final full stop.';
/** A new chat's name, until it is named. */
export const UNNAMED = 'General chat';
/** The longest name kept, in characters. */
const MAX_NAME = 70;
/** How long naming may take, in ms; the turn is saved by then. */
const NAMING_MS = 15000;
/** The most tokens naming may take: room for a sentence of reasoning first. */
const NAME_TOKENS = 100;
/** How a reply without tags that narrates instead of naming starts. */
const NARRATION = /^(the user\b|i\b|i'|let me\b|okay\b|ok\b|sure\b|here\b)/i;

/** The question put to the model: the conversation in tags, then what to do. */
function question(message, answer) {
  return (
    '<conversation>\n<message>' +
    message.slice(0, 2000) +
    '</message>\n<answer>' +
    answer.slice(0, 1500) +
    '</answer>\n</conversation>\n\nWhat is a 2 to 6 word name for this conversation? Put it in <name></name>.'
  );
}

/** The name in a reply: what is inside <name> tags, else a short first line
 * that does not talk about the task (a model that ignored the tags). */
function nameIn(reply) {
  const tagged = /<name>([\s\S]*?)<\/name>/i.exec(reply)?.[1],
    line = (tagged ?? reply.trim().split('\n')[0]).replace(/^["'“”‘’*#\s]+|["'“”‘’*.\s]+$/g, '');
  if (tagged == null && (NARRATION.test(line) || line.split(/\s+/).length > 8)) return null;
  return line.slice(0, MAX_NAME) || null;
}

/** The chat's name from its first message and answer, or null when the
 * model gives none. */
export async function nameChat({ model, provider, key, message, answer, upstream }) {
  try {
    const r = await plainChat({
      model,
      provider,
      key,
      effort: 'off',
      maxOutput: NAME_TOKENS,
      rounds: 1,
      history: [],
      prompt: question(message, answer),
      toolSpecs: [],
      instructions: NAMER,
      signal: AbortSignal.timeout(NAMING_MS),
      ...(upstream && { upstream }),
    });
    return nameIn(r.summary);
  } catch {
    return null;
  }
}

/** The tool a chat's model renames the chat with. */
export const RENAME_TOOL = {
  name: 'rename_chat',
  description:
    'Rename this chat in the user’s list of chats. Use it when the conversation has moved to a new topic, or the name no longer says what it is about.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '2 to 6 words, in the language of the chat, sentence case, no quotes',
      },
    },
    required: ['name'],
  },
};

/** What the model is told about the name of chat session s; nothing while
 * it has none, as the namer names it after the first answer. */
export function nameInstructions(s) {
  if (s.title === UNNAMED) return '';
  return (
    'This chat is named “' +
    s.title +
    '”.' +
    (s.customTitle
      ? ' The user chose that name: rename the chat only if they ask.'
      : ' When the conversation turns to a new topic, rename it with rename_chat, without mentioning it in your answer.')
  );
}

/** The name rename_chat was given (args.name), tidied; throws when empty. */
export function newName(args) {
  const name = String(args.name ?? '')
    .replace(/^["'“”‘’*#\s]+|["'“”‘’*.\s]+$/g, '')
    .slice(0, MAX_NAME);
  if (!name) throw Error('Give the chat a name of 2 to 6 words.');
  return name;
}
