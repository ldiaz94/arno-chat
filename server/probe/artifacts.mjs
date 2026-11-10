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
 * A chat's model makes and revises them with two tools (ARTIFACT_TOOLS); a
 * coding session's arno writes files that ../code/collect.mjs brings in
 * (putArtifact). HTML pages and Mermaid diagrams are shown by viewResponse,
 * sandboxed, on a page of their own. Depends on ../http.mjs. Leaves out
 * public share links: artifacts stay inside the signed-in app.
 */
/** The kinds an artifact may be, and the file extension each downloads as. */
export const KINDS = { markdown: 'md', html: 'html', svg: 'svg', mermaid: 'mmd', code: 'txt' };
/** Longest artifact, in characters; an image's, in base64. */
const MAX_CONTENT = 200000,
  MAX_IMAGE = 1400000;
/** Artifacts one conversation may hold. */
const MAX_ARTIFACTS = 100;
/** Earlier versions kept per artifact. */
const KEEP_VERSIONS = 20;
/** Characters of text a summary previews. */
const PREVIEW = 240;
/** Mermaid, loaded from its CDN by a diagram's page. */
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

/** Text added to the system prompt telling the model when and how to use the artifact tools. */
export const ARTIFACT_INSTRUCTIONS =
  'You can make artifacts with create_artifact and revise them with update_artifact: standalone things the user may want to keep, open full screen, copy or download. Kinds: markdown (documents, plans, lists, tables, itineraries, specs), html (an interactive page, mini-app, game, calculator or chart: one self-contained file with inline CSS and JS; scripts may load from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com, but the page has no network otherwise, so put its data in the page), svg (a drawing, icon or illustration), mermaid (a flowchart, sequence, class, state, gantt or ER diagram; the source only, no fence) and code (a source file; give its language). Use one for substantial content (roughly more than 15 lines), anything visual or interactive, or when asked; keep the chat reply short and refer to the artifact by title. Update an existing artifact rather than making a near-duplicate; for a small change, send edits instead of the whole content.';

/** The two tool definitions offered to the model (name, description, JSON schema). */
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
    name: 'update_artifact',
    description:
      'Make a new version of an artifact from earlier in this conversation: either the whole new content, or edits that each replace text occurring exactly once.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The artifact id create_artifact returned' },
        title: { type: 'string' },
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
/** content with each edit's find, which must occur exactly once, replaced. */
export function applyEdits(content, edits) {
  for (const { find, replace } of edits) {
    if (typeof find !== 'string' || !find || typeof replace !== 'string')
      throw Error('Each edit needs find and replace');
    const at = content.indexOf(find);
    if (at < 0) throw Error('Edit not applied, text not found: ' + find.slice(0, 80));
    if (content.indexOf(find, at + 1) >= 0)
      throw Error('Edit not applied, text occurs more than once: ' + find.slice(0, 80));
    content = content.slice(0, at) + replace + content.slice(at + find.length);
  }
  return content;
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
  if (name === 'create_artifact') {
    if (!title) throw Error('Give the artifact a title');
    const kind = KINDS[args.kind] ? args.kind : 'markdown';
    artifact = await putArtifact(storage, null, {
      title,
      kind,
      language: kind === 'code' ? String(args.language || '').slice(0, 30) : '',
      content: args.content,
    });
  } else {
    const old = await load(storage, String(args.id || ''));
    if (!old) throw Error('No artifact with that id in this conversation');
    const content = Array.isArray(args.edits) ? applyEdits(old.content, args.edits) : args.content;
    artifact = await putArtifact(storage, old.id, { title: title || old.title, content });
  }
  const card = summary(artifact),
    i = touched.findIndex(t => t.id === card.id);
  if (i < 0) touched.push(card);
  else touched[i] = card;
  return { id: artifact.id, title: artifact.title, kind: artifact.kind, version: artifact.version };
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
const PAGE_POLICY = [
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
    return new Response(v.content, {
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
