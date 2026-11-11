/** What a turn's composer options (web/options.mjs) change on the host: web
 * tools, thinking effort, extra instructions, output and research budgets,
 * model rounds (a chat turn has no time limit: chat/turn.mjs), and a coding
 * turn's time limit. Chat (turn.mjs plainTurn) and coding
 * (code/turn.mjs, code/workspace.mjs writeConfig, and the model gateway in
 * gateways/gateways.mjs) read the same plan. Depends on providers.mjs and the
 * option defaults in web/options.mjs. Leaves out the options' storage.
 *
 *   mode          effort          search   output   rounds  searches/reads
 *   standard      as chosen       chosen   16,384   24      6 / 12
 *   fast          off unless set  chosen   4,096    12      6 / 12
 *   deep          at least medium on       16,384   32      10 / 20
 *   super search  (any mode)      on       as mode  40      25 / 50
 *
 * Rounds are sized for a turn that builds a page: research, write, the
 * browser's check, the reviewer's defects and their fixes (12 ran out).
 */
import { MAX_OUTPUT } from '../providers.mjs';
import { DEFAULTS } from '../../web/options.mjs';

/** Extra instructions for each answer style the composer offers. */
const STYLE = {
  normal: '',
  concise: 'Be brief: answer in as few words as the question needs, without preamble or recap.',
  caveman:
    'Answer in caveman speak: few words, no articles, no filler, short sentences. Example: "Me check. Bug in loop. Fix: change < to <=." Keep facts, names, numbers and code exactly right; code blocks stay normal, correct code.',
};
/** The instruction added in fast mode. */
const FAST = 'Answer briefly and directly.';
/** The instruction added in deep mode: how to research and report. */
export const DEEP_RESEARCH =
  'Deep research: plan the sub-questions first, then search broadly (several queries), read primary sources, and compare them. Write a structured report (summary, findings by sub-question, disagreements and open questions, numbered citations [1], [2] to the sources you read) and save it with create_artifact, titled "Research: <topic>". Then reply in chat with a short summary and the artifact link.';
/** Thinking efforts from least to most, to compare them by position. */
const RANK = ['off', 'low', 'medium', 'high'];

/** Arno's settings for a coding turn's options, as config lines: its mode,
 * the workers the lead may delegate to (the same model, on the same
 * provider) and how many run side by side, and the turn's budget at list
 * price. */
export function codeSettings(model, options = DEFAULTS) {
  const o = { ...DEFAULTS, ...options };
  return [
    o.approach !== 'auto' && 'mode = ' + o.approach,
    o.workers !== 'off' && 'workers = ' + model + '\nmax_workers = ' + o.workers,
    o.budget !== 'auto' && 'turn_budget = ' + o.budget,
    o.budget !== 'auto' && 'build_budget = ' + o.budget,
  ]
    .filter(Boolean)
    .map(line => line + '\n')
    .join('');
}
/** How long a coding turn may run and how many model requests it may make,
 * workers' included: build leads a longer job; fast stays short. A Durable
 * Object alarm may run for 15 minutes, which build keeps 2 of. */
export function codeLimits(options = DEFAULTS) {
  const o = { ...DEFAULTS, ...options };
  if (o.approach === 'build') return { rounds: 400, timeLimit: 13 * 60000 };
  if (o.mode === 'fast') return { rounds: 40, timeLimit: 4 * 60000 };
  return { rounds: 150, timeLimit: 10 * 60000 };
}
/** The plan for one turn's options (defaults when none were saved). */
export function turnPlan(options = DEFAULTS) {
  const o = { ...DEFAULTS, ...options },
    deep = o.mode === 'deep',
    fast = o.mode === 'fast';
  return {
    search: deep || o.superSearch || o.search,
    // 'auto' sends no effort field at all: the provider's default.
    effort: deep
      ? RANK[Math.max(2, RANK.indexOf(o.effort))]
      : fast && o.effort === 'auto'
        ? 'off'
        : o.effort,
    maxOutput: fast ? 4096 : MAX_OUTPUT,
    rounds: o.superSearch ? 40 : deep ? 32 : fast ? 12 : 24,
    limits: o.superSearch
      ? { searches: 25, reads: 50, sources: 80 }
      : deep
        ? { searches: 10, reads: 20, sources: 60 }
        : undefined,
    instructions: [deep ? DEEP_RESEARCH : fast ? FAST : '', STYLE[o.style]]
      .filter(Boolean)
      .join('\n\n'),
  };
}
