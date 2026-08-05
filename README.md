# AIChatRender

Read your Claude Code or Codex CLI session in a VS Code panel, with the math
actually rendered. Prose stays plain text; `$$…$$` becomes typeset equations,
updating live as the session runs.

The terminal already shows you the chat. The reason this exists is that LaTeX in
a terminal is unreadable, and copying an equation out of one is worse.

> **Unaffiliated.** AIChatRender is an independent tool. It is not made,
> endorsed, or supported by Anthropic or OpenAI. It reads the session files
> those CLIs already write to your own disk; it uses no API and no account.

## What it does

- **Follows the active session.** Watches this workspace's Claude transcripts
  (`~/.claude/projects/`) and Codex rollouts (`~/.codex/sessions/`), following
  whichever was written most recently and switching automatically. Both vendors
  count a session as this workspace's when its cwd is the workspace folder or
  any directory beneath it, so a CLI started in a subfolder is still followed.
- **AIChatRender: Follow Active Terminal Chat** pins the panel to the transcript
  held open by your active terminal's process tree. If the terminal can't be
  matched — an idle CLI often closes its transcript — a picker lists the
  workspace's recent chats.
- **AIChatRender: Browse Turns and Pick** opens a searchable list of the user
  prompts in the chat being followed, oldest first to match the panel and its
  upper-right turn index, each shown as its first 80 characters or so (the cap
  bounds rendered width, so wide characters count double). Picking one scrolls
  the panel to that turn and flashes it. The list covers the messages the panel
  currently holds, so it never offers a turn the panel cannot show.
- **Renders math** with a vendored, pinned KaTeX: `$$…$$` and `\[…\]` display,
  `\(…\)` and `$…$` inline. Single-`$` uses Pandoc-style guards so currency and
  `$VAR` don't trigger false positives.
- **Copies rendered content back as Markdown source.** Headings, emphasis,
  blockquotes, ordered and unordered lists, code, rules, and tables retain their
  syntax; equations become their original LaTeX. Mixed and partial selections
  keep their surrounding Markdown context, and table alignment remains intact.
- **A deliberately small Markdown subset**: headings, lists, blockquotes, rules,
  bold/italic, inline and fenced code, and `| a | b |` tables (with column
  alignment and math inside cells). Raw HTML and Markdown links stay inert
  text — see below.
- **Shows Claude Code's tool calls** the way the terminal does: the tool and its
  primary argument on one line, the first lines of its result beneath it, and a
  count of what was left unread. Commands show their output; a file read
  collapses to its size, and a file edit reports its added and removed line
  counts, since neither the file nor the diff is what you are reading the panel
  for. Failed calls are marked and keep their reason. A call still running says
  so, and says instead that no result was recorded once the chat has moved past
  it — so a shift in the transcript format reads as a shift, not as a hang.
  Codex CLI sessions show prose only: its rollouts describe a tool call as a
  JavaScript program inside a string, with the readable labels in a separate
  event stream, so it needs its own parser.
- Shows assistant text and real user prompts from the newest 100 user turns.
  Thinking blocks, subagent traffic, and harness bookkeeping are skipped.

## Requirements

- **Linux or macOS.** Following the active terminal needs process
  introspection: `/proc` on Linux, `pgrep`/`lsof`/`ps` on macOS.
- **Windows: use WSL or a remote/container workspace.** AIChatRender declares
  `"extensionKind": ["workspace"]`, so it runs on the Linux side of a remote
  window, which is the supported path. Run natively on Windows, the panel and
  manual transcript picking still work, but **Follow Active Terminal Chat**
  reports that it is unsupported rather than silently failing.
- VS Code 1.85 or newer.

## What it reads, and what that means

This is an extension that reads your AI chat transcripts, so it's worth being
precise about the scope.

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
- **No XSS surface.** The Markdown subset builds only fixed DOM elements and
  assigns prose via `textContent`; raw HTML is never parsed. Tool arguments and
  tool output are arbitrary bytes, so they are assigned the same way and are
  never run through the Markdown or math renderers at all. Only math source
  reaches KaTeX (`trust: false`, `throwOnError: false`), under a strict CSP with
  nonce'd scripts, failing soft on malformed records.

The inert-Markdown choice is deliberate. Rendering links or HTML out of a
transcript would turn model output into a clickable surface inside your editor,
which is exactly what this panel is trying not to be.

## Commands

| Command | What it does |
| --- | --- |
| `AIChatRender: Show Panel` | Open the panel, following the newest transcript. |
| `AIChatRender: Follow Active Terminal Chat` | Pin to the active terminal's chat. |
| `AIChatRender: Browse Turns and Pick` | List the chat's user prompts and scroll to one. |

## Known limitations

- Exactly one workspace folder.
- Automatic discovery does not follow sessions started from a subdirectory, but
  **Follow Active Terminal Chat** can select one whose real cwd is inside the
  workspace.
- No source toggle: with concurrent Claude and Codex sessions, the panel follows
  whichever matching file changed last unless you pin one.
- Codex discovery scans only the last seven date directories, plus tomorrow as a
  cross-time-zone guard. Older rollouts are not followed, even when resumed.
- On macOS, a stale PID-reuse check is weaker than on Linux: `ps` reports
  wall-clock start times that can't be compared to the marker Claude records, so
  AIChatRender verifies the process still exists rather than that it is the *same*
  process.
- These CLIs ship frequently and their session formats are internal and
  undocumented. A format change can break parsing until it's fixed.

## License and citation

MIT — see `LICENSE`. Use it freely, including in commercial work. Bundled KaTeX
is separately MIT-licensed; see `media/katex/LICENSE`.

If AIChatRender is useful in academic work, a citation is appreciated but not
required by the license:

> Chen, Andrew Y. (2026). *AIChatRender: rendered math for AI coding-agent
> transcripts in VS Code.*
