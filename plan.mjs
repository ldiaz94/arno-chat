/** What a turn's composer options (web/options.mjs) change on the host: web
 * tools, thinking effort, extra instructions, output and research budgets,
 * model rounds and the time limit. Chat (session.mjs plainTurn) and coding
 * (session-routes.mjs, the model gateway, writeConfig) read the same plan.
 *
 *   mode      effort          search   output   rounds  searches/reads  time
 *   standard  as chosen       chosen   16,384   8       3 / 6           4 min
 *   fast      off unless set  chosen   4,096    8       3 / 6           4 min
 *   deep      at least medium on       16,384   16      10 / 20         12 min
 */
import { MAX_OUTPUT } from './account.mjs';
import { DEFAULTS } from './web/options.mjs';

const STYLE = {
  normal: '',
  concise: 'Be brief: answer in as few words as the question needs, without preamble or recap.',
  caveman:
    'Answer in caveman speak: few words, no articles, no filler, short sentences. Example: "Me check. Bug in loop. Fix: change < to <=." Keep facts, names, numbers and code exactly right; code blocks stay normal, correct code.',
};
const FAST = 'Answer briefly and directly.';
export const DEEP_RESEARCH =
  'Deep research: plan the sub-questions first, then search broadly (several queries), read primary sources, and compare them. Write a structured report (summary, findings by sub-question, disagreements and open questions, numbered citations [1], [2] to the sources you read) and save it with create_artifact, titled "Research: <topic>". Then reply in chat with a short summary and the artifact link.';
const RANK = ['off', 'low', 'medium', 'high'];

/** The plan for one turn's options (defaults when none were saved). */
export function turnPlan(options = DEFAULTS) {
  const o = { ...DEFAULTS, ...options },
    deep = o.mode === 'deep',
    fast = o.mode === 'fast';
  return {
    search: deep || o.search,
    // 'auto' sends no effort field at all: the provider's default.
    effort: deep
      ? RANK[Math.max(2, RANK.indexOf(o.effort))]
      : fast && o.effort === 'auto'
        ? 'off'
        : o.effort,
    maxOutput: fast ? 4096 : MAX_OUTPUT,
    rounds: deep ? 16 : 8,
    limits: deep ? { searches: 10, reads: 20, sources: 60 } : undefined,
    // A Durable Object alarm may run for 15 minutes; deep research keeps 3 spare.
    timeLimit: deep ? 12 * 60000 : 4 * 60000,
    instructions: [deep ? DEEP_RESEARCH : fast ? FAST : '', STYLE[o.style]]
      .filter(Boolean)
      .join('\n\n'),
  };
}
