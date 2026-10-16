# lacp

An [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) (ACP) server for
[Letta Code](https://github.com/letta-ai/letta-code), written in [Effect](https://github.com/Effect-TS/effect) v4.

`lacp` lets any ACP client — Zed, T3 Code, JetBrains IDEs, Neovim and Emacs plugins — talk to your Letta agents.
It does not bundle its own copy of Letta Code: it drives **the Letta Code already installed on your machine**, so
your login, settings, permission rules, skills, hooks, subagents, MCP servers and **mods** all carry over exactly
as they are in your terminal.

- **ACP v1 and v2.** Every connection negotiates the best version both sides support. v1 (stable) works with every
  client; the v2 draft is used with clients that ask for it, such as T3 Code nightly.
- **Your Letta Code, not a copy.** `lacp` finds the host's `letta` (PATH, global npm/bun/pnpm installs, your login
  shell) and runs it as an App Server (`letta server --listen`).
- **One process, many sessions.** A single App Server serves every ACP session; it is started on demand and
  restarted transparently if it dies.
- **Editor-native experience.** Streaming answers and reasoning, tool calls with diffs and file locations, shell
  commands as terminals, permission prompts (including Letta's "always allow" rules), plans, slash commands
  (including mod commands), model, effort and mode switching, session list / load / resume with history replay,
  usage.

## Requirements

- Node.js 22.19 or newer
- Optionally [Bun](https://bun.sh), if you run Letta Code with it (see [Node or Bun](#node-or-bun))
- Letta Code 0.30 or newer, installed globally:

  ```sh
  npm install -g @letta-ai/letta-code
  letta setup   # once, to sign in (or use an API key, below)
  ```

## Install

From source (until the package is published):

```sh
git clone https://github.com/klittle32/lacp.git
cd lacp
npm install
npm run build
npm link        # puts `lacp` on your PATH
```

Check that everything is found:

```sh
lacp doctor
```

## Configure your editor

`lacp` is configured the same way as Letta's own ACP adapter: choose how to authenticate and, optionally, which
Letta agent to talk to. Everything can be set through environment variables in your editor's agent settings.

| Setting               | Env var                    | Flag                       | Values                                                                                                                                                                    |
| --------------------- | -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication        | `LACP_AUTH`                | `--auth`                   | `host` (default: whatever your Letta Code uses), `cloud-oauth` (the login from `letta setup`), `api-key` (with `LETTA_API_KEY`), `local` (Letta Code's on-device backend) |
| API key               | `LETTA_API_KEY`            | —                          | Your Letta API key (for `api-key`)                                                                                                                                        |
| Agent                 | `LETTA_AGENT_ID`           | `--agent-id`               | A Letta agent id. Default: the agent you last used in that project (as `letta` would), otherwise a new one (made with the first prompt)                                   |
| Model                 | `LACP_MODEL`               | `--model`                  | A model handle for new sessions, e.g. `anthropic/claude-sonnet-4-5`                                                                                                       |
| Permission mode       | `LACP_PERMISSION_MODE`     | `--permission-mode`        | `standard`, `acceptEdits`, `unrestricted`, `strict`. Default: `unrestricted` for new sessions; a reopened session keeps its own                                           |
| Letta Code executable | `LACP_LETTA_PATH`          | `--letta-path`             | Path to `letta`, if discovery does not find it                                                                                                                            |
| Letta Code runtime    | `LACP_LETTA_RUNTIME`       | `--letta-runtime`          | `auto` (default), `node` or `bun`: what runs Letta Code. See [Node or Bun](#node-or-bun)                                                                                  |
| Existing App Server   | `LACP_APP_SERVER_URL`      | `--app-server-url`         | Connect to a running `letta server --listen ws://…` instead of starting one                                                                                               |
| ACP version           | `LACP_ACP_VERSION`         | `--acp-version`            | `2` (default: negotiate v1 or v2) or `1` (never negotiate the v2 draft)                                                                                                   |
| Echo prompts          | `LACP_ECHO_PROMPTS`        | `--echo-prompts`           | `false` (default) or `true`. ACP v2 only: send each prompt back to the client as a `user_message`                                                                         |
| Wait for background   | `LACP_WAIT_FOR_BACKGROUND` | `--no-wait-for-background` | `true` (default) or `false`: keep a turn open until the background subagents it started report back. See below                                                            |
| Startup timeout       | `LACP_STARTUP_TIMEOUT`     | `--startup-timeout`        | Seconds to wait for the App Server (default `60`)                                                                                                                         |
| Log level             | `LACP_LOG_LEVEL`           | `--log-level`              | `debug`, `info` (default), `warn`, … (any case). `trace` also logs every App Server frame. Logs go to stderr                                                              |
| Log file              | `LACP_LOG_FILE`            | `--log-file`               | Also append the server's log to this file (`~/` is your home). Useful in T3 Code, which keeps none of an agent's stderr                                                   |

Self-hosted Letta servers work through Letta Code's own `LETTA_BASE_URL` setting.

Letta Code uses `LETTA_API_KEY` from its environment ahead of your stored login. With the default `LACP_AUTH=host`,
a key that reaches `lacp` therefore wins; `LACP_AUTH=cloud-oauth` removes it so your login is used. Editors started
from the macOS Dock usually do not see variables exported in your shell profile, so only a key set in the editor's
agent settings reaches `lacp` there. `lacp doctor` notes when the key is set.

### Node or Bun

Letta Code keeps your Letta Cloud login in a different place depending on what runs it. Under **Bun** it is in the
system keychain (the macOS Keychain); under **Node** it is in `~/.letta/settings.json`. Bun also moves a login it
finds in that file into the keychain, after which Letta Code under Node no longer sees it. So `lacp` runs Letta
Code's `letta.js` with the runtime that can see your login:

- `auto` (default): Node while `~/.letta/settings.json` holds your login, otherwise Bun when it is installed. On
  Windows, always Node.
- `node` or `bun`: always that runtime.

`lacp doctor` shows the runtime it picked, why, and where your login is. `lacp` itself runs on Node either way; this
setting only decides what runs Letta Code. It applies when `letta` is an npm or Bun install (a link to `letta.js`).
For other launchers (Volta or pnpm shims, `letta.cmd` on Windows), set `LACP_LETTA_PATH` to the `letta.js` file to
choose the runtime. Under Bun, Letta Code loads the `.env` files of the folder your editor starts `lacp` in (the
project), as it does in your terminal; under Node it does not. With `LACP_AUTH=cloud-oauth`, `lacp` passes an empty
`LETTA_API_KEY`, which no `.env` file can override, so your login is used either way.

### Zed

```jsonc
// settings.json
{
  "agent_servers": {
    "Letta Code": {
      "type": "custom",
      "command": "lacp",
      "args": [],
      "env": {
        "LACP_AUTH": "cloud-oauth",
        "LETTA_AGENT_ID": "agent-…"
      }
    }
  }
}
```

With an API key instead:

```jsonc
"env": { "LACP_AUTH": "api-key", "LETTA_API_KEY": "sk-let-…", "LETTA_AGENT_ID": "agent-…" }
```

Open the Agent Panel, click **+**, and choose **Letta Code**. If Zed cannot find `lacp`, use its absolute path
(`which lacp`): editors launched from the macOS Dock may not see your shell's PATH.

### T3 Code

**Settings → Providers → Add provider → Local ACP command**, then:

- Command: `lacp` (or its absolute path)
- Environment: `LACP_AUTH=cloud-oauth` and `LETTA_AGENT_ID=agent-…` (or `LACP_AUTH=api-key` with `LETTA_API_KEY`)
- Letta's notices (a retried model request, an error, an MCP server that did not start) show as rows in the
  turn's work log: T3 Code's ACP version has no notices of its own.
- To see what `lacp` logs, add `LACP_LOG_FILE=~/lacp.log` (and `LACP_LOG_LEVEL=debug`, or `trace` for every
  App Server frame): T3 Code does not keep an agent's stderr.

T3 Code nightly speaks the ACP v2 draft, so `lacp` negotiates v2 with it: turns end with `state_update`, shell
commands appear as terminals, and edits arrive as git patches. Prompts are not echoed back (`LACP_ECHO_PROMPTS`):
T3 Code cannot match an echo to the message it already shows, so it would display a second copy, including the
instructions T3 adds to your prompts.

### Other ACP clients

Run `lacp` as the agent command with the environment above. Clients that support terminal authentication are
offered a **Sign in to Letta** method, which runs `lacp setup` (that is, your `letta setup`) in a terminal.

## How it works

```
ACP client ──stdio, JSON-RPC (ACP v1 or v2)──▶ lacp ──WebSocket──▶ letta server --listen ──▶ Letta Cloud /
 (Zed, T3 Code, …)                               │                 (your Letta Code install)     local backend
                                                 └── spawns and supervises ───────┘
```

- Each ACP session is a Letta **conversation** on your agent, attached to the App Server as a runtime with the
  session's working directory. A new session gets its conversation with its first prompt, so sessions a client
  opens and never uses (T3 Code opens one each time it checks its providers) leave nothing behind in Letta. Such a
  session has an id of `lacp`'s own (`lacp-<uuid>`), which it keeps once its conversation exists: `lacp` records
  the pair in `~/.letta/lacp/sessions`, so the session lists and resumes under that id. A session opened on an
  existing conversation (`session/load`, `session/resume`) uses the conversation id.
- Tool calls run inside Letta Code, with its permission rules. When Letta needs approval, `lacp` asks the editor
  (`session/request_permission`) and forwards the answer, including "always allow" suggestions.
- Sessions offer three settings, in this order: **Model**, **Effort** and **Mode**.
  - Models are Letta Code's, one per model and context window (a `…-1M` variant is its own entry), named with
    their provider, since the same model can come from several.
  - Effort lists the levels the selected model supports (from `letta model list`, which covers your own
    providers, a ChatGPT subscription and the local backend, not just Letta's hosted models). It is applied
    through Letta's effort preset where the model has one, and with `letta model set --reasoning` otherwise.
    Switching models keeps the effort when the new model supports it. Clients show it as a `thought_level`
    setting (T3 Code: the traits menu; Zed: a dropdown next to the model).
  - Modes are Letta Code's permission modes.
- Slash commands are the App Server's commands plus those contributed by your mods. Until a new session's first
  prompt starts its runtime, it offers Letta's built-in commands.
- Background subagents, such as a Codex worker started with the Agent tool, report back in a follow-up turn that
  Letta runs on its own. Clients like T3 Code only show turns they started, so `lacp` keeps a turn open until the
  background subagents it started have reported back, and their report appears in it. Meanwhile the client shows
  the turn as working; stopping it ends the wait (the subagent carries on, but its report is then not shown in T3).
  T3 Code holds back the end of a reply that is still streaming, so the report shows in full when the turn ends.
  Letta's silent subagents (reflection, memory), background shell commands and subagents started before the prompt
  do not hold a turn open. Letta's `<task-notification>` messages are not shown as if you had typed them.
- MCP servers the editor offers in `session/new` (for example T3 Code's per-session server) are connected by
  `lacp`, over stdio or Streamable HTTP, and their tools are registered with the Letta runtime as external tools
  named `mcp__<server>__<tool>`. Letta Code runs them like its own tools (with its approval rules), and `lacp`
  executes each call against the editor's server. Tools added later (`notifications/tools/list_changed`) are
  re-registered live. A server that cannot start is skipped with a warning; the session still opens. MCP
  servers configured in Letta Code itself keep working alongside them.
- Ambient variables leaked by a parent Letta session (`AGENT_ID`, `USER_CWD`, `MEMORY_DIR`, …) are removed before
  `letta` starts, so the editor session cannot accidentally bind to another agent.

More detail: [docs/architecture.md](docs/architecture.md). Why both ACP versions:
[docs/decisions/0001-acp-version.md](docs/decisions/0001-acp-version.md).

### Known limitations

- Client MCP servers using the deprecated SSE transport are skipped (stdio and Streamable HTTP are supported).
  A bridged tool call may take at most 5 minutes, Letta's limit for external tools.
- Client file-system and terminal capabilities are not used: tools run in Letta Code on your machine.
- Session forking and deletion are not offered.

## Development

The project uses the toolchain the Effect v4 repository recommends:

| Tool                                                                                       | Purpose                                                                                            |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [TypeScript 7](https://github.com/microsoft/typescript-go) (`tsc`, the Go-native compiler) | type checking and builds                                                                           |
| [`@effect/tsgo`](https://github.com/Effect-TS/tsgo)                                        | the Effect Language Service for TS 7; `npm install` patches `tsc` so it reports Effect diagnostics |
| [oxlint](https://oxc.rs) + `oxlint-tsgolint`                                               | linting, with the Effect rule presets shipped in `@effect/tsgo`                                    |
| [dprint](https://dprint.dev)                                                               | formatting                                                                                         |
| [Vitest](https://vitest.dev) + `@effect/vitest`                                            | tests                                                                                              |

```sh
npm install          # also runs `effect-tsgo patch`
npm run check        # tsc with Effect diagnostics
npm run lint         # oxlint + dprint check
npm test             # unit and integration tests
npm run build        # dist/
npm run dev -- doctor  # run from source (Node type stripping)
```

End-to-end tests drive a real Letta Code with its offline deterministic backend (no network, no account):

```sh
LACP_E2E_LETTA="$(command -v letta)" npm test
```

A smoke test runs this checkout in a real T3 Code. It installs a T3 Code release (the nightly by default, kept in
`~/.cache/lacp/t3-smoke`), adds `lacp` as a Local ACP command on Letta Code's local backend with a scripted model,
and drives T3's web UI in your Chrome. It checks that a background subagent's report appears and the turn ends on
its own, that Stop ends a turn waiting for one, that Letta's retries show as readable rows, and that only the
threads it prompted (not T3's provider checks) created Letta conversations. Screenshots, `lacp.log` and T3's
output go to the directory it prints (macOS and Linux):

```sh
npm run smoke:t3
T3_SMOKE_VERSION=0.1.1-nightly.20261016.3218 npm run smoke:t3   # a specific release
T3_SMOKE_BROWSER=/path/to/chromium npm run smoke:t3              # without Google Chrome
```

In VS Code, install the TypeScript 7 (native preview) extension to get the Effect Language Service in the editor;
`.vscode/settings.json` already points at the workspace TypeScript.

## License

MIT
