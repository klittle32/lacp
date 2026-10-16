# 0001 — Which ACP version to target

- Status: accepted
- Date: 2026-10-16

## Context

ACP has a stable protocol version **1** (schema 1.26.0) and a **v2 draft** (schema `2.0.0-alpha.9`, announced
2026-07-20; nine alphas in about three months, all v2 RFDs still "Active", no stabilization date). v2 is a large
breaking redesign:

- `session/prompt` returns `{ messageId }` once the prompt is _inserted_; the turn ends with a `state_update`
  notification (`running` / `requires_action` / `idle` + `stopReason`).
- `tool_call` is gone: `tool_call_update` is an upsert. Message, thought and user-message upserts exist alongside
  chunks, and every chunk carries a `messageId`.
- Client `fs/*` and `terminal/*` are removed; agents report their own terminals with `terminal_update` /
  `terminal_output_chunk`.
- Diffs carry structured `changes` plus a `git_patch`; permission requests gain `title` / `subject`; plans become
  `plan_update`; modes become config options; `authenticate` becomes `auth/login` / `auth/logout`.
- `session/list`, `session/resume` (with `replayFrom`) and `session/close` are baseline; `session/load` is gone.

Client support, as of the decision (verified in source):

- Zed, CodeCompanion.nvim, agent-shell (Emacs) and marimo send `protocolVersion: 1`.
- **T3 Code** (stable and nightly) sends a hybrid `initialize` (v2 `info`/`capabilities` plus v1
  `clientInfo`/`clientCapabilities`, `protocolVersion: 2`), picks v2 when the response contains `info`, and handles
  the v2 features above. Its schemas are pinned to `2.0.0-alpha.3`; the differences to alpha.9 are additive for the
  features `lacp` uses (it does not advertise MCP-over-ACP, which changed incompatibly).

The ACP maintainers ask implementers to support both versions side by side and to gate v2 behind negotiation.

## Decision

Build for v2, serve both.

1. The agent core uses a **version-neutral event model shaped like v2** (stable ids, upserts, an explicit
   foreground state machine). See `src/domain/Events.ts`.
2. Two thin adapters project it onto the wire: `src/acp/ProjectV1.ts` and `src/acp/ProjectV2.ts`, with method
   handlers for each version in `src/agent/AcpServer.ts`.
3. `initialize` follows the v2 negotiation rules, which also satisfy v1 clients: the highest supported version at
   or below the requested one. A client that requests v2 but sends a v1-shaped request is answered as v1. Versions
   below 1 get `-32022` with `{ requested, supported }`.
4. v2 is negotiable **by default** — it only activates for clients that explicitly ask for it, and the primary
   v2 client today (T3 Code) is one this project targets. `LACP_ACP_VERSION=1` turns it off.
5. v1 output already uses the features that carry into v2: `messageId` on every chunk, config options for mode and
   model (with legacy `modes` kept in sync), `session/list` / `session/resume` / `session/close`, `usage_update`, and
   no dependence on client `fs/*` or `terminal/*`.

## Consequences

- Every protocol change touches one adapter, not the core.
- The v2 draft will keep moving; the v2 schemas in `src/acp/V2.ts` are pinned to alpha.9 and must be re-checked
  against each new alpha. Decoding is lenient (unknown keys are ignored) to tolerate additive changes.
- Removing v1 later, once v2 stabilizes and clients move, is a matter of deleting one adapter.
