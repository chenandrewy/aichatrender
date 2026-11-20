// Run: node --test chatview/test/*.test.js
// Inputs: the browser renderer and synthetic live history snapshots.
// Output: assertions for reader position and follow-at-bottom behavior.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('live redraws preserve the visible turn unless the reader is following the bottom', () => {
  const articleHeight = 100;
  const viewportHeight = 200;
  let scrollY = 0;
  let receive;

  function element() {
    return { dataset: {}, children: [], appendChild(child) { this.children.push(child); }, setAttribute() {} };
  }

  const log = {
    children: [],
    appendChild(child) { this.children.push(child); },
    replaceChildren(fragment) {
      this.children = fragment?.children || [];
      // Replacing the whole transcript can reset native scroll anchoring.
      scrollY = 0;
    },
    querySelectorAll() { return this.children; },
    querySelector(selector) {
      const key = /\[data-key="(\d+)"\]/.exec(selector)[1];
      return this.children.find((article) => article.dataset.key === key);
    },
  };
  const turnIndex = {
    scrollTop: 0,
    replaceChildren() { this.scrollTop = 0; },
    appendChild() {},
    addEventListener() {},
  };
  const scroller = {
    clientHeight: viewportHeight,
    get scrollTop() { return scrollY; },
    get scrollHeight() { return Math.max(viewportHeight, log.children.length * articleHeight); },
  };
  const elements = { log, 'turn-index': turnIndex, status: {}, notice: {} };
  const document = {
    scrollingElement: scroller,
    body: scroller,
    getElementById(id) { return elements[id]; },
    addEventListener() {},
    createDocumentFragment: element,
    createElement() {
      const node = element();
      node.getBoundingClientRect = () => {
        const top = log.children.indexOf(node) * articleHeight - scrollY;
        return { top, bottom: top + articleHeight };
      };
      return node;
    },
  };
  const window = {
    innerHeight: viewportHeight,
    get scrollY() { return scrollY; },
    scrollTo(position, y) {
      const top = typeof position === 'object' ? position.top : y;
      scrollY = Math.max(0, Math.min(top, scroller.scrollHeight - viewportHeight));
    },
    chatviewSubscribe(callback) { receive = callback; },
  };
  const html = fs.readFileSync(path.join(__dirname, '../../media/index.html'), 'utf8');
  const [, script] = /<script nonce="\{\{nonce\}\}">([\s\S]*?)<\/script>/.exec(html);
  vm.runInNewContext(script, { document, window, AIChatRenderMarkdown: require('../../media/markdown') });

  const entries = Array.from({ length: 8 }, (_, index) => ({
    key: index + 1, role: 'user', tsDisplay: '', spans: [],
  }));
  const render = (items) => receive({ type: 'replaceHistory', entries: items });
  render(entries.slice(0, 6));
  assert.equal(scrollY, 400);

  scrollY = 250;
  turnIndex.scrollTop = 75;
  render(entries.slice(1, 7));
  assert.equal(scrollY, 150, 'turn 3 stays at the same viewport offset after turn 1 is trimmed');
  assert.equal(turnIndex.scrollTop, 75);

  scrollY = 400;
  render(entries.slice(1));
  assert.equal(scrollY, 500, 'an update follows the bottom when the reader was there already');
});
