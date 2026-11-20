#!/usr/bin/env node
// Run: chatview/bin/chatview start | chatview/bin/chatview stop
//   (the wrapper passes this file's absolute path, which `stop` matches)
// Inputs: Claude and Codex JSONL in their local session stores
//   ($CLAUDE_CONFIG_DIR or ~/.claude, $CODEX_HOME or ~/.codex).
// Output: an HTTP/SSE browser viewer or its shutdown status.
// Environment (all optional):
//   CHATVIEW_PORT       port to listen on (default 7710; 0 picks a free one)
//   CHATVIEW_BIND       address to listen on (default 127.0.0.1; use 0.0.0.0
//                       inside a container whose port is published)
//   CHATVIEW_HOST_PORT  port shown in the printed URL when it differs from the
//                       listening port, e.g. behind a Docker port mapping
//   CHATVIEW_LABEL      short text shown in the header, e.g. a machine name
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { discoverSessions, listSessions, followSession } = require('./sessions');

const MEDIA = path.join(__dirname, '..', 'media');
const BROWSER_SCRIPT = path.join(__dirname, 'browser.js');
const ASSETS = {
  katexCss: 'katex/katex.min.css',
  katexJs: 'katex/katex.min.js',
  copyTexJs: 'katex/copy-tex.min.js',
  markdownJs: 'markdown.js',
};
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};
const USAGE = 'Usage: chatview start | chatview stop';
const START_COMMANDS = ['start', 'serve'];
const DEFAULT_PORT = 7710;
const DEFAULT_BIND = '127.0.0.1';
const POLL_MS = 750;
const MAX_STREAMS = 8;

function escapeHtml(text) {
  // `$` too: the result goes through String.prototype.replace below.
  return text.replace(/[&<>"'$]/g, (c) => '&#' + c.charCodeAt(0) + ';');
}

function browserPage() {
  const nonce = randomBytes(16).toString('base64');
  const label = process.env.CHATVIEW_LABEL;
  const template = fs.readFileSync(path.join(MEDIA, 'index.html'), 'utf8');
  const theme = fs.readFileSync(path.join(__dirname, 'browser.css'), 'utf8');
  let html = template
    .replace('<!-- browser-head -->', () => '<style nonce="{{nonce}}">' + theme + '</style>')
    .replace("connect-src 'none'", "connect-src 'self'")
    .replaceAll('{{cspSource}}', "'self'")
    .replace('<!-- browser-controls -->', [
      '<header class="chatview-controls">',
      label ? '<span class="chatview-environment">' + escapeHtml(label) + '</span>' : '',
      '<label for="chatview-session">Session</label>',
      '<select id="chatview-session" disabled></select>',
      '<button id="chatview-refresh" type="button">Refresh</button>',
      '<span id="chatview-connection" role="status">Loading sessions…</span>',
      '</header>',
    ].join('\n'))
    .replace('<!-- browser-adapter -->', '<script nonce="{{nonce}}" src="/chatview.js"></script>');
  for (const [key, file] of Object.entries(ASSETS)) {
    html = html.replaceAll('{{' + key + '}}', '/media/' + file);
  }
  return html.replaceAll('nonce="{{nonce}}"', 'nonce="' + nonce + '"')
    .replaceAll("'nonce-{{nonce}}'", "'nonce-" + nonce + "'");
}

function send(response, code, content, type = 'text/plain; charset=utf-8') {
  response.writeHead(code, { 'Content-Type': type });
  response.end(content);
}

function sendEvents(response, poll, onClose) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  response.flushHeaders();
  let lastWrite = Date.now();
  let lastError = '';
  let lastSnapshot;
  const write = (event) => {
    response.write(event);
    lastWrite = Date.now();
  };
  const tick = () => {
    if (response.destroyed) return;
    if (response.writableNeedDrain) {
      if (Date.now() - lastWrite > 30_000) response.destroy();
      return;
    }
    try {
      const snapshot = poll();
      if (snapshot || lastError) {
        lastError = '';
        if (snapshot) lastSnapshot = JSON.stringify(snapshot);
        if (lastSnapshot) write('data: ' + lastSnapshot + '\n\n');
      } else if (Date.now() - lastWrite > 15_000) {
        write(': heartbeat\n\n');
      }
    } catch (error) {
      const message = error.code ? 'Waiting for the transcript to become available…' : error.message;
      if (message !== lastError || Date.now() - lastWrite > 15_000) {
        write('event: transcript-error\ndata: ' + JSON.stringify(message) + '\n\n');
        lastError = message;
      }
    }
  };
  const timer = setInterval(tick, POLL_MS);
  response.once('close', () => {
    clearInterval(timer);
    onClose();
  });
  tick();
}

function matchesToken(value, token) {
  if (typeof value !== 'string') return false;
  const supplied = Buffer.from(value, 'utf8');
  return supplied.length === token.length && timingSafeEqual(supplied, token);
}

function serve(port, hostPort, onReady = () => {}, bind = DEFAULT_BIND) {
  const token = randomBytes(16).toString('hex');
  const tokenBytes = Buffer.from(token, 'utf8');
  const hosts = new Set();
  const assets = new Map(Object.values(ASSETS).map((file) => ['/media/' + file, path.join(MEDIA, file)]));
  const fonts = path.join(MEDIA, 'katex', 'fonts');
  for (const file of fs.readdirSync(fonts)) {
    if (Object.hasOwn(CONTENT_TYPES, path.extname(file))) {
      assets.set('/media/katex/fonts/' + file, path.join(fonts, file));
    }
  }
  assets.set('/chatview.js', BROWSER_SCRIPT);
  let streams = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!hosts.has(request.headers.host)) return response.writeHead(403).end();
    try {
      const viewerOrigin = 'http://' + request.headers.host;
      const url = new URL(request.url, viewerOrigin);
      if (url.origin !== viewerOrigin) return response.writeHead(403).end();
      const validQuery = matchesToken(url.searchParams.get('t'), tokenBytes);
      const cookie = /(?:^|;\s*)chatview=([^;]*)/.exec(request.headers.cookie || '')?.[1];
      if (!validQuery && !matchesToken(cookie, tokenBytes)) return response.writeHead(403).end();
      if (validQuery) response.setHeader('Set-Cookie', 'chatview=' + token + '; HttpOnly; SameSite=Strict; Path=/');
      if (request.method !== 'GET') return send(response, 405, 'Method not allowed.');
      if (url.pathname === '/') return send(response, 200, browserPage(), 'text/html; charset=utf-8');
      const asset = assets.get(url.pathname);
      if (asset) return send(response, 200, fs.readFileSync(asset), CONTENT_TYPES[path.extname(asset)]);
      if (url.pathname !== '/sessions' && url.pathname !== '/events') {
        return send(response, 404, 'Not found.');
      }
      const origin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      if ((origin && origin !== viewerOrigin) || (fetchSite && fetchSite !== 'same-origin')) {
        return response.writeHead(403).end();
      }
      const catalog = discoverSessions();
      if (url.pathname === '/sessions') {
        return send(response, 200, JSON.stringify(listSessions(catalog)), 'application/json; charset=utf-8');
      }
      const session = catalog.sessions.find((entry) => entry.key === url.searchParams.get('session'));
      if (!session) return send(response, 404, 'Session not found.');
      if (streams >= MAX_STREAMS) return send(response, 503, 'Too many viewer tabs.');
      streams++;
      sendEvents(response, followSession(catalog.sessions, session), () => { streams--; });
    } catch (error) {
      console.error('chatview:', error.message);
      if (response.headersSent) response.destroy();
      else send(response, 500, 'Could not read the viewer or session store.');
    }
  });
  server.listen(port, bind, () => {
    const localPort = server.address().port;
    const publicPort = hostPort ?? localPort;
    for (const n of [localPort, publicPort]) {
      hosts.add('127.0.0.1:' + n);
      hosts.add('localhost:' + n);
    }
    onReady('http://127.0.0.1:' + publicPort + '/?t=' + token);
  });
  return server;
}

async function stopViewer() {
  // Find viewers started from this checkout by their full command line. Only
  // short options that procps (Linux) and BSD (macOS) pgrep/pkill share:
  // -u effective user, -f match the argument list, -x match it exactly. The
  // pattern is a POSIX ERE, so no \s or \S. `node` may appear bare or as a
  // path, depending on how the launcher found it.
  const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const node = `(([^ ]*/)?node|${escapePattern(process.execPath)})`;
  const command = `${node} ${escapePattern(__filename)} (${START_COMMANDS.join('|')})`;
  const match = ['-u', String(process.geteuid()), '-f', '-x', '--', command];

  function matches(tool, options = []) {
    const result = spawnSync(tool, [...options, ...match], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error(result.stderr.trim() || `${tool} could not check the viewer process.`);
  }

  if (!matches('pkill', ['-TERM'])) {
    console.log('No chat viewer is running from this checkout.');
    return;
  }
  const deadline = Date.now() + 5000;
  while (matches('pgrep')) {
    if (Date.now() >= deadline) throw new Error('The chat viewer did not stop within 5 seconds.');
    await delay(100);
  }
  console.log('Stopped the chat viewer.');
}

function tcpPort(name, fallback, { allowAny = false } = {}) {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < (allowAny ? 0 : 1) || port > 65535) {
    throw new Error(name + ' must be a valid TCP port.');
  }
  return port;
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(USAGE);
  } else if (args.length === 1 && START_COMMANDS.includes(args[0])) {
    // CHATVIEW_PORT=0 picks a free port; the printed URL then shows it.
    const port = tcpPort('CHATVIEW_PORT', DEFAULT_PORT, { allowAny: true });
    const hostPort = process.env.CHATVIEW_HOST_PORT === undefined ? undefined : tcpPort('CHATVIEW_HOST_PORT');
    const bind = process.env.CHATVIEW_BIND || DEFAULT_BIND;
    serve(port, hostPort, (url) => {
      console.log('Open ' + url + ' in your browser. Press Ctrl-C or run chatview stop to stop.');
    }, bind).on('error', (error) => {
      console.error('chatview:', error.message);
      process.exitCode = 1;
    });
  } else if (args.length === 1 && args[0] === 'stop') {
    await stopViewer();
  } else {
    throw new Error(USAGE);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('chatview:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { serve };
