/** The home page's arithmetic, with no DOM so test/test.mjs runs it in Node: the
 * greeting's part of the day, the pick of the day from a list, the moon's
 * phase, the WMO weather codes, and the session list's order and "2m ago"
 * times. Depends on nothing.
 */

/** "morning", "afternoon" or "evening" for a local hour; null late at night. */
export function partOfDay(hour) {
  return hour < 5 ? null : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

/** The local calendar day as a whole number, the same all day long. */
export function dayNumber(date) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

/** The item of the day: the same one all day, the next one tomorrow; `skip`
 * steps past it ("another"). The step 7 is coprime to every list length that
 * is not a multiple of 7, so a year's days don't fall into a short cycle. */
export function daily(list, date, skip = 0) {
  const n = list.length,
    i = (((dayNumber(date) * 7 + skip) % n) + n) % n;
  return list[i];
}

const SYNODIC = 29.530588853; // days from one new moon to the next, on average
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // a known new moon (2000-01-06 18:14 UTC)
// The moon's eight phase names, from new moon round to new moon.
const PHASES = [
  'New moon',
  'Waxing crescent',
  'First quarter',
  'Waxing gibbous',
  'Full moon',
  'Waning gibbous',
  'Last quarter',
  'Waning crescent',
];

/** The moon at a moment, from the mean synodic month (good to about half a
 * day): `phase` runs 0 (new) → 0.5 (full) → 1, `lit` is the lit fraction of
 * the disc, `toFull` the days to the next full moon. */
export function moon(date) {
  const age = (date.getTime() - NEW_MOON) / 86400000,
    phase = (((age / SYNODIC) % 1) + 1) % 1;
  return {
    phase,
    name: PHASES[Math.round(phase * 8) % 8],
    lit: (1 - Math.cos(2 * Math.PI * phase)) / 2,
    toFull: ((((0.5 - phase) % 1) + 1) % 1) * SYNODIC,
  };
}

/** An SVG path of the moon's lit part on a disc of radius r centred at (r, r):
 * the bright limb's half circle closed by the terminator, a half ellipse. */
export function moonPath(phase, r) {
  const waxing = phase < 0.5,
    x = r * Math.cos(2 * Math.PI * phase), // terminator half-width, signed
    rx = Math.abs(x).toFixed(2),
    limb = waxing ? 1 : 0, // the lit limb: right while waxing, left while waning
    bulge = x < 0 === waxing ? 1 : 0; // which way the terminator bows
  return (
    'M' +
    r +
    ' 0A' +
    r +
    ' ' +
    r +
    ' 0 0 ' +
    limb +
    ' ' +
    r +
    ' ' +
    2 * r +
    'A' +
    rx +
    ' ' +
    r +
    ' 0 0 ' +
    bulge +
    ' ' +
    r +
    ' 0Z'
  );
}

/** WMO weather interpretation codes (as Open-Meteo reports them): a symbol
 * and a few words. */
export function weatherText(code) {
  const table = [
    [[0], '☀', 'Clear sky'],
    [[1], '🌤', 'Mainly clear'],
    [[2], '⛅', 'Partly cloudy'],
    [[3], '☁', 'Overcast'],
    [[45, 48], '🌫', 'Fog'],
    [[51, 53, 55], '🌦', 'Drizzle'],
    [[56, 57], '🌧', 'Freezing drizzle'],
    [[61, 63, 65], '🌧', 'Rain'],
    [[66, 67], '🌧', 'Freezing rain'],
    [[71, 73, 75, 77], '❄', 'Snow'],
    [[80, 81, 82], '🌦', 'Rain showers'],
    [[85, 86], '🌨', 'Snow showers'],
    [[95], '⛈', 'Thunderstorm'],
    [[96, 99], '⛈', 'Thunderstorm with hail'],
  ];
  const row = table.find(([codes]) => codes.includes(code));
  return row ? { icon: row[1], text: row[2] } : { icon: '·', text: 'Unknown' };
}

/** When a conversation was last active: its last turn, else its creation. */
export const activeAt = s => s.updatedAt || s.createdAt || 0;

/** Conversations, most recently active first. */
export function byRecent(list) {
  return [...list].sort((a, b) => activeAt(b) - activeAt(a));
}

/** A short relative time: "now", "5m", "3h", "Yesterday", "Tue", "Mar 4". */
export function ago(ms, now = Date.now()) {
  if (!ms) return '';
  const minutes = Math.floor((now - ms) / 60000),
    days = dayNumber(new Date(now)) - dayNumber(new Date(ms));
  if (minutes < 1) return 'now';
  if (minutes < 60) return minutes + 'm';
  if (days < 1) return Math.floor(minutes / 60) + 'h';
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
