/** Read-only code navigation. Both host and container validate paths; file
 * contents are returned as JSON and escaped by the browser, never executed.
 * Used by the files route in code-routes.mjs. Leaves out writing and symlinks.
 */
/** Whether path is safe to read: a relative path in the repository, with no
 * NUL, no ".." and nothing inside .git. */
export function validPath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 1000 &&
    !path.startsWith('/') &&
    !path.includes('\0') &&
    !path.split('/').some(p => p === '..' || p === '.git')
  );
}
/** Node script run in the container (argument: the path, '' for the root):
 * prints a directory's entries (at most 300) or a text file's content (at most
 * 200 KB) as JSON, refusing symlinks, binaries and paths outside the repository. */
export const READ_FILE = String.raw`
const fs=require('fs'),path=require('path'),root='/workspace/repo',name=process.argv[1]||'';
const full=path.resolve(root,name);
if(full!==root&&!full.startsWith(root+'/'))throw Error('Path outside repository');
const real=fs.realpathSync(full);if(real!==full||real!==root&&!real.startsWith(root+'/'))throw Error('Symlink navigation is disabled');
const stat=fs.statSync(full);
if(stat.isDirectory()){
 const entries=fs.readdirSync(full,{withFileTypes:true}).filter(e=>e.name!=='.git'&&!e.isSymbolicLink()).map(e=>({name:e.name,path:name?name+'/'+e.name:e.name,directory:e.isDirectory()})).sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name));
 process.stdout.write(JSON.stringify({path:name,directory:true,entries:entries.slice(0,300),truncated:entries.length>300}));
}else{
 if(!stat.isFile()||stat.size>200000)throw Error('Text preview limit is 200 KB');
 const bytes=fs.readFileSync(full);if(bytes.includes(0))throw Error('Binary file preview is unavailable');
 const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);process.stdout.write(JSON.stringify({path:name,directory:false,content,bytes:bytes.length}));
}
`;
