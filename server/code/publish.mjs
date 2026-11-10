/** Export only regular UTF-8 worktree files. Credentials never enter this code:
 * it executes inside the untrusted container, and the host validates the result.
 * Publishing creates a new branch from the pinned GitHub source commit.
 */
import { github } from '../auth.mjs';

export const EXPORT_FILES = String.raw`
const fs=require('fs'),cp=require('child_process'),path=require('path'),root='/workspace/repo';
const git=args=>{try{return cp.execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim()}catch{return ''}};
const base=git(['config','arno.sourceCommit'])||git(['rev-list','--max-parents=0','HEAD']).split('\n')[0];
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
});process.stdout.write(JSON.stringify({files}));
`;
/** Host-side validation is necessary even though the export script is fixed:
 * repository code can change the runtime and all files inside its container.
 */
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
/** Include newly created files as well as tracked edits in the review UI.
 * git diff alone omits untracked files. Arguments are passed without a shell.
 */
export const WORKTREE_DIFF = String.raw`
const cp=require('child_process');let out='';
const run=args=>{try{return cp.execFileSync('git',args,{encoding:'utf8',maxBuffer:2000000})}catch(e){if(e.status===1)return e.stdout||'';throw e}};
// The session started from arno.sourceCommit; a session made before clones has a synthetic root.
const base=run(['config','arno.sourceCommit']).trim()||run(['rev-list','--max-parents=0','HEAD']).trim().split('\n')[0];
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
