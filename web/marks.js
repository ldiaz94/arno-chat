/** Provider marks: small simplified drawings after each provider's own logo,
 * so the providers are recognisable in lists, buttons and headers. They are
 * our own simplified versions for this private app, not the official artwork;
 * a public release would use each provider's published brand assets instead.
 * Each is drawn in a 24-unit box on a rounded tile. Depends on nothing.
 */
const tile = (fill, stroke = 'none') =>
  `<rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="${fill}" stroke="${stroke}"/>`;
// The attributes of a round-capped outline stroke.
const line = (colour, width = 1.8) =>
  `fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;

/** Per provider: the tile and drawing in the 24-unit box. */
const MARKS = {
  // A llama's head in outline, black on white, like Ollama's mascot.
  ollama:
    tile('#fff', '#d0d5dc') +
    `<path ${line('#111', 1.5)} d="M8.5 9.5V5.6c0-1 1.4-1 1.6 0l.5 2.6m4.9 1.3V5.6c0-1-1.4-1-1.6 0l-.5 2.6M7.6 13.5c0-2.7 2-4.6 4.4-4.6s4.4 1.9 4.4 4.6v3.2c0 1.2-1 2.3-2.2 2.3H9.8c-1.2 0-2.2-1.1-2.2-2.3z"/>` +
    `<circle cx="10.2" cy="13" r=".8" fill="#111"/><circle cx="13.8" cy="13" r=".8" fill="#111"/>` +
    `<ellipse ${line('#111', 1.2)} cx="12" cy="15.9" rx="1.6" ry="1.1"/>`,
  // A six-fold knot of rounded links, white on black, after OpenAI's blossom.
  openai:
    tile('#0d0d0d') +
    [0, 60, 120, 180, 240, 300]
      .map(
        a =>
          `<rect ${line('#fff', 1.5)} x="10.1" y="4.8" width="3.8" height="8.4" rx="1.9" transform="rotate(${a} 12 12) translate(1.2 0)"/>`,
      )
      .join(''),
  // Claude's spark: rays from a centre, white on terracotta.
  anthropic:
    tile('#d97757') +
    Array.from({ length: 12 }, (_, i) => i * 30)
      .map(
        a =>
          `<path ${line('#fff', 1.7)} d="M12 12V${a % 60 ? 6.4 : 5}" transform="rotate(${a} 12 12)"/>`,
      )
      .join(''),
  // Gemini's four-pointed sparkle, in its blue-to-violet gradient.
  gemini:
    `<defs><linearGradient id="pm-gem" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#1f6feb"/><stop offset=".55" stop-color="#7b61ff"/><stop offset="1" stop-color="#e86fbf"/></linearGradient></defs>` +
    tile('#fff', '#d0d5dc') +
    `<path fill="url(#pm-gem)" d="M12 3.5c.6 4.4 4 7.9 8.5 8.5-4.5.6-7.9 4.1-8.5 8.5-.6-4.4-4-7.9-8.5-8.5 4.5-.6 7.9-4.1 8.5-8.5z"/>`,
  // DeepSeek's whale, white on its blue.
  deepseek:
    tile('#4d6bfe') +
    `<path fill="#fff" d="M4.2 11.2c.4 3.9 3.6 6.7 7.6 6.7 2.5 0 4.6-1 6-2.7.8.6 1.8.8 2.6.5-.6-.4-.9-1.1-.8-1.8.5-.9.9-2 .9-3.1-1.1.7-2.3.9-3.5.6-1.6-.4-2.6-1.9-4.4-2.4-2.6-.7-5.4.4-6.8 2.6-.6-.3-1.1-.4-1.6-.4z"/>` +
    `<circle cx="9.4" cy="12.3" r=".9" fill="#4d6bfe"/>`,
  // Kimi's K with its blue dot, white on black.
  kimi:
    tile('#0b0b0f', '#3a3f4b') +
    `<path ${line('#fff', 2.2)} d="M8 6v12M15.2 6.5 9 12l6.4 5.5"/><circle cx="17" cy="6.6" r="1.7" fill="#2b7fff"/>`,
  // Mistral's blocky M in warm stripes, red at the bottom to yellow at the top.
  mistral:
    tile('#fff', '#d0d5dc') +
    [
      ['#ffd800', 'M5 5h3v2.8H5zM16 5h3v2.8h-3z'],
      ['#ffaf00', 'M5 7.8h6v2.8H5zM13 7.8h6v2.8h-6z'],
      ['#ff8205', 'M5 10.6h14v2.8H5z'],
      ['#fa500f', 'M5 13.4h3v2.8H5zM10.5 13.4h3v2.8h-3zM16 13.4h3v2.8h-3z'],
      ['#e10500', 'M3.5 16.2h6v2.8h-6zM14.5 16.2h6v2.8h-6z'],
    ]
      .map(([colour, d]) => `<path fill="${colour}" d="${d}"/>`)
      .join(''),
  // Meta's infinity loop, in its blue.
  meta:
    tile('#fff', '#d0d5dc') +
    `<path ${line('#0866ff', 2.3)} d="M12 12c-1.8-2.9-3.3-4.4-4.9-4.4-2 0-3.3 2.2-3.3 4.9 0 2.3 1 3.9 2.8 3.9 1.9 0 3.4-2.2 5.4-5.2 2-3 3.4-3.6 4.6-3.6 2.1 0 3.6 2.5 3.6 5 0 2.4-1.1 3.8-2.8 3.8-1.6 0-2.9-1.4-5.4-4.4z"/>`,
};

// Not a provider: the web search card's tile, a magnifier, so its header lines
// up with the provider cards.
MARKS.search =
  tile('#2f3a4a') +
  `<circle ${line('#fff', 2)} cx="10.5" cy="10.5" r="4.5"/><path ${line('#fff', 2.2)} d="M14 14l4 4"/>`;

/** Returns the inline SVG mark for a provider id (Ollama's for an unknown one). */
export function providerMark(provider, size = 18) {
  return (
    `<svg class="pmark" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    (MARKS[provider] || MARKS.ollama) +
    '</svg>'
  );
}
