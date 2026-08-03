// Run: `node --test .tools/aichatrender/extension/test/copy-tex.test.js`.
// Input: the pinned KaTeX copy-tex asset and AIChatRender webview template.
// Output: assertions for vendor integrity and clipboard-script load order.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_DIR = path.join(__dirname, '..');
const COPY_TEX_SHA256 =
  'c571c49b520cb8e9040287338286b21783e39b476660b8b56d9e1c037eeaeaff';

test('copy-tex: vendored asset matches the pinned KaTeX 0.16.47 tarball', () => {
  const asset = fs.readFileSync(
    path.join(EXTENSION_DIR, 'media', 'katex', 'copy-tex.min.js'),
  );
  assert.equal(asset[asset.length - 1], 0x0a);
  assert.equal(
    crypto.createHash('sha256').update(asset.subarray(0, -1)).digest('hex'),
    COPY_TEX_SHA256,
  );
});

test('copy-tex: webview loads it after KaTeX and before AIChatRender rendering', () => {
  const html = fs.readFileSync(path.join(EXTENSION_DIR, 'media', 'index.html'), 'utf8');
  const katexAt = html.indexOf('src="{{katexJs}}"');
  const copyTexAt = html.indexOf('src="{{copyTexJs}}"');
  const markdownAt = html.indexOf('src="{{markdownJs}}"');
  assert.ok(katexAt >= 0);
  assert.ok(copyTexAt > katexAt);
  assert.ok(markdownAt > copyTexAt);

  const host = fs.readFileSync(path.join(EXTENSION_DIR, 'extension.js'), 'utf8');
  assert.match(
    host,
    /\.replaceAll\('\{\{copyTexJs\}\}', mediaUri\('katex', 'copy-tex\.min\.js'\)\)/,
  );
});

// The table serialiser must win over copy-tex for selections holding a table,
// and stay out of the way otherwise. copy-tex listens on the bubble phase, so
// ours has to be registered with capture and must bail before preventDefault
// when the fragment has no table in it.
test('copy-tex: the table copy handler captures and defers when there is no table', () => {
  const html = fs.readFileSync(path.join(EXTENSION_DIR, 'media', 'index.html'), 'utf8');
  const handler = html.slice(html.indexOf("addEventListener('copy'"));
  assert.ok(handler.startsWith("addEventListener('copy'"), 'copy handler present');
  const body = handler.slice(0, handler.indexOf('}, true);') + '}, true);'.length);
  assert.match(body, /}, true\);$/, 'registered on the capture phase');
  assert.ok(
    body.indexOf("querySelector('table')") < body.indexOf('preventDefault'),
    'bails on table-free selections before taking over the clipboard',
  );
  assert.match(body, /stopImmediatePropagation/);
});
