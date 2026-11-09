/** Render a deliberately small Markdown dialect. Raw HTML is always text.
 * Links and images are restricted to HTTP(S); repository/model content never enters an
 * HTML attribute without escaping. Code fences are parsed before inline markup.
 */
export function markdown(source, sources = []) {
  const escape = s =>
    String(s).replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  // Table helpers: a GFM delimiter row, and a row split on unescaped pipes outside code spans (\| becomes |).
  const isDelimiter = s => s.includes('-') && splitRow(s).every(c => /^:?-+:?$/.test(c));
  const splitRow = s => {
    s = s
      .trim()
      .replace(/^\|/, '')
      .replace(/(^|[^\\])\|$/, '$1');
    const cells = [];
    let cur = '';
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (c === '\\' && s[j + 1] === '|') {
        cur += '|';
        j++;
      } else if (c === '\x60' && s.indexOf('\x60', j + 1) > 0) {
        const e = s.indexOf('\x60', j + 1);
        cur += s.slice(j, e + 1).replace(/\\\|/g, '|');
        j = e;
      } else if (c === '|') {
        cells.push(cur);
        cur = '';
      } else cur += c;
    }
    cells.push(cur);
    return cells.map(c => c.trim());
  };
  const entities = { quot: '"', '#39': "'", lt: '<', gt: '>', amp: '&' };
  const inline = s => {
    const code = [];
    let text = escape(s).replace(
      /\x60([^\x60]+)\x60/g,
      (_, v) => '\u0000' + (code.push('<code>' + v + '</code>') - 1) + '\u0000',
    );
    // Images load through the same-origin /api/image proxy; the original URL only links out.
    text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (original, alt, href) => {
      const real = href.replace(/&(quot|#39|lt|gt|amp);/g, (_, e) => entities[e]);
      try {
        if (real.length > 2000 || !['https:', 'http:'].includes(new URL(real).protocol))
          return original;
      } catch {
        return original;
      }
      return (
        '\u0000' +
        (code.push(
          '<a class="md-image" href="' +
            href +
            '" target="_blank" rel="noopener noreferrer"><img src="/api/image?url=' +
            escape(encodeURIComponent(real)) +
            '" alt="' +
            alt +
            '" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>',
        ) -
          1) +
        '\u0000'
      );
    });
    text = text.replace(/\[(\d+)\](?:\((https?:\/\/[^\s)]+)\))?/g, (original, id) => {
      const source = sources.find(s => s.id === Number(id));
      if (!source) return original;
      try {
        if (!['https:', 'http:'].includes(new URL(source.url).protocol)) return original;
      } catch {
        return original;
      }
      return (
        '\u0000' +
        (code.push(
          '<button class="citation" type="button" data-citation="' +
            Number(id) +
            '" title="' +
            escape(source.title || source.url) +
            '" aria-label="Source ' +
            Number(id) +
            ': ' +
            escape(source.title || source.url) +
            '">' +
            Number(id) +
            '</button>',
        ) -
          1) +
        '\u0000'
      );
    });
    text = text
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // NUL brackets the index of a code span or citation set aside above.
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u0000(\d+)\u0000/g, (_, n) => code[Number(n)]);
  };
  const lines = String(source || '').split('\n');
  let out = '',
    i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\x60{3}/.test(line)) {
      const lang = line.replace(/^\s*\x60{3}/, '').trim();
      const block = [];
      i++;
      while (i < lines.length && !/^\s*\x60{3}/.test(lines[i])) block.push(lines[i++]);
      i++;
      out +=
        '<div class="codeblock"><div class="codehead"><span>' +
        escape(lang || 'code') +
        '</span><button type="button" class="copy-code">Copy</button></div><pre><code>' +
        escape(block.join('\n')) +
        '</code></pre></div>';
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)/);
    if (heading) {
      const n = heading[1].length + 1;
      out += '<h' + n + '>' + inline(heading[2]) + '</h' + n + '>';
      i++;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      out += '<hr>';
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      out += '<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>';
      i++;
      continue;
    }
    if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line),
        tag = ordered ? 'ol' : 'ul';
      out += '<' + tag + '>';
      while (i < lines.length && /^\s*(?:[-*+] |\d+\. )/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*(?:[-*+] |\d+\. )/, '');
        item = item.replace(/^\[([ xX])\]\s*/, (_, x) => (x === ' ' ? '☐ ' : '☑ '));
        out += '<li>' + inline(item) + '</li>';
      }
      out += '</' + tag + '>';
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isDelimiter(lines[i + 1])) {
      const head = splitRow(line),
        n = head.length,
        align = splitRow(lines[i + 1]).map(c =>
          c.startsWith(':')
            ? c.endsWith(':')
              ? 'center'
              : 'left'
            : c.endsWith(':')
              ? 'right'
              : '',
        );
      const cell = (tag, v, k) => {
        const t = v.trim(),
          num = tag === 'td' && !align[k] && /^[-+~]?[$€£]?\d[\d,.]*\s?(?:%|[kKmMbB]|x)?$/.test(t);
        return (
          '<' +
          tag +
          (align[k] ? ' style="text-align:' + align[k] + '"' : '') +
          (num ? ' class="num"' : '') +
          '>' +
          inline(t) +
          (tag === 'th' ? '<span class="col-resize" aria-hidden="true"></span>' : '') +
          '</' +
          tag +
          '>'
        );
      };
      out +=
        '<div class="table-wrap"><table><thead><tr>' +
        head.map((v, k) => cell('th', v, k)).join('') +
        '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].includes('|')) {
        const row = splitRow(lines[i++]);
        out +=
          '<tr>' +
          Array.from({ length: n }, (_, k) => cell('td', row[k] || '', k)).join('') +
          '</tr>';
      }
      out += '</tbody></table></div>';
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|\s*\x60{3}|>\s|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])
    )
      paragraph.push(lines[i++]);
    out += '<p>' + inline(paragraph.join('\n')).replace(/\n/g, '<br>') + '</p>';
  }
  return out;
}
/** Hide the CLI's implementation banner from prose while retaining raw logs. */
export function cleanOutput(text) {
  return (
    String(text || '')
      // eslint-disable-next-line no-control-regex -- ANSI escape sequences
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .split('\n')
      .filter(
        line =>
          !/^\s*safety:.*working on a copy/.test(line) &&
          !/^applied to \d+ file\(s\) in \/workspace\/repo/.test(line),
      )
      .join('\n')
      .trim()
  );
}
export function diffHtml(diff) {
  const escape = s =>
    String(s).replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  return String(diff || '')
    .split('\n')
    .map(
      line =>
        '<div class="diff-line ' +
        (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')
          ? 'file'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'remove'
              : line.startsWith('@@')
                ? 'hunk'
                : '') +
        '">' +
        escape(line || ' ') +
        '</div>',
    )
    .join('');
}
/** Let users drag a table header's .col-resize handle to size its columns;
 * double-click a handle to go back to automatic sizing. Delegated on root. */
export function tableResize(root) {
  const sum = th =>
    [...th.parentElement.children].reduce((n, h) => n + parseFloat(h.style.width), 0);
  root.addEventListener('pointerdown', e => {
    const grip = e.target.closest && e.target.closest('.col-resize');
    if (!grip) return;
    const th = grip.parentElement,
      table = th.closest('table'),
      heads = [...th.parentElement.children];
    if (!table.classList.contains('sized')) {
      heads.forEach(h => (h.style.width = h.getBoundingClientRect().width + 'px'));
      table.classList.add('sized');
    }
    const x0 = e.clientX,
      w0 = parseFloat(th.style.width);
    const move = m => {
      th.style.width = Math.max(40, w0 + m.clientX - x0) + 'px';
      table.style.width = sum(th) + 'px';
    };
    const stop = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', stop);
      grip.removeEventListener('pointercancel', stop);
    };
    e.preventDefault();
    table.style.width = sum(th) + 'px';
    grip.setPointerCapture(e.pointerId);
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  });
  root.addEventListener('dblclick', e => {
    const grip = e.target.closest && e.target.closest('.col-resize');
    if (!grip) return;
    const table = grip.closest('table');
    table.classList.remove('sized');
    table.style.width = '';
    table.querySelectorAll('th').forEach(h => (h.style.width = ''));
  });
}
