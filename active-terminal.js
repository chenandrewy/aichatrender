// Pure active-terminal process helpers for AIChatRender.
// Input: a terminal root PID, workspace-validated transcript candidates, and
// optionally an injected process source for tests (`fs`/`procRoot` for the
// Linux /proc reader, or `platform`/`exec` for the macOS ps+lsof reader).
// Output: the candidate whose JSONL basename is open in that process tree, or
// the live Claude session metadata registered for a process in that tree.
//
// Process introspection is the one platform-specific part of the extension.
// Everything the panel needs reduces to three questions -- who are a PID's
// children, which JSONL files does a process hold open, and when did a PID
// start -- so each platform implements just those, behind `processSource()`.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_PROCESSES = 512;
const DELETED_SUFFIX = ' (deleted)';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_ID = /^[0-9a-f]{8}$/i;
const COMMAND_TIMEOUT_MS = 5000;
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Linux: /proc
// ---------------------------------------------------------------------------

function procFsSource(opts) {
  const procFs = (opts && opts.fs) || fs;
  const procRoot = (opts && opts.procRoot) || '/proc';
  return {
    // A /proc starttime is directly comparable to the value Claude records.
    comparableStartTime: true,

    children(pid) {
      let raw;
      try {
        raw = procFs.readFileSync(
          path.join(procRoot, String(pid), 'task', String(pid), 'children'),
          'utf8',
        );
      } catch {
        return [];
      }
      return String(raw)
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0);
    },

    jsonlBasenames(pids) {
      const names = new Set();
      for (const pid of pids) {
        const fdDir = path.join(procRoot, String(pid), 'fd');
        let fds;
        try {
          fds = procFs.readdirSync(fdDir);
        } catch {
          continue;
        }
        for (const fd of fds) {
          let target;
          try {
            target = procFs.readlinkSync(path.join(fdDir, String(fd)));
          } catch {
            continue;
          }
          addJsonlBasename(names, target);
        }
      }
      return names;
    },

    startTime(pid) {
      let raw;
      try {
        raw = procFs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
      } catch {
        return undefined;
      }
      // Field 2 is parenthesized and may itself contain spaces or parentheses.
      // Everything after its final ")" begins at field 3; starttime is field 22.
      const close = String(raw).lastIndexOf(')');
      if (close === -1) return undefined;
      const fields = String(raw).slice(close + 1).trim().split(/\s+/);
      return fields.length > 19 ? fields[19] : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// macOS: pgrep + lsof + ps
// ---------------------------------------------------------------------------

function runCommand(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // pgrep exits 1 on "no matches", and lsof exits 1 when any requested PID
    // has already gone. Both still write the results for the PIDs that did
    // match, so a nonzero exit is normal here rather than an error.
    if (err && typeof err.stdout === 'string') return err.stdout;
    return '';
  }
}

function bsdSource(opts) {
  const exec = (opts && opts.exec) || runCommand;
  return {
    // `ps -o lstart` is a wall-clock string, not the monotonic jiffy counter
    // Claude records on Linux, so the two cannot be compared. macOS therefore
    // gets a liveness check (does the PID still exist?) rather than a full
    // stale-PID rejection; see readClaudeState.
    comparableStartTime: false,

    children(pid) {
      return String(exec('pgrep', ['-P', String(pid)]))
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0);
    },

    jsonlBasenames(pids) {
      const names = new Set();
      const list = [...pids];
      if (!list.length) return names;
      // One batched lsof beats one call per PID by a wide margin. -n and -P
      // suppress host and port lookups, which are the slow part of lsof.
      const out = exec('lsof', ['-n', '-P', '-Fn', '-p', list.join(',')]);
      for (const line of String(out).split('\n')) {
        // -Fn output is one field per line, each prefixed by its type; "n" is
        // the file name.
        if (line.charCodeAt(0) !== 110 /* n */) continue;
        addJsonlBasename(names, line.slice(1));
      }
      return names;
    },

    startTime(pid) {
      const out = String(exec('ps', ['-p', String(pid), '-o', 'lstart='])).trim();
      return out || undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function addJsonlBasename(names, target) {
  let value = String(target).trim();
  if (!value) return;
  if (value.endsWith(DELETED_SUFFIX)) {
    value = value.slice(0, -DELETED_SUFFIX.length);
  }
  const name = path.basename(value);
  if (name.endsWith('.jsonl')) names.add(name);
}

function processSource(opts) {
  // An explicit platform wins, so a test can pair the macOS reader with an
  // injected fs for Claude's session files. Otherwise an injected fs or
  // procRoot means the /proc reader, pinning the Linux path regardless of the
  // host the tests run on.
  if (opts && opts.platform) {
    return opts.platform === 'darwin' ? bsdSource(opts) : procFsSource(opts);
  }
  if (opts && (opts.fs || opts.procRoot)) return procFsSource(opts);
  return process.platform === 'darwin' ? bsdSource(opts) : procFsSource(opts);
}

function treePids(source, rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return [];
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length && seen.size < MAX_PROCESSES) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of source.children(pid)) {
      if (!seen.has(child)) queue.push(child);
    }
  }
  return [...seen];
}

function processTreePids(rootPid, opts) {
  return treePids(processSource(opts), rootPid);
}

function openJsonlBasenames(rootPid, opts) {
  const source = processSource(opts);
  return source.jsonlBasenames(treePids(source, rootPid));
}

function candidateForProcessTree(rootPid, candidates, opts) {
  const names = openJsonlBasenames(rootPid, opts);
  let best;
  for (const candidate of candidates || []) {
    if (!candidate || typeof candidate.path !== 'string') continue;
    if (!names.has(path.basename(candidate.path))) continue;
    if (!best || candidate.mtimeMs > best.mtimeMs) best = candidate;
  }
  return best;
}

function readClaudeState(source, sessionFs, sessionDir, pid) {
  let state;
  try {
    state = JSON.parse(
      sessionFs.readFileSync(path.join(sessionDir, `${pid}.json`), 'utf8'),
    );
  } catch {
    return undefined;
  }
  if (
    !state ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    state.pid !== pid ||
    typeof state.sessionId !== 'string' ||
    !SESSION_ID.test(state.sessionId) ||
    typeof state.cwd !== 'string' ||
    !path.isAbsolute(state.cwd)
  ) {
    return undefined;
  }
  // Claude records a process start marker to distinguish a live process from
  // an old state file whose PID has since been reused. Where that marker is
  // comparable (Linux) a mismatch rejects the state outright; where it is not
  // (macOS) the weaker check is that the PID still exists at all.
  if (typeof state.procStart === 'string') {
    const start = source.startTime(pid);
    if (source.comparableStartTime ? state.procStart !== start : start === undefined) {
      return undefined;
    }
  }
  return {
    pid,
    sessionId: state.sessionId,
    cwd: state.cwd,
    kind: typeof state.kind === 'string' ? state.kind : '',
    jobId: typeof state.jobId === 'string' && JOB_ID.test(state.jobId) ? state.jobId : '',
    parkedJobId:
      typeof state.parkedJobId === 'string' && JOB_ID.test(state.parkedJobId)
        ? state.parkedJobId
        : '',
  };
}

function publicClaudeState(state) {
  return {
    pid: state.pid,
    sessionId: state.sessionId,
    cwd: state.cwd,
    kind: state.kind,
  };
}

function parkedClaudeState(source, sessionFs, sessionDir, jobId) {
  let names;
  try {
    names = sessionFs.readdirSync(sessionDir);
  } catch {
    return undefined;
  }
  let checked = 0;
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    checked += 1;
    if (checked > MAX_PROCESSES) break;
    const pid = Number(name.slice(0, -'.json'.length));
    const state = readClaudeState(source, sessionFs, sessionDir, pid);
    if (state && state.kind === 'bg' && state.jobId === jobId) return state;
  }
  return undefined;
}

function claudeSessionForProcessTree(rootPid, sessionDir, opts) {
  const source = processSource(opts);
  // Claude's session-state files are ordinary files on every platform; only
  // the process introspection around them varies.
  const sessionFs = (opts && opts.fs) || fs;
  const states = [];
  for (const pid of treePids(source, rootPid)) {
    const state = readClaudeState(source, sessionFs, sessionDir, pid);
    if (state) states.push(state);
  }
  const active = states.find((state) => state.kind === 'interactive') || states[0];
  if (!active) return undefined;
  if (active.parkedJobId) {
    const parked = parkedClaudeState(
      source,
      sessionFs,
      sessionDir,
      active.parkedJobId,
    );
    if (parked) return publicClaudeState(parked);
  }
  return publicClaudeState(active);
}

module.exports = {
  processTreePids,
  openJsonlBasenames,
  candidateForProcessTree,
  claudeSessionForProcessTree,
};
