/** Provider marks: small original badges (a coloured rounded square with a white glyph) that
 * tell the providers apart in lists, buttons and headers. They imitate no real logo. Depends
 * on nothing.
 */
const G =
  'fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
/** Per provider: the badge colour and the glyph drawn in a 24-unit box. */
const MARKS = {
  // A llama's head: two ears over a round face.
  ollama: ['#4b5563', `<path ${G} d="M8 11V6m8 5V6"/><circle ${G} cx="12" cy="14" r="5"/>`],
  // A hexagon ring.
  openai: ['#0f9d7a', `<path ${G} d="M12 5.5l5.6 3.25v6.5L12 18.5l-5.6-3.25v-6.5z"/>`],
  // A pointed arch with a crossbar.
  anthropic: ['#c8643c', `<path ${G} d="M7 18L12 6l5 12M9.2 14h5.6"/>`],
  // Two half rings, one offset.
  gemini: ['#7048e8', `<path ${G} d="M6.5 12a5.5 5.5 0 0 1 11 0M6.5 12h11M9 17a3 3 0 0 0 6 0"/>`],
  // Two waves.
  deepseek: ['#1e3a8a', `<path ${G} d="M5 10c2-3 4-3 7 0s5 3 7 0M5 15c2-3 4-3 7 0s5 3 7 0"/>`],
  // A K with a dot.
  kimi: [
    '#b5179e',
    `<path ${G} d="M8 6v12M15 7l-6 5.5 6 5.5"/><circle cx="16.5" cy="7" r="1.6" fill="#38bdf8"/>`,
  ],
  // Three bars climbing.
  mistral: ['#e8590c', `<path ${G} d="M6.5 17.5h4M6.5 12h8M6.5 6.5h11"/>`],
  // Two arches side by side.
  meta: [
    '#1d6ff2',
    `<path ${G} d="M5.5 17V11a3.25 3.25 0 0 1 6.5 0v6m0-6a3.25 3.25 0 0 1 6.5 0v6"/>`,
  ],
};
/** Returns the inline SVG badge for a provider id (Ollama's for an unknown one). */
export function providerMark(provider, size = 18) {
  const [colour, glyph] = MARKS[provider] || MARKS.ollama;
  return (
    `<svg class="pmark" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `<rect width="24" height="24" rx="6" fill="${colour}"/>${glyph}</svg>`
  );
}
