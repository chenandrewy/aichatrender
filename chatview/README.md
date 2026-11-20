# chatview

A browser viewer for Claude Code and Codex CLI sessions, built on the same
parsers and renderer as the AIChatRender extension. It reads the session files
the CLIs already write and needs no VS Code, no API and no `npm install`.

## Run

Needs Node 22.12 or newer, on Linux or macOS. From the repository root:

```sh
chatview/bin/chatview start
```

Open the printed URL, pick a session, and use **Refresh** to find new ones.
Stop with Ctrl-C, or `chatview/bin/chatview stop` from another terminal. Put
`chatview/bin` on your `PATH` (or symlink the script) to run it as `chatview`.
`stop` finds the viewer by the absolute path of `server.js`, which the wrapper
passes; a viewer started as `node chatview/server.js` cannot be stopped that
way.

Sessions come from `$CLAUDE_CONFIG_DIR` (default `~/.claude`) and
`$CODEX_HOME` (default `~/.codex`).

## Settings

All optional environment variables:

| Variable             | Default     | Purpose                                                                         |
| -------------------- | ----------- | ------------------------------------------------------------------------------- |
| `CHATVIEW_PORT`      | `7710`      | Port to listen on; `0` picks a free one.                                        |
| `CHATVIEW_BIND`      | `127.0.0.1` | Address to listen on. Use `0.0.0.0` inside a container whose port is published. |
| `CHATVIEW_HOST_PORT` | the port    | Port shown in the printed URL, e.g. behind a Docker port mapping.               |
| `CHATVIEW_LABEL`     | none        | Short text shown in the page header, e.g. which machine is serving.             |

## Security

Every request needs the per-run token from the printed URL, or the cookie that
URL sets. Restarting creates a new token and invalidates both. Requests must
use a `127.0.0.1` or `localhost` host name. If you bind to `0.0.0.0`, other
hosts that can reach the port still need the token.

## Tests

```sh
node --test chatview/test/*.test.js
```

## Layout

`server.js` (HTTP and SSE), `sessions.js` (finding and following sessions),
`session-titles.js`, and `browser.js`/`browser.css` (the browser adapter and
theme). The parsers (`transcript.js`, `codex.js`, `codex-tools.js`,
`tool-presentation.js`) and the page (`media/`) live at the repository root and
are shared with the extension. `vendor/` holds Acorn 8.18.0 and Acorn Walk
8.3.5 as ES module source from the
[Acorn repository](https://github.com/acornjs/acorn/tree/d788421b242ddccb28040f1431438ee5cf474208),
with their licenses.
