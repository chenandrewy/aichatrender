# Developing AIChatRender

No build step and no runtime dependencies. The vendored KaTeX under
`media/katex/` is committed as-is; see `media/katex/VENDOR.md` for its pinned
version.

## Tests

```sh
node --test test/*.test.js
```

Pure-parser and process-helper tests against synthetic fixtures. No real
transcript content is committed. CI runs these on Linux and macOS, which
matters: `active-terminal.js` reads `/proc` on Linux and shells out to
`pgrep`/`lsof`/`ps` on macOS, and only a macOS runner exercises the latter.

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
