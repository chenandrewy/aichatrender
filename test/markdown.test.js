// Run: `node --test .tools/aichatrender/extension/test/markdown.test.js`.
// Input: synthetic text/math spans.
// Output: assertions for AIChatRender's safe Markdown block model.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, formatTable } = require('../media/markdown');

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

test('markdown: unordered and ordered outlines form separate lists', () => {
  assert.deepEqual(
    parse([{ t: 'text', s: '- first\n- second\n\n1. one\n2. two' }]),
    [
      {
        type: 'list',
        ordered: false,
        items: [[{ t: 'text', s: 'first' }], [{ t: 'text', s: 'second' }]],
      },
      {
        type: 'list',
        ordered: true,
        items: [[{ t: 'text', s: 'one' }], [{ t: 'text', s: 'two' }]],
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
