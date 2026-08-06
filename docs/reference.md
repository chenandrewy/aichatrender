# AIChatRender reference

The long-form version of the README: what each command does in detail, how the
security choices were made, and the full list of known limitations.

## Features in detail

### Following the active session

Watches this workspace's Claude transcripts (`~/.claude/projects/`) and Codex
rollouts (`~/.codex/sessions/`), following whichever was written most recently
and switching automatically. Both vendors count a session as this workspace's
when its cwd is the workspace folder or any directory beneath it, so a CLI
started in a subfolder is still followed.

**Follow Active Terminal Chat** pins the panel to the transcript held open by
your active terminal's process tree. If the terminal can't be matched — an idle
CLI often closes its transcript — a picker lists the workspace's recent chats.

### Browse Turns and Pick

Opens a searchable list of the user prompts in the chat being followed, oldest
first to match the panel and its upper-right turn index, each shown as its first
80 characters or so (the cap bounds rendered width, so wide characters count
double). Picking one scrolls the panel to that turn and flashes it. The list
covers the messages the panel currently holds, so it never offers a turn the
panel cannot show. It does not preview while you move through the list; it
scrolls and flashes only after a turn is picked.

### Search Chat Source

Searches the Markdown and LaTeX behind the rendering rather than the rendering
itself, which is the only way to find a symbol by name: the panel draws `\theta`
as θ, so no search of the displayed text can match `\theta`. Enter a query, and
the matching lines are listed one per line with their turn number and role.
Moving through the results previews each hit in the panel; Enter keeps the
chosen position, while Escape returns the panel to where it was before the
result picker opened. Matching is case-insensitive substring, not regular
expression. Tool calls are not searched — their output reaches the panel as
ordinary text, where the find widget already covers it.

Formulas whose source matched are outlined and highlighted, and the panel
scrolls to the first rather than to the top of the message, so a hit is findable
once you arrive. The whole formula is highlighted, not the symbol within it:
KaTeX renders an expression as a tree of positioned spans, and no element there
stands for a single symbol. A query matching only prose highlights nothing and
flashes the message instead — displayed text is what the find widget already
covers. Highlights stay up until the next jump, and a live update to the chat
clears them.

Bound to `Cmd+Shift+F` (`Ctrl+Shift+F`) **while the panel is focused only**, so
it never displaces Find in Files anywhere else. To reach it from the editor or
terminal, use the palette, or bind it yourself without the `when` clause.

### Find in the panel

With the panel focused, `Cmd+F` (`Ctrl+F` on Windows and Linux) opens VS Code's
find widget over the rendered chat, with the usual next/previous and match
count. It searches what is currently in the panel; use **Browse Turns and Pick**
to jump by prompt. Equations are searched as rendered, not as source: `x` in
`$x^2$` matches, but a symbol matches only its rendered character — `θ`, not
`\theta`. KaTeX does keep the original LaTeX in a MathML annotation, but it is
clip-hidden and the find widget skips it.

### Math, Markdown, and copying

Math renders with a vendored, pinned KaTeX: `$$…$$` and `\[…\]` display, `\(…\)`
and `$…$` inline. Single-`$` uses Pandoc-style guards so currency and `$VAR`
don't trigger false positives.

The Markdown subset is deliberately small: headings, lists, blockquotes, rules,
bold/italic, inline and fenced code, and `| a | b |` tables (with column
alignment and math inside cells). Raw HTML and Markdown links stay inert text.

Copying takes rendered content back out as Markdown source. Headings, emphasis,
blockquotes, ordered and unordered lists, code, rules, and tables retain their
syntax; equations become their original LaTeX. Mixed and partial selections keep
their surrounding Markdown context, and table alignment remains intact.

### Tool calls

Claude Code and Codex CLI tool calls appear in the terminal's visual language:
the tool and its primary argument on one line, the first lines of its result
beneath it, and a count of what was left unread. Commands show their output; a
file read collapses to its size; a file edit reports its added and removed line
counts and draws the diff beneath them, numbered by line and coloured with the
editor's own diff colours, so it matches whichever theme is active. Failed calls
are marked and keep their reason. A call still running says so, and says instead
that no result was recorded once the chat has moved past it — so a shift in the
transcript format reads as a shift, not as a hang.

Codex commands, file changes, web searches, MCP calls, image views, and image
generation are normalized from the rollout's direct, wrapper, and completion
event formats. Ambiguous multi-tool wrappers appear as an explicit `Exec` batch
instead of attributing output to the wrong call.

The panel shows assistant text and real user prompts from the newest 100 user
turns. Thinking blocks, subagent traffic, and harness bookkeeping are skipped.

## Security and privacy in detail

### No local server or agent hooks

AIChatRender deliberately has no HTTP listener. A loopback server is still
reachable by other processes on the same machine and, when cross-origin access
is allowed, may also be reachable from browser pages. Without authentication, a
predictable local endpoint can expose saved chats, accept injected content or
control commands, or be impersonated so an agent hook sends responses to the
wrong process.

Instead, AIChatRender reads the transcript files Claude Code and Codex already
write, validates sessions against the open workspace, and passes parsed content
only through VS Code's internal extension-to-webview channel. It installs no
agent hooks, does not modify either agent's configuration, keeps no additional
history, and makes no network requests. The renderer uses vendored assets under
a no-network Content Security Policy; raw HTML and links remain inert, tool
output is inserted as plain text, and transcript wrapper programs are parsed but
never executed.

These choices reduce the extension's attack surface. They do not sandbox the
underlying agent, make unrestricted execution safe, or turn the rendered panel
into a complete or tamper-proof audit log.

### What it reads

- **Read-only.** It never writes under `~/.claude/` or `~/.codex/`, and keeps no
  copy, inbox, or history of its own — the panel re-reads the existing
  transcript on load.
- **No network.** No HTTP listener, socket, port, or CDN request. KaTeX is
  vendored and served over VS Code's internal webview channel.
- **Codex discovery reads across projects.** To find the rollout belonging to
  *this* workspace, it must read the **first line** of every rollout in the
  scanned date directories — including ones from your other projects. Those
  lines can contain base instructions, git, and provider metadata. Only `cwd`
  and the session timestamp are retained; metadata from nonmatching rollouts is
  never logged and never reaches the webview. Full contents are read only for
  the one rollout that matches this workspace.
- **Follow Active Terminal Chat** may additionally read the PID-keyed Claude
  state record under `~/.claude/sessions/` and the transcript it names, after
  validating that its real cwd is inside the workspace.
- **Transcripts are themselves sensitive files.** A session can contain your
  prompts, command output, diffs, file paths, and any secret that ever appeared
  in them. AIChatRender keeps no extra copy, but it does put that content on
  screen, and anything you copy from the panel lands on the system clipboard —
  worth remembering when sharing a screen or recording.

### Why the rendering is inert

- **No XSS surface.** The Markdown subset builds only fixed DOM elements and
  assigns prose via `textContent`; raw HTML is never parsed. Tool arguments and
  tool output are arbitrary bytes, so they are assigned the same way and are
  never run through the Markdown or math renderers at all. Only math source
  reaches KaTeX (`trust: false`, `throwOnError: false`), under a strict CSP with
  nonce'd scripts, failing soft on malformed records.
- **Codex wrapper programs are never executed.** AIChatRender parses their
  JavaScript syntax with bounded static analysis and accepts only literal data
  (plus simple immutable `const` bindings). Dynamic expressions, computed
  properties, mutation, and unfamiliar block types raise the format-drift
  notice. Image blocks become the text marker `[image]`; data URLs never enter
  panel history or the webview.

Rendering links or HTML out of a transcript would turn model output into a
clickable surface inside your editor, which is exactly what this panel is trying
not to be.

## Full list of known limitations

- **Copying an equation brings extra text with it.** KaTeX renders a formula as
  three layers — a MathML tree, the original LaTeX in an annotation, and the
  visible spans — and the copy currently returns all three concatenated instead
  of the annotation alone. The LaTeX is present and correct; it just arrives
  between the other two, so a pasted `$$…$$` block needs trimming by hand.
  Prose, lists, code, and tables are unaffected.
- Exactly one workspace folder.
- No source toggle: with concurrent Claude and Codex sessions, the panel follows
  whichever matching file changed last unless you pin one.
- Codex discovery scans only the last seven date directories, plus tomorrow as a
  cross-time-zone guard. Older rollouts are not followed, even when resumed.
- Codex rollout JSONL is internal and changes across CLI versions. Parsing is
  intentionally fail-soft: an unfamiliar tool record leaves prose intact and
  raises the panel's format-drift notice.
- Code-mode extraction supports common literal calls, not general JavaScript
  control flow. Ambiguous batches stay aggregated; `write_stdin` and `wait` can
  appear as separate cards. Some wrappers omit a nested shell exit code, in
  which case AIChatRender shows the output without guessing that it failed.
- Event-backed file changes can appear only when their completion event arrives,
  so a very fast Codex edit may never show a pending state.
- On macOS, a stale PID-reuse check is weaker than on Linux: `ps` reports
  wall-clock start times that can't be compared to the marker Claude records, so
  AIChatRender verifies the process still exists rather than that it is the
  *same* process.
- These CLIs ship frequently and their session formats are internal and
  undocumented. A format change can break parsing until it's fixed.
