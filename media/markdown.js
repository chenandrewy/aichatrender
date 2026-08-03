// Run: loaded by media/index.html; test with `node --test test/*.test.js`.
// Input: ordered transcript spans shaped as {t:'text',s} or {t:'math',m,s}.
// Output: a small Markdown block model; raw HTML is never interpreted.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIChatRenderMarkdown = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function pushText(tokens, text) {
    if (!text) return;
    var last = tokens[tokens.length - 1];
    if (last && last.t === 'text') last.s += text;
    else tokens.push({ t: 'text', s: text });
  }

  function spansToLines(spans) {
    var lines = [[]];
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i];
      if (span.t === 'math') {
        lines[lines.length - 1].push({ t: 'math', m: span.m, s: span.s });
        continue;
      }
      var parts = span.s.split('\n');
      for (var j = 0; j < parts.length; j++) {
        pushText(lines[lines.length - 1], parts[j]);
        if (j < parts.length - 1) lines.push([]);
      }
    }
    return lines;
  }

  function lineText(line) {
    var out = '';
    for (var i = 0; i < line.length; i++) {
      out += line[i].t === 'text' ? line[i].s : '\ufffc';
    }
    return out;
  }

  function stripPrefix(line, count) {
    var out = [];
    for (var i = 0; i < line.length; i++) {
      var token = line[i];
      if (token.t === 'text' && count > 0) {
        if (token.s.length <= count) {
          count -= token.s.length;
          continue;
        }
        pushText(out, token.s.slice(count));
        count = 0;
      } else if (token.t === 'text') {
        pushText(out, token.s);
      } else {
        out.push({ t: 'math', m: token.m, s: token.s });
      }
    }
    return out;
  }

  function marker(line) {
    var text = lineText(line);
    var match = text.match(/^ {0,3}(#{1,6})[ \t]+/);
    if (match && text.slice(match[0].length).trim()) {
      return { type: 'heading', level: match[1].length, prefix: match[0].length };
    }
    if (/^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(text)) {
      return { type: 'rule' };
    }
    match = text.match(/^ {0,3}([-+*])[ \t]+/);
    if (match) return { type: 'list', ordered: false, prefix: match[0].length };
    match = text.match(/^ {0,3}\d+[.)][ \t]+/);
    if (match) return { type: 'list', ordered: true, prefix: match[0].length };
    match = text.match(/^ {0,3}>[ \t]?/);
    if (match) return { type: 'blockquote', prefix: match[0].length };
    match = text.match(/^ {0,3}```[ \t]*([A-Za-z0-9_-]+)?[ \t]*$/);
    if (match) return { type: 'fence', language: match[1] || '' };
    return { type: 'paragraph' };
  }

  // Split a line's tokens on unescaped pipes. Math tokens are opaque, so a
  // pipe inside rendered math can never split a cell.
  function splitRow(line) {
    var cells = [];
    var current = [];
    for (var i = 0; i < line.length; i++) {
      var token = line[i];
      if (token.t !== 'text') {
        current.push({ t: 'math', m: token.m, s: token.s });
        continue;
      }
      var buffer = '';
      for (var j = 0; j < token.s.length; j++) {
        var ch = token.s[j];
        if (ch === '\\' && token.s[j + 1] === '|') {
          buffer += '|';
          j++;
        } else if (ch === '|') {
          pushText(current, buffer);
          buffer = '';
          cells.push(current);
          current = [];
        } else {
          buffer += ch;
        }
      }
      pushText(current, buffer);
    }
    cells.push(current);

    // GFM drops one optional leading and trailing pipe.
    var text = lineText(line).trim();
    if (cells.length > 1 && text.charAt(0) === '|') cells.shift();
    if (cells.length > 1 && text.charAt(text.length - 1) === '|') cells.pop();
    for (var k = 0; k < cells.length; k++) cells[k] = trimTokens(cells[k]);
    return cells;
  }

  function trimTokens(tokens) {
    var out = tokens.slice();
    while (out.length && out[0].t === 'text') {
      var head = out[0].s.replace(/^[ \t]+/, '');
      if (head) {
        out[0] = { t: 'text', s: head };
        break;
      }
      out.shift();
    }
    while (out.length && out[out.length - 1].t === 'text') {
      var tail = out[out.length - 1].s.replace(/[ \t]+$/, '');
      if (tail) {
        out[out.length - 1] = { t: 'text', s: tail };
        break;
      }
      out.pop();
    }
    return out;
  }

  function hasPipe(line) {
    for (var i = 0; i < line.length; i++) {
      if (line[i].t === 'text' && /(^|[^\\])\|/.test(line[i].s)) return true;
    }
    return false;
  }

  // A delimiter row such as `| --- | :---: |` yields one alignment per column.
  function alignments(line) {
    if (!hasPipe(line)) return null;
    var cells = splitRow(line);
    var out = [];
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (cell.length !== 1 || cell[0].t !== 'text') return null;
      var match = cell[0].s.match(/^(:?)-+(:?)$/);
      if (!match) return null;
      out.push(match[1] && match[2] ? 'center' : match[2] ? 'right' : match[1] ? 'left' : '');
    }
    return out;
  }

  function tableAt(lines, i) {
    if (i + 1 >= lines.length || !hasPipe(lines[i])) return null;
    var align = alignments(lines[i + 1]);
    if (!align) return null;
    var header = splitRow(lines[i]);
    if (header.length !== align.length) return null;
    return { header: header, align: align };
  }

  function fitRow(cells, width) {
    var out = cells.slice(0, width);
    while (out.length < width) out.push([]);
    return out;
  }

  function isBlank(line) {
    return lineText(line).trim() === '';
  }

  function literalLine(line) {
    var out = '';
    for (var i = 0; i < line.length; i++) out += line[i].s;
    return out;
  }

  function parse(spans) {
    var lines = spansToLines(spans);
    var blocks = [];
    var i = 0;
    while (i < lines.length) {
      if (isBlank(lines[i])) {
        i++;
        continue;
      }

      var table = tableAt(lines, i);
      if (table) {
        var rows = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]) && hasPipe(lines[i])) {
          rows.push(fitRow(splitRow(lines[i]), table.align.length));
          i++;
        }
        blocks.push({
          type: 'table',
          align: table.align,
          header: table.header,
          rows: rows,
        });
        continue;
      }

      var kind = marker(lines[i]);
      if (kind.type === 'fence') {
        var code = [];
        i++;
        while (i < lines.length && marker(lines[i]).type !== 'fence') {
          code.push(literalLine(lines[i]));
          i++;
        }
        if (i < lines.length) i++;
        blocks.push({ type: 'code', language: kind.language, text: code.join('\n') });
        continue;
      }
      if (kind.type === 'heading') {
        blocks.push({
          type: 'heading',
          level: kind.level,
          content: stripPrefix(lines[i], kind.prefix),
        });
        i++;
        continue;
      }
      if (kind.type === 'rule') {
        blocks.push({ type: 'rule' });
        i++;
        continue;
      }
      if (kind.type === 'list') {
        var list = { type: 'list', ordered: kind.ordered, items: [] };
        while (i < lines.length) {
          var itemKind = marker(lines[i]);
          if (itemKind.type !== 'list' || itemKind.ordered !== kind.ordered) break;
          list.items.push(stripPrefix(lines[i], itemKind.prefix));
          i++;
        }
        blocks.push(list);
        continue;
      }
      if (kind.type === 'blockquote') {
        var quote = { type: 'blockquote', lines: [] };
        while (i < lines.length) {
          var quoteKind = marker(lines[i]);
          if (quoteKind.type !== 'blockquote') break;
          quote.lines.push(stripPrefix(lines[i], quoteKind.prefix));
          i++;
        }
        blocks.push(quote);
        continue;
      }

      var paragraph = { type: 'paragraph', lines: [] };
      while (i < lines.length && !isBlank(lines[i]) && marker(lines[i]).type === 'paragraph') {
        paragraph.lines.push(lines[i]);
        i++;
      }
      blocks.push(paragraph);
    }
    return blocks;
  }

  // --- clipboard -----------------------------------------------------------
  // Render extracted cell strings back to pipe syntax. Kept here, away from the
  // DOM walk in index.html, so the fiddly padding and escaping stay testable.

  function escapeCell(text) {
    return String(text == null ? '' : text)
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\|/g, '\\|')
      .trim();
  }

  function displayWidth(text) {
    // Astral characters (emoji) occupy one column for our padding purposes.
    return Array.from(text).length;
  }

  function padCell(text, width) {
    var pad = width - displayWidth(text);
    return pad > 0 ? text + new Array(pad + 1).join(' ') : text;
  }

  function delimiterCell(align, width) {
    if (align === 'center') return ':' + new Array(width - 1).join('-') + ':';
    if (align === 'right') return new Array(width).join('-') + ':';
    if (align === 'left') return ':' + new Array(width).join('-');
    return new Array(width + 1).join('-');
  }

  function pipeRow(cells) {
    return '| ' + cells.join(' | ') + ' |';
  }

  // header may be null for a partial selection that missed the header row; the
  // delimiter row is then omitted rather than promoting a body row to a header.
  function formatTable(header, rows, align) {
    var body = [];
    var i, j;
    for (i = 0; i < rows.length; i++) {
      var row = [];
      for (j = 0; j < rows[i].length; j++) row.push(escapeCell(rows[i][j]));
      body.push(row);
    }
    var head = header ? header.map(escapeCell) : null;

    var width = head ? head.length : 0;
    for (i = 0; i < body.length; i++) width = Math.max(width, body[i].length);
    if (!width) return '';

    var widths = [];
    for (j = 0; j < width; j++) {
      var max = 3; // a delimiter cell needs room for `:-:`
      if (head && head[j]) max = Math.max(max, displayWidth(head[j]));
      for (i = 0; i < body.length; i++) {
        if (body[i][j]) max = Math.max(max, displayWidth(body[i][j]));
      }
      widths.push(max);
    }

    function fill(row) {
      var out = [];
      for (var k = 0; k < width; k++) out.push(padCell(row[k] || '', widths[k]));
      return out;
    }

    var lines = [];
    if (head) {
      lines.push(pipeRow(fill(head)));
      var delims = [];
      for (j = 0; j < width; j++) {
        delims.push(delimiterCell((align && align[j]) || '', widths[j]));
      }
      lines.push(pipeRow(delims));
    }
    for (i = 0; i < body.length; i++) lines.push(pipeRow(fill(body[i])));
    return lines.join('\n');
  }

  return { parse: parse, formatTable: formatTable };
});
