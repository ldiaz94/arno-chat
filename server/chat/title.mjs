/** A name for a new chat (turn.mjs): one call, with no tools and no thinking,
 * to the chat's own model, given the first message and the start of the
 * answer. A name the user gave is never replaced (customTitle). Depends on
 * chat.mjs. */
import { plainChat } from './chat.mjs';

/** What the model is told. */
const NAMER =
  'Name this conversation for a list of chats: 2 to 6 words, in the language of the message, sentence case, no quotes, no final full stop. Reply with the name only.';
/** How long naming may take, in ms; the turn is saved by then. */
const NAMING_MS = 15000;

/** The chat's name from its first message and answer, or null when the
 * model gives none. */
export async function nameChat({ model, provider, key, message, answer, upstream }) {
  try {
    const r = await plainChat({
      model,
      provider,
      key,
      effort: 'off',
      maxOutput: 40,
      rounds: 1,
      history: [],
      prompt: 'Message: ' + message.slice(0, 2000) + '\n\nAnswer: ' + answer.slice(0, 1500),
      toolSpecs: [],
      instructions: NAMER,
      signal: AbortSignal.timeout(NAMING_MS),
      ...(upstream && { upstream }),
    });
    const name = r.summary
      .trim()
      .split('\n')[0]
      .replace(/^["'“”‘’*#\s]+|["'“”‘’*.\s]+$/g, '')
      .slice(0, 70);
    return name || null;
  } catch {
    return null;
  }
}
