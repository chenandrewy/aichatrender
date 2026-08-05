#!/usr/bin/env node
// Run: npm run chat-example -- [fork|resume] [claude1|codex1|...] [options]
// Input: a JSONL session in test/fixtures/chat-examples/ and optional CLI args.
// Output: a temporary native Claude/Codex session copy and an interactive CLI;
//   the checked-in fixture is never modified.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'chat-examples');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage() {
  process.stdout.write(`Usage:
  npm run chat-example -- SELECTOR
  npm run chat-example -- fork SELECTOR
  npm run chat-example -- resume SELECTOR
  npm run chat-example -- --list

SELECTOR is a fixture prefix such as claude1, claude2, codex1, or codex2.
Resume is the disposable default. Use fork explicitly to retain a new chat.
With no selector, an interactive picker is shown.

Options:
  -l, --list     List available chat examples
      --dry-run  Print the staging path and command without writing or launching
      --keep     Keep the staged seed after the CLI exits
  -h, --help     Show this help
  --             Pass all remaining arguments to claude or codex
`);
}

function fixtures() {
  const found = [];
  for (const name of fs.readdirSync(FIXTURE_DIR)) {
    const match = /^(claude|codex)(\d+)-(.+)-([0-9a-f]{8})\.jsonl$/i.exec(name);
    if (!match) continue;
    found.push({
      provider: match[1].toLowerCase(),
      number: Number(match[2]),
      key: `${match[1].toLowerCase()}${match[2]}`,
      description: match[3],
      name,
      file: path.join(FIXTURE_DIR, name),
    });
  }
  found.sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.number - b.number,
  );
  return found;
}

function printFixtures(items) {
  for (const [index, item] of items.entries()) {
    process.stdout.write(
      `${String(index + 1).padStart(2)}  ${item.key.padEnd(8)} ${item.description}\n`,
    );
  }
}

function selectFixture(items, selector) {
  if (/^[0-9]+$/.test(selector)) return items[Number(selector) - 1];
  const needle = selector.toLowerCase();
  const exact = items.filter((item) => item.key === needle);
  if (exact.length === 1) return exact[0];
  const matches = items.filter(
    (item) => item.key.startsWith(needle) || item.name.toLowerCase().includes(needle),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Selector ${JSON.stringify(selector)} is ambiguous: ${matches.map((x) => x.key).join(', ')}`,
    );
  }
  throw new Error(`No chat example matches ${JSON.stringify(selector)}.`);
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const own = separator < 0 ? argv : argv.slice(0, separator);
  const forwarded = separator < 0 ? [] : argv.slice(separator + 1);
  let mode = 'resume';
  let selector = '';
  let list = false;
  let dryRun = false;
  let keep = false;

  for (const arg of own) {
    if (arg === 'fork' || arg === 'resume') mode = arg;
    else if (arg === '--list' || arg === '-l') list = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--keep') keep = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!selector) selector = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { mode, selector, list, dryRun, keep, forwarded, help: false };
}

function sessionMetadata(raw, provider) {
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (provider === 'codex' && record.type === 'session_meta') {
      const id = record.payload && record.payload.id;
      if (UUID.test(id || '')) return { id };
    }
    if (provider === 'claude' && UUID.test(record.sessionId || '')) {
      return { id: record.sessionId };
    }
  }
  throw new Error(`Could not find a valid ${provider} session ID in the fixture.`);
}

function localDateParts(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return {
    year: String(now.getFullYear()),
    month: pad(now.getMonth() + 1),
    day: pad(now.getDate()),
    time: `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`,
  };
}

function codexSeed(raw, oldId, newId, cwd) {
  let staged = raw.split(oldId).join(newId);
  const newline = staged.indexOf('\n');
  const firstEnd = newline < 0 ? staged.length : newline;
  const first = JSON.parse(staged.slice(0, firstEnd));
  if (first.type !== 'session_meta' || !first.payload) {
    throw new Error('Codex fixture does not begin with session_meta.');
  }
  first.payload.cwd = cwd;
  return JSON.stringify(first) + staged.slice(firstEnd);
}

function stageFixture(item, cwd, dryRun, roots = {}) {
  const raw = fs.readFileSync(item.file, 'utf8');
  const { id: oldId } = sessionMetadata(raw, item.provider);
  const id = crypto.randomUUID();
  let destination;
  let contents;

  if (item.provider === 'codex') {
    const date = localDateParts(new Date());
    const codexHome =
      roots.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    destination = path.join(
      codexHome,
      'sessions',
      date.year,
      date.month,
      date.day,
      `rollout-${date.year}-${date.month}-${date.day}T${date.time}-${id}.jsonl`,
    );
    contents = codexSeed(raw, oldId, id, cwd);
  } else {
    const claudeRoot =
      roots.claudeRoot ||
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(os.homedir(), '.claude');
    const projectKey = cwd.replace(/[\\/,]/g, '-');
    destination = path.join(claudeRoot, 'projects', projectKey, `${id}.jsonl`);
    contents = raw.split(oldId).join(id);
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  return { id, destination };
}

function commandFor(item, mode, id, cwd, forwarded) {
  if (item.provider === 'codex') {
    return { bin: 'codex', args: [mode, '-C', cwd, id, ...forwarded] };
  }
  const args = ['--resume', id];
  if (mode === 'fork') args.push('--fork-session');
  args.push(...forwarded);
  return { bin: 'claude', args };
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const items = fixtures();
  if (!items.length) throw new Error(`No prefixed chat examples found in ${FIXTURE_DIR}.`);
  if (options.list) {
    printFixtures(items);
    return;
  }

  let selector = options.selector;
  if (!selector) {
    if (!process.stdin.isTTY) throw new Error('A selector is required when stdin is not a terminal.');
    printFixtures(items);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      selector = (await rl.question('Use which chat example? ')).trim();
    } finally {
      rl.close();
    }
  }

  const item = selectFixture(items, selector);
  const cwd = process.cwd();
  const staged = stageFixture(item, cwd, options.dryRun);
  const command = commandFor(
    item,
    options.mode,
    staged.id,
    cwd,
    options.forwarded,
  );
  const rendered = [command.bin, ...command.args].map(shellQuote).join(' ');

  process.stdout.write(
    `Chat example: ${item.key} (${item.provider}, ${options.mode})\n` +
      `Fixture:      ${path.relative(cwd, item.file)}\n` +
      `Staged seed:  ${staged.destination}\n` +
      `Command:      ${rendered}\n`,
  );
  if (options.dryRun) return;

  try {
    const result = spawnSync(command.bin, command.args, { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.signal) process.stderr.write(`${command.bin} exited on ${result.signal}.\n`);
    process.exitCode = result.status === null ? 1 : result.status;
  } finally {
    if (options.keep) {
      process.stdout.write(`Kept staged seed: ${staged.destination}\n`);
    } else {
      try {
        fs.unlinkSync(staged.destination);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`chat-example: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  commandFor,
  fixtures,
  parseArgs,
  selectFixture,
  sessionMetadata,
  stageFixture,
};
