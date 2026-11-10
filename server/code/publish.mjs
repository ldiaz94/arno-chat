/** A coding session's changes, and publishing them. The changes are those
 * GitHub does not have yet: from the base, where the branch meets its
 * upstream (or, never pushed, the branch it came from), to the files as they
 * stand. Commits pushed, and work pulled from upstream, are not in them; so
 * parallel sessions and upstream changes do not show up as this session's.
 *
 *   upstream ──●──●──●              (pulled in: not the session's)
 *               \        \
 *   HEAD      base──●──●──merge──[uncommitted]
 *                   └ the session's, not yet pushed: the changes
 *
 * The scripts run in the untrusted container (credentials never enter them),
 * and the host checks what they print. Publishing makes a new branch from the
 * base commit, which GitHub has.
 * Depends on auth.mjs (the GitHub API call). Used by code-routes.mjs and
 * turn.mjs. Leaves out merging, force pushes and binary files.
 */
import { github } from '../auth.mjs';

/** Node script code, run in the container before the others, that finds base
 * (see above). ARNO_REF names the branch the session tracks, for a branch with
 * no upstream yet; a session from before clones falls back to its first commit. */
const BASE = String.raw`
const gitq=args=>{try{return require('child_process').execFileSync('git',args,{cwd:'/workspace/repo',encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{return ''}};
const upstream=gitq(['rev-parse','--abbrev-ref','--symbolic-full-name','@{u}'])||(process.env.ARNO_REF?'origin/'+process.env.ARNO_REF:'');
const base=(upstream&&gitq(['merge-base','HEAD',upstream]))||gitq(['config','arno.sourceCommit'])||gitq(['rev-list','--max-parents=0','HEAD']).split('\n')[0];
`;

/** Node script run in the container: prints, as JSON, the base and every file
 * changed since it (tracked or new; at most 50 files, 1 MB of text) with its
 * content and mode, or {deleted: true}. */
export const EXPORT_FILES =
  BASE +
  String.raw`
const fs=require('fs'),cp=require('child_process'),path=require('path'),root='/workspace/repo';
const tracked=cp.execFileSync('git',['diff','--name-only','-z',base],{cwd:root}).toString().split('\0');
const others=cp.execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{cwd:root}).toString().split('\0');
const names=[...new Set([...tracked,...others].filter(Boolean))];if(names.length>50)throw Error('Review at most 50 files per publish');
let size=0;const files=names.map(name=>{
 const full=path.resolve(root,name);
 if(!full.startsWith(root+'/')||name.split('/').includes('.git'))throw Error('Invalid path');
 if(!fs.existsSync(full))return {path:name,deleted:true};
 const info=fs.lstatSync(full);if(!info.isFile()||fs.realpathSync(full)!==full)throw Error('Symlinks cannot be published');
 const bytes=fs.readFileSync(full);size+=bytes.length;if(size>1000000||bytes.includes(0))throw Error('Publish supports up to 1 MB of text changes');
 const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 return {path:name,content,mode:info.mode&0o111?'100755':'100644'};
});process.stdout.write(JSON.stringify({base,files}));
`;
/** Host-side validation is necessary even though the export script is fixed:
 * repository code can change the runtime and all files inside its container.
 * Returns files if they are 1 to 50 safe, unique paths of at most 1 MB of text;
 * throws otherwise. */
export function validateFiles(files) {
  if (!Array.isArray(files) || files.length > 50 || !files.length)
    throw Error('No changes to publish');
  let size = 0;
  const seen = new Set();
  for (const f of files) {
    if (
      typeof f.path !== 'string' ||
      !f.path ||
      f.path.startsWith('/') ||
      f.path.split('/').some(p => !p || p === '..' || p === '.' || p === '.git') ||
      seen.has(f.path)
    )
      throw Error('Invalid changed file path');
    seen.add(f.path);
    if (!f.deleted) {
      if (typeof f.content !== 'string' || !['100644', '100755'].includes(f.mode))
        throw Error('Unsupported file');
      size += new TextEncoder().encode(f.content).length;
    }
  }
  if (size > 1000000) throw Error('Changes exceed 1 MB');
  return files;
}
/** Node script run in the container: the diff from base to the files as they
 * stand, new (untracked) files included, cut at 60 KB. Arguments are passed
 * without a shell. */
export const WORKTREE_DIFF =
  BASE +
  String.raw`
const cp=require('child_process');let out='';
const run=args=>{try{return cp.execFileSync('git',args,{encoding:'utf8',maxBuffer:2000000})}catch(e){if(e.status===1)return e.stdout||'';throw e}};
out+=run(['diff',base,'--','.']);
for(const file of run(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean).slice(0,50)){if(out.length>60000)break;out+=run(['diff','--no-index','--','/dev/null',file])}
process.stdout.write(out.slice(0,60000));
`;

/** The changes for review, checked, and the digest that names them: a publish
 * must name the same digest, so what is published is what was reviewed. */
export async function changesDigest(changes) {
  const files = validateFiles(changes.files),
    hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify({ files, sourceSha: changes.sourceSha })),
    );
  const digest = [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
  return { changes, files, digest };
}

/** Publishes reviewed changes ({changes, files} of changesDigest) to GitHub
 * with token: a commit on the pinned source commit, a new branch body.branch
 * (arno/...), and a pull request titled body.title. An error carries the
 * HTTP status to answer with. */
export async function publishChanges({ changes, files }, body, token) {
  if (
    typeof body.branch !== 'string' ||
    !/^arno\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}$/.test(body.branch) ||
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    body.title.length > 200
  )
    throw Object.assign(Error('Use an arno/branch-name and a commit title up to 200 characters'), {
      status: 400,
    });
  const call = async (path, method = 'GET', data) => {
    const r = await github('/repos/' + changes.repo + path, token, {
      method,
      ...(data
        ? { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }
        : {}),
    });
    if (!r.ok)
      throw Error(
        'GitHub rejected publishing (' +
          r.status +
          '). A branch may already exist; check GitHub before retrying.',
      );
    return r.json();
  };
  const base = await call('/git/commits/' + changes.sourceSha);
  const tree = await call('/git/trees', 'POST', {
    base_tree: base.tree.sha,
    tree: files.map(f => ({
      path: f.path,
      mode: f.mode || '100644',
      type: 'blob',
      ...(f.deleted ? { sha: null } : { content: f.content }),
    })),
  });
  const commit = await call('/git/commits', 'POST', {
    message: body.title.trim(),
    tree: tree.sha,
    parents: [changes.sourceSha],
  });
  await call('/git/refs', 'POST', { ref: 'refs/heads/' + body.branch, sha: commit.sha });
  let url = null,
    warning = null;
  try {
    url = (
      await call('/pulls', 'POST', {
        title: body.title.trim(),
        head: body.branch,
        base: changes.ref,
        body: 'Changes prepared with Arno Chat.\n\nBase revision: ' + changes.sourceSha,
      })
    ).html_url;
  } catch {
    warning = 'Branch created, but the pull request could not be opened. Open it on GitHub.';
  }
  return {
    branch: body.branch,
    commit: commit.sha,
    url: url || 'https://github.com/' + changes.repo + '/tree/' + body.branch,
    warning,
  };
}
