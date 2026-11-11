/** Artifacts: standalone things the model makes for the user to keep, open,
 * copy or download, of five kinds: a Markdown document, an HTML page, an SVG
 * drawing, a Mermaid diagram or a code file (and, from a coding session's
 * arno, an image). Kept in the session's Durable Object storage, each version
 * whole:
 *
 *   artifact:<id>        {id, title, kind, language, mime, content, version,
 *                         createdAt, updatedAt, path,
 *                         versions: [{version, title, updatedAt}]}  older ones
 *   artifact-v:<id>:<n>  {version, title, kind, language, mime, content,
 *                         updatedAt, path}
 *   session.artifacts    {<id>: summary}  for the list and the gallery
 *
 * A chat's model makes, reads, revises and checks them with four tools
 * (ARTIFACT_TOOLS; check_artifact runs in ../chat/turn.mjs, through
 * render.mjs), and each turn's instructions list the conversation's
 * artifacts (artifactList), so later turns can find earlier ones; a
 * coding session's arno writes files that ../code/collect.mjs brings in
 * (putArtifact). HTML pages and Mermaid diagrams are shown by viewResponse,
 * sandboxed, on a page of their own; an HTML page reports its errors to the
 * viewer (REPORTER), which sends them back to be kept beside the artifact
 * (artifact-errors:<id>) for read_artifact and the log. Depends on ../http.mjs. Leaves out
 * public share links: artifacts stay inside the signed-in app.
 */
/** The kinds an artifact may be, and the file extension each downloads as. */
export const KINDS = { markdown: 'md', html: 'html', svg: 'svg', mermaid: 'mmd', code: 'txt' };
/** Longest artifact, in characters; an image's, in base64. */
const MAX_CONTENT = 200000,
  MAX_IMAGE = 1400000;
/** Most steps a check_artifact call may take (render.mjs). */
export const MAX_STEPS = 12;
/** Artifacts one conversation may hold. */
const MAX_ARTIFACTS = 100;
/** Earlier versions kept per artifact. */
const KEEP_VERSIONS = 20;
/** Most characters of content read_artifact gives back. */
const MAX_READ = 60000;
/** Artifacts a turn's instructions list, the latest first. */
const MAX_LISTED = 30;
/** Characters of text a summary previews. */
const PREVIEW = 240;
/** Mermaid, loaded from its CDN by a diagram's page. */
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

/** Text added to the system prompt telling the model when and how to use the artifact tools. */
export const ARTIFACT_INSTRUCTIONS = `Artifacts are standalone things the user may keep, open full screen, copy or download. Make one for substantial content (over ~15 lines), anything visual or interactive, or when asked; keep the chat reply short and name the artifact by title. Update an existing one rather than make a near-duplicate, and keep related artifacts consistent (notes must describe the current page).
Kinds (the content must match the kind; update_artifact with kind converts): markdown (documents, plans, tables), html (one self-contained page, inline CSS and JS), svg, mermaid (source only, no fence), code (give language).
HTML pages:
- Scripts load only from cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com (inline is fine); styles also from Google Fonts.
- Images: data:, blob: or any https URL. Audio/video: data: or blob: only.
- No fetch, XHR or WebSocket, no form submits, no storage or cookies (localStorage throws), no relative paths: put data in the page.
- At most 200,000 characters. Shown in an iframe, often on a phone (~390px wide): design phone-first, use pointer events, nothing hover-only.
- Chart.js: <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>.
- three.js: a module with the import map {"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}; build geometry in code; TextureLoader takes https images, fetch-based loaders fail.
Rules:
- Never say a change is done, live or under way unless you made it with a tool in this turn; if you could not, say so.
- Writing an html artifact checks it in a phone-sized browser: read the check result and fix what it reports before you reply. check_artifact checks again, e.g. after layout changes. To see another state (a slider position, a tab, after a tap), use check_artifact with steps; never change the page's defaults or initial state just to test it.
- On a reported error, read_artifact and fix the actual cause, located by pageErrors and the check's line numbers (often a syntax slip). Never blame the sandbox, network or CDN without evidence.
- Factual content: research it first when you have web tools, and cite in the reply. Images: only URLs from find_image or web results, never from memory; give each image an onerror fallback. Never claim a check you did not run.
- Simulations and visualisations: first decide the model (equations, what is drawn, boundary conditions; an airfoil is a solid obstacle, drawn and enforced in the solver). Make every requested element visible. Correct and clear beats more particles; tune one thing at a time.
- Change with edits, not rewrites. A reply stops after ~3 minutes, so build a large page as a working skeleton, then add sections with append or edits.`;

/** The tool definitions offered to the model (name, description, JSON schema). */
export const ARTIFACT_TOOLS = [
  {
    name: 'create_artifact',
    description:
      'Create an artifact the user sees as a card they can open beside the chat, copy and download: a markdown document, an html page, an svg drawing, a mermaid diagram or a code file.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, up to 80 characters' },
        kind: { type: 'string', enum: Object.keys(KINDS) },
        language: {
          type: 'string',
          description: 'For kind code: the language, such as python, sql or typescript',
        },
        content: { type: 'string', description: 'The whole content' },
      },
      required: ['title', 'kind', 'content'],
    },
  },
  {
    name: 'read_artifact',
    description:
      'Read an artifact of this conversation: its title, kind, version and whole content. Read one before editing it, so the edits find their text.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The artifact id, from the list' } },
      required: ['id'],
    },
  },
  {
    name: 'update_artifact',
    description:
      'Make a new version of an artifact from earlier in this conversation. Send exactly one of: content (the whole new content), edits (each replaces text occurring exactly once) or append (text added at the end, to build a large page in parts). An html page is then opened in a browser at phone size and the result says what failed (check).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The artifact id create_artifact returned' },
        title: { type: 'string' },
        kind: { type: 'string', enum: Object.keys(KINDS), description: 'Only to change its kind' },
        content: { type: 'string', description: 'The whole new content' },
        edits: {
          type: 'array',
          description: 'Instead of content: replacements, applied in order',
          items: {
            type: 'object',
            properties: { find: { type: 'string' }, replace: { type: 'string' } },
            required: ['find', 'replace'],
          },
        },
        append: {
          type: 'string',
          description: 'Instead of content or edits: text added to the end of the current content',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'check_artifact',
    description:
      'Open an html or svg artifact in a browser at phone size (390×844), as the user sees it, and report its script errors and the images, scripts or styles that failed to load. Optional steps run in order once the page settles, before the screenshot, to see another state without changing the page; a step that fails is reported in stepErrors (step is its index) and the rest still run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The artifact id, from the list' },
        steps: {
          type: 'array',
          maxItems: MAX_STEPS,
          description:
            'Each one of: {set: css selector, value: string} (sets an input, select, textarea or range slider and sends input and change), {click: selector}, {tap: [x, y]}, {drag: [x1, y1, x2, y2]}, {key: name, e.g. "ArrowRight"}, {wait: ms, at most 3000}, {scroll: y}. Coordinates are CSS pixels in the viewport.',
          items: { type: 'object' },
        },
      },
      required: ['id'],
    },
  },
];

/** What the list, the cards and the gallery show of an artifact: no content,
 * a line of its text. */
export function summary(a) {
  const text =
    a.kind === 'image' || a.kind === 'svg'
      ? ''
      : a.kind === 'html'
        ? String(a.content)
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<[^>]*>/g, ' ')
        : String(a.content).replace(/[#*_`>|-]+/g, ' ');
  return {
    id: a.id,
    title: a.title,
    kind: a.kind,
    language: a.language || '',
    version: a.version,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    preview: text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW),
  };
}
/** The artifact id. One made before versions had keys of their own has its
 * earlier versions ('previous') moved out to them first. */
async function load(storage, id) {
  const a = await storage.get('artifact:' + id);
  if (!a || !a.previous) return a;
  const { previous, ...rest } = a;
  for (const p of previous)
    await storage.put('artifact-v:' + id + ':' + p.version, { kind: 'markdown', ...p });
  const moved = {
    kind: 'markdown',
    ...rest,
    versions: previous.map(({ version, title, updatedAt }) => ({ version, title, updatedAt })),
  };
  await storage.put('artifact:' + id, moved);
  return moved;
}
/** Stores next as the artifact's newest version, keeping old (if any) as an
 * earlier one and dropping those beyond KEEP_VERSIONS; updates the session's
 * summaries. */
async function save(storage, old, next) {
  if (old) {
    // The version as it was, less what belongs to the artifact as a whole.
    const kept = { ...old };
    for (const k of ['id', 'createdAt', 'versions']) delete kept[k];
    await storage.put('artifact-v:' + old.id + ':' + old.version, kept);
    next.versions = [
      { version: old.version, title: old.title, updatedAt: old.updatedAt },
      ...(old.versions || []),
    ];
    for (const v of next.versions.splice(KEEP_VERSIONS))
      await storage.delete('artifact-v:' + old.id + ':' + v.version);
  } else next.versions = [];
  await storage.put('artifact:' + next.id, next);
  const session = await storage.get('session');
  if (session) {
    session.artifacts = { ...(session.artifacts || {}), [next.id]: summary(next) };
    await storage.put('session', session);
  }
  return next;
}
/** Checks content is something an artifact of kind may hold. */
function checkContent(content, kind) {
  const most = kind === 'image' ? MAX_IMAGE : MAX_CONTENT;
  if (typeof content !== 'string' || !content.trim()) throw Error('Artifact content is empty');
  if (content.length > most) throw Error('Artifacts are limited to ' + most + ' characters');
}
/** Whether a tool sent content with something in it. */
const filled = content => typeof content === 'string' && !!content.trim();
/** The kind to keep content as: a whole HTML page sent as markdown or code,
 * as models sometimes do, is kept as the page it is. */
export function kindFor(kind, content) {
  const page = /^\s*<(!doctype html|html)[\s>]/i.test(content);
  return page && (kind === 'markdown' || kind === 'code') ? 'html' : kind;
}
/** content with each edit's find, which must occur exactly once, replaced. */
export function applyEdits(content, edits) {
  for (const { find, replace } of edits) {
    if (typeof find !== 'string' || !find.trim() || typeof replace !== 'string')
      throw Error('Each edit needs find and replace');
    const [at, length] = locate(content, find);
    content = content.slice(0, at) + replace + content.slice(at + length);
  }
  return content;
}
/** Where an edit's text is, as [start, length]: exactly, or else with its
 * whitespace (indentation, line breaks) matched loosely, as models often
 * misremember it. Either way it must occur once. */
function locate(content, find) {
  const fail = why => Error('Edit not applied, text ' + why + ': ' + find.trim().slice(0, 80));
  const at = content.indexOf(find);
  if (at >= 0) {
    if (content.indexOf(find, at + 1) >= 0) throw fail('occurs more than once');
    return [at, find.length];
  }
  const words = find
    .trim()
    .split(/\s+/)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const found = [...content.matchAll(new RegExp(words.join('\\s+'), 'g'))];
  if (found.length === 1) return [found[0].index, found[0][0].length];
  throw fail(
    found.length ? 'occurs more than once' : 'not found (read_artifact gives the current text)',
  );
}

/** Makes or replaces an artifact from fields {title, kind, language, mime,
 * content, path}: a new one when id is absent. Returns it. */
export async function putArtifact(storage, id, fields) {
  const now = Date.now(),
    old = id ? await load(storage, id) : null;
  if (id && !old) throw Error('No artifact with that id in this conversation');
  checkContent(fields.content, fields.kind || old?.kind);
  if (!old && (await storage.list({ prefix: 'artifact:' })).size >= MAX_ARTIFACTS)
    throw Error('This conversation has reached its artifact limit');
  return save(storage, old, {
    ...(old || { id: crypto.randomUUID(), createdAt: now }),
    ...fields,
    version: old ? old.version + 1 : 1,
    updatedAt: now,
  });
}
/** Run an artifact tool; returns what the model sees, and adds the touched
 * artifact's summary to touched. */
export async function artifactTool(storage, name, args, touched) {
  const title = typeof args.title === 'string' ? args.title.trim().slice(0, 80) : '';
  let artifact;
  if (name === 'read_artifact') {
    const a = await findArtifact(storage, args.id);
    if (a.kind === 'image')
      if (a.kind === 'image')
        return { id: a.id, title: a.title, kind: a.kind, content: '(an image)' };
    const content = String(a.content),
      seen = await storage.get('artifact-errors:' + a.id);
    return {
      id: a.id,
      title: a.title,
      kind: a.kind,
      version: a.version,
      content: content.slice(0, MAX_READ),
      ...(content.length > MAX_READ ? { truncated: content.length + ' characters in all' } : {}),
      ...(seen?.version === a.version ? { pageErrors: seen.errors } : {}),
    };
  }
  if (name === 'create_artifact') {
    if (!title) throw Error('Give the artifact a title');
    if (!filled(args.content)) throw Error('Send create_artifact the whole content in content');
    const kind = kindFor(KINDS[args.kind] ? args.kind : 'markdown', args.content);
    artifact = await putArtifact(storage, null, {
      title,
      kind,
      language: kind === 'code' ? String(args.language || '').slice(0, 30) : '',
      content: args.content,
    });
  } else {
    const old = await findArtifact(storage, args.id);
    if (args.kind !== undefined && !KINDS[args.kind])
      throw Error('kind must be one of ' + Object.keys(KINDS).join(', '));
    const content = Array.isArray(args.edits)
      ? applyEdits(old.content, args.edits)
      : typeof args.append === 'string' && args.append
        ? old.content + args.append
        : args.content;
    if (!filled(content))
      throw Error(
        'Send update_artifact one of: content (the whole new content), edits (find and replace pairs) or append (text added at the end)',
      );
    artifact = await putArtifact(storage, old.id, {
      title: title || old.title,
      kind: kindFor(args.kind || old.kind, content),
      content,
    });
  }
  const card = summary(artifact),
    i = touched.findIndex(t => t.id === card.id);
  if (i < 0) touched.push(card);
  else touched[i] = card;
  return { id: artifact.id, title: artifact.title, kind: artifact.kind, version: artifact.version };
}

/** The artifact a tool call names, by id or, as models sometimes send, by its
 * title; when none matches, the error lists the ones there are. */
export async function findArtifact(storage, ref) {
  const key = String(ref || '').trim();
  const byId = key && (await load(storage, key));
  if (byId) return byId;
  const list = await listArtifacts(storage),
    named = list.findLast(a => a.title.toLowerCase() === key.toLowerCase());
  if (named) return load(storage, named.id);
  throw Error(
    list.length
      ? 'No artifact ' + JSON.stringify(key) + ' in this conversation. ' + artifactList(list)
      : 'This conversation has no artifacts yet.',
  );
}
/** The line a turn's instructions give the conversation's artifacts (summaries,
 * oldest first): the latest MAX_LISTED, with their ids; '' when there are none. */
export function artifactList(list) {
  if (!list.length) return '';
  const shown = list.slice(-MAX_LISTED).reverse();
  return (
    'Artifacts in this conversation, latest first (read_artifact shows one; update_artifact revises it): ' +
    shown.map(a => a.id + ' "' + a.title + '" (' + a.kind + ', v' + a.version + ')').join('; ') +
    (list.length > shown.length ? '; and ' + (list.length - shown.length) + ' older.' : '.')
  );
}
/** All artifacts of a session, as summaries, oldest first. */
export async function listArtifacts(storage) {
  const session = await storage.get('session');
  let list = Object.values(session?.artifacts || {});
  // Artifacts from before the summaries were kept: read once, then kept.
  const keys = await storage.list({ prefix: 'artifact:' });
  if (keys.size !== list.length || !session?.artifacts) {
    list = [];
    for (const id of keys.keys()) list.push(summary(await load(storage, id.slice(9))));
    if (session) {
      session.artifacts = Object.fromEntries(list.map(a => [a.id, a]));
      await storage.put('session', session);
    }
  }
  return list.sort((a, b) => a.createdAt - b.createdAt);
}
/** One version of artifact id (the newest when version is absent) with the
 * list of all its versions, newest first; null when there is no such. */
export async function getArtifact(storage, id, version) {
  const a = await load(storage, id);
  if (!a) return null;
  const versions = [
      { version: a.version, title: a.title, updatedAt: a.updatedAt },
      ...(a.versions || []),
    ],
    v = Number(version);
  const shown = !v || v === a.version ? a : await storage.get('artifact-v:' + id + ':' + v);
  if (!shown) return null;
  return {
    id,
    createdAt: a.createdAt,
    path: a.path || '',
    kind: a.kind,
    language: a.language || '',
    ...shown,
    latest: a.version,
    versions,
  };
}
/** Makes version of artifact id its newest, as a new version. */
export async function restoreArtifact(storage, id, version) {
  const v = await getArtifact(storage, id, version);
  if (!v) throw Error('No such version');
  return putArtifact(storage, id, { title: v.title, content: v.content });
}

/** The policy an artifact's page runs under: a sandbox (an origin of its
 * own, so no cookies, storage or app API), scripts from the three CDNs, no
 * network, framed only by the app. */
export const PAGE_POLICY = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-forms',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://fonts.googleapis.com",
  'font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com',
  'img-src data: blob: https:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');
/** Errors a page keeps of what it showed, and the characters of each. */
const MAX_ERRORS = 20,
  ERROR_LENGTH = 300;
/** Put at the top of an HTML page: tells the viewer (its parent) of the
 * page's errors: uncaught ones, failed loads, rejected promises, console.error
 * and what the page policy blocked. One line, so line numbers stay the page's. */
const REPORTER =
  '<script>(()=>{const s=new Set(),r=m=>{m=String(m).slice(0,' +
  ERROR_LENGTH +
  ');if(s.has(m)||s.size>=' +
  MAX_ERRORS +
  ")return;s.add(m);parent.postMessage({arnoPageError:m},'*')};" +
  "addEventListener('error',e=>r(e.message?e.message+(e.lineno?' (line '+e.lineno+')':''):'Could not load '+(e.target.src||e.target.href||e.target.tagName)),true);" +
  "addEventListener('unhandledrejection',e=>r('Unhandled: '+(e.reason&&e.reason.message||e.reason)));" +
  "document.addEventListener('securitypolicyviolation',e=>r('Blocked by the page policy: '+e.blockedURI+' ('+e.effectiveDirective+')'));" +
  "const c=console.error;console.error=(...a)=>{r(a.map(String).join(' '));c.apply(console,a)}})()</script>";
/** An HTML page with REPORTER first in it: after <head>, else after the
 * doctype (before it would put the page in quirks mode), else at the top. */
export function withReporter(html) {
  const at = /<head[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
  return at
    ? html.slice(0, at.index + at[0].length) + REPORTER + html.slice(at.index + at[0].length)
    : REPORTER + html;
}
/** Keeps the errors a version of an artifact showed when opened, the latest
 * report replacing the one before; [] clears them. Returns what was kept. */
export async function notePageErrors(storage, id, version, errors) {
  const a = await load(storage, String(id));
  if (!a) throw Error('No artifact with that id in this conversation');
  const kept = {
    version: Number(version) || a.version,
    errors: (Array.isArray(errors) ? errors : [])
      .slice(0, MAX_ERRORS)
      .map(e => String(e).slice(0, ERROR_LENGTH)),
    at: Date.now(),
  };
  if (kept.errors.length) await storage.put('artifact-errors:' + a.id, kept);
  else await storage.delete('artifact-errors:' + a.id);
  return { ...kept, title: a.title, kind: a.kind };
}
/** Escapes text for HTML. */
const escape = s =>
  String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** A Mermaid diagram's page: its source, drawn by Mermaid in theme. */
function mermaidPage(source, dark) {
  return (
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html,body{margin:0;background:' +
    (dark ? '#0f1720' : '#fff') +
    '}body{display:flex;justify-content:center;padding:20px}pre{margin:0}svg{max-width:100%;height:auto}' +
    '.err{font:13px system-ui;color:#c33;white-space:pre-wrap}</style>' +
    '<pre class="mermaid">' +
    escape(source) +
    '</pre><script type="module">import m from "' +
    MERMAID +
    '";m.initialize({startOnLoad:false,securityLevel:"strict",theme:"' +
    (dark ? 'dark' : 'default') +
    '"});m.run().catch(e=>{document.body.innerHTML="<p class=err></p>";document.querySelector(".err").textContent="This diagram could not be drawn: "+e.message})</script>'
  );
}
/** The response that shows version v of an artifact on a page of its own:
 * an HTML page or Mermaid diagram sandboxed under PAGE_POLICY, an SVG or an
 * image as itself; null for kinds the app draws (Markdown, code). pinned:
 * the version was asked for by number. */
export function viewResponse(v, dark, pinned) {
  const headers = {
    'Content-Security-Policy': PAGE_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // A version never changes: asked for by number, it may be kept.
    'Cache-Control': pinned ? 'private, max-age=31536000, immutable' : 'no-store',
  };
  if (v.kind === 'html')
    return new Response(withReporter(v.content), {
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
    });
  if (v.kind === 'mermaid')
    return new Response(mermaidPage(v.content, dark), {
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
    });
  if (v.kind === 'svg')
    return new Response(v.content, {
      headers: {
        ...headers,
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        'Content-Type': 'image/svg+xml; charset=utf-8',
      },
    });
  if (v.kind === 'image')
    return new Response(
      Uint8Array.from(atob(v.content), c => c.charCodeAt(0)),
      {
        headers: {
          ...headers,
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Type': v.mime || 'image/png',
        },
      },
    );
  return null;
}
