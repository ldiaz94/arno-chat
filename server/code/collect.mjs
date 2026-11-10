/** A coding session's artifacts: arno writes the documents, pages, drawings
 * and files it is asked for in its artifacts directory (arno(1), Artifacts),
 * which the user cannot reach in the sandbox; after each turn the files new
 * or changed there are read and kept as the session's artifacts
 * (../probe/artifacts.mjs), each file one artifact, a change a new version.
 *
 *   /workspace/data/arno/artifacts/<conversation>/<file>   ($XDG_DATA_HOME)
 *   artifact-path:<conversation>/<file>   {id, mtime}   which artifact it is
 *
 * Depends on ../probe/artifacts.mjs. Leaves out files that are not text or
 * an image (docx, xlsx, PDF), and files deleted there: their artifact stays.
 */
import { putArtifact, summary } from '../probe/artifacts.mjs';

/** Where arno keeps artifacts, under the XDG_DATA_HOME code/turn.mjs sets. */
export const ARTIFACTS_DIR = '/workspace/data/arno/artifacts';
/** Most bytes of output one collection reads. */
const MAX_OUTPUT = 8000000;

/** Run by node in the workspace: prints, one JSON line each, the files under
 * ROOT whose mtime is not the one SEEN (a JSON map of path to mtime) holds:
 * {path, mtime, kind, language, mime, content}, an image's content base64.
 * Skips binary files and those too big for an artifact. */
const LIST = String.raw`
const fs = require('fs'), path = require('path');
const root = process.env.ROOT, seen = JSON.parse(process.env.SEEN || '{}');
const kinds = { md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', svg: 'svg', mmd: 'mermaid', mermaid: 'mermaid' };
const images = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function walk(dir) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of names) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    if (!e.isFile()) continue;
    const rel = path.relative(root, full), st = fs.statSync(full), mtime = Math.round(st.mtimeMs);
    if (seen[rel] === mtime) continue;
    const ext = path.extname(e.name).slice(1).toLowerCase(), mime = images[ext];
    if (st.size > (mime ? 1000000 : 200000)) continue;
    const bytes = fs.readFileSync(full);
    let kind = kinds[ext] || (mime ? 'image' : 'code'), content;
    if (mime) content = bytes.toString('base64');
    else {
      if (bytes.includes(0)) continue;
      content = bytes.toString('utf8');
      if (content.includes('�')) continue;
    }
    console.log(JSON.stringify({ path: rel, mtime, kind, language: kind === 'code' ? ext : '', mime: mime || '', content }));
  }
}
walk(root);
`;

/** A file's title: a Markdown file's first heading, else its name. */
function titleOf(file) {
  const heading = file.kind === 'markdown' && /^#\s+(.+)$/m.exec(file.content);
  return (heading ? heading[1] : file.path.split('/').pop()).trim().slice(0, 80);
}

/** Reads the artifacts arno made or changed this turn into the store of
 * probe (the session's ArnoProbe); returns their summaries, for the turn. */
export async function collectArtifacts(probe) {
  const storage = probe.ctx.storage,
    known = await storage.list({ prefix: 'artifact-path:' }),
    seen = Object.fromEntries([...known].map(([k, v]) => [k.slice(14), v.mtime]));
  const process = await probe.ctx.container.exec(['timeout', '30', 'node', '-e', LIST], {
    env: { ROOT: ARTIFACTS_DIR, SEEN: JSON.stringify(seen) },
  });
  const output = await process.output();
  if (output.exitCode !== 0) return [];
  const touched = [];
  for (const line of new TextDecoder().decode(output.stdout.slice(0, MAX_OUTPUT)).split('\n')) {
    let file;
    try {
      file = JSON.parse(line);
    } catch {
      continue; // blank, or cut off at MAX_OUTPUT
    }
    const key = 'artifact-path:' + file.path,
      was = known.get(key);
    try {
      const a = await putArtifact(storage, was?.id, {
        title: titleOf(file),
        kind: file.kind,
        language: file.language,
        mime: file.mime,
        content: file.content,
        path: file.path,
      });
      await storage.put(key, { id: a.id, mtime: file.mtime });
      touched.push(summary(a));
    } catch (e) {
      console.error(
        JSON.stringify({ event: 'artifact_skipped', path: file.path, error: e.message }),
      );
    }
  }
  return touched;
}
