/** Voice in the browser: dictating into the composer and reading answers and
 * documents aloud, both by the browser's own speech engines, so no audio
 * leaves the device where the browser can keep it there.
 *
 *   mic button ─► SpeechRecognition (on-device when offered) ─► #prompt
 *   Listen ─────► speechSynthesis, a sentence group at a time ─► speaker
 *
 * Dictation asks for on-device recognition (Chrome's processLocally,
 * installing the language pack on first use); where the browser has none it
 * uses the browser's own recognizer, and the mic's title says so. Reading
 * aloud uses the system's voices, which are local. A browser without
 * recognition hides the mic; one without synthesis hides Listen.
 * Depends on core. Left out: server-side speech models and voice choice.
 */
import { $, icon, toast } from './core.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition,
  synth = window.speechSynthesis;
/** Whether this browser can read aloud. */
export const canSpeak = !!synth;
/** The language spoken and heard: the browser's. */
const lang = navigator.language || 'en-US';

// ---- Dictation ----

const mic = $('#mic'),
  prompt = $('#prompt');
/** The running recognizer, or null. */
let listening = null;

/** Whether on-device recognition of the language can be had, installing its
 * pack if the browser offers one to download (Chrome 139+). */
async function onDevice() {
  if (!Recognition?.available) return false;
  const opts = { langs: [lang], processLocally: true };
  try {
    const status = await Recognition.available(opts);
    if (status === 'available') return true;
    if (status === 'downloadable' || status === 'downloading') {
      toast('Downloading the speech model for ' + lang + '…');
      return await Recognition.install(opts);
    }
  } catch {
    // An older engine without the options: fall through to its default.
  }
  return false;
}

/** Start dictating: what is heard is added to the composer after what is
 * there, the words still being heard shown as they come. */
async function listen() {
  const r = new Recognition(),
    before = prompt.value ? prompt.value.replace(/\s*$/, ' ') : '';
  listening = r;
  mic.classList.add('on');
  r.lang = lang;
  r.continuous = true;
  r.interimResults = true;
  if (await onDevice()) r.processLocally = true;
  else mic.title = 'Dictate (by the browser’s recognizer: on-device is not offered here)';
  r.onresult = e => {
    let heard = '';
    for (const res of e.results) heard += res[0].transcript;
    prompt.value = before + heard.trim();
    prompt.dispatchEvent(new Event('input')); // resizes it and keeps the draft
  };
  r.onerror = e => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Dictation: ' + e.error);
  };
  r.onend = () => {
    if (listening === r) listening = null;
    mic.classList.remove('on');
  };
  if (listening === r) r.start(); // unless stopped while the pack was checked
}

/** Stop dictating, keeping what was heard. */
export function stopListening() {
  const r = listening;
  listening = null;
  mic.classList.remove('on');
  r?.stop();
}

mic.innerHTML = icon('mic');
mic.hidden = !Recognition;
mic.onclick = () => (listening ? stopListening() : listen());

// ---- Reading aloud ----

/** The button reading now, or null. */
let reading = null;

/** Plain words from markdown or code: code blocks and markup left out, links
 * read by their text. */
function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_#>|~]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The text in pieces short enough for every engine (Chrome stops a long
 * utterance after about 15 seconds): whole sentences, up to ~200 letters. */
function pieces(text) {
  const out = [];
  for (const s of text.match(/[^.!?]+[.!?]*\s*/g) || []) {
    if (out.length && out.at(-1).length + s.length < 200) out[out.length - 1] += s;
    else out.push(s);
  }
  return out;
}

/** Stop reading aloud. */
export function stopSpeaking() {
  reading?.classList.remove('on');
  reading = null;
  synth?.cancel();
}

/** Read text aloud, the button showing it is on; a second press stops it. */
export function speak(text, button) {
  const again = reading === button;
  stopSpeaking();
  if (again || !synth) return;
  const parts = pieces(speakable(text));
  if (!parts.length) return;
  reading = button;
  button.classList.add('on');
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.lang = lang;
    if (i === parts.length - 1)
      u.onend = u.onerror = () => {
        if (reading === button) stopSpeaking();
      };
    synth.speak(u);
  });
}

/** The small Listen button under a message (thread.js). */
export function listenButton(what) {
  return canSpeak
    ? '<button type="button" class="copy-message listen-message" aria-label="Read the ' +
        what +
        ' aloud">' +
        icon('speaker') +
        ' Listen</button>'
    : '';
}
