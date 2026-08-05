// AIChatRender: VS Code glue. Discovers the active Claude Code or Codex CLI session
// transcript for this workspace, follows it read-only via fs.watchFile, and
// mirrors the parsed history into a singleton webview. No network, no transcript
// writes, no files of our own.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  LIMITS,
  mungePath,
  pathWithin,
  LineBuffer,
  turnPreview,
  parseLine: parseClaudeLine,
} = require('./transcript');
const {
  recentSessionDateParts,
  cachedSessionMeta,
  parseLine: parseCodexLine,
} = require('./codex');
const {
  candidateForProcessTree,
  claudeSessionForProcessTree,
} = require('./active-terminal');

const INCLUDE_USER = true; // interleave real user prompts with assistant text
const DISCOVERY_MS = 1000;
const WATCH_MS = 750;
const CODEX_DAYS = 7;
const FIRST_LINE_CHUNK = 64 * 1024;
const MAX_CWD_CACHE = 512;
const NO_SESSION = 'No Claude Code or Codex CLI session found for this workspace.';

let panel; // singleton WebviewPanel
let webviewReady = false;
let follower; // transcript-follow state while the panel is open
let pendingGoto; // message key to scroll to once the webview reports ready

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('aichatrender.show', () => show(context)),
    vscode.commands.registerCommand('aichatrender.followActiveChat', () =>
      followActiveChat(context),
    ),
    vscode.commands.registerCommand('aichatrender.browseTurns', () => browseTurns(context)),
  );
}

function deactivate() {
  stopFollower();
}

function show(context, preserveFocus = false, preserveColumn = false) {
  if (panel) {
    panel.reveal(preserveColumn ? undefined : vscode.ViewColumn.Beside, preserveFocus);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'aichatrender',
    'AIChatRender',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    },
  );
  webviewReady = false;
  panel.webview.html = buildHtml(context, panel.webview);
  panel.webview.onDidReceiveMessage(
    (m) => {
      if (m && m.type === 'ready') {
        webviewReady = true;
        sendHistory();
        if (pendingGoto !== undefined) postGoto(pendingGoto);
      }
    },
    undefined,
    context.subscriptions,
  );
  panel.onDidDispose(
    () => {
      panel = undefined;
      webviewReady = false;
      pendingGoto = undefined;
      stopFollower();
    },
    undefined,
    context.subscriptions,
  );
  startFollower();
}

// Following the active terminal needs process introspection: Linux reads
// /proc, macOS shells out to pgrep/lsof/ps. Nothing equivalent is implemented
// for Windows, so say that plainly instead of silently finding no candidate.
// Showing the panel and picking a transcript by hand still work everywhere.
const FOLLOW_SUPPORTED = process.platform === 'linux' || process.platform === 'darwin';

async function followActiveChat(context) {
  if (!FOLLOW_SUPPORTED) {
    vscode.window.showErrorMessage(
      'AIChatRender: following the active terminal is supported on Linux and macOS only. ' +
        'On Windows, run VS Code against a WSL or remote workspace, or use ' +
        '"AIChatRender: Show Panel" and pick a transcript manually.',
    );
    show(context, true, true);
    return;
  }

  // Capture this before showing AIChatRender: revealing a webview can otherwise
  // change which terminal VS Code considers active.
  const terminal = vscode.window.activeTerminal;
  let terminalPid;
  if (terminal) {
    try {
      terminalPid = await terminal.processId;
    } catch {}
  }

  show(context, true, true);
  if (!follower || !follower.workspaceReal) return;

  const activeClaude =
    terminalPid !== undefined ? activeClaudeCandidate(terminalPid) : undefined;
  const candidates = discoverCandidates();
  if (
    activeClaude &&
    !candidates.some(
      (candidate) =>
        candidate.path === activeClaude.path && candidate.source === activeClaude.source,
    )
  ) {
    candidates.push(activeClaude);
  }
  let candidate =
    activeClaude ||
    (terminalPid !== undefined
      ? candidateForProcessTree(terminalPid, candidates)
      : undefined);

  if (!candidate) {
    const selected = await pickCandidate(candidates);
    if (!selected) return;
    if (selected.automatic) {
      follower.pinned = undefined;
      discover();
      vscode.window.setStatusBarMessage('AIChatRender: Following the newest transcript.', 3000);
      return;
    }
    candidate = selected.candidate;
  }

  follower.pinned = candidate;
  selectFile(candidate);
  vscode.window.setStatusBarMessage(
    `AIChatRender: Following the selected ${candidate.source === 'codex' ? 'Codex' : 'Claude'} chat.`,
    3000,
  );
}

async function pickCandidate(candidates) {
  if (!candidates.length) {
    vscode.window.showWarningMessage(NO_SESSION);
    return undefined;
  }
  const sorted = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const items = [
    {
      label: '$(sync) Automatic',
      description: 'Follow the most recently modified transcript',
      automatic: true,
    },
    ...sorted.map((candidate) => {
      const id = path.basename(candidate.path, '.jsonl');
      const shortened = id.length > 20 ? `…${id.slice(-20)}` : id;
      return {
        label: `${candidate.source === 'codex' ? 'Codex' : 'Claude'} — ${tsDisplay(
          candidate.sessionTimestamp || candidate.mtimeMs,
        )}`,
        description: shortened,
        candidate,
      };
    }),
  ];
  return vscode.window.showQuickPick(items, {
    placeHolder: 'The active terminal could not be matched; select a chat to follow',
    matchOnDescription: true,
  });
}

// ---------------------------------------------------------------- turn picker

// Lists the user prompts among the messages the panel currently holds, oldest
// first, and scrolls the panel to the one picked. Scope is deliberately what is
// rendered: the picker can never offer a turn the panel cannot show.
async function browseTurns(context) {
  show(context, true, true);
  const messages = (follower && follower.messages) || [];
  const items = [];
  let turnNumber = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    turnNumber += 1;
    items.push({
      label: `${turnNumber}. ${turnPreview(m.spans) || '(empty prompt)'}`,
      description: tsDisplay(m.ts),
      key: m.key,
    });
  }
  if (!items.length) {
    vscode.window.showInformationMessage(
      follower && follower.status
        ? `AIChatRender: ${follower.status}`
        : 'AIChatRender: no user turns in the chat currently being followed.',
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a turn to scroll the panel to',
    matchOnDescription: true,
  });
  if (!picked) return;
  postGoto(picked.key);
}

function postGoto(key) {
  if (!panel) return;
  if (!webviewReady) {
    pendingGoto = key;
    return;
  }
  pendingGoto = undefined;
  panel.reveal(undefined, true);
  panel.webview.postMessage({ type: 'gotoMessage', key });
}

function buildHtml(context, webview) {
  const mediaUri = (...p) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', ...p)).toString();
  const nonce = crypto.randomBytes(16).toString('base64');
  const html = fs.readFileSync(path.join(context.extensionPath, 'media', 'index.html'), 'utf8');
  return html
    .replaceAll('{{cspSource}}', webview.cspSource)
    .replaceAll('{{nonce}}', nonce)
    .replaceAll('{{katexCss}}', mediaUri('katex', 'katex.min.css'))
    .replaceAll('{{katexJs}}', mediaUri('katex', 'katex.min.js'))
    .replaceAll('{{copyTexJs}}', mediaUri('katex', 'copy-tex.min.js'))
    .replaceAll('{{markdownJs}}', mediaUri('markdown.js'));
}

// ---------------------------------------------------------------- follower

function startFollower() {
  if (follower) return;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length !== 1 || folders[0].uri.scheme !== 'file') {
    follower = { messages: [], status: 'AIChatRender supports exactly one local workspace folder.' };
    return;
  }
  // Match both vendors against the workspace realpath. Their transcript roots
  // stay logical — the kernel resolves any symlink again on every access.
  let real;
  try {
    real = fs.realpathSync(folders[0].uri.fsPath);
  } catch {
    real = folders[0].uri.fsPath;
  }
  follower = {
    workspaceReal: real,
    claudeProjectsRoot: path.join(os.homedir(), '.claude', 'projects'),
    claudeSessionsDir: path.join(os.homedir(), '.claude', 'sessions'),
    claudeProjDir: path.join(os.homedir(), '.claude', 'projects', mungePath(real)),
    codexRoot: path.join(os.homedir(), '.codex', 'sessions'),
    codexMetaCache: new Map(), // positive path+inode; negative path+inode+size
    cwdMatch: new Map(), // recorded session cwd -> is it inside this workspace?
    file: undefined,
    source: undefined,
    pinned: undefined,
    sessionTimestamp: '',
    lastIno: -1,
    lastSize: 0,
    lineBuf: new LineBuffer(),
    messages: [],
    // Monotonic per-message key. The turn picker and the webview address
    // messages by key, so trimming to MAX_MESSAGES (or a rebuild) while the
    // picker is open cannot make a selection land on a different message.
    nextKey: 1,
    unexpected: false,
    status: NO_SESSION,
    timer: setInterval(discover, DISCOVERY_MS),
  };
  discover();
}

function stopFollower() {
  if (!follower) return;
  if (follower.timer) clearInterval(follower.timer);
  if (follower.file) fs.unwatchFile(follower.file);
  follower = undefined;
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs > a.mtimeMs ? b : a;
  return b.path > a.path ? b : a;
}

// Does a recorded session cwd belong to this workspace? Both vendors record the
// directory the CLI was launched in, and a session started in a subdirectory is
// still this workspace's session -- so the test is containment, not equality.
// `workspaceReal` is a realpath, so resolve the cwd before comparing, falling
// back to its spelling when the directory is gone. Cached per spelling: this
// runs on every rollout in the Codex scan, once a second.
function withinWorkspace(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return false;
  const cached = follower.cwdMatch.get(cwd);
  if (cached !== undefined) return cached;
  let real;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    real = cwd;
  }
  const match = pathWithin(follower.workspaceReal, real);
  if (follower.cwdMatch.size < MAX_CWD_CACHE) follower.cwdMatch.set(cwd, match);
  return match;
}

function activeClaudeCandidate(terminalPid) {
  const state = claudeSessionForProcessTree(
    terminalPid,
    follower.claudeSessionsDir,
  );
  if (!state) return undefined;

  if (!withinWorkspace(state.cwd)) return undefined;
  let cwdReal;
  try {
    cwdReal = fs.realpathSync(state.cwd);
  } catch {
    cwdReal = state.cwd;
  }

  // Claude keys its project directory by the cwd spelling it was launched
  // with. Try that first, then its realpath for symlinked subdirectories.
  const cwdChoices = [...new Set([state.cwd, cwdReal])];
  for (const cwd of cwdChoices) {
    const p = path.join(
      follower.claudeProjectsRoot,
      mungePath(cwd),
      `${state.sessionId}.jsonl`,
    );
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;
    return { path: p, source: 'claude', mtimeMs: st.mtimeMs };
  }
  return undefined;
}

function discoverClaudeCandidates() {
  let names;
  try {
    names = fs.readdirSync(follower.claudeProjDir);
  } catch {
    return [];
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const p = path.join(follower.claudeProjDir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;
    candidates.push({ path: p, source: 'claude', mtimeMs: st.mtimeMs });
  }
  return candidates;
}

function recentCodexDirs() {
  return recentSessionDateParts(Date.now(), CODEX_DAYS).map((parts) =>
    path.join(follower.codexRoot, ...parts),
  );
}

// Read only the first line, capped by the same guard as normal transcript lines.
// Most metadata lines fit in the initial 64 KiB; grow only when necessary.
function readFirstLine(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const maxBytes = LIMITS.MAX_LINE + 1;
    let buf = Buffer.alloc(Math.min(FIRST_LINE_CHUNK, maxBytes));
    let read = 0;
    for (;;) {
      if (read === buf.length) {
        if (buf.length === maxBytes) return undefined; // no newline within cap
        const grown = Buffer.alloc(Math.min(buf.length * 2, maxBytes));
        buf.copy(grown, 0, 0, read);
        buf = grown;
      }
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n <= 0) return undefined;
      const newline = buf.subarray(read, read + n).indexOf(0x0a);
      if (newline >= 0) return buf.toString('utf8', 0, read + newline);
      read += n;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function discoverCodexCandidates() {
  const candidates = [];
  for (const dir of recentCodexDirs()) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const p = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size === 0) continue;
      const meta = cachedSessionMeta(
        follower.codexMetaCache,
        p,
        st.ino,
        st.size,
        () => readFirstLine(p),
      );
      if (!meta) continue;
      if (!withinWorkspace(meta.cwd)) continue;
      candidates.push({
        path: p,
        source: 'codex',
        mtimeMs: st.mtimeMs,
        sessionTimestamp: meta.timestamp,
      });
    }
  }
  return candidates;
}

function discoverCandidates() {
  if (!follower || !follower.claudeProjDir) return [];
  return [...discoverClaudeCandidates(), ...discoverCodexCandidates()];
}

// Every ~1s: union the Claude project candidates with the Codex rollouts whose
// cwd is inside this workspace, from the last seven date directories plus
// tomorrow's timezone guard,
// then follow the newest mtime.
function discover() {
  if (!follower || !follower.claudeProjDir) return;
  const candidates = discoverCandidates();
  if (follower.pinned) {
    const refreshed = candidates.find(
      (candidate) =>
        candidate.path === follower.pinned.path &&
        candidate.source === follower.pinned.source,
    );
    if (refreshed) follower.pinned = refreshed;
    selectFile(follower.pinned);
    return;
  }
  let best;
  for (const candidate of candidates) best = newer(best, candidate);
  selectFile(best);
}

function selectFile(candidate) {
  if (!follower) return;
  const p = candidate && candidate.path;
  if (p === follower.file && (!candidate || candidate.source === follower.source)) {
    if (candidate) {
      follower.sessionTimestamp = candidate.sessionTimestamp || '';
      poll();
    }
    return;
  }
  if (follower.file) fs.unwatchFile(follower.file);
  follower.file = p;
  follower.source = candidate && candidate.source;
  follower.sessionTimestamp = (candidate && candidate.sessionTimestamp) || '';
  follower.lastIno = -1;
  follower.lastSize = 0;
  follower.lineBuf.reset();
  follower.messages = [];
  follower.unexpected = false;
  if (!p) {
    follower.status = NO_SESSION;
    sendHistory();
    return;
  }
  follower.status = '';
  fs.watchFile(p, { interval: WATCH_MS }, poll);
  poll();
}

// Open the logical path fresh each time (never a cached fd or realpath) so a
// swapped symlink target shows up as an inode change or transient ENOENT.
function poll() {
  if (!follower || !follower.file) return;
  let fd;
  try {
    fd = fs.openSync(follower.file, 'r');
  } catch {
    return; // transient ENOENT (rotation/sync swap): keep polling
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.ino !== follower.lastIno || st.size < follower.lastSize) {
      rebuild(fd, st);
    } else if (st.size > follower.lastSize) {
      const consumed = readRange(fd, follower.lastSize, st.size);
      follower.lastSize += consumed;
      sendHistory();
    }
  } catch {
    // fail-soft: skip this cycle
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

function rebuild(fd, st) {
  follower.messages = [];
  follower.lineBuf.reset();
  follower.unexpected = false;
  let offset = 0;
  if (st.size > LIMITS.MAX_REBUILD_BYTES) {
    offset = st.size - LIMITS.MAX_REBUILD_BYTES;
    follower.lineBuf.startMidLine();
  }
  const consumed = readRange(fd, offset, st.size);
  follower.lastIno = st.ino;
  follower.lastSize = offset + consumed;
  sendHistory();
}

// Reads [from, to), feeds complete lines through the parser. Returns bytes
// actually consumed so a short read is retried on the next poll.
function readRange(fd, from, to) {
  const len = to - from;
  if (len <= 0) return 0;
  const buf = Buffer.alloc(len);
  let read = 0;
  while (read < len) {
    const n = fs.readSync(fd, buf, read, len - read, from + read);
    if (n <= 0) break;
    read += n;
  }
  const lines = follower.lineBuf.push(read === len ? buf : buf.subarray(0, read));
  for (const line of lines) {
    const opts = {
      includeUser: INCLUDE_USER,
      sessionTimestamp: follower.sessionTimestamp,
    };
    const r =
      follower.source === 'codex'
        ? parseCodexLine(line, opts)
        : parseClaudeLine(line, opts);
    if (r.unexpected) follower.unexpected = true;
    for (const m of r.messages) {
      m.key = follower.nextKey++;
      follower.messages.push(m);
    }
  }
  if (follower.messages.length > LIMITS.MAX_MESSAGES) {
    follower.messages = follower.messages.slice(-LIMITS.MAX_MESSAGES);
  }
  return read;
}

// ---------------------------------------------------------------- webview out

// Host zone, matching the clock the session was written by. In this devcontainer
// that is whatever .devcontainer/write-local-env.sh detected from the host.
const TS_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function tsDisplay(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : TS_FMT.format(d);
}

function sendHistory() {
  if (!panel || !webviewReady) return;
  const f = follower;
  panel.webview.postMessage({
    type: 'replaceHistory',
    entries: f
      ? f.messages.map((m) => ({
          key: m.key,
          role: m.role,
          tsDisplay: tsDisplay(m.ts),
          spans: m.spans,
        }))
      : [],
    status: f ? f.status : '',
    notice:
      f && f.unexpected
        ? `Some records were skipped — ${
            f.source === 'codex' ? 'Codex CLI' : 'Claude Code'
          } transcript format may have changed.`
        : '',
  });
}

module.exports = { activate, deactivate };
