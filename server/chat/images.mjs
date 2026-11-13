/** Images for artifacts: the find_image tool, which searches Wikimedia
 * Commons for freely licensed pictures a page can show, so the model links
 * real images rather than guessing addresses that turn out dead.
 *
 *   query ─► Commons API (files, with their web-sized URL and licence)
 *         ─► [{title, url, width, height, description, license, artist}]
 *
 * Commons asks every client to name itself (USER_AGENT). Depends on nothing
 * else in the app. Leaves out other image sources and checking that a found
 * image suits the page: the model judges from the description. */

/** The tool offered to the model, in the shape MCP lists them. */
export const IMAGE_TOOLS = [
  {
    name: 'find_image',
    description:
      'Find freely licensed photos and drawings on Wikimedia Commons for an artifact. Returns direct image URLs (up to 1280 px wide) with a description, licence and author. Use these URLs in pages instead of guessing image addresses, and credit the author and licence near the image.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the picture shows, in a few words' },
      },
      required: ['query'],
    },
  },
];
/** Commons' search of files, each with its URL, size, type and licence, and a
 * copy scaled to at most 1280 px wide. */
const API =
  'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1280&gsrsearch=';
/** Who is asking, as Wikimedia's policy wants it said. */
const USER_AGENT = 'ArnoChat/1.0 (+https://github.com/ldiaz94/arno-chat)';
/** File types a page can show as an image. */
const IMAGE_MIME = /^image\/(jpeg|png|gif|webp|svg\+xml)$/;
/** Most images returned, and characters of a description. */
const MAX_IMAGES = 8,
  DESCRIPTION = 200;

/** Up to MAX_IMAGES freely licensed images on Commons for query, best match
 * first. upstream stands in for fetch in tests. */
export async function findImage(query, { upstream = fetch } = {}) {
  const q = String(query || '')
    .trim()
    .slice(0, 200);
  if (!q) throw Error('Say what the image should show');
  const response = await upstream(API + encodeURIComponent(q), {
    headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error('Wikimedia Commons could not search (' + response.status + ')');
  const pages = Object.values((await response.json()).query?.pages || {});
  return pages
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(p => ({ title: p.title, info: p.imageinfo?.[0] }))
    .filter(({ info }) => info && IMAGE_MIME.test(info.mime))
    .slice(0, MAX_IMAGES)
    .map(({ title, info }) => {
      const meta = info.extmetadata || {};
      return {
        title: String(title).replace(/^File:/, ''),
        url: info.thumburl || info.url,
        width: info.thumburl ? info.thumbwidth : info.width,
        height: info.thumburl ? info.thumbheight : info.height,
        description: plain(meta.ImageDescription?.value).slice(0, DESCRIPTION),
        license: plain(meta.LicenseShortName?.value),
        artist: plain(meta.Artist?.value),
      };
    });
}
/** Commons' HTML metadata as plain text. */
function plain(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => entities[e])
    .replace(/\s+/g, ' ')
    .trim();
}
