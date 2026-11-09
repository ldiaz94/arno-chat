/** Render a deliberately small Markdown dialect. Raw HTML is always text.
 * Links are restricted to HTTP(S); repository/model content never enters an
 * HTML attribute without escaping. Code fences are parsed before inline markup.
 */
export function markdown(source,sources=[]) {
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const inline=s=>{
    const code=[];let text=escape(s).replace(/\x60([^\x60]+)\x60/g,(_,v)=>'\u0000'+(code.push('<code>'+v+'</code>')-1)+'\u0000');
    text=text.replace(/\[(\d+)\](?:\((https?:\/\/[^\s)]+)\))?/g,(original,id)=>{
      const source=sources.find(s=>s.id===Number(id));if(!source)return original;
      try{if(!['https:','http:'].includes(new URL(source.url).protocol))return original}catch{return original}
      return '\u0000'+(code.push('<button class="citation" type="button" data-citation="'+Number(id)+'" title="'+escape(source.title||source.url)+'" aria-label="Source '+Number(id)+': '+escape(source.title||source.url)+'">'+Number(id)+'</button>')-1)+'\u0000';
    });
    text=text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/~~([^~]+)~~/g,'<del>$1</del>');
    return text.replace(/\u0000(\d+)\u0000/g,(_,n)=>code[Number(n)]);
  };
  const lines=String(source||'').split('\n');let out='',i=0;
  while(i<lines.length){
    const line=lines[i];
    if(/^\s*\x60{3}/.test(line)){
      const lang=line.replace(/^\s*\x60{3}/,'').trim();const block=[];i++;
      while(i<lines.length&&!/^\s*\x60{3}/.test(lines[i]))block.push(lines[i++]);
      i++;out+='<div class="codeblock"><div class="codehead"><span>'+escape(lang||'code')+'</span><button type="button" class="copy-code">Copy</button></div><pre><code>'+escape(block.join('\n'))+'</code></pre></div>';continue;
    }
    if(!line.trim()){i++;continue}
    const heading=line.match(/^(#{1,4})\s+(.+)/);
    if(heading){const n=heading[1].length+1;out+='<h'+n+'>'+inline(heading[2])+'</h'+n+'>';i++;continue}
    if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){out+='<hr>';i++;continue}
    if(/^>\s?/.test(line)){out+='<blockquote>'+inline(line.replace(/^>\s?/,''))+'</blockquote>';i++;continue}
    if(/^\s*(?:[-*+] |\d+\. )/.test(line)){
      const ordered=/^\s*\d+\./.test(line),tag=ordered?'ol':'ul';out+='<'+tag+'>';
      while(i<lines.length&&/^\s*(?:[-*+] |\d+\. )/.test(lines[i])){let item=lines[i++].replace(/^\s*(?:[-*+] |\d+\. )/,'');item=item.replace(/^\[([ xX])\]\s*/,(_,x)=>x===' '?'☐ ':'☑ ');out+='<li>'+inline(item)+'</li>'}
      out+='</'+tag+'>';continue;
    }
    if(line.includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-{3}/.test(lines[i+1])){
      const cells=s=>s.trim().replace(/^\||\|$/g,'').split('|');
      out+='<div class="table-wrap"><table><thead><tr>'+cells(line).map(v=>'<th>'+inline(v.trim())+'</th>').join('')+'</tr></thead><tbody>';i+=2;
      while(i<lines.length&&lines[i].includes('|'))out+='<tr>'+cells(lines[i++]).map(v=>'<td>'+inline(v.trim())+'</td>').join('')+'</tr>';
      out+='</tbody></table></div>';continue;
    }
    const paragraph=[line];i++;
    while(i<lines.length&&lines[i].trim()&&!/^(#{1,4}\s|\s*\x60{3}|>\s|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i]))paragraph.push(lines[i++]);
    out+='<p>'+inline(paragraph.join('\n')).replace(/\n/g,'<br>')+'</p>';
  }
  return out;
}
/** Hide the CLI's implementation banner from prose while retaining raw logs. */
export function cleanOutput(text) {
  return String(text||'').replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'').split('\n').filter(line=>!/^\s*safety:.*working on a copy/.test(line)&&!/^applied to \d+ file\(s\) in \/workspace\/repo/.test(line)).join('\n').trim();
}
export function diffHtml(diff) {
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return String(diff||'').split('\n').map(line=>'<div class="diff-line '+(line.startsWith('+++')||line.startsWith('---')||line.startsWith('diff ')?'file':line.startsWith('+')?'add':line.startsWith('-')?'remove':line.startsWith('@@')?'hunk':'')+'">'+escape(line||' ')+'</div>').join('');
}
