/** Artifacts: standalone content the model makes for the user to keep, copy
 * or download (lists, tables, plans, documents), written in Markdown and kept
 * in the session's Durable Object storage:
 *
 *   artifact:<id>   {id, title, content, version, createdAt, updatedAt,
 *                    previous: [{version, title, content, updatedAt}]}
 *
 * The model creates and revises them with two tools; each turn records which
 * artifacts it touched. Left out: public share links (artifacts stay inside
 * the signed-in app), and kinds other than Markdown. Depends on no other app
 * module; session-routes.mjs lists them and the chat turn runs the tools.
 */
/** Longest artifact, in characters. */
const MAX_CONTENT = 100000;
/** Artifacts one conversation may hold. */
const MAX_ARTIFACTS = 50;
/** Earlier versions kept per artifact. */
const KEEP_VERSIONS = 10;

/** Text added to the system prompt telling the model when and how to use the artifact tools. */
export const ARTIFACT_INSTRUCTIONS =
  'You can make artifacts with create_artifact and revise them with update_artifact: standalone Markdown the user may want to keep, copy, download or share, such as lists, checklists, tables, plans, itineraries, specs and documents. Use one for substantial structured content (roughly more than 15 lines) or when asked; keep the chat reply short and refer to the artifact by title. Update an existing artifact rather than creating a near-duplicate.';

/** The two tool definitions offered to the model (name, description, JSON schema). */
export const ARTIFACT_TOOLS = [
  {
    name: 'create_artifact',
    description:
      'Create an artifact: standalone Markdown content (lists, tables, documents) shown to the user as a card they can open, copy and download.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, up to 80 characters' },
        content: { type: 'string', description: 'The full Markdown content' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'update_artifact',
    description:
      'Replace the content (and optionally the title) of an artifact made earlier in this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The artifact id returned by create_artifact' },
        title: { type: 'string' },
        content: { type: 'string', description: 'The full new Markdown content' },
      },
      required: ['id', 'content'],
    },
  },
];

/** Run an artifact tool; returns what the model sees, and adds the touched
 * artifact ({id, title, version}) to touched. */
export async function artifactTool(storage, name, args, touched) {
  const title = typeof args.title === 'string' ? args.title.trim().slice(0, 80) : '';
  if (typeof args.content !== 'string' || !args.content.trim())
    throw Error('Artifact content must be non-empty Markdown');
  if (args.content.length > MAX_CONTENT)
    throw Error('Artifacts are limited to ' + MAX_CONTENT + ' characters');
  const now = Date.now();
  let artifact;
  if (name === 'create_artifact') {
    if (!title) throw Error('Give the artifact a title');
    const count = (await storage.list({ prefix: 'artifact:' })).size;
    if (count >= MAX_ARTIFACTS) throw Error('This conversation has reached its artifact limit');
    const id = crypto.randomUUID();
    artifact = {
      id,
      title,
      content: args.content,
      version: 1,
      createdAt: now,
      updatedAt: now,
      previous: [],
    };
  } else {
    const old = await storage.get('artifact:' + args.id);
    if (!old) throw Error('No artifact with that id in this conversation');
    artifact = {
      ...old,
      title: title || old.title,
      content: args.content,
      version: old.version + 1,
      updatedAt: now,
      previous: [
        { version: old.version, title: old.title, content: old.content, updatedAt: old.updatedAt },
        ...old.previous,
      ].slice(0, KEEP_VERSIONS),
    };
  }
  await storage.put('artifact:' + artifact.id, artifact);
  const card = { id: artifact.id, title: artifact.title, version: artifact.version };
  const i = touched.findIndex(t => t.id === card.id);
  if (i < 0) touched.push(card);
  else touched[i] = card;
  return { id: artifact.id, title: artifact.title, version: artifact.version };
}

/** All artifacts of a session, without their contents or history. */
export async function listArtifacts(storage) {
  return [...(await storage.list({ prefix: 'artifact:' })).values()]
    .map(({ id, title, version, createdAt, updatedAt }) => ({
      id,
      title,
      version,
      createdAt,
      updatedAt,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}
