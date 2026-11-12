/** A question the model puts to the user as a card of choices (web/thread.js),
 * in a chat (chat/turn.mjs) or a coding turn (code/serve.mjs, as one of the
 * host's tools). Asking ends the turn rather than waiting: the user's choice
 * comes as the next message, so no turn holds its time limit or its
 * container open for an answer. */

/** The tool, in the chat's form ({name, description, inputSchema}). */
export const ASK_TOOL = {
  name: 'ask_user',
  description:
    'Ask the user to decide something only they can: a choice between real alternatives, approval of something risky or costly, or a fact you cannot find out. Not for "shall I go on?": if the way forward is clear, take it. The question shows as a card of options; your turn then ends, and their choice comes as the next message. Give 2 to 5 options, the one you recommend first.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, one or two sentences' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The choice, a few words' },
            detail: { type: 'string', description: 'What it means or costs, one line' },
          },
          required: ['label'],
        },
      },
      other: { type: 'boolean', description: 'Whether the user may answer in their own words' },
    },
    required: ['question', 'options'],
  },
};
/** What the model is told once it has asked. */
export const ASKED =
  'The question is on the user’s screen with your options. End your turn now, with at most one short line; their choice comes as the next message.';

/** The decision a call's args describe, trimmed to what the card shows:
 * {question, options: [{label, detail}], other}; throws when there is no
 * question or option. */
export function decisionOf(args = {}) {
  const text = (s, n) =>
    String(s ?? '')
      .trim()
      .slice(0, n);
  const question = text(args.question, 600),
    options = (Array.isArray(args.options) ? args.options : [])
      .map(o => (typeof o === 'string' ? { label: o } : o || {}))
      .map(o => ({ label: text(o.label, 80), detail: text(o.detail, 200) }))
      .filter(o => o.label)
      .slice(0, 6);
  if (!question || !options.length)
    throw Error('ask_user needs a question and at least one option');
  return { question, options, other: args.other !== false };
}
