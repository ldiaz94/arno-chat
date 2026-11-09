/** Running a turn: sending a prompt, editing a message, polling the job and showing
 * live output. Depends on core, layout, thread, offline and render.mjs.
 */
import { markdown } from './render.mjs';
import { $, state, esc, duration, api, toast, showError, prompt } from './core.js';
import { busy, title, sidebar } from './layout.js';
import { message, failure, scrollDown } from './thread.js';
import { resume } from './sessions.js';
import { uploading, takeReady, restore } from './attach.js';
import { warm } from './offline.js';
function activity(job) {
  let node = $('#activity');
  if (!node) {
    node = document.createElement('div');
    node.id = 'activity';
    node.className = 'activity';
    $('#thread').append(node);
  }
  if (state.session?.kind === 'chat') {
    node.className = 'chat-activity';
    const label =
      job.stage === 'searching'
        ? 'Searching the web'
        : job.stage === 'reading'
          ? 'Reading sources'
          : job.stage === 'saving'
            ? 'Saving response'
            : $('#live-response .prose')?.textContent
              ? 'Responding'
              : 'Thinking';
    node.innerHTML =
      '<div class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></div><span>' +
      label +
      '…</span>';
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
  node.innerHTML =
    '<div class="activity-top"><span class="spinner"></span><strong>' +
    esc(labels[stage] || 'Working…') +
    '</strong><span class="spacer"></span><span class="caption">' +
    duration(Date.now() - (job.createdAt || Date.now())) +
    '</span></div><small>' +
    (stage === 'restoring'
      ? 'Your existing workspace is being restored, not checked out again.'
      : stage === 'checkpointing'
        ? 'Your answer will appear when its workspace checkpoint is safely saved.'
        : 'This task continues if you close the page.') +
    '</small><div class="steps">' +
    order.map((s, i) => '<span class="' + (i <= at ? 'done' : '') + '"></span>').join('') +
    '</div>';
  scrollDown();
}
/** Live text is provisional until the durable result arrives. Native details
 * preserve keyboard accessibility and keep model thinking optional/collapsed.
 * Only the answer is rendered as Markdown; thinking is escaped plain text. */
function livePreview(preview) {
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
      '<div class="turn-header"><div class="avatar arno-avatar"></div><strong>Arno</strong><span class="caption live-label">Live response</span></div><details class="model-thinking"><summary>Thinking <span>Provided by the model</span></summary><div class="thinking-text"></div></details><div class="prose"></div><small class="caption live-pass"></small>';
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
  node.querySelector('.prose').innerHTML = markdown(preview.text || '');
  if (state.session?.kind === 'chat' && preview.text) {
    const label = $('#activity > span');
    if (label) label.textContent = 'Responding…';
    $('#send').textContent = 'Responding…';
  }
  node.querySelector('.live-pass').textContent =
    state.session?.kind === 'chat'
      ? 'Streaming · response not yet saved'
      : 'Model pass ' + preview.round + ' · workspace not yet saved';
  scrollDown();
}
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
        const label = $('#activity strong') || $('#activity span');
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
            sidebar();
            title(
              updated.title || updated.repo,
              updated.kind === 'chat'
                ? 'Private chat · Web research enabled'
                : (updated.ref || 'main') + ' · GitHub workspace',
            );
          }
          toast(
            state.session?.kind === 'chat' ? 'Response saved' : 'Turn complete · workspace saved',
          );
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
export async function submit(e) {
  e.preventDefault();
  if (!state.session || state.busy || !prompt.value.trim()) return;
  if (state.offline) return toast('Reconnect to send');
  if (uploading()) return toast('Wait for the uploads to finish');
  const text = prompt.value.trim();
  prompt.value = '';
  resizePrompt();
  sessionStorage.removeItem('draft:' + state.session.id);
  await send(text, undefined, undefined, takeReady());
}
/** Edit a saved chat message in place; sending replaces it and every later turn. */
export function editMessage(node, text) {
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
  save.onclick = () => {
    const v = area.value.trim();
    if (!v || state.busy) return;
    while (node.nextSibling) node.nextSibling.remove();
    node.remove();
    send(v, at, undefined, node._attachments);
  };
}
/** Send a failed turn's message again in its place. */
export function retry(card, text) {
  if (state.busy) return toast('Wait for the current turn to finish');
  const replaces = Number(card.dataset.at) || undefined;
  card.previousElementSibling?.classList.contains('user') && card.previousElementSibling.remove();
  card.remove();
  send(text, undefined, replaces, card._attachments);
}
// attachments are the metadata of uploaded files sent with the message.
async function send(text, editAt, replaces, attachments = []) {
  if (state.offline) return toast('Reconnect to send');
  const id = state.session.id,
    gen = state.generation,
    body = {
      id: crypto.randomUUID(),
      prompt: text,
      ...(attachments.length ? { attachments: attachments.map(a => a.id) } : {}),
      ...(editAt ? { editAt } : {}),
      ...(replaces ? { replaces } : {}),
    };
  $('#thread .starter')?.remove();
  const asked = message('You', body.prompt, { attachments });
  busy(true);
  activity({ stage: 'queued', createdAt: Date.now() });
  scrollDown(true);
  try {
    await api('/api/sessions/' + id + '/messages', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
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
export function resizePrompt() {
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, innerWidth < 800 ? 105 : 150) + 'px';
}
