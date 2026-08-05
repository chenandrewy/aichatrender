# Changelog

All notable changes to AIChatRender are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Panel history is now measured in user turns, not messages**: the newest 100
  turns are retained, cut at a turn boundary so the panel always opens on a
  prompt rather than mid-exchange. Turns are the unit a chat is actually read
  in. A message ceiling remains underneath, because the panel rebuilds every
  entry on each append and one turn can hold hundreds of tool calls; it does not
  fire in ordinary use.
- A whole-file rebuild now reads up to the final 10 MiB of a transcript instead
  of 4 MiB, so longer chats keep substantially more scrollback, including the
  complete `claude1` development example.
- **Browse Turns and Pick** now lists prompts oldest-to-newest, matching both
  the transcript and the upper-right numbered turn index.

### Added

- **Claude Code tool calls now appear in the panel**, shaped after the CLI's own
  display: the tool and its primary argument on one line, the first few lines of
  its result under it, and a count of the lines not shown. Failed calls are
  marked. Paths inside the session's working directory are shown relative to it.
  Results are clipped as they are read, so a chat full of large outputs does not
  grow the panel's memory in proportion. Subagent calls and thinking blocks stay
  out, as before.
- Codex CLI sessions are unaffected: its rollouts record a tool call as a
  JavaScript program inside a string, with the human-readable labels in a
  separate event stream keyed by a different id space, so the same treatment
  needs its own parser. Codex prose renders exactly as it did before.
- Copying rendered transcript content now writes the corresponding Markdown to
  the plain-text clipboard. Headings, bold and italic emphasis, blockquotes,
  ordered and unordered lists, inline and fenced code, rules, tables, and math
  retain their source form, including in mixed selections. Partial selections
  inside formatted content regain their surrounding marker, and partial math
  selections widen to the complete formula.

- Markdown tables render as tables. They previously had no parser rule at all,
  so a table fell through to the paragraph branch and showed up as raw
  `| --- |` lines. The parser now emits a `table` block with per-column
  alignment from the delimiter row, honours `\|` escapes, and keeps math spans
  intact inside cells; short rows are padded and long rows truncated to the
  header's column count. This is the `| a | b |` pipe syntax, which is what
  both Claude Code and Codex emit; Pandoc's grid and simple table syntaxes are
  not recognised and stay plain text.

- Copying a selection that contains a table puts pipe syntax on the clipboard
  rather than the browser's tab-separated flattening, with column alignment
  preserved and math cells written as their LaTeX source — the same round-trip
  KaTeX's `copy-tex` already gave equations.

### Fixed

- Codex rollouts started in a *subdirectory* of the workspace folder are now
  discovered. Codex matching required the recorded cwd to equal the workspace
  root exactly, while Claude had always accepted any cwd beneath it; a Codex
  session run in, say, `1-SANDBOX/Live,AIChatRender` with `1-SANDBOX` open in
  VS Code was filtered out of the candidate list, so **Follow Active Terminal
  Chat** could not match it even though the terminal held the rollout open, and
  fell back to the picker with only stale chats in it. Both vendors now share
  one realpath-based containment test (`pathWithin`).

## [0.5.0] — 2026-08-02

### Added

- **AIChatRender: Browse Turns and Pick** (`aichatrender.browseTurns`): a quick
  pick listing the user prompts of the chat being followed, newest first, with
  each prompt previewed to about its first 80 characters and its timestamp as the
  filterable description. Choosing one reveals the panel, scrolls that turn into
  view, and flashes it. Scope is the messages the panel currently retains.
- Messages now carry a monotonic key, sent to the webview and used to address
  the scroll target, so trimming to `MAX_MESSAGES` or a whole-file rebuild
  while the picker is open cannot land the jump on a different message.

### Changed

- Development installs now build a `.vsix` from this repo
  (`scripts/install-local.sh`) instead of copying the source tree into a
  separate staging directory, which had drifted out of sync. `.vscode/launch.json`
  lets F5 load the extension from the repo, so testing a change needs no install
  at all.
- `dev/` (host-dropped screenshots) and `scripts/` are excluded from the
  package; `dev/` had been neither gitignored nor `.vscodeignore`d.

## [0.4.0] — 2026-08-01

### Added

- **macOS support.** Active-terminal detection now works on macOS, using
  `pgrep`, `lsof`, and `ps` where Linux reads `/proc`. Process introspection
  sits behind a single platform-dispatched source, so the rest of the extension
  is unchanged.
- Packaging metadata for the VS Code Marketplace: icon, categories, keywords,
  an MIT `LICENSE`, this changelog, and a `.vscodeignore` that keeps the
  vendored KaTeX build (and its LICENSE) while dropping tests and fixtures.

### Changed

- Renamed from **ChatRender** to **AIChatRender**, disambiguating from chat
  tools generally on a crowded Marketplace. Command IDs are now
  `aichatrender.show` and `aichatrender.followActiveChat`.
- **Follow Active Terminal Chat** now reports plainly that it is unsupported on
  Windows, and still opens the panel, instead of silently finding no candidate.
- `install-extension.sh` derives the publisher from `package.json` rather than
  hardcoding `local`, so a real Marketplace publisher does not install a second
  copy alongside the old one.

## [0.3.0] — 2026-07-31

### Changed

- Renamed from **MathPanel** to **ChatRender**, reflecting that the panel had
  grown beyond math into Markdown, lists, code fences, copy-tex, and
  active-terminal following. Command IDs became `chatrender.show` and
  `chatrender.followActiveChat`. (Renamed again to **AIChatRender** in 0.4.0,
  before any public release; neither earlier name was ever published.)

## [0.2.x] — 2026-07

### Added

- Codex CLI rollouts as a second transcript source, discovered by matching
  `cwd` across recent date directories.
- **Follow Active Terminal Chat**: pins the panel to the transcript held open by
  the active terminal's process tree, including Claude sessions parked in a
  background PTY.
- Copy rendered equations as their original LaTeX source via KaTeX `copy-tex`.
- Markdown subset: headings, lists, blockquotes, rules, bold/italic, inline and
  fenced code — with raw HTML and links left as inert text.

## [0.1.0] — 2026-07

### Added

- Initial release: a read-only webview rendering the current Claude Code
  session's math live from its transcript, using vendored KaTeX.
