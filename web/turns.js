/** Running a turn: sending a prompt, editing a message, polling the job and showing
 * live output. A message that can't go now (offline, or others of its conversation
 * still waiting) goes to the outbox instead. Depends on core, layout, thread,
 * sessions, attach, offline, outbox, queue.mjs and render.mjs.
 */
import { markdown } from './render.mjs';
import { $, state, esc, duration, api, toast, showError, prompt, sendKey } from './core.js';
import { openNamed } from './artifacts.js';
import { busy, title, bump } from './layout.js';
import { message, failure, scrollDown, place, spent } from './thread.js';
import { resume, persist } from './sessions.js';
import { uploading, takeReady, restore } from './attach.js';
import { warm } from './offline.js';
import { queueMessage, waiting } from './outbox.js';
import { isLocal } from './queue.mjs';
import { messageOptions, optionCommand } from './options.js';
import { pull } from './code.js';
/** A chat's question before an MCP action (approve in server/chat/turn.mjs): what would
 * run, with its arguments, and Allow or Deny. Shown while the job waits. */
function approval(job) {
  const a = job.stage === 'approval' ? job.approval : null,
    node = $('#approval');
  if (!a) return node?.remove();
  if (node?.dataset.id === a.id) return;
  const card = document.createElement('div');
  card.id = 'approval';
  card.className = 'approval-card';
  card.dataset.id = a.id;
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-label', 'Allow this action?');
  card.innerHTML =
    '<strong>Allow this action?</strong><p>' +
    esc(a.what) +
    '</p><pre>' +
    esc(a.args) +
    '</pre><div class="approval-actions"><button type="button" class="primary" data-allow="1">Allow</button><button type="button" data-allow="">Deny</button><span class="caption">Waits up to 3 minutes</span></div>';
  card.onclick = async e => {
    const b = e.target.closest('[data-allow]');
    if (!b) return;
    const allow = !!b.dataset.allow;
    for (const x of card.querySelectorAll('button')) x.disabled = true;
    try {
      await api('/api/sessions/' + state.session.id + '/approve', {
        method: 'POST',
        body: JSON.stringify({ id: a.id, allow }),
      });
      card.querySelector('.caption').textContent = allow ? 'Allowed · running' : 'Denied';
    } catch (err) {
      card.querySelector('.caption').textContent = err.message;
      for (const x of card.querySelectorAll('button')) x.disabled = false;
    }
  };
  node?.remove();
  place(card);
  scrollDown();
}
/** The newest live preview (livePreview), which the activity card reads the
 * turn's steps from. */
let latest = null;
// Shows what a running job is doing (and any MCP question) in the thread.
function activity(job) {
  approval(job);
  let node = $('#activity');
  if (!node) {
    node = document.createElement('div');
    node.id = 'activity';
    node.className = 'activity';
    place(node);
  }
  const preview = latest?.jobId === job.id ? latest : null;
  if (state.session?.kind === 'chat') {
    chatActivity(node, job, preview);
    scrollDown();
    return;
  }
  const stage = job.stage || 'queued',
    order = ['queued', 'preparing', 'thinking', 'checkpointing'],
    at = stage === 'restoring' ? 1 : Math.max(0, order.indexOf(stage));
  const labels = {
    queued: 'Task saved · waiting to start',
    preparing: 'Preparing your warm workspace',
    restoring: 'Restoring your saved workspace',
    thinking: 'Arno is reading, reasoning, and working',
    checkpointing: 'Saving your changes and conversation',
  };
  // Built once, then updated in place, so what is open or scrolled stays so.
  if (node.dataset.job !== 'code:' + (job.id || '')) {
    node.dataset.job = 'code:' + (job.id || '');
    node.className = 'activity';
    node.innerHTML =
      '<div class="activity-top"><span class="spinner"></span><strong></strong><span class="spacer"></span><span class="caption"></span></div><small></small><div class="steps">' +
      order.map(() => '<span></span>').join('') +
      '</div><ol class="step-list recent" aria-label="Recent steps"></ol><details class="all-steps"><summary>All steps</summary><ol class="step-list"></ol></details>';
    const all = node.querySelector('.all-steps');
    all.ontoggle = () => all.open && followSteps(state.session.id, job.id, all);
  }
  const set = (sel, text) => {
    const el = node.querySelector(sel);
    if (el.textContent !== text) el.textContent = text;
  };
  set('.activity-top strong', labels[stage] || 'Working…');
  set(
    '.activity-top .caption',
    duration(Date.now() - (job.createdAt || Date.now())) +
      // A turn going on from one stopped at its time limit: the time in all, too.
      (job.chainStartedAt ? ' · ' + duration(Date.now() - job.chainStartedAt) + ' in all' : ''),
  );
  set(
    ':scope > small',
    stage === 'restoring'
      ? 'Your existing workspace is being restored, not checked out again.'
      : stage === 'checkpointing'
        ? 'Your answer will appear when its workspace checkpoint is safely saved.'
        : preview?.activity || 'This task continues if you close the page.',
  );
  node.querySelectorAll('.steps span').forEach((s, i) => s.classList.toggle('done', i <= at));
  const steps = preview?.steps || [],
    recent = steps.at(-1)?.text === preview?.activity ? steps.slice(0, -1) : steps;
  syncSteps(node.querySelector('.step-list.recent'), recent, true);
  const count = preview?.stepCount || 0;
  set('.all-steps summary', count ? 'All ' + count + ' steps' : 'All steps');
  node.querySelector('.all-steps').hidden = count <= recent.length + 1;
  scrollDown();
}
/** A chat turn's card: what it does now, with a pulsing dot and a ticking
 * clock since it began, over the steps it has finished. Built once, then
 * updated, so the clock and the screen reader's status line are not reset. */
function chatActivity(node, job, preview) {
  if (node.className !== 'chat-activity') {
    node.className = 'chat-activity';
    delete node.dataset.job;
    node.innerHTML =
      '<div class="activity-now"><span class="pulse-dot" aria-hidden="true"></span><span class="activity-label" role="status"></span><span class="activity-clock"></span></div><div class="activity-steps"></div><p class="activity-quote"></p>';
    const began = job.createdAt || Date.now(),
      clock = node.querySelector('.activity-clock'),
      quote = node.querySelector('.activity-quote');
    let next = Math.floor(Math.random() * QUOTES.length);
    // A quote to read while it works, a new one every QUOTE_SECONDS.
    const tick = () => {
      const s = Math.floor((Date.now() - began) / 1000);
      clock.textContent = elapsed(Date.now() - began);
      if (s % QUOTE_SECONDS && quote.textContent) return;
      const [words, who] = QUOTES[next++ % QUOTES.length];
      quote.innerHTML = '“' + esc(words) + '” <span>— ' + esc(who) + '</span>';
      quote.classList.remove('fresh');
      void quote.offsetWidth;
      quote.classList.add('fresh');
    };
    tick();
    const timer = setInterval(() => (node.isConnected ? tick() : clearInterval(timer)), 1000);
  }
  const steps = preview?.steps || [],
    last = steps.at(-1);
  const now =
    job.stage === 'approval'
      ? 'Waiting for your answer'
      : job.stage === 'saving'
        ? 'Saving response'
        : preview?.text && (!last || preview.updatedAt > last.at)
          ? 'Responding'
          : last?.text ||
            (job.stage === 'searching'
              ? 'Searching the web'
              : job.stage === 'reading'
                ? 'Reading sources'
                : 'Thinking');
  const label = node.querySelector('.activity-label');
  if (label.textContent !== now + '…') label.textContent = now + '…';
  // Redrawn only when the steps change, and only new ones fade in: a redraw
  // on every update replayed the fade on all of them, so the list flashed.
  const list = node.querySelector('.activity-steps'),
    html = stepsHtml(steps, now);
  if (list.dataset.html === html) return;
  const seen = new Set([...list.querySelectorAll('li')].map(li => li.textContent));
  list.innerHTML = list.dataset.html = html;
  for (const li of list.querySelectorAll('li'))
    if (!seen.has(li.textContent)) li.classList.add('fresh');
}
/** The turn's recent steps, each ✓ but the one it is on (current). */
function stepsHtml(steps = [], current) {
  const done = steps.at(-1)?.text === current ? steps.slice(0, -1) : steps;
  if (!done.length) return '';
  const mark = s =>
    '<span aria-hidden="true">' + (s.done === false ? '…' : '✓') + '</span> ' + esc(s.text);
  const item = s => '<li>' + mark(s) + '</li>';
  return '<ol class="step-list" aria-label="Recent steps">' + done.map(item).join('') + '</ol>';
}
/** Brings list up to steps, keyed by their call's number: a new step is
 * added, a known one has its mark and detail set when they change, and
 * nothing else is touched, so an open step and its scroll stay put. With
 * prune, steps no longer given go. */
function syncSteps(list, steps, prune = false) {
  const keys = new Set();
  for (const s of steps) {
    const key = String(s.n ?? s.text + '@' + s.at);
    keys.add(key);
    let li = [...list.children].find(l => l.dataset.key === key);
    if (!li) {
      li = document.createElement('li');
      li.dataset.key = key;
      li.innerHTML = s.detail
        ? '<details><summary><span aria-hidden="true"></span> ' +
          esc(s.text) +
          '</summary><pre class="step-detail"></pre></details>'
        : '<span aria-hidden="true"></span> ' + esc(s.text);
      list.append(li);
    }
    const mark = li.querySelector('span'),
      sign = s.done === false ? '…' : '✓';
    if (mark.textContent !== sign) mark.textContent = sign;
    const pre = li.querySelector('pre');
    if (pre && pre.textContent !== s.detail) pre.textContent = s.detail;
  }
  if (prune) for (const li of [...list.children]) if (!keys.has(li.dataset.key)) li.remove();
}
/** Fills the "All steps" list of the card while it is open: every step of
 * job so far, then every 3 s what is new or has finished since. */
async function followSteps(sid, jobId, box) {
  const list = box.querySelector('ol');
  while (box.open && box.isConnected && state.session?.id === sid) {
    // From the first step still running, so its result comes in too.
    const items = [...list.children],
      running = items.findIndex(li => li.querySelector('span')?.textContent === '…'),
      from = running < 0 ? items.length : running;
    const r = await api('/api/sessions/' + sid + '/steps?from=' + from).catch(() => null);
    if (!r || r.jobId !== jobId) return;
    if (r.from === 0 && from > 0 && r.steps.length < from) list.textContent = '';
    syncSteps(list, r.steps);
    await new Promise(done => setTimeout(done, 3000));
  }
}
/** How often the activity card's quote changes, in seconds. */
const QUOTE_SECONDS = 15;
/** Quotes on making, finding out and keeping it simple, as [words, who]. */
const QUOTES = [
  ['Simplicity is prerequisite for reliability.', 'Edsger W. Dijkstra'],
  ['The purpose of computing is insight, not numbers.', 'Richard Hamming'],
  ['What I cannot create, I do not understand.', 'Richard Feynman'],
  [
    'The first principle is that you must not fool yourself, and you are the easiest person to fool.',
    'Richard Feynman',
  ],
  [
    'Programs must be written for people to read, and only incidentally for machines to execute.',
    'Abelson and Sussman',
  ],
  ['Premature optimization is the root of all evil.', 'Donald Knuth'],
  ['The best way to predict the future is to invent it.', 'Alan Kay'],
  ['Any sufficiently advanced technology is indistinguishable from magic.', 'Arthur C. Clarke'],
  ['If I have seen further it is by standing on the shoulders of Giants.', 'Isaac Newton'],
  [
    'Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away.',
    'Antoine de Saint-Exupéry',
  ],
  [
    'We can only see a short distance ahead, but we can see plenty there that needs to be done.',
    'Alan Turing',
  ],
  ['Science is a way of thinking much more than it is a body of knowledge.', 'Carl Sagan'],
  ['The important thing is not to stop questioning.', 'Albert Einstein'],
  ['Talk is cheap. Show me the code.', 'Linus Torvalds'],
  [
    'There are only two hard things in Computer Science: cache invalidation and naming things.',
    'Phil Karlton',
  ],
  ['Brevity is the soul of wit.', 'William Shakespeare'],
];
/** Time since a turn began, as m:ss. */
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
/** Live text is provisional until the durable result arrives. Native details
 * preserve keyboard accessibility and keep model thinking optional/collapsed.
 * Only the answer is rendered as Markdown; thinking is escaped plain text. */
function livePreview(preview) {
  // Its steps go to the activity card, newest preview first.
  if (
    preview?.jobId === state.job?.id &&
    (latest?.jobId !== preview.jobId || preview.updatedAt > latest.updatedAt)
  ) {
    latest = preview;
    if ($('#activity')) activity(state.job);
  }
  if (
    !preview ||
    preview.jobId !== state.job?.id ||
    !['queued', 'running'].includes(state.job.status) ||
    (!preview.text && !preview.reasoning)
  )
    return;
  let node = $('#live-response');
  if (!node) {
    node = document.createElement('article');
    node.id = 'live-response';
    node.className = 'turn assistant streaming';
    node.innerHTML =
      '<div class="turn-header"><div class="avatar arno-avatar"></div><strong>Arno</strong><span class="caption live-label">Live response</span></div><details class="model-thinking"><summary>Thinking <span>Provided by the model</span><small class="thinking-peek"></small></summary><div class="thinking-text"></div></details><div class="prose"></div><small class="caption live-pass"></small>';
    $('#thread').insertBefore(node, $('#activity'));
  }
  const round = Number(node.dataset.round || 0),
    updatedAt = Number(node.dataset.updatedAt || 0);
  if (preview.round < round || (preview.round === round && preview.updatedAt <= updatedAt)) return;
  node.dataset.round = preview.round;
  node.dataset.updatedAt = preview.updatedAt;
  const thinking = node.querySelector('.model-thinking');
  thinking.hidden = !preview.reasoning;
  node.querySelector('.thinking-text').textContent = preview.reasoning || '';
  // The latest line of thinking, seen while it is collapsed and no answer streams yet.
  node.querySelector('.thinking-peek').textContent = preview.text
    ? ''
    : (preview.reasoning || '').trim().split('\n').at(-1).slice(-160);
  node.querySelector('.prose').innerHTML = markdown(preview.text || '');
  node.querySelector('.live-pass').textContent =
    state.session?.kind === 'chat'
      ? 'Streaming · response not yet saved'
      : 'Model pass ' + preview.round + ' · workspace not yet saved';
  scrollDown();
}
// Opens the live event stream of a running job and shows its previews. Returns a function that
// closes it. `gen` is the view generation it belongs to.
function watchLive(id, gen) {
  if (!window.EventSource) return () => {};
  const stream = new EventSource('/api/sessions/' + id + '/events');
  stream.addEventListener('preview', e => {
    if (gen !== state.generation) {
      stream.close();
      return;
    }
    try {
      livePreview(JSON.parse(e.data));
    } catch {}
  });
  // EventSource reconnects itself. Polling below remains the fallback and source
  // of truth for final results, errors, cancellation, and workspace checkpoints.
  return () => stream.close();
}
/** Follows the turn the server starts from one stopped at its time limit
 * (next, its job id; server/probe/probe.mjs), unless a message sent or Stop
 * took its place. */
async function followOn(id, gen, next) {
  for (let i = 0; i < 10 && gen === state.generation; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const job = await api('/api/sessions/' + id + '/job').catch(() => null);
    if (job?.id === next) return watchJob(id, gen);
    if (job && !job.goesOnAs) return;
  }
}
// Poll durable task state. expected is an idempotency record for a new send;
// without it, resume only follows an active job and avoids duplicate old answers.
export async function watchJob(id, gen, expected) {
  let active = false,
    stopLive;
  try {
    for (let attempt = 0; attempt < 240 && gen === state.generation; attempt++) {
      let job;
      try {
        job = await api('/api/sessions/' + id + '/job');
      } catch {
        if (gen !== state.generation) return;
        // Offline with no turn known to be running: nothing to follow.
        if (!active && !expected && (state.offline || !navigator.onLine)) return;
        busy(true);
        if (!$('#activity')) activity({ stage: 'queued' });
        const label = $('#activity strong') || $('#activity .activity-label');
        if (label) label.textContent = 'Connection interrupted · reconnecting';
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      if (gen !== state.generation) return;
      if (!expected && !active && !['queued', 'running'].includes(job.status)) return;
      if (expected && job.status === 'idle') {
        toast('Message was not received. Your draft has been restored.');
        prompt.value = expected.prompt;
        return;
      }
      if (expected && job.id !== expected.id) return;
      if (!active && !expected && job.prompt)
        message('You', job.prompt, { attachments: job.attachments || [] });
      active = true;
      state.job = job;
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        stopLive?.();
        $('#activity')?.remove();
        $('#approval')?.remove();
        $('#live-response')?.remove();
        if (job.status === 'completed') {
          message('Arno', job.result.summary, { ...job.result, at: job.finishedAt });
          const updated = await api('/api/sessions/' + id);
          warm([{ id }], true); // keep the new turn's artifacts and images for offline
          if (gen === state.generation) {
            state.session = { id, ...updated };
            const asked = [...document.querySelectorAll('#thread .turn.user')].at(-1),
              saved = updated.history?.at(-1)?.at;
            if (asked && saved) asked.dataset.at = saved;
            state.sessions = state.sessions.map(s => (s.id === id ? { ...s, ...updated } : s));
            title(
              updated.title || updated.repo,
              updated.kind === 'chat'
                ? 'Private chat · Web research enabled'
                : (updated.ref || 'main') + ' · GitHub workspace',
            );
          }
          bump(id); // the conversation moves to the top of the list
          toast(
            job.goesOnAs
              ? 'Time limit reached · continuing'
              : state.session?.kind === 'chat'
                ? 'Response saved'
                : 'Turn complete · workspace saved',
          );
          if (job.goesOnAs) followOn(id, gen, job.goesOnAs);
        } else {
          const card = failure(
            job.prompt,
            job.status === 'cancelled'
              ? 'Stopped before it finished.'
              : job.result?.error || 'Task failed. Your previous checkpoint is preserved.',
            undefined,
            [...document.querySelectorAll('#thread .turn.user')].at(-1)?._attachments,
          );
          // The saved failure's time lets Retry and Edit replace it.
          const updated = await api('/api/sessions/' + id).catch(() => null),
            saved = updated?.history?.at(-1);
          if (gen === state.generation && saved?.failed) {
            state.session = { id, ...updated };
            card.dataset.at = saved.at;
            card.querySelector('p').insertAdjacentHTML('afterend', spent(saved.usage));
            const asked = card.previousElementSibling;
            if (asked?.classList.contains('user')) asked.dataset.at = saved.at;
          }
          toast(
            job.status === 'cancelled'
              ? 'Task stopped'
              : 'Task failed. Review the error and retry when ready.',
          );
        }
        return;
      }
      busy(true);
      activity(job);
      if (!stopLive) stopLive = watchLive(id, gen);
      livePreview(job.preview);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (gen === state.generation)
      toast('Task is still saved. Reopen the session to check its status.');
  } catch (e) {
    showError(e);
  } finally {
    stopLive?.();
    if (gen === state.generation) {
      busy(false);
      state.job = null;
    }
  }
}
// Sends the prompt: a command is applied, a message goes to the server, or to the outbox when
// it cannot go now. Then follows the job.
export async function submit(e) {
  e.preventDefault();
  if (!state.session || !prompt.value.trim()) return;
  if (uploading()) return toast('Wait for the uploads to finish');
  const text = prompt.value.trim();
  // /pull is the app's: it updates the workspace without a turn (code.js).
  if (text === '/pull' && state.session.kind !== 'chat') {
    prompt.value = '';
    resizePrompt();
    return pull();
  }
  // /open is the app's too: it shows an artifact (artifacts.js).
  const open = /^\/open(?:\s+(.*))?$/.exec(text);
  if (open) {
    prompt.value = '';
    resizePrompt();
    return openNamed(open[1] || '');
  }
  const set = optionCommand(text);
  if (set) {
    prompt.value = '';
    resizePrompt();
    return toast(set);
  }
  if (!(await persist())) return;
  prompt.value = '';
  resizePrompt();
  sessionStorage.removeItem('draft:' + state.session.id);
  await send(text, undefined, undefined, takeReady());
}
/** Edit a saved message in place; sending replaces it and every later turn. */
export function editMessage(node, text) {
  if (state.offline) return toast('Reconnect to edit');
  if (state.busy) return toast('Wait for the current turn to finish');
  const at = Number(node.dataset.at);
  if (!at) return toast('This message can be edited once its answer is saved');
  const box = node.querySelector('.user-content');
  box.innerHTML =
    '<textarea class="edit-box" rows="3"></textarea><div class="edit-actions"><button type="button">Cancel</button><button type="button" class="primary">Send</button></div>';
  const area = box.querySelector('textarea');
  area.value = text;
  area.focus();
  const [cancel, save] = box.querySelectorAll('button');
  cancel.onclick = () => {
    box.textContent = text;
  };
  area.onkeydown = e => {
    if (!sendKey(e)) return;
    e.preventDefault();
    save.click();
  };
  save.onclick = () => {
    const v = area.value.trim();
    if (v && !state.busy && replaceOk(node, 'Edit')) replaceFrom(node, v, at);
  };
}
/** Send a saved message again as it is: its answer and every later turn
 * are replaced (in a coding session, the workspace too). */
export function retryMessage(node, text) {
  if (state.offline) return toast('Reconnect to retry');
  if (state.busy) return toast('Wait for the current turn to finish');
  const at = Number(node.dataset.at);
  if (!at) return toast('This message can be retried once its answer is saved');
  if (replaceOk(node, 'Retry')) replaceFrom(node, text, at);
}
/** Whether to replace node's turn, asked when that loses more than its answer:
 * later messages, or a coding session's workspace changes since. */
function replaceOk(node, verb) {
  const later = [...node.parentNode.querySelectorAll('.turn.user')].filter(
      n => n.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING,
    ).length,
    notes = [];
  if (later)
    notes.push(
      (later === 1 ? 'The message after it' : 'The ' + later + ' messages after it') +
        ' and their answers will be removed.',
    );
  if (state.session?.kind !== 'chat')
    notes.push(
      'The workspace goes back to how this message found it; what was pushed stays on GitHub.',
    );
  return !notes.length || confirm(verb + ' this message? ' + notes.join(' '));
}
/** Clear node (a saved message, sent at at) and everything after it, and send
 * text in its place. */
function replaceFrom(node, text, at) {
  while (node.nextSibling) node.nextSibling.remove();
  node.remove();
  send(text, at, undefined, node._attachments);
}
/** Send a failed turn's message again in its place. */
export function retry(card, text) {
  if (state.offline) return toast('Reconnect to retry');
  if (state.busy) return toast('Wait for the current turn to finish');
  const replaces = Number(card.dataset.at) || undefined;
  card.previousElementSibling?.classList.contains('user') && card.previousElementSibling.remove();
  card.remove();
  send(text, undefined, replaces, card._attachments);
}
// attachments are the metadata of uploaded files sent with the message (or, for
// files picked offline, the files themselves).
/** Sends text as the user's next message, as if typed: a decision card's
 * choice (thread.js). */
export async function answer(text) {
  if (state.offline) return toast('Reconnect to answer');
  if (state.busy) return toast('Wait for the current turn to finish');
  if (!(await persist())) return;
  await send(text);
}
async function send(text, editAt, replaces, attachments = []) {
  const id = state.session.id,
    gen = state.generation,
    body = {
      id: crypto.randomUUID(),
      prompt: text,
      options: messageOptions(),
      ...(attachments.length ? { attachments: attachments.map(a => a.id) } : {}),
      ...(editAt ? { editAt } : {}),
      ...(replaces ? { replaces } : {}),
    };
  // A new message waits in the outbox while offline, while a turn runs (it is
  // queued, and sends when the turn ends), while earlier ones of its
  // conversation wait, or while its files are not uploaded; edits and retries
  // of saved turns need the network.
  const plain = !editAt && !replaces;
  if (
    plain &&
    (state.offline ||
      state.busy ||
      isLocal(id) ||
      waiting(id, 'message') ||
      attachments.some(a => !a.id))
  )
    return queueMessage(id, body, attachments, state.busy && !state.offline);
  if (state.offline) return toast('Reconnect to send');
  $('#thread .starter')?.remove();
  const asked = message('You', body.prompt, { attachments });
  busy(true);
  activity({ stage: 'queued', createdAt: Date.now() });
  scrollDown(true);
  try {
    await api('/api/sessions/' + id + '/messages', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if (e.network && plain && (state.offline || !navigator.onLine)) {
      // The network went: the outbox sends it later. The server de-duplicates
      // by the message's id, so if this one did arrive, that does no harm.
      // (Still online, only the reply was lost: the job poll below finds out.)
      asked.remove();
      $('#activity')?.remove();
      busy(false);
      return queueMessage(id, body, attachments);
    }
    if (e.status === 400) {
      // An edit already cleared the turns after it: show the saved thread again
      // first (resume clears pending chips), then give back the draft and files.
      if (editAt && gen === state.generation) await resume(id);
      rejected(e, asked, text, attachments, editAt ? state.generation : gen);
      return;
    }
    toast('Checking whether your message was saved…');
  }
  await watchJob(id, gen, body);
}
// The server refused the message: show why and give the draft and files back.
function rejected(e, asked, text, attachments, gen) {
  if (gen !== state.generation) return;
  asked.remove();
  $('#activity')?.remove();
  busy(false);
  state.job = null;
  if (!prompt.value) prompt.value = text;
  resizePrompt();
  restore(attachments);
  showError(e);
}
// Grows the prompt box with its text, up to a limit.
export function resizePrompt() {
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, innerWidth < 800 ? 105 : 150) + 'px';
}
