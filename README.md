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
  (including mod commands), mode and model switching, session list / load / resume with history replay, usage.

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

| Setting               | Env var                | Flag                | Values                                                                                                                                                                    |
| --------------------- | ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication        | `LACP_AUTH`            | `--auth`            | `host` (default: whatever your Letta Code uses), `cloud-oauth` (the login from `letta setup`), `api-key` (with `LETTA_API_KEY`), `local` (Letta Code's on-device backend) |
| API key               | `LETTA_API_KEY`        | —                   | Your Letta API key (for `api-key`)                                                                                                                                        |
| Agent                 | `LETTA_AGENT_ID`       | `--agent-id`        | A Letta agent id. Default: the agent you last used in that project (as `letta` would), otherwise a new one                                                                |
| Model                 | `LACP_MODEL`           | `--model`           | A model handle for new sessions, e.g. `anthropic/claude-sonnet-4-5`                                                                                                       |
| Permission mode       | `LACP_PERMISSION_MODE` | `--permission-mode` | `standard`, `acceptEdits`, `unrestricted`, `strict`. Default: your Letta Code setting                                                                                     |
| Letta Code executable | `LACP_LETTA_PATH`      | `--letta-path`      | Path to `letta`, if discovery does not find it                                                                                                                            |
| Letta Code runtime    | `LACP_LETTA_RUNTIME`   | `--letta-runtime`   | `auto` (default), `node` or `bun`: what runs Letta Code. See [Node or Bun](#node-or-bun)                                                                                  |
| Existing App Server   | `LACP_APP_SERVER_URL`  | `--app-server-url`  | Connect to a running `letta server --listen ws://…` instead of starting one                                                                                               |
| ACP version           | `LACP_ACP_VERSION`     | `--acp-version`     | `2` (default: negotiate v1 or v2) or `1` (never negotiate the v2 draft)                                                                                                   |
| Echo prompts          | `LACP_ECHO_PROMPTS`    | `--echo-prompts`    | `false` (default) or `true`. ACP v2 only: send each prompt back to the client as a `user_message`                                                                         |
| Startup timeout       | `LACP_STARTUP_TIMEOUT` | `--startup-timeout` | Seconds to wait for the App Server (default `60`)                                                                                                                         |
| Log level             | `LACP_LOG_LEVEL`       | `--log-level`       | `debug`, `info` (default), `warn`, … Logs go to stderr                                                                                                                    |

Self-hosted Letta servers work through Letta Code's own `LETTA_BASE_URL` setting.

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
choose the runtime.

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

- Each ACP session is a Letta **conversation** (the session id is the conversation id) on your agent, attached
  to the App Server as a runtime with the session's working directory.
- Tool calls run inside Letta Code, with its permission rules. When Letta needs approval, `lacp` asks the editor
  (`session/request_permission`) and forwards the answer, including "always allow" suggestions.
- Modes are Letta Code's permission modes, models come from Letta's model catalog, and slash commands are the
  App Server's commands plus those contributed by your mods.
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

In VS Code, install the TypeScript 7 (native preview) extension to get the Effect Language Service in the editor;
`.vscode/settings.json` already points at the workspace TypeScript.

## License

MIT
