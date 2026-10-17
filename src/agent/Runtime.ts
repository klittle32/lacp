/**
 * Starting a Letta runtime for a session's conversation.
 *
 * `runtime_start` attaches an App Server connection to a conversation (or
 * creates one) with lacp's client info and the flags it relies on: approvals
 * are recovered, the device status is forced and replay is awaited.
 */
import { Effect, Exit, Option, type PubSub, Scope } from "effect"
import type { Frame, LettaConnection } from "../letta/AppServer.ts"
import {
  type ExternalToolDefinition,
  type PermissionMode,
  type RuntimeScope,
  RuntimeStartResponse
} from "../letta/Protocol.ts"
import { AGENT_NAME, AGENT_TITLE, VERSION } from "../Version.ts"
import { AgentUnavailable, unavailable } from "./Errors.ts"

export interface RuntimeTarget {
  readonly agentId: string
  readonly conversationId: Option.Option<string>
  readonly cwd: string
  readonly tools: ReadonlyArray<ExternalToolDefinition>
  readonly mode: Option.Option<PermissionMode>
}

/** A started runtime: its scope, its frames and Letta's response. */
export interface StartedRuntime {
  readonly scope: Scope.Closeable
  readonly subscription: PubSub.Subscription<Frame>
  readonly response: RuntimeStartResponse
  readonly runtime: RuntimeScope
}

/**
 * Starts a runtime in a new scope and subscribes to its frames (before
 * `runtime_start`, so nothing is missed). The scope is closed again if
 * starting fails or is interrupted.
 */
export const startRuntime = Effect.fnUntraced(
  function*(conn: LettaConnection, parent: Scope.Scope, target: RuntimeTarget) {
    const scope = yield* Scope.fork(parent)
    return yield* Effect.gen(function*() {
      const subscription = yield* Scope.provide(conn.subscribe, scope)
      const response = yield* conn.call(
        (request_id) => ({
          type: "runtime_start",
          request_id,
          agent_id: target.agentId,
          ...(Option.isSome(target.conversationId)
            ? { conversation_id: target.conversationId.value }
            : { create_conversation: { body: {} } }),
          cwd: target.cwd,
          mode: Option.getOrUndefined(target.mode),
          client_info: { name: AGENT_NAME, title: AGENT_TITLE, version: VERSION },
          recover_approvals: true,
          force_device_status: true,
          wait_for_replay: true,
          ...(target.tools.length > 0 ? { external_tools: [{ tools: target.tools }] } : {})
        }),
        RuntimeStartResponse,
        { timeout: "2 minutes" }
      ).pipe(Effect.mapError(unavailable))
      if (response.runtime === null) {
        return yield* new AgentUnavailable({
          message: response.error ?? "Letta Code did not start a runtime",
          auth: false
        })
      }
      const started: StartedRuntime = { scope, subscription, response, runtime: response.runtime }
      return started
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
  }
)
