# Architecture

`lacp` is a pure Effect v4 program. Every component is a `Context.Service` with a `static layer`; layers are
provided once, in `src/Cli.ts` / `src/main.ts`.

```
src/
├── main.ts               entry: Node services, Host, stderr logging, runMain
├── Cli.ts                effect/cli: `lacp`, `lacp setup`, `lacp doctor`; flags with env fallbacks
├── Config.ts             LacpConfig (auth mode, agent, model, permission mode, ACP version, …)
├── Host.ts               the host process environment (env, platform, cwd, home) as a service
├── LogFile.ts            the optional log file (`LACP_LOG_FILE`), alongside stderr
├── jsonrpc/              transport-agnostic JSON-RPC 2.0
│   ├── JsonRpc.ts        wire schemas, error codes, RpcError
│   ├── Method.ts         typed method descriptors, handlers, dispatchers
│   ├── Transport.ts      NDJSON over stdio (single writer fiber) / in-memory queues for tests
│   └── Peer.ts           bidirectional peer: requests both ways, batches, cancellation (ACP or MCP style)
├── acp/                  the ACP wire formats
│   ├── Content.ts        shared content blocks and small types
│   ├── V1.ts, V2.ts      method descriptors and schemas per protocol version
│   ├── Mcp.ts            the client's `mcpServers` (v1 or v2 shape) → MCP server configs
│   └── ProjectV1.ts, ProjectV2.ts   domain events → session/update per version
├── domain/Events.ts      the version-neutral session model (v2-shaped)
├── agent/
│   ├── AcpServer.ts      initialize negotiation; v1 and v2 method sets over the core
│   ├── Agent.ts          the core: sessions ⇄ Letta runtimes, frame routing, turns, approvals, history
│   ├── Turn.ts           a turn's phase (Submitted, Queued, Running, Held) and its transitions
│   ├── AgentResolver.ts  which Letta agent a session uses: configured, the host's last one, or a new one
│   ├── Settings.ts       a session's model, effort and mode: config options and applying changes (a service)
│   ├── SessionIds.ts     lacp's own ids for sessions created before their conversation, and their conversations
│   ├── Errors.ts         the core's errors, mapped onto JSON-RPC errors by AcpServer
│   ├── Client.ts         the client port: emit events / request permission on the negotiated surface
│   └── Prompt.ts         ACP prompt content → Letta message content; slash-command detection
├── letta/
│   ├── Executable.ts     finds and validates the host's `letta`; picks Node or Bun for `letta.js`
│   ├── Login.ts          where Letta Code's login lives (settings file or keychain)
│   ├── AppServer.ts      spawns `letta server --listen`, WebSocket client, request correlation, restarts
│   ├── Protocol.ts       schemas for App Server commands and frames (`RuntimeFrame`, `Delta` unions)
│   ├── History.ts        a conversation's stored messages, paged as a Stream
│   ├── Commands.ts       Letta's slash commands as an editor sees them
│   ├── Models.ts         Letta's models → model choices with effort levels; how a change is applied
│   ├── Translator.ts     stream deltas / history rows → domain events
│   ├── Tools.ts          tool-call presentation (titles, kinds, locations, diffs, plans)
│   └── Errors.ts
└── mcp/                  an MCP client for the servers the ACP client provides
    ├── Config.ts         McpServerConfig (stdio / Streamable HTTP), McpError
    ├── Protocol.ts       MCP lifecycle, tools and server-to-client method schemas
    ├── Transports.ts     stdio (child process) and Streamable HTTP (POST + JSON/SSE, session id) transports
    ├── McpClient.ts      initialize, paginated tools/list, list_changed, tools/call, roots/list, ping
    └── Bridge.ts         McpBridges: a session's servers as Letta external tools (names, definitions, results)
```

## Sessions and conversations

`session/new` creates nothing in Letta. It reads the agent (if one is configured or found in the host's Letta
settings) and the model catalog, and opens a _pending_ session with an id from `SessionIds` (`lacp-<uuid>`), the
agent's model and effort, the configured permission mode (Unrestricted by default) and Letta's built-in slash
commands. Changing the model, effort or mode only records the choice. The first prompt then creates the agent (if
there is none yet) and the conversation, with `runtime_start` (`create_conversation`, the session's mode), applies
the chosen model and effort to the new conversation, and records the pair in `SessionIds`. The runtime's device
status then supplies the session's real commands. A session lock serializes this with config changes made
meanwhile.

`SessionIds` keeps each pair in memory and as two small files in `~/.letta/lacp/sessions` (one per side), so a
`lacp-` id resumes or loads its conversation in this process or a later one, and `session/list` reports
conversations under the id they were created for. A `lacp-` id without a conversation reopens as a pending
session again. Sessions opened on a stored conversation (`session/load`, `session/resume` with a conversation
id) start their runtime at once.

## Flow of a prompt

1. The client sends `session/prompt`. `AcpServer` decodes it with the negotiated version's schema and calls
   `Agent.prompt`.
2. `Agent` takes the session's turn lock (one turn at a time), creates the session's conversation if it has none
   yet (see above) or makes sure it is attached to the current App Server generation, and sends an `input`
   command. Once Letta acknowledges it (`input_accepted`), the prompt
   is _inserted_: a `UserMessage` event and `State(running)` are emitted and a `PromptHandle` is returned.
   - v2 answers `session/prompt` right away with `{ messageId }`.
   - v1 awaits `handle.completion` and answers with the stop reason.
3. The session's frame fiber decodes App Server frames for its conversation (`RuntimeFrame`) and routes them by
   type (`Match`):
   - `stream_delta` → `Translator` → events (message/thought chunks, tool-call upserts, terminals, plans, usage);
   - `control_request` → a permission request to the client, answered back as an `approval_response`;
   - `turn_finished` → remaining tool calls are closed, `State(idle, stopReason)` is emitted and the turn resolves.
     If the turn started background subagents that are still running (`update_subagent_state`, not silent) or a
     `task_notification` is queued (`update_queue`), the result is held instead: the subagent's report comes in a
     follow-up turn Letta runs on its own, which streams into the still-open turn, and that turn's end resolves it
     (or the held result stands if no follow-up starts within a grace period). A subagent counts as done when its
     state says so or when its report arrives (the `subagent_id=` in the `<task-notification>`): once the turn
     that started it has ended, Letta Code does not send the subagent's final state. A turn Letta ends as
     cancelled is never held, and cancelling a held turn ends it at once. This is for clients that do not show
     turns the agent starts on its own, such as T3 Code.
4. `AcpClient` projects each event onto the negotiated version (`ProjectV1` / `ProjectV2`) and sends
   `session/update` notifications in order, always before the v1 prompt response. Notices (retries, Letta errors,
   unavailable MCP servers) go out as `notice` where the client presents them: v1 clients that advertise
   `session.notices`, and v2 clients other than T3 Code. T3 Code's ACP draft predates notices and shows one as an
   empty "Unsupported ACP update" row, so it gets each as a finished tool call (failed for errors) with the
   notice's text.

Cancellation sends `abort_message` and ends the turn as soon as Letta acknowledges the abort: Letta reports the end
of an aborted turn only once the model request settles, which takes as long as the model stays silent. If Letta
has nothing to abort and never reports the end of the turn, the turn is ended locally after 15 seconds. Either way
the turn's late output and end are dropped. A queued input (Letta still finishing earlier work) only counts as
started once Letta dequeues or echoes it, so a `turn_finished` for the earlier work cannot end the new turn. These
rules are the turn's phases in `src/agent/Turn.ts`: Submitted (sent, not yet acknowledged), Queued, Running, and
Held (waiting for background work).

## The Letta connection

`LettaAppServer` owns one connection at a time. The first use resolves the host's `letta` (`LettaExecutable`).
When that is a link to `letta.js`, the script is run with Node or Bun (`LACP_LETTA_RUNTIME`): Letta Code keeps its
login in the system keychain only under Bun and in `~/.letta/settings.json` under Node, so `auto` follows the
login (`letta/Login.ts`), with Node on Windows. It then spawns `letta [--backend …] server --listen
ws://127.0.0.1:0` with the host's environment (minus ambient Letta session variables) and connects over WebSocket
(`effect/socket`). Responses are correlated by `request_id`; all other frames are published to a `PubSub` that
sessions subscribe to _before_ starting their runtime, so no replayed state is missed. If the process exits or the
socket drops, active turns end with an error and the next use starts a new App Server; sessions see the new
`generation` and re-attach their runtimes.

## Models and effort

Sessions offer three config options: model, effort (`thought_level`) and mode, built and applied by the `Settings`
service (`agent/Settings.ts`) on each session's settings record. `letta/Models.ts` builds the model
choices from `list_models`, one per handle and context window, and takes each model's effort levels from
`letta model list` (run once per App Server, through `LettaAppServer.cli`), falling back to the levels of its
presets when that is unavailable.

Letta Code expresses effort in two ways, and `Settings` applies a change accordingly:

- Hosted models have one catalog preset per effort level: `update_model` with the preset's `model_id`.
- Models from the user's own providers, a ChatGPT subscription or the local backend report their levels instead:
  `letta model set --conversation <id> --reasoning <level>`, which uses Letta's own per-provider translation, and
  then `conversation_retrieve` to read the result back.

The current effort is read from the conversation's `model_settings`. A model switch selects the preset for the
current effort, else the medium one (Letta resolves a bare handle to its first preset, often `none`), and then
re-applies the effort if the new model supports it as a setting.

## Client MCP servers

ACP clients may pass MCP servers to `session/new`, `session/load` and `session/resume`. `lacp` itself is the MCP
client: Letta Code has no way to attach a server to one runtime, but it does accept controller-owned _external
tools_.

1. `acp/Mcp.ts` decodes the version-specific entries; SSE servers and malformed entries are skipped.
2. While the Letta connection is prepared, `Bridge.connectAll` connects every server concurrently, each in its own
   scope forked from the session's (so closing the session stops the servers). The MCP client reuses the JSON-RPC
   peer over an MCP transport and answers `ping` and `roots/list` (the session's working directory). A server that
   fails or takes longer than 30 seconds is reported as a warning notice and left out.
3. `runtime_start` carries the tools as `external_tools`, named `mcp__<server>__<tool>` (sanitized, at most 64
   characters) with `auto_background: false` and Letta's maximum timeout.
4. Letta sends `external_tool_call_request` frames on the runtime's channel; the session runs the call with
   `tools/call` and answers with `external_tool_call_response`. Errors become `is_error` results.
5. On `notifications/tools/list_changed` the client refreshes its list and the session sends
   `runtime_external_tools_update` (when Letta Code advertises that capability).

Tool calls are presented with the MCP tool's title and its `readOnlyHint`, through the translator's
`externalTool` hook.

## Testing

- `test/helpers/FakeLetta.ts` is an in-memory App Server connection with scripted responses and frames, and
  `test/helpers/AcpClient.ts` a scripted ACP client over in-memory queues. Together they exercise the full server
  (peer, negotiation, adapters, core) deterministically.
- `test/mcp.test.ts` drives the MCP client and bridge against `test/fixtures/mcp-server.mjs` (stdio) and an
  in-test Streamable HTTP server; `test/acp-mcp.test.ts` covers the bridge end to end through the ACP server.
- `test/e2e.test.ts` runs the same stack against a real Letta Code install with its offline deterministic backend
  (opt-in with `LACP_E2E_LETTA`).
