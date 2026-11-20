// Run: node --test chatview/test/*.test.js
// Inputs: temporary Claude and Codex JSONL fixtures.
// Output: assertions for the live HTTP/SSE viewer.
'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { serve } = require('../server');
const { discoverSessions, followSession } = require('../sessions');

const timestamp = '2026-11-19T10:00:00.000Z';
function prompt(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp }) + '\n';
}

function codexLine(type, payload) {
  return JSON.stringify({ type, payload, timestamp }) + '\n';
}

function fixtures(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chatview-test-'));
  const previous = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = path.join(temporary, 'claude');
  process.env.CODEX_HOME = path.join(temporary, 'codex');
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'test-project');
  const codex = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '19');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  return { claude: path.join(project, 'test-session.jsonl'), codex };
}

async function* events(body) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const bytes of body) {
    pending += decoder.decode(bytes, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      assert.ok(frame.startsWith('data: '), frame);
      yield JSON.parse(frame.slice(6));
    }
  }
}

async function startViewer(t, port = 0, hostPort) {
  let printedUrl;
  const server = serve(port, hostPort, (url) => { printedUrl = new URL(url); });
  const stop = async () => {
    if (!server.listening) return;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  };
  t.after(stop);
  await once(server, 'listening');
  const localPort = server.address().port;
  return { localPort, printedUrl, stop };
}

async function checkStop(t, command) {
  // Use a separate checkout path and an ephemeral port so this test cannot
  // stop a viewer the user is running.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chatview-stop.'));
  const checkout = path.join(temporary, 'aichatrender');
  const skip = new Set(['.git', 'node_modules']);
  fs.cpSync(path.join(__dirname, '..', '..'), checkout, {
    recursive: true, filter: (source) => !skip.has(path.basename(source)),
  });
  const script = path.join(checkout, 'chatview', 'server.js');
  const startCheck = spawnSync(process.execPath, [script, command], {
    encoding: 'utf8', timeout: 2000, env: { ...process.env, CHATVIEW_HOST_PORT: 'invalid' },
  });
  const viewer = spawn(process.execPath, ['-e', `
    process.title = ${JSON.stringify(`${process.execPath} ${script} ${command}`)};
    require(${JSON.stringify(script)}).serve(0, undefined, (url) => console.log(new URL(url).port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(viewer, 'exit');
  t.after(async () => {
    viewer.kill();
    await exited;
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  assert.equal(startCheck.status, 1);
  assert.match(startCheck.stderr, /CHATVIEW_HOST_PORT must be a valid TCP port/);
  const [chunk] = await once(viewer.stdout, 'data', { signal: t.signal });
  const url = 'http://127.0.0.1:' + String(chunk).trim();
  assert.equal((await fetch(url)).status, 403);

  const stop = () => spawnSync(process.execPath, [script, 'stop'], { encoding: 'utf8', timeout: 7000 });
  const result = stop();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Stopped the chat viewer/);
  assert.deepEqual(await exited, [null, 'SIGTERM']);
  await assert.rejects(fetch(url));

  const repeated = stop();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /No chat viewer is running/);
}

for (const command of ['start', 'serve']) {
  test(`the stop command terminates a viewer launched with ${command} and succeeds when repeated`,
    { timeout: 8000 }, (t) => checkStop(t, command));
}

test('the browser header shows CHATVIEW_LABEL, escaped, only when set', async (t) => {
  const previous = process.env.CHATVIEW_LABEL;
  t.after(() => {
    if (previous === undefined) delete process.env.CHATVIEW_LABEL;
    else process.env.CHATVIEW_LABEL = previous;
  });
  const { printedUrl } = await startViewer(t);
  for (const [value, shown] of [['YOLO', 'YOLO'], ['<b>$&', '&#60;b&#62;&#36;&#38;'], [undefined, undefined]]) {
    if (value === undefined) delete process.env.CHATVIEW_LABEL;
    else process.env.CHATVIEW_LABEL = value;
    const response = await fetch(printedUrl);
    assert.equal(response.status, 200);
    const html = await response.text();
    if (shown === undefined) assert.doesNotMatch(html, /class="chatview-environment"/);
    else assert.ok(html.includes(`<span class="chatview-environment">${shown}</span>`));
  }
});

test('requires credentials on every route and invalidates the URL and cookie on restart', { timeout: 8000 }, async (t) => {
  const { localPort, printedUrl, stop } = await startViewer(t, 0, 17711);
  assert.equal(printedUrl.port, '17711');
  const base = 'http://127.0.0.1:' + localPort;
  const host = '127.0.0.1:17711';
  // Fetch can replace the Host header. Send it directly to exercise the check.
  async function request(route, headers) {
    const req = http.get(base + route, { headers });
    const [response] = await once(req, 'response');
    response.setEncoding('utf8');
    let body = '';
    for await (const chunk of response) body += chunk;
    return { status: response.statusCode, headers: response.headers, body };
  }
  for (const route of ['/', '/sessions', '/events?session=test', '/chatview.js', '/media/katex/katex.min.css']) {
    const denied = await request(route, { Host: host });
    assert.equal(denied.status, 403);
    assert.equal(denied.body, '');
    assert.equal(denied.headers['set-cookie'], undefined);
  }
  for (const invalid of ['short', '0'.repeat(32)]) {
    const denied = await fetch(base + '/?t=' + invalid, { headers: { Cookie: 'chatview=' + invalid } });
    assert.equal(denied.status, 403);
  }

  const original = await request('/' + printedUrl.search, { Host: host });
  assert.equal(original.status, 200);
  assert.equal(original.headers['referrer-policy'], 'no-referrer');
  const [setCookie] = original.headers['set-cookie'];
  assert.ok(/^chatview=[0-9a-f]{32}; HttpOnly; SameSite=Strict; Path=\/$/.test(setCookie),
    'viewer sets the expected token cookie attributes');
  const [cookie] = setCookie.split(';');
  assert.equal((await request('/sessions', { Cookie: cookie, Host: 'foreign.test' })).status, 403);

  await stop();
  const restarted = await startViewer(t, localPort, 17711);
  assert.equal((await fetch(base + '/' + printedUrl.search)).status, 403);
  assert.equal((await fetch(base + '/', { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(base + '/' + restarted.printedUrl.search)).status, 200);
});

test('serves the browser shell and follows complete JSONL records across writes and reconnects', { timeout: 8000 }, async (t) => {
  const { claude } = fixtures(t);
  fs.writeFileSync(claude, prompt('First prompt') + '{"type":"custom-title","customTitle":"Named session"}\n');
  fs.writeFileSync(path.join(path.dirname(claude), 'other-session.jsonl'), prompt('Other session'));
  const { printedUrl } = await startViewer(t);
  const shell = await fetch(printedUrl, { signal: t.signal });
  assert.equal(shell.status, 200);
  const [cookie] = shell.headers.get('set-cookie').split(';');
  const get = (route, headers) => fetch(printedUrl.origin + route, {
    signal: t.signal, headers: { Cookie: cookie, ...headers },
  });
  const html = await shell.text();
  assert.match(html, /connect-src 'self'/);
  assert.match(html, /src="\/chatview\.js"/);
  assert.doesNotMatch(html, /\{\{nonce\}\}/);
  assert.equal((await get('/chatview.js')).status, 200);
  assert.equal((await get('/media/katex/fonts/KaTeX_Main-Regular.woff2')).status, 200);
  assert.equal((await get('/sessions', { Origin: 'http://example.test' })).status, 403);
  assert.equal((await get('/events?session=..%2Foutside.jsonl')).status, 404);
  const sessions = await (await get('/sessions')).json();
  const session = sessions.find(({ id }) => id === 'test-session');
  assert.equal(session.provider, 'claude');
  assert.equal(session.title, 'Named session');

  const route = '/events?' + new URLSearchParams({ session: session.key });
  const response = await get(route);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const messages = events(response.body);
  assert.equal((await messages.next()).value.entries[0].spans[0].s, 'First prompt');
  const next = Buffer.from(prompt('Second prompt λ'));
  const split = next.indexOf(Buffer.from('λ')) + 1;
  fs.appendFileSync(claude, next.subarray(0, split));
  assert.equal((await messages.next()).value.entries.length, 1);
  fs.appendFileSync(claude, next.subarray(split));
  const updated = (await messages.next()).value;
  assert.equal(updated.entries[1].spans[0].s, 'Second prompt λ');
  await messages.return();

  const reconnect = events((await get(route)).body);
  assert.deepEqual((await reconnect.next()).value, updated);
  await reconnect.return();

  const other = sessions.find(({ id }) => id === 'other-session');
  const switched = events((await get('/events?' + new URLSearchParams({ session: other.key }))).body);
  assert.equal((await switched.next()).value.entries[0].spans[0].s, 'Other session');
  await switched.return();
});

test('follows a Codex fork including only the inherited prefix', (t) => {
  const { codex } = fixtures(t);
  const parentId = '00000000-0000-0000-0000-000000000001';
  const childId = '00000000-0000-0000-0000-000000000002';
  const parent = path.join(codex, 'rollout-parent-' + parentId + '.jsonl');
  const child = path.join(codex, 'rollout-child-' + childId + '.jsonl');
  const prefix = codexLine('session_meta', { id: parentId, cwd: '/tmp' })
    + codexLine('event_msg', { type: 'user_message', message: 'Inherited prompt' });
  fs.writeFileSync(parent, prefix + codexLine('event_msg', { type: 'user_message', message: 'Parent continued' }));
  const childText = 'Child prompt';
  fs.writeFileSync(child, codexLine('session_meta', {
    id: childId, cwd: '/tmp', history_base: { thread_id: parentId, end_byte_offset: Buffer.byteLength(prefix) },
  }) + codexLine('event_msg', { type: 'user_message', message: childText }));

  const { sessions } = discoverSessions();
  const poll = followSession(sessions, sessions.find(({ id }) => id === childId));
  const snapshot = poll();
  assert.deepEqual(snapshot.entries.map(({ spans }) => spans.map(({ s }) => s).join('')), ['Inherited prompt', childText]);
});
