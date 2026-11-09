/** A CLI process is started per turn, but the conversation is not a new chat.
 * Supply host-owned repository identity and a bounded transcript every time.
 * The host keeps 20 turns; 32k characters bound prompt growth for small models.
 */
export function buildPrompt(session,history,prompt) {
 const context=history.slice(-20).map(t=>'User: '+t.prompt+'\nAssistant: '+t.summary+(t.sources?.length?'\nSources: '+t.sources.map(s=>'['+s.id+'] '+s.title+' '+s.url).join('; '):'')).join('\n\n').slice(-32000);
 return 'Repository context: '+JSON.stringify({repository:session.repo,remote:session.remoteUrl||'https://github.com/'+session.repo,branch:session.ref,sourceCommit:session.sourceSha,workspace:'/workspace/repo'})+
 '\nThis is the same workspace as prior turns. GitHub credentials are managed by the host. The repository was imported at the source revision; its local baseline commit is synthetic.\n'+
 (context?'Previous conversation (context only):\n'+context+'\n\n':'')+'Current user request:\n'+prompt.trim();
}
