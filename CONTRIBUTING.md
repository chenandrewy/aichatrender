# Developing AIChatRender

No build step. Runtime dependencies are limited to Acorn and Acorn Walk for
static, non-executing analysis of Codex wrapper records. The vendored KaTeX
under `media/katex/` is committed as-is; see `media/katex/VENDOR.md` for its
pinned version.

## Tests

```sh
node --test test/*.test.js
```

Pure-parser and process-helper tests use synthetic fixtures, including compact
Codex direct/wrapper/event variants. The larger real transcripts under
`test/fixtures/chat-examples/` are for manual live testing;
they are not loaded by the parser test suite. CI runs on Linux and macOS, which
matters: `active-terminal.js` reads `/proc` on Linux and shells out to
`pgrep`/`lsof`/`ps` on macOS, and only a macOS runner exercises the latter.

## Live transcript testing

Resume a disposable copy of a chat example with its short prefix:

```sh
scripts/chat-example claude1
scripts/chat-example claude2
scripts/chat-example codex1
scripts/chat-example codex2
```

Resuming is the default, and the staged transcript is removed when the CLI
exits. Use `fork` explicitly when testing fork behavior; that creates a new
persistent chat. Omit the selector for an interactive picker:

```sh
scripts/chat-example fork claude2
scripts/chat-example
scripts/chat-example --list
```

The equivalent cross-platform form is `npm run chat-example -- <arguments>`.

Every run gives its staged copy a fresh session ID and leaves the checked-in
JSONL untouched. The staged seed is removed when the CLI exits; an explicitly
forked chat remains in the normal CLI session store. Pass `--keep` to retain the
seed, `--dry-run` to inspect the command, or put CLI arguments after `--`.

## Running it locally

```sh
npx @vscode/vsce package
code --install-extension aichatrender-<version>.vsix
```

Then reload the window (`Developer: Reload Window`).

Copying the directory into `~/.vscode/extensions/` does **not** work on the
desktop app — it only loads extensions registered in that directory's
`extensions.json`, so the `.vsix` path above is the supported one. A VS Code
Server (remote or devcontainer) does still scan for directories.

## Platform support

Linux and macOS. Windows is unsupported for **Follow Active Terminal Chat**,
which says so rather than failing silently; the panel and manual transcript
picking work everywhere. The supported Windows path is a WSL or remote
workspace, since the extension declares `"extensionKind": ["workspace"]` and
runs on the remote side.

Adding a platform means implementing three things in `active-terminal.js`:
the children of a PID, the JSONL files a process holds open, and a process
start time. Everything else is platform-independent.

## Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `npx @vscode/vsce package` and inspect the file list.
3. `npx @vscode/vsce publish`.

Marketplace versions are immutable — a mistake in a published version needs a
new version, not a re-upload.
