# Changelog

All notable changes to AIChatRender are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **AIChatRender: Browse Turns and Pick** (`aichatrender.browseTurns`): a quick
  pick listing the user prompts of the chat being followed, newest first, with
  each prompt previewed to about its first 80 characters and its timestamp as the
  filterable description. Choosing one reveals the panel, scrolls that turn into
  view, and flashes it. Scope is the messages the panel currently retains.
- Messages now carry a monotonic key, sent to the webview and used to address
  the scroll target, so trimming to `MAX_MESSAGES` or a whole-file rebuild
  while the picker is open cannot land the jump on a different message.

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
