# Architecture

`lacp` is a pure Effect v4 program. Every component is a `Context.Service` with a `static layer`; layers are
provided once, in `src/Cli.ts` / `src/main.ts`.

```
src/
├── main.ts               entry: Node services, Host, stderr logging, runMain
├── Cli.ts                effect/cli: `lacp`, `lacp setup`, `lacp doctor`; flags with env fallbacks
├── Config.ts             LacpConfig (auth mode, agent, model, permission mode, ACP version, …)
├── Host.ts               the host process environment (env, platform, cwd, home) as a service
├── jsonrpc/              transport-agnostic JSON-RPC 2.0
│   ├── JsonRpc.ts        wire schemas, error codes, RpcError
│   ├── Method.ts         typed method descriptors, handlers, dispatchers
│   ├── Transport.ts      NDJSON over stdio (single writer fiber) / in-memory queues for tests
│   └── Peer.ts           bidirectional peer: requests both ways, batches, $/cancel_request
├── acp/                  the ACP wire formats
│   ├── Content.ts        shared content blocks and small types
│   ├── V1.ts, V2.ts      method descriptors and schemas per protocol version
│   └── ProjectV1.ts, ProjectV2.ts   domain events → session/update per version
├── domain/Events.ts      the version-neutral session model (v2-shaped)
├── agent/
│   ├── AcpServer.ts      initialize negotiation; v1 and v2 method sets over the core
│   ├── Agent.ts          the core: sessions ⇄ Letta runtimes, turns, approvals, config, history
│   ├── Client.ts         the client port: emit events / request permission on the negotiated surface
│   └── Prompt.ts         ACP prompt content → Letta message content; slash-command detection
└── letta/
    ├── Executable.ts     finds and validates the host's `letta`
    ├── AppServer.ts      spawns `letta server --listen`, WebSocket client, request correlation, restarts
    ├── Protocol.ts       schemas for App Server commands and frames
    ├── Translator.ts     stream deltas / history rows → domain events
    ├── Tools.ts          tool-call presentation (titles, kinds, locations, diffs, plans)
    └── Errors.ts
```

## Flow of a prompt

1. The client sends `session/prompt`. `AcpServer` decodes it with the negotiated version's schema and calls
   `Agent.prompt`.
2. `Agent` takes the session's turn lock (one turn at a time), makes sure the session is attached to the current
   App Server generation, and sends an `input` command. Once Letta acknowledges it (`input_accepted`), the prompt
   is _inserted_: a `UserMessage` event and `State(running)` are emitted and a `PromptHandle` is returned.
   - v2 answers `session/prompt` right away with `{ messageId }`.
   - v1 awaits `handle.completion` and answers with the stop reason.
3. The session's frame fiber routes App Server frames for its conversation:
   - `stream_delta` → `Translator` → events (message/thought chunks, tool-call upserts, terminals, plans, usage);
   - `control_request` → a permission request to the client, answered back as an `approval_response`;
   - `turn_finished` → remaining tool calls are closed, `State(idle, stopReason)` is emitted and the turn resolves.
4. `AcpClient` projects each event onto the negotiated version (`ProjectV1` / `ProjectV2`) and sends
   `session/update` notifications in order, always before the v1 prompt response.

Cancellation sends `abort_message`; if Letta never reports the end of the turn, the turn is ended locally after
15 seconds. A queued input (Letta still finishing earlier work) only counts as started once Letta dequeues or
echoes it, so a `turn_finished` for the earlier work cannot end the new turn.

## The Letta connection

`LettaAppServer` owns one connection at a time. The first use resolves the host's `letta` (`LettaExecutable`),
spawns `letta [--backend …] server --listen ws://127.0.0.1:0` with the host's environment (minus ambient Letta
session variables) and connects over WebSocket (`effect/socket`). Responses are correlated by `request_id`; all
other frames are published to a `PubSub` that sessions subscribe to _before_ starting their runtime, so no replayed
state is missed. If the process exits or the socket drops, active turns end with an error and the next use starts
a new App Server; sessions see the new `generation` and re-attach their runtimes.

## Testing

- `test/helpers/FakeLetta.ts` is an in-memory App Server connection with scripted responses and frames, and
  `test/helpers/AcpClient.ts` a scripted ACP client over in-memory queues. Together they exercise the full server
  (peer, negotiation, adapters, core) deterministically.
- `test/e2e.test.ts` runs the same stack against a real Letta Code install with its offline deterministic backend
  (opt-in with `LACP_E2E_LETTA`).
