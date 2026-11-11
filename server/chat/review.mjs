/** The review of a page a chat turn wrote (turn.mjs): one call, with no tools,
 * to the owner's review model (or the chat's own), which compares the page
 * with the request and answers with its defects or "No defects.":
 *
 *   request + source + browser check + screenshots (phone, wide) ─► reviewer
 *     ─► "No defects."  the answer stands
 *     ─► 1. … 2. …      sent back to the chat model to fix (fixRequest)
 *
 * Depends on chat.mjs, for the request in each provider's dialect. Leaves out
 * rendering the page (probe/render.mjs), when to review and what it costs
 * (turn.mjs). */
import { plainChat } from './chat.mjs';

/** The most characters of the page's source the reviewer reads. */
const SOURCE_CHARS = 40000;
/** The reviewer's output limit, in tokens, and how long it may take, in ms. */
const REVIEW_OUTPUT = 1500,
  REVIEW_MS = 120000;
/** What the reviewer is told to do. */
const REVIEWER =
  'You are a strict reviewer of a web page another model built for a user. Do not assume it works.\n' +
  '1. Go through each thing the user asked for: is it visibly present and correct in the screenshots?\n' +
  '2. Check the physics, maths and logic in the code for errors: coordinate mappings, units, signs, formulas, state that is never updated.\n' +
  '3. Check the layout at both sizes: overflow, overlap, cut-off or unreadable parts, areas left empty where something should be drawn.\n' +
  '4. Note broken visuals and the errors the browser check found.\n' +
  'Reply only with a short numbered list of concrete defects, each with how to fix it, or with exactly "No defects." Leave out matters of taste.';
/** A reply that finds nothing wrong. */
const NO_DEFECTS = /^\W*no defects\b/i;

/** Asks the reviewer (model with its provider and key) about page ({title,
 * version, content}), written for request (this turn's message; previous is
 * the user's message before it, for context), with the browser's check and
 * the screenshots ({type, data, caption}; none for a model that can't see
 * them). Returns {defects: the numbered list, or null when there are none or
 * the review failed, count, usage: what it spent, or null}. upstream stands
 * in for fetch in tests. */
export async function reviewPage({
  model,
  provider,
  key,
  effort = 'auto',
  request,
  previous,
  page,
  check,
  images = [],
  signal,
  upstream,
}) {
  const prompt = [
    previous ? 'The user’s message before this one: ' + previous : '',
    'The user asked: ' + request,
    'The page: "' + page.title + '" v' + page.version,
    'Browser check at phone size: ' + JSON.stringify(check),
    images.length
      ? 'Screenshots follow: ' + images.map(i => i.caption).join('; ') + '.'
      : 'No screenshots: judge from the code and the check.',
    'Source' +
      (page.content.length > SOURCE_CHARS ? ' (first ' + SOURCE_CHARS + ' characters)' : '') +
      ':\n' +
      page.content.slice(0, SOURCE_CHARS),
  ]
    .filter(Boolean)
    .join('\n\n');
  const timeout = AbortSignal.timeout(REVIEW_MS);
  try {
    const r = await plainChat({
      model,
      provider,
      key,
      effort,
      maxOutput: REVIEW_OUTPUT,
      rounds: 1,
      history: [],
      prompt,
      images,
      toolSpecs: [],
      instructions: REVIEWER,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(upstream && { upstream }),
    });
    const text = r.summary.trim();
    if (!text || NO_DEFECTS.test(text)) return { defects: null, count: 0, usage: r.usage };
    return {
      defects: text,
      count: Math.max(1, text.match(/^\s*\d+[.)]/gm)?.length || 0),
      usage: r.usage,
    };
  } catch (e) {
    return { defects: null, count: 0, usage: e.spent?.usage || null, error: e.message };
  }
}

/** What the chat model is told when the reviewer found defects in page. */
export function fixRequest(page, defects) {
  return (
    'A reviewer checked "' +
    page.title +
    '" v' +
    page.version +
    ' and found:\n' +
    defects +
    '\nFix these with update_artifact (check other states with check_artifact steps), then answer.'
  );
}
