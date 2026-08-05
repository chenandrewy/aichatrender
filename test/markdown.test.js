// Run: `node --test test/markdown.test.js`.
// Input: synthetic text/math spans and rendered-DOM fixtures.
// Output: assertions for AIChatRender's Markdown parser and clipboard serializer.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parse,
  formatTable,
  serializeMarkdown,
  cloneSelectionWithContext,
} = require('../media/markdown');

function text(value) {
  return {
    nodeType: 3,
    nodeValue: value,
    parentNode: null,
    cloneNode() { return text(value); },
  };
}

function element(tagName, attributes = {}, children = []) {
  const attrs = { ...attributes };
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    className: attrs.class || '',
    childNodes: [],
    parentNode: null,
    classList: {
      contains(name) { return (` ${node.className} `).includes(` ${name} `); },
    },
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
    setAttribute(name, value) {
      attrs[name] = String(value);
      if (name === 'class') node.className = String(value);
    },
    appendChild(child) {
      node.childNodes.push(child);
      child.parentNode = node;
      return child;
    },
    cloneNode(deep) {
      return element(
        node.tagName,
        attrs,
        deep ? node.childNodes.map((child) => child.cloneNode(true)) : [],
      );
    },
  };
  for (const child of children) node.appendChild(child);
  return node;
}

function fragment(children = []) {
  const node = {
    nodeType: 11,
    childNodes: [],
    parentNode: null,
    appendChild(child) {
      node.childNodes.push(child);
      child.parentNode = node;
      return child;
    },
    cloneNode(deep) {
      return fragment(deep ? node.childNodes.map((child) => child.cloneNode(true)) : []);
    },
  };
  for (const child of children) node.appendChild(child);
  return node;
}

function math(mode, source) {
  return element('span', { class: `math ${mode}` }, [
    element('math'),
    element('annotation', { encoding: 'application/x-tex' }, [text(source)]),
  ]);
}

test('markdown: headings retain inline math', () => {
  assert.deepEqual(
    parse([
      { t: 'text', s: '## Result for ' },
      { t: 'math', m: 'inline', s: 'x' },
    ]),
    [
      {
        type: 'heading',
        level: 2,
        content: [
          { t: 'text', s: 'Result for ' },
          { t: 'math', m: 'inline', s: 'x' },
        ],
      },
    ],
  );
});

test('markdown: unordered and ordered outlines retain item numbers', () => {
  assert.deepEqual(
    parse([{ t: 'text', s: '- first\n- second\n\n7. seven\n9) nine' }]),
    [
      {
        type: 'list',
        ordered: false,
        items: [[{ t: 'text', s: 'first' }], [{ t: 'text', s: 'second' }]],
      },
      {
        type: 'list',
        ordered: true,
        items: [[{ t: 'text', s: 'seven' }], [{ t: 'text', s: 'nine' }]],
        values: [7, 9],
      },
    ],
  );
});

test('markdown: quotes, rules, paragraphs, and fenced code', () => {
  assert.deepEqual(
    parse([
      {
        t: 'text',
        s: '> quoted\n> again\n\n---\n\nplain\nline\n\n```js\n<b>inert</b>\n```',
      },
    ]),
    [
      {
        type: 'blockquote',
        lines: [[{ t: 'text', s: 'quoted' }], [{ t: 'text', s: 'again' }]],
      },
      { type: 'rule' },
      {
        type: 'paragraph',
        lines: [[{ t: 'text', s: 'plain' }], [{ t: 'text', s: 'line' }]],
      },
      { type: 'code', language: 'js', text: '<b>inert</b>' },
    ],
  );
});

test('markdown: pipe tables carry alignment, math cells, and escaped pipes', () => {
  assert.deepEqual(
    parse([
      { t: 'text', s: '| name | value |\n| :--- | ---: |\n| ' },
      { t: 'math', m: 'inline', s: 'x' },
      { t: 'text', s: ' | a \\| b |\n| lone |' },
    ]),
    [
      {
        type: 'table',
        align: ['left', 'right'],
        header: [[{ t: 'text', s: 'name' }], [{ t: 'text', s: 'value' }]],
        rows: [
          [[{ t: 'math', m: 'inline', s: 'x' }], [{ t: 'text', s: 'a | b' }]],
          [[{ t: 'text', s: 'lone' }], []],
        ],
      },
    ],
  );
});

test('markdown: tables need a matching delimiter row', () => {
  assert.deepEqual(
    parse([{ t: 'text', s: 'a | b\n--- | --- | ---' }]),
    [
      {
        type: 'paragraph',
        lines: [[{ t: 'text', s: 'a | b' }], [{ t: 'text', s: '--- | --- | ---' }]],
      },
    ],
  );
});

test('markdown: a headerless pipe table stays a paragraph', () => {
  const blocks = parse([{ t: 'text', s: 'cost | 3 | 4\nother | 5 | 6' }]);
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph']);
});

test('formatTable: pads columns and writes the alignment row', () => {
  assert.equal(
    formatTable(['name', 'value'], [['a', '1'], ['bb', '22']], ['', 'right']),
    ['| name | value |', '| ---- | ----: |', '| a    | 1     |', '| bb   | 22    |'].join('\n'),
  );
});

test('formatTable: escapes pipes, flattens newlines, fills ragged rows', () => {
  assert.equal(
    formatTable(['a | b'], [['x\ny'], []], []),
    ['| a \\| b |', '| ------ |', '| x y    |', '|        |'].join('\n'),
  );
});

test('formatTable: a headerless selection omits the delimiter row', () => {
  assert.equal(formatTable(null, [['a', 'b']], []), '| a   | b   |');
  assert.equal(formatTable(null, [], []), '');
});

test('formatTable: output re-parses to the table it came from', () => {
  const source = '| a | b |\n| :-- | --: |\n| 1 | 2 |';
  const table = parse([{ t: 'text', s: source }])[0];
  const flatten = (cells) => cells.map((c) => c.map((t) => t.s).join(''));
  const round = formatTable(flatten(table.header), table.rows.map(flatten), table.align);
  assert.deepEqual(parse([{ t: 'text', s: round }]), [table]);
});

test('markdown: raw HTML remains ordinary paragraph text', () => {
  assert.deepEqual(parse([{ t: 'text', s: '<img src=x onerror=alert(1)>' }]), [
    {
      type: 'paragraph',
      lines: [[{ t: 'text', s: '<img src=x onerror=alert(1)>' }]],
    },
  ]);
});

test('clipboard: headings, emphasis, quotes, and enumerations become Markdown', () => {
  const rendered = fragment([
    element('h2', {}, [
      text('Result '),
      element('em', {}, [text('carefully')]),
      text(' with '),
      math('inline', 'x'),
    ]),
    element('blockquote', {}, [
      text('quoted'),
      element('br'),
      element('strong', {}, [text('again')]),
    ]),
    element('ul', {}, [
      element('li', {}, [text('one')]),
      element('li', {}, [element('em', {}, [text('two')])]),
    ]),
    element('ol', {}, [
      element('li', { value: '1' }, [text('first')]),
      element('li', { value: '2' }, [text('second')]),
    ]),
  ]);

  assert.equal(
    serializeMarkdown(rendered),
    [
      '## Result *carefully* with $x$',
      '',
      '> quoted',
      '> **again**',
      '',
      '- one',
      '- *two*',
      '',
      '1. first',
      '2. second',
    ].join('\n'),
  );
});

test('clipboard: tables retain inline Markdown, alignment, and math', () => {
  const table = element('table', {}, [
    element('thead', {}, [
      element('tr', {}, [
        element('th', { class: 'md-align-left' }, [element('em', {}, [text('name')])]),
        element('th', { class: 'md-align-right' }, [text('value')]),
      ]),
    ]),
    element('tbody', {}, [
      element('tr', {}, [
        element('td', { class: 'md-align-left' }, [math('inline', 'x')]),
        element('td', { class: 'md-align-right' }, [element('em', {}, [text('two')])]),
      ]),
    ]),
  ]);

  assert.equal(
    serializeMarkdown(table),
    formatTable(['*name*', 'value'], [['$x$', '*two*']], ['left', 'right']),
  );
});

test('clipboard: paragraphs, code, and rules retain the rendered subset', () => {
  const rendered = fragment([
    element('div', { class: 'md-paragraph' }, [
      text('Use '),
      element('code', {}, [text('x')]),
      text('.'),
    ]),
    element('hr'),
    element('pre', { 'data-language': 'js' }, [element('code', {}, [text('a\nb')])]),
  ]);

  assert.equal(
    serializeMarkdown(rendered),
    ['Use `x`.', '', '---', '', '```js', 'a', 'b', '```'].join('\n'),
  );
});

test('clipboard: a partial list selection regains its real rendered ancestors', () => {
  const selected = text('art');
  const emphasis = element('em', {}, [selected]);
  const item = element('li', { value: '7' }, [emphasis]);
  const ordered = element('ol', {}, [item]);
  const body = element('div', { class: 'message-body' }, [ordered]);
  const log = element('main', {}, [body]);
  const range = {
    startContainer: selected,
    endContainer: selected,
    commonAncestorContainer: selected,
    cloneRange() { return this; },
    cloneContents() { return fragment([text('art')]); },
    setStartBefore() {},
    setEndAfter() {},
  };

  const contextual = cloneSelectionWithContext(range, log);
  assert.equal(serializeMarkdown(contextual), '7. *art*');
});

test('clipboard: a partial heading selection regains heading and emphasis markers', () => {
  const selected = text('art');
  const emphasis = element('em', {}, [selected]);
  const heading = element('h3', {}, [emphasis]);
  const body = element('div', { class: 'message-body' }, [heading]);
  const log = element('main', {}, [body]);
  const range = {
    startContainer: selected,
    endContainer: selected,
    commonAncestorContainer: selected,
    cloneRange() { return this; },
    cloneContents() { return fragment([text('art')]); },
    setStartBefore() {},
    setEndAfter() {},
  };

  const contextual = cloneSelectionWithContext(range, log);
  assert.equal(serializeMarkdown(contextual), '### *art*');
});

test('clipboard: a partial equation selection widens to the complete source', () => {
  const formula = math('inline', 'x+y');
  const annotationText = formula.childNodes[1].childNodes[0];
  const paragraph = element('div', { class: 'md-paragraph' }, [formula]);
  const body = element('div', { class: 'message-body' }, [paragraph]);
  const log = element('main', {}, [body]);
  const calls = [];
  const range = {
    startContainer: annotationText,
    endContainer: annotationText,
    commonAncestorContainer: annotationText,
    cloneRange() { return this; },
    setStartBefore(node) {
      calls.push(['start', node]);
      this.commonAncestorContainer = paragraph;
    },
    setEndAfter(node) {
      calls.push(['end', node]);
      this.commonAncestorContainer = paragraph;
    },
    cloneContents() { return fragment([formula.cloneNode(true)]); },
  };

  const contextual = cloneSelectionWithContext(range, log);
  assert.deepEqual(calls, [['start', formula], ['end', formula]]);
  assert.equal(serializeMarkdown(contextual), '$x+y$');
});
