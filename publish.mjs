/** Export only regular UTF-8 worktree files. Credentials never enter this code:
 * it executes inside the untrusted container, and the host validates the result.
 * Publishing creates a new branch from the pinned GitHub source commit.
 */
export const EXPORT_FILES=String.raw`
const fs=require('fs'),cp=require('child_process'),path=require('path'),root='/workspace/repo';
const base=cp.execFileSync('git',['rev-list','--max-parents=0','HEAD'],{cwd:root,encoding:'utf8'}).trim().split('\n')[0];
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
 if(!Array.isArray(files)||files.length>50||!files.length)throw Error('No changes to publish');
 let size=0;const seen=new Set();
 for(const f of files){
  if(typeof f.path!=='string'||!f.path||f.path.startsWith('/')||f.path.split('/').some(p=>!p||p==='..'||p==='.'||p==='.git')||seen.has(f.path))throw Error('Invalid changed file path');
  seen.add(f.path);
  if(!f.deleted){if(typeof f.content!=='string'||!['100644','100755'].includes(f.mode))throw Error('Unsupported file');size+=new TextEncoder().encode(f.content).length}
 }
 if(size>1000000)throw Error('Changes exceed 1 MB');
 return files;
}
/** Include newly created files as well as tracked edits in the review UI.
 * git diff alone omits untracked files. Arguments are passed without a shell.
 */
export const WORKTREE_DIFF=String.raw`
const cp=require('child_process');let out='';
const run=args=>{try{return cp.execFileSync('git',args,{encoding:'utf8',maxBuffer:2000000})}catch(e){if(e.status===1)return e.stdout||'';throw e}};
const base=run(['rev-list','--max-parents=0','HEAD']).trim().split('\n')[0];
out+=run(['diff',base,'--','.']);
for(const file of run(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean).slice(0,50)){if(out.length>60000)break;out+=run(['diff','--no-index','--','/dev/null',file])}
process.stdout.write(out.slice(0,60000));
`;
