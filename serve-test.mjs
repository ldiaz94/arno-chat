/* serve.mjs against the real arno --serve and arno's stub model server
 * (~/r/arno/build/stub): a turn, a tool call answered by its question, a
 * worker, and a second turn that loads the first's conversation. Needs a
 * built arno; run with `node serve-test.mjs`. Its directory is under ~/.cache,
 * not /tmp: arno's jail has a /tmp of its own, which would hide the stage. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { serveTurn, replyOf, transcriptOf } from './serve.mjs';

const ARNO = process.env.ARNO || process.env.HOME + '/r/arno/build/arno',
  STUB = process.env.STUB || process.env.HOME + '/r/arno/build/stub';
const dir = mkdtempSync(homedir() + '/.cache/arno-serve-test-'),
  repo = dir + '/repo';
for (const d of ['config/arno', 'data', 'cache', 'run', 'repo'])
  mkdirSync(dir + '/' + d, { recursive: true });
writeFileSync(repo + '/f.txt', 'one\n');
execFileSync(
  'sh',
  ['-c', 'git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm i'],
  { cwd: repo },
);
const [port] = execFileSync(STUB, ['30']).toString().trim().split(/\s+/);
writeFileSync(
  dir + '/config/arno/config',
  `url = http://127.0.0.1:${port}/v1\ncontext_files = no\nproject_map = no\nsafety = safe\nworkers = small\n`,
);

async function turn(line, conversation) {
  const child = spawn(ARNO, ['--serve'], {
    cwd: repo,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: dir + '/config',
      XDG_DATA_HOME: dir + '/data',
      XDG_CACHE_HOME: dir + '/cache',
      XDG_RUNTIME_DIR: dir + '/run',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const events = [];
  // serve.mjs wants the hello's root to be /workspace/repo; point it here.
  const t = await serveTurn(
    { stdin: Writable.toWeb(child.stdin), stdout: Readable.toWeb(child.stdout) },
    { hello: {}, conversation, line, onEvent: e => events.push(e.n), root: repo },
  );
  await new Promise(r => child.on('exit', r));
  return { t, events };
}

const one = await turn('hello there');
assert.ok(one.t.conversation, 'a conversation id');
assert.match(replyOf(one.t), /messages/);
assert.ok(one.t.stats && one.t.stats.requests >= 1, 'stats');

const two = await turn('call read {"path":"f.txt"}', one.t.conversation);
assert.equal(two.t.conversation, one.t.conversation, 'the conversation was loaded');
assert.match(transcriptOf(two.t), /▸ read/);
assert.match(replyOf(two.t), /the tool said/);

const three = await turn('call delegate {"task":"hello worker"}', one.t.conversation);
assert.ok(
  three.t.entries.some(e => e.worker),
  'a worker spoke',
);
console.log('PASS serve: turn, tool, loaded conversation, worker');

// Staged, as in the container: a shell edit in the copy, applied at the end
// of the turn when its diff is asked about and answered yes.
writeFileSync(
  dir + '/config/arno/config',
  `url = http://127.0.0.1:${port}/v1\ncontext_files = no\nproject_map = no\nsafety = auto\n`,
);
const four = await turn('call shell {"command":"echo two > f.txt"}');
assert.equal(
  execFileSync('cat', [repo + '/f.txt']).toString(),
  'two\n',
  'the stage was applied: ' + transcriptOf(four.t),
);
console.log('PASS serve: staged shell edit applied');
