// Run: `node --test test/search-highlight.test.js`.
// Input: the AIChatRender webview template and extension host source.
// Output: assertions that a source-search query reaches the panel and that the
//   panel highlights the matching formulas.
//
// These are source-level assertions. The webview script is an IIFE that needs
// KaTeX and a live DOM, and the project has no browser harness, so what is
// checked here is the contract across the extension/webview boundary — the part
// that breaks silently, because a dropped `query` field still scrolls correctly
// and merely stops highlighting.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_DIR = path.join(__dirname, '..');
const html = () => fs.readFileSync(path.join(EXTENSION_DIR, 'media', 'index.html'), 'utf8');
const host = () => fs.readFileSync(path.join(EXTENSION_DIR, 'extension.js'), 'utf8');

// Rendering consumes the TeX: `\theta` reaches the DOM as θ. Keeping the source
// on the element is the whole basis of the highlight, so it has to be set on
// every formula, not just the ones KaTeX renders without complaint.
test('search highlight: every rendered formula carries its TeX source', () => {
  const body = html();
  const fn = body.slice(body.indexOf('function appendMath('));
  const decl = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(decl, /el\.dataset\.tex = span\.s;/);
  assert.ok(
    decl.indexOf('el.dataset.tex') < decl.indexOf('katex.render'),
    'set before rendering, so a KaTeX failure still leaves the source searchable',
  );
});

test('search highlight: the panel marks matching formulas and scrolls to the first', () => {
  const body = html();
  const fn = body.slice(body.indexOf('function markMath('));
  const decl = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(decl, /querySelectorAll\('\.math\[data-tex\]'\)/);
  assert.match(decl, /dataset\.tex\.toLowerCase\(\)/, 'case-insensitive, matching the search');
  assert.match(decl, /classList\.add\('hit'\)/);
  assert.match(decl, /return first;/, 'returns the first hit for the caller to scroll to');
  assert.match(body, /\.math\.hit \{/, 'the hit class is styled');
});

// A query that matched only prose highlights nothing, and a message that has
// scrolled out of the retained window is not found at all. Neither may strand
// the reader at an unmarked position with no indication of where they landed.
test('search highlight: a message with no marked formula still flashes', () => {
  const body = html();
  const fn = body.slice(body.indexOf('function gotoMessage('));
  const decl = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(decl, /markMath\(target, query\)/);
  assert.match(decl, /flash\(target\)/, 'falls back to the whole-message flash');
  assert.ok(
    decl.indexOf('clearHits()') < decl.indexOf('querySelector'),
    'clears the previous jump first, so a stale key does not leave old marks up',
  );
});

// Highlights must not outlive the picker they belong to: dismissing restores the
// reader's position, and marks left behind would point at a hit they rejected.
test('search highlight: ending a preview clears the marks', () => {
  const body = html();
  const fn = body.slice(body.indexOf('function endPreview('));
  const decl = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(decl, /clearHits\(\)/);
});

test('search highlight: the query crosses the extension/webview boundary', () => {
  const body = html();
  const source = host();
  assert.match(source, /postMessage\(\{ type: 'gotoMessage', key, query \}\)/);
  assert.match(source, /postMessage\(\{ type: 'previewMessage', key, query \}\)/);
  assert.match(body, /m\.type === 'gotoMessage'\) gotoMessage\(m\.key, m\.query\)/);
  assert.match(body, /m\.type === 'previewMessage'\) previewMessage\(m\.key, m\.query\)/);

  // The search passes its query on both the preview and the accepted jump; the
  // turn picker passes none, which is what keeps its behaviour a plain jump.
  assert.match(source, /postPreview\(active\.key, query\)/);
  assert.match(source, /if \(picked\) postGoto\(picked\.key, query\)/);
  assert.match(source, /if \(!picked\) return;\n\s*postGoto\(picked\.key\);/);
});

// A goto issued before the webview reports ready is replayed on ready; the
// query has to survive that hop or the first search after opening the panel
// scrolls without highlighting.
test('search highlight: a deferred goto replays the query', () => {
  const source = host();
  assert.match(source, /pendingGoto = \{ key, query \};/);
  assert.match(source, /postGoto\(pendingGoto\.key, pendingGoto\.query\)/);
});
