# Changelog

All notable changes to AIChatRender are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.6.1] — 2026-08-07

### Fixed

- **Browse Turns and Pick** again lists prompts from current Codex rollouts.
  Codex 0.147 records real prompts as completed `UserMessage` items instead of
  the older `user_message` events; assistant output continued to follow, but
  the missing user records left the turn picker empty. Injected user-role
  context such as AGENTS.md remains excluded.

### Changed

- Marketplace listing: the extension description is now the README's opening
  sentence, and `transcript` replaces `katex` in the keywords.

## [0.6.0] — 2026-08-06

First release published to the VS Code Marketplace.

### Changed

- Assistant inline code now uses the editor theme's terminal-cyan colour without
  a pill background, matching the Claude Code and Codex CLI treatment of paths,
  branch names, commit IDs, commands, and other backtick-delimited text. Fenced
  code blocks and user prompts keep their existing presentation.
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
- The README is now a listing page rather than a manual: pitch, screenshots,
  requirements, commands, and condensed security. The reference material it
  carried moves to `docs/reference.md`.
- `package.json` declares `repository`, `bugs`, and `homepage`, and no longer
  lists `onCommand:` activation events — VS Code derives those from the
  contributed commands.

### Known issues

- Copying an equation returns the correct LaTeX wrapped in KaTeX's other two
  rendering layers, so a pasted `$$…$$` block needs trimming by hand. Prose,
  lists, code, and tables are unaffected.

### Added

- **Find in the panel.** `Cmd+F` / `Ctrl+F` with the panel focused opens VS
  Code's webview find widget, searching the rendered chat.
- **AIChatRender: Search Chat Source** searches the Markdown and LaTeX as
  written, so `\theta` finds math the panel renders as θ — which the find
  widget cannot match, since the displayed text is the glyph. Hits are listed
  with their turn number and role, windowed around the match, and picking one
  scrolls the panel to it. Moving through the result list now previews each hit;
  accepting keeps the chosen hit, while dismissing restores the panel's previous
  content-relative scroll position. The turn picker remains commit-on-accept.
  Formulas whose source matched are outlined and highlighted in the panel, and
  the panel scrolls to the first rather than the message top — without that, a
  `\theta` hit lands the reader in a wall of rendered symbols with nothing
  marking what matched. The highlight covers the whole formula, since KaTeX
  output has no element standing for a single symbol within an expression. A
  match in prose highlights nothing and flashes the message, as before: prose is
  what the find widget already covers. Tool entries are skipped: their text is
  displayed as prose, so the find widget already reaches it. Bound to `Cmd+Shift+F` /
  `Ctrl+Shift+F` while the panel holds focus, and only then — the binding is
  scoped by `activeWebviewPanelId` so that Find in Files keeps the key
  everywhere else.
- **Claude Code and Codex CLI tool calls now appear in the panel**, shaped after
  the CLIs' own display: the tool and its primary argument on one line, the
  first few lines of
  its result under it, and a count of the lines not shown. Failed calls are
  marked and keep their reason. Paths inside the session's working directory are
  shown relative to it. Results are clipped as they are read, so a chat full of
  large outputs does not grow the panel's memory in proportion. Subagent calls
  and thinking blocks stay out, as before.
- A file read collapses to its line count and a file edit reports its added and
  removed lines, rather than reprinting the file or the confirmation sentence
  the model was sent. Commands are unchanged, since there the transcript's
  documented result field already is the command's output.
- **File edits now render their diff**, numbered by line — removals against the
  old file, additions and context against the new — with hunks separated and
  long diffs cut to a line budget with a "+N more lines" marker. Colours come
  from the editor's own diff theme rather than fixed values, so a diff matches
  the surrounding editor in any theme. Copying one yields a fenced `diff` block;
  the line numbers are CSS generated content and so stay out of the clipboard.
  Syntax highlighting inside the diff is deliberately not attempted: a patch
  supplies hunks rather than whole files, so a highlighter would be lexing from
  an arbitrary mid-file offset and would mis-tokenize at the edges.
- The panel now says when a tool call's result never arrived. Previously an
  unanswered call read "running…" indefinitely, which looked identical to the
  panel having lost track of the transcript format.
- An unrecognized content block now raises the existing "transcript format may
  have changed" notice instead of vanishing from the panel silently.
- **Codex direct calls and current code-mode wrappers are normalized into the
  shared tool renderer.** Wrapper JavaScript is parsed but never executed; only
  literal data and simple immutable `const` bindings are resolved. A single
  inner call gets its own card, while ambiguous multi-tool wrappers use an
  explicit `Exec` batch and raise the format-drift notice rather than guessing
  which output belongs to which call.
- Codex patch, web-search, MCP, and image-generation completion events render
  from their richer side-channel data. Patches produce one cwd-relative card per
  file with added/removed counts and numbered diffs; image bytes and data URLs
  are reduced to inert summaries and never retained in panel history.
- Codex parser state is per transcript, reset on file switches and rebuilds, and
  bounded to 512 pending calls. Unknown tool names still render generically;
  unfamiliar tool-output records fail soft and surface the existing drift
  notice. Markdown exports remain prose-only for both providers.
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

- Tool-result previews now shorten each overlong output line with a visible
  ellipsis. A few wide lines, such as JSONL records printed by a Codex Bash
  call, no longer expand into a large wrapped block or get cut mid-line without
  any indication; the existing "+N lines" note still counts only wholly omitted
  lines.
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
