/** The home pages' shared parts: the greeting and the "today" card with its
 * widgets (quote, fact, moon, weather), each switched on or off in Settings →
 * You → Home page (the profile's `home`). Everything but the weather is worked
 * out on the device; the forecast comes from Open-Meteo, fetched by the browser
 * and kept in localStorage, so offline the last one shows with its time.
 * Depends on core, today.mjs and home-content.js.
 */
import { $, state, esc } from './core.js';
import { partOfDay, daily, moon, moonPath, weatherText } from './today.mjs';
import { QUOTES, FACTS } from './home-content.js';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_KEY = 'weather'; // localStorage: the last forecast, {key, at, place, temp, …}
const FRESH_MS = 30 * 60 * 1000; // a kept forecast younger than this is not fetched again
/** The profile's home settings, with the defaults for what is missing. */
export const homePrefs = () => ({
  quote: true,
  fact: true,
  moon: true,
  weather: false,
  place: '',
  ...state.profile.home,
});
const skips = { quote: 0, fact: 0 }; // how many times "another" was pressed today
/** The greeting by the mascot: "Good evening, <login>", with a line below. */
export function greeting(eyebrow, line) {
  const name = esc(state.profile?.name || state.user?.login || 'there'),
    part = partOfDay(new Date().getHours());
  return (
    '<div class="welcome"><div class="eyebrow">' +
    eyebrow +
    '</div><h1>' +
    (part ? 'Good ' + part + ', ' + name : 'Still up, ' + name + '?') +
    '</h1><p>' +
    line +
    '</p></div>'
  );
}
function quoteTile() {
  const [text, author] = daily(QUOTES, new Date(), skips.quote);
  return (
    '<blockquote>“' +
    esc(text) +
    '”</blockquote>' +
    (author ? '<cite>— ' + esc(author) + '</cite>' : '')
  );
}
function factTile() {
  return '<p>' + esc(daily(FACTS, new Date(), skips.fact)) + '</p>';
}
function moonTile() {
  const m = moon(new Date()),
    days = Math.round(m.toFull);
  return (
    '<svg class="moon" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20"/><path d="' +
    moonPath(m.phase, 20) +
    '"/></svg><div><strong>' +
    m.name +
    '</strong><small>' +
    Math.round(m.lit * 100) +
    '% lit · ' +
    (days < 1 ? 'full tonight' : 'full in ' + days + (days === 1 ? ' day' : ' days')) +
    '</small></div>'
  );
}
const tile = (kind, label, body, another) =>
  '<div class="today-tile today-' +
  kind +
  '"><div class="today-label"><span>' +
  label +
  '</span>' +
  (another
    ? '<button type="button" class="link" data-another="' + kind + '">Another</button>'
    : '') +
  '</div><div class="today-body" data-today="' +
  kind +
  '">' +
  body +
  '</div></div>';
/** The today card's markup, or '' with every widget off; `compact` for the
 * coding home. Call wireToday() once it is in the page. */
export function todayCard(compact) {
  const h = homePrefs(),
    tiles = [
      h.moon && tile('moon', 'Moon', moonTile()),
      h.weather && tile('weather', 'Weather', weatherBody(kept())),
      h.quote && tile('quote', 'Quote of the day', quoteTile(), true),
      h.fact && tile('fact', 'Did you know?', factTile(), true),
    ].filter(Boolean);
  if (!tiles.length) return '';
  return (
    '<section class="today' +
    (compact ? ' compact' : '') +
    '" aria-label="Today"><div class="today-head"><span class="eyebrow">Today</span><span class="caption">' +
    new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) +
    '</span></div><div class="today-grid">' +
    tiles.join('') +
    '</div></section>'
  );
}
export function wireToday() {
  for (const b of document.querySelectorAll('[data-another]'))
    b.onclick = () => {
      const kind = b.dataset.another;
      skips[kind]++;
      $('[data-today="' + kind + '"]').innerHTML = kind === 'quote' ? quoteTile() : factTile();
    };
  if ($('[data-today="weather"]')) refreshWeather();
}
/** What the forecast is for: rounded coordinates, else the typed place. */
function where() {
  const h = homePrefs();
  return h.lat != null ? h.lat + ',' + h.lon : h.place.trim().toLowerCase();
}
/** The kept forecast, if it is for the current place. */
function kept() {
  try {
    const w = JSON.parse(localStorage.getItem(WEATHER_KEY));
    return w?.key === where() ? w : null;
  } catch {
    return null;
  }
}
function weatherBody(w) {
  if (!where()) return '<small>Choose a place in Settings › You › Home page.</small>';
  if (!w) return '<small>Loading the forecast…</small>';
  const { icon, text } = weatherText(w.code),
    deg = n => Math.round(n) + '°';
  return (
    '<span class="weather-icon" aria-hidden="true">' +
    icon +
    '</span><div><strong>' +
    deg(w.temp) +
    ' · ' +
    text +
    '</strong><small>H ' +
    deg(w.hi) +
    ' L ' +
    deg(w.lo) +
    (w.place ? ' · ' + esc(w.place) : '') +
    (Date.now() - w.at > FRESH_MS
      ? ' · as of ' + new Date(w.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '') +
    '</small></div>'
  );
}
/** A place name's coordinates and display name, from Open-Meteo's geocoder. */
export async function geocode(name) {
  const r = await fetch(GEOCODE + '?count=1&name=' + encodeURIComponent(name), {
      signal: AbortSignal.timeout(8000),
    }),
    hit = r.ok && (await r.json()).results?.[0];
  if (!hit) throw Error('Place not found');
  return { lat: hit.latitude, lon: hit.longitude, place: hit.name };
}
/** Fetches the forecast unless the kept one is fresh, then shows it. */
async function refreshWeather() {
  const w = kept(),
    unavailable = () => {
      const node = $('[data-today="weather"]');
      if (node && !w) node.innerHTML = '<small>Forecast unavailable right now.</small>';
    };
  if (!where() || (w && Date.now() - w.at < FRESH_MS)) return;
  if (state.offline) return unavailable();
  try {
    const h = homePrefs(),
      at = h.lat != null ? { lat: h.lat, lon: h.lon, place: '' } : await geocode(h.place),
      r = await fetch(
        FORECAST +
          '?latitude=' +
          at.lat +
          '&longitude=' +
          at.lon +
          '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1',
        { signal: AbortSignal.timeout(8000) },
      ),
      d = await r.json();
    const fresh = {
      key: where(),
      at: Date.now(),
      place: at.place,
      temp: d.current.temperature_2m,
      code: d.current.weather_code,
      hi: d.daily.temperature_2m_max[0],
      lo: d.daily.temperature_2m_min[0],
    };
    localStorage.setItem(WEATHER_KEY, JSON.stringify(fresh));
    const node = $('[data-today="weather"]');
    if (node) node.innerHTML = weatherBody(fresh);
  } catch {
    unavailable();
  }
}
