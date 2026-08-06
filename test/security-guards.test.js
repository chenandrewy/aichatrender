// Guard tests for the regression rules in dev/security-findings.md. Each test
// mechanically checks an invariant of the shipped first-party source, so a
// future change that reintroduces a listener, a network asset, an executable
// rendering sink, or a transcript write fails loudly here instead of shipping.
// Vendored KaTeX (media/katex/**) is third-party and deliberately not scanned.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Everything first-party that ships in the .vsix and runs at runtime.
const SHIPPED = [
  'extension.js',
  'transcript.js',
  'codex.js',
  'codex-tools.js',
  'tool-presentation.js',
  'active-terminal.js',
  'export.js',
  'media/markdown.js',
  'media/index.html',
];

const sources = new Map(
  SHIPPED.map((rel) => [rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')]),
);

function offenders(pattern) {
  const hits = [];
  for (const [rel, text] of sources) {
    if (pattern.test(text)) hits.push(rel);
  }
  return hits;
}

test('rule 1: no HTTP listener, socket, or delivery endpoint', () => {
  assert.deepStrictEqual(
    offenders(/require\(['"](?:node:)?(?:http|https|net|tls|dgram|ws)['"]\)/),
    [],
  );
  assert.deepStrictEqual(offenders(/\.listen\(/), []);
});

test('rule 2: no runtime assets or connections from a network origin', () => {
  const html = sources.get('media/index.html');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  assert.ok(csp, 'webview must declare a CSP');
  assert.ok(csp[1].startsWith("default-src 'none'"));
  assert.ok(csp[1].includes("connect-src 'none'"));
  assert.ok(csp[1].includes("img-src 'none'"));
  assert.ok(csp[1].includes("script-src 'nonce-{{nonce}}'"));
  // No element in the page may reference a network URL.
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:/i);
  assert.deepStrictEqual(
    offenders(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/),
    [],
  );
});

test('rule 3: no executable sinks for transcript-derived data', () => {
  assert.deepStrictEqual(
    offenders(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/),
    [],
  );
  assert.deepStrictEqual(offenders(/\beval\s*\(|new Function/), []);
});

test('rule 4: no filesystem writes — no second history, no agent config edits', () => {
  assert.deepStrictEqual(
    offenders(
      /\bfs\.(?:write|append|createWriteStream|mkdir|rm|unlink|rename|truncate|chmod|chown|cp|copyFile|link|symlink|utimes)/,
    ),
    [],
  );
});

test('subprocess use is confined to active-terminal.js, execFileSync only', () => {
  for (const [rel, text] of sources) {
    if (rel === 'active-terminal.js') {
      // The only thing taken from child_process is execFileSync — no shell,
      // no spawn, and exactly one import to audit.
      const imports = text.match(/require\(['"](?:node:)?child_process['"]\)/g);
      assert.strictEqual(imports && imports.length, 1);
      assert.match(
        text,
        /const \{ execFileSync \} = require\('child_process'\);/,
      );
    } else {
      assert.doesNotMatch(text, /child_process/);
    }
  }
});

test('macOS utilities are invoked by fixed absolute paths, not PATH', () => {
  const text = sources.get('active-terminal.js');
  for (const utility of ['pgrep', 'lsof', 'ps']) {
    assert.ok(
      new RegExp(`'/(?:usr/(?:s?bin)|bin)/${utility}'`).test(text),
      `${utility} must be listed by absolute path`,
    );
  }
  // execFileSync must be reached only through the utilityPath gate.
  assert.strictEqual((text.match(/execFileSync\(/g) || []).length, 1);
  assert.match(text, /utilityPath\(/);
});
