/**
 * The agent core: ACP sessions backed by Letta Code App Server runtimes.
 *
 * Each ACP session is one Letta conversation, attached to the App Server as a
 * runtime; a new session gets its conversation with its first prompt (see
 * {@link SessionIds} for the ids of such sessions). The core is
 * protocol-version neutral: it emits {@link SessionEvent}s and permission
 * requests through {@link AcpClient}, and exposes turn completion as an effect
 * that the v1 surface awaits and the v2 surface reports via `state_update`.
 */
import {
  Context,
  Deferred,
  Effect,
  Equal,
  Exit,
  FiberHandle,
  FiberSet,
  Layer,
  Match,
  Option,
  Path,
  PubSub,
  Schema,
  Scope,
  Semaphore,
  Stream
} from "effect"
import { Crypto } from "effect/Crypto"
import type { ContentBlock } from "../acp/Content.ts"
import * as Content from "../acp/Content.ts"
import { LacpConfig } from "../Config.ts"
import type { Command, ConfigOption, PermissionDecision, SessionEvent } from "../domain/Events.ts"
import { Host } from "../Host.ts"
import { type Frame, LettaAppServer, type LettaConnection } from "../letta/AppServer.ts"
import * as Commands from "../letta/Commands.ts"
import * as History from "../letta/History.ts"
import {
  AbortMessageResponse,
  type ControlRequest,
  ConversationListResponse,
  ConversationRetrieveResponse,
  type DeviceStatus,
  ExecuteCommandResponse,
  type ExternalToolCallRequest,
  type ExternalToolDefinition,
  GetCwdMapResponse,
  InputAccepted,
  type LoopStatus,
  type PermissionMode,
  type QueueUpdate,
  RuntimeExternalToolsUpdateResponse,
  RuntimeFrame,
  type RuntimeScope,
  RuntimeStartResponse,
  type StreamDelta,
  type SubagentState,
  type TurnFinished
} from "../letta/Protocol.ts"
import * as Translator from "../letta/Translator.ts"
import * as Bridge from "../mcp/Bridge.ts"
import type { McpServerConfig } from "../mcp/Config.ts"
import { AGENT_NAME, AGENT_TITLE, VERSION } from "../Version.ts"
import { AgentResolver } from "./AgentResolver.ts"
import { AcpClient } from "./Client.ts"
import { type AgentError, AgentUnavailable, PromptRejected, SessionNotFound, unavailable } from "./Errors.ts"
import { plainText, slashCommand, toLettaContent } from "./Prompt.ts"
import { SessionIds } from "./SessionIds.ts"
import {
  configOptions,
  decodePermissionMode,
  DEFAULT_PERMISSION_MODE,
  initialSettings,
  type SessionSettings,
  Settings,
  type Target
} from "./Settings.ts"
import * as Turn from "./Turn.ts"
import type { TurnResult } from "./Turn.ts"

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

export interface SessionSetup {
  readonly sessionId: string
  readonly configOptions: ReadonlyArray<ConfigOption>
  readonly commands: ReadonlyArray<Command>
}

export type { TurnResult } from "./Turn.ts"

export interface PromptHandle {
  /** The id of the inserted user message. */
  readonly messageId: string
  /** Completes when the turn ends (never fails). */
  readonly completion: Effect.Effect<TurnResult>
}

export interface SessionSummary {
  readonly sessionId: string
  readonly cwd: string
  readonly title: Option.Option<string>
  readonly updatedAt: Option.Option<string>
}

const decodeRuntimeFrame = Schema.decodeUnknownOption(RuntimeFrame)
const decodeDeltaRun = Schema.decodeUnknownOption(Schema.Struct({ run_id: Schema.String }))

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface Attachment {
  readonly generation: number
  readonly scope: Scope.Closeable
  readonly connection: LettaConnection
  readonly runtime: RuntimeScope
}

interface Session {
  /**
   * The ACP session id: the Letta conversation's id for a session opened on
   * one, lacp's own for a session opened before it had one (see SessionIds).
   */
  readonly id: string
  /** The Letta agent; a session opened without one gets it with its conversation. */
  agentId: Option.Option<string>
  readonly cwd: string
  readonly scope: Scope.Closeable
  readonly translator: Translator.Translator
  readonly turnLock: Semaphore.Semaphore
  readonly permissions: FiberSet.FiberSet<void, never>
  /** The grace period of a held turn whose background work is done (see releaseWhenSettled). */
  readonly grace: FiberHandle.FiberHandle<void, never>
  /** The runtime of the session's Letta conversation; none until the session has a conversation. */
  attachment: Option.Option<Attachment>
  /** Serializes creating the conversation with config changes made meanwhile. */
  readonly setupLock: Semaphore.Semaphore
  /** The client has the session's commands and config options (they went out with its setup). */
  announced: boolean
  /** Model, effort and mode. */
  readonly settings: SessionSettings
  commands: ReadonlyArray<Command>
  readonly ownMessages: Set<string>
  /** Runs of turns lacp ended itself; their late frames are ignored. */
  readonly abandonedRuns: Set<string>
  /** Background subagents that will report back (not silent): running in Letta's last snapshot, not yet reported. */
  backgroundSubagents: ReadonlySet<string>
  /** Reports of finished background work waiting in Letta's queue. */
  queuedNotifications: number
  /** The client's MCP servers this session was opened with. */
  readonly mcpServers: ReadonlyArray<McpServerConfig>
  turn: Option.Option<Turn.Turn>
  foreground: "idle" | "running" | "requires_action"
  readonly deviceStatus: Deferred.Deferred<void>
  localCommand: boolean
  /** Approval requests awaiting the client's answer. */
  approvals: number
  /** The client's MCP servers, bridged into Letta as external tools. */
  readonly mcp: Bridge.McpBridge
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Agent extends Context.Service<Agent, {
  /** Starts Letta Code in the background. */
  readonly warmup: Effect.Effect<void>
  newSession(input: {
    readonly cwd: string
    readonly mcpServers: ReadonlyArray<McpServerConfig>
  }): Effect.Effect<SessionSetup, AgentError>
  /** Attaches to an existing conversation; with `replay`, its history is emitted first. */
  loadSession(input: {
    readonly sessionId: string
    readonly cwd: string
    readonly replay: boolean
    readonly mcpServers: ReadonlyArray<McpServerConfig>
  }): Effect.Effect<SessionSetup, AgentError>
  listSessions(input: {
    readonly cwd: Option.Option<string>
    readonly cursor: Option.Option<string>
  }): Effect.Effect<
    { readonly sessions: ReadonlyArray<SessionSummary>; readonly nextCursor: Option.Option<string> },
    AgentError
  >
  /** Inserts a prompt. Resolves once Letta accepted it; `completion` resolves when the turn ends. */
  prompt(sessionId: string, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<PromptHandle, AgentError>
  cancel(sessionId: string): Effect.Effect<void>
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Effect.Effect<ReadonlyArray<ConfigOption>, AgentError>
  closeSession(sessionId: string): Effect.Effect<void>
  /** The foreground state of a session, for v2 `session/resume` snapshots. */
  foreground(sessionId: string): Effect.Effect<"idle" | "running" | "requires_action">
}>()("lacp/agent/Agent") {
  static readonly layer = Layer.effect(
    Agent,
    Effect.gen(function*() {
      const config = yield* LacpConfig
      const host = yield* Host
      const appServer = yield* LettaAppServer
      const settings = yield* Settings
      const client = yield* AcpClient
      const crypto = yield* Crypto
      const sessionIds = yield* SessionIds
      const agents = yield* AgentResolver
      const path = yield* Path.Path
      const bridges = yield* Bridge.McpBridges
      const layerScope = yield* Effect.scope
      const sessions = new Map<string, Session>()

      // A failing CSPRNG is not a recoverable condition.
      const uuid = crypto.randomUUIDv4().pipe(Effect.orDie)

      const connection = appServer.connection.pipe(Effect.mapError(unavailable))

      const targetOf = (attachment: Attachment): Target => ({
        connection: attachment.connection,
        runtime: attachment.runtime,
        conversationId: attachment.runtime.conversation_id
      })

      const getSession = (sessionId: string) =>
        Effect.suspend(() => {
          const session = sessions.get(sessionId)
          return session === undefined ? Effect.fail(new SessionNotFound({ sessionId })) : Effect.succeed(session)
        })

      const emit = (session: Session, event: SessionEvent) => client.emit(session.id, event)
      const emitAll = (session: Session, events: ReadonlyArray<SessionEvent>) =>
        Effect.forEach(events, (event) => emit(session, event), { discard: true })

      const setForeground = (session: Session, state: "running" | "requires_action") =>
        Effect.suspend(() => {
          if (session.foreground === state) return Effect.void
          session.foreground = state
          return emit(session, { _tag: "State", state })
        })

      // --- turns ------------------------------------------------------------

      const completeTurn = Effect.fnUntraced(function*(session: Session, result: TurnResult) {
        yield* emitAll(
          session,
          session.translator.finishTurn(
            result.stopReason === "cancelled" ? "cancelled" : result.stopReason === "error" ? "error" : "end_turn"
          )
        )
        session.foreground = "idle"
        yield* emit(session, {
          _tag: "State",
          state: "idle",
          stopReason: result.stopReason,
          ...(Option.isSome(result.error) ? { error: result.error.value } : {})
        })
        const turn = session.turn
        session.turn = Option.none()
        session.localCommand = false
        if (Option.isSome(turn)) {
          session.ownMessages.delete(turn.value.clientMessageId)
          yield* Deferred.succeed(turn.value.done, result)
        }
        yield* FiberSet.clear(session.permissions)
        session.approvals = 0
      })

      const onTurnFinished = Effect.fnUntraced(function*(session: Session, frame: TurnFinished) {
        // The late end of a turn lacp ended itself must not end the next one.
        if (frame.run_id != null && session.abandonedRuns.has(frame.run_id)) return
        const turn = session.turn
        // Nothing is running, so this is the late end of a turn lacp ended before seeing any of its runs.
        if (Option.isNone(turn) && session.foreground === "idle") return
        if (Option.isSome(turn) && turn.value.phase._tag === "Submitted") {
          turn.value.phase = Turn.Phase.Submitted({ ...turn.value.phase, early: Option.some(frame) })
          return
        }
        // A turn that finished before ours was dequeued belongs to earlier (background) work.
        if (Option.isSome(turn) && turn.value.phase._tag === "Queued") return
        const stopReason = Translator.stopReasonOf(frame.stop_reason)
        const message = frame.error ?? Option.getOrUndefined(Option.flatMap(turn, (t) => t.error))
        if (frame.usage !== undefined && frame.usage !== null && Option.isSome(session.settings.contextWindow)) {
          const used = frame.usage.context_tokens ?? frame.usage.prompt_tokens
          if (used !== undefined && used !== null) {
            yield* emit(session, { _tag: "Usage", used, size: session.settings.contextWindow.value })
          }
        }
        const result: TurnResult = {
          stopReason,
          error: stopReason === "error"
            ? Option.some({ code: -32603, message: message ?? `Letta Code stopped: ${frame.stop_reason}` })
            : Option.none()
        }
        // A cancelled turn ends now, whatever is still running in the background.
        if (stopReason !== "cancelled" && Option.isSome(turn) && awaitsBackground(session, turn.value)) {
          if (turn.value.phase._tag !== "Held") {
            yield* Effect.logInfo(`Keeping the turn open until its background work in ${session.id} reports back`)
          }
          turn.value.phase = Turn.Phase.Held({ result, followUp: false })
          return
        }
        yield* completeTurn(session, result)
      })

      /** Whether a turn has background work outstanding that will report back into the conversation. */
      const awaitsBackground = (session: Session, turn: Turn.Turn) =>
        config.waitForBackground &&
        (session.queuedNotifications > 0 ||
          Array.from(session.backgroundSubagents).some((id) => !turn.preexisting.has(id)))

      /** Whether `turn` still only waits for background work that is done. */
      const settled = (session: Session, turn: Turn.Turn) =>
        Option.exists(session.turn, (current) => current === turn) && Turn.waitingForBackground(turn) &&
        !awaitsBackground(session, turn)

      /**
       * Ends a held turn once its background work is done. The report starts a
       * follow-up turn, whose end ends the held turn; if none starts within the
       * grace period (counted from the last sign that the work is done), the
       * held result stands.
       */
      const releaseWhenSettled = (session: Session) =>
        Effect.suspend(() => {
          const turn = Option.getOrUndefined(session.turn)
          if (turn === undefined || !settled(session, turn)) return Effect.void
          return Effect.sleep(config.backgroundGrace).pipe(
            Effect.andThen(Effect.suspend(() =>
              settled(session, turn) && turn.phase._tag === "Held"
                ? completeTurn(session, turn.phase.result)
                : Effect.void
            )),
            FiberHandle.run(session.grace),
            Effect.asVoid
          )
        })

      const decide = (decision: PermissionDecision) => {
        if (decision._tag === "Cancelled") {
          return { behavior: "deny" as const, message: "The user cancelled the request." }
        }
        if (decision.optionId === Translator.PERMISSION_REJECT) {
          return { behavior: "deny" as const, message: "The user rejected this tool call." }
        }
        if (decision.optionId.startsWith(Translator.PERMISSION_ALWAYS_PREFIX)) {
          return {
            behavior: "allow" as const,
            selected_permission_suggestion_ids: [decision.optionId.slice(Translator.PERMISSION_ALWAYS_PREFIX.length)]
          }
        }
        return { behavior: "allow" as const }
      }

      const onControlRequest = Effect.fnUntraced(
        function*(session: Session, attachment: Attachment, frame: ControlRequest) {
          const { events, request } = session.translator.permission(frame.request)
          yield* emitAll(session, events)
          session.approvals += 1
          yield* setForeground(session, "requires_action")
          yield* client.requestPermission(session.id, request).pipe(
            Effect.flatMap((decision) =>
              attachment.connection.send({
                type: "input",
                runtime: attachment.runtime,
                payload: { kind: "approval_response", request_id: frame.request_id, decision: decide(decision) }
              })
            ),
            Effect.catch((error) => Effect.logWarning(`Could not answer a Letta approval: ${error.message}`)),
            Effect.ensuring(Effect.sync(() => {
              session.approvals = Math.max(0, session.approvals - 1)
            })),
            Effect.andThen(
              Effect.suspend(() =>
                Option.isSome(session.turn) && session.approvals === 0 ? setForeground(session, "running") : Effect.void
              )
            ),
            FiberSet.run(session.permissions)
          )
        }
      )

      const onDelta = Effect.fnUntraced(function*(session: Session, frame: StreamDelta) {
        // Subagent streams are summarised by their parent tool call.
        if (frame.subagent_id !== undefined && frame.subagent_id !== null) return
        const run = Option.map(decodeDeltaRun(frame.delta), (d) => d.run_id)
        // Output of a turn lacp already ended (a cancel Letta never confirmed) is dropped.
        if (Option.isSome(run) && session.abandonedRuns.has(run.value)) return
        if (Option.isSome(run) && Option.isSome(session.turn)) session.turn.value.runs.add(run.value)
        if (Option.isSome(session.turn) && session.turn.value.phase._tag === "Held") {
          session.turn.value.phase = Turn.Phase.Held({ ...session.turn.value.phase, followUp: true })
        }
        for (const item of session.translator.delta(frame.delta)) {
          switch (item._tag) {
            case "SubagentsReported": {
              // The report is the reliable end of a subagent: once the turn that started it
              // has ended, Letta Code may never send the subagent's final state.
              const outstanding = new Set(session.backgroundSubagents)
              for (const id of item.subagentIds) outstanding.delete(id)
              session.backgroundSubagents = outstanding
              continue
            }
            case "UserEcho": {
              const own = Option.isSome(item.otid) && session.ownMessages.has(item.otid.value)
              if (own) {
                if (
                  Option.isSome(session.turn) &&
                  session.turn.value.clientMessageId === Option.getOrUndefined(item.otid)
                ) {
                  Turn.start(session.turn.value)
                }
                continue
              }
              yield* setForeground(session, "running")
              yield* emit(session, item.event)
              continue
            }
            case "LoopError": {
              const turn = session.turn
              if (!item.terminal || Option.isNone(turn)) {
                yield* emit(session, { _tag: "Notice", severity: "warning", title: item.message })
                continue
              }
              turn.value.error = Option.some(item.message)
              if (!Turn.started(turn.value) && item.clientMessageIds.includes(turn.value.clientMessageId)) {
                yield* completeTurn(session, {
                  stopReason: "error",
                  error: Option.some({ code: -32603, message: item.message })
                })
              }
              continue
            }
            case "Event": {
              if (
                session.localCommand && item.event._tag === "AgentMessageChunk" &&
                item.event.messageId.startsWith("command-")
              ) {
                continue
              }
              if (item.event._tag !== "Usage" && item.event._tag !== "Notice") {
                yield* setForeground(session, "running")
              }
              yield* emit(session, item.event)
            }
          }
        }
      })

      /** Runs a bridged MCP tool for Letta and returns its result. */
      const onExternalToolCall = (session: Session, attachment: Attachment, frame: ExternalToolCallRequest) =>
        session.mcp.call(frame.tool_name, frame.input).pipe(
          Effect.flatMap((result) =>
            attachment.connection.send({ type: "external_tool_call_response", request_id: frame.request_id, result })
          ),
          Effect.catch((error) => Effect.logWarning(`Could not return an MCP tool result to Letta: ${error.message}`)),
          Effect.forkIn(session.scope),
          Effect.asVoid
        )

      /** Re-registers the bridged tools after an MCP server's tool list changed. */
      const updateTools = Effect.fnUntraced(function*(session: Session) {
        if (Option.isNone(session.attachment)) return
        const { connection: conn, runtime } = session.attachment.value
        if (conn.info.capabilities?.["runtime_external_tools_update"] !== true) {
          yield* Effect.logWarning("This Letta Code cannot update MCP tools live; they refresh on the next session")
          return
        }
        const tools = yield* session.mcp.tools
        yield* conn.call(
          (request_id) => ({
            type: "runtime_external_tools_update",
            request_id,
            updates: [{ runtimes: [runtime], external_tools: [{ tools }] }]
          }),
          RuntimeExternalToolsUpdateResponse
        ).pipe(Effect.catch((error) => Effect.logWarning(`Could not update MCP tools: ${error.message}`)))
      })

      const onDeviceStatus = Effect.fnUntraced(function*(session: Session, frame: DeviceStatus) {
        const status = frame.device_status
        const before = configOptions(session.settings)
        const mode = Option.flatMap(Option.fromUndefinedOr(status.current_permission_mode), decodePermissionMode)
        if (Option.isSome(mode)) session.settings.mode = mode
        const commands = Commands.fromDeviceStatus(status)
        const commandsChanged = !Equal.equals(commands, session.commands)
        session.commands = commands
        const firstReport = !(yield* Deferred.isDone(session.deviceStatus))
        yield* Deferred.succeed(session.deviceStatus, undefined)
        // A session's first report goes out with its setup, unless the client already has the setup.
        if (firstReport && !session.announced) return
        if (commandsChanged) yield* emit(session, { _tag: "AvailableCommands", commands })
        const after = configOptions(session.settings)
        if (!Equal.equals(before, after)) yield* emit(session, { _tag: "ConfigOptions", options: after })
      })

      const onLoopStatus = (session: Session, frame: LoopStatus) =>
        Effect.suspend(() =>
          // `requires_action` is driven by approval requests themselves; loop status
          // frames can lag behind an answer and must not re-block the session.
          frame.loop_status.status !== "WAITING_ON_APPROVAL" && frame.loop_status.status !== "WAITING_ON_INPUT" &&
            Option.isSome(session.turn) && session.approvals === 0
            ? setForeground(session, "running")
            : Effect.void
        )

      const onSubagentState = (session: Session, frame: SubagentState) =>
        Effect.suspend(() => {
          session.backgroundSubagents = new Set(
            frame.subagents
              .filter((a) =>
                a.is_background === true && a.silent !== true && (a.status === "pending" || a.status === "running")
              )
              .map((a) => a.subagent_id)
          )
          return releaseWhenSettled(session)
        })

      const onQueueUpdate = Effect.fnUntraced(function*(session: Session, frame: QueueUpdate) {
        if (frame.queue !== undefined) {
          session.queuedNotifications = frame.queue.filter((item) => item.kind === "task_notification").length
          yield* releaseWhenSettled(session)
        }
        const turn = session.turn
        if (Option.isNone(turn)) return
        for (const removed of frame.removed ?? []) {
          if (removed.client_message_id !== turn.value.clientMessageId) continue
          if (removed.disposition === "dequeued") Turn.start(turn.value)
          if (removed.disposition === "cancelled") {
            yield* completeTurn(session, { stopReason: "cancelled", error: Option.none() })
          }
        }
      })

      /** Handles a runtime's frames for a session. */
      const route = (session: Session, attachment: Attachment): (frame: RuntimeFrame) => Effect.Effect<void> =>
        Match.type<RuntimeFrame>().pipe(
          Match.discriminatorsExhaustive("type")({
            stream_delta: (frame) => onDelta(session, frame),
            turn_finished: (frame) => onTurnFinished(session, frame),
            control_request: (frame) => onControlRequest(session, attachment, frame),
            update_loop_status: (frame) => onLoopStatus(session, frame),
            update_device_status: (frame) => onDeviceStatus(session, frame),
            external_tool_call_request: (frame) => onExternalToolCall(session, attachment, frame),
            update_subagent_state: (frame) => onSubagentState(session, frame),
            update_queue: (frame) => onQueueUpdate(session, frame)
          })
        )

      /** Routes this runtime's frames from the subscription into the session; other frames are ignored. */
      const consume = (session: Session, attachment: Attachment, subscription: PubSub.Subscription<Frame>) => {
        const handle = route(session, attachment)
        return PubSub.take(subscription).pipe(
          Effect.flatMap((frame) =>
            (frame.header.runtime?.conversation_id ?? frame.header.conversation_id) ===
                attachment.runtime.conversation_id
              ? Option.match(decodeRuntimeFrame(frame.raw), { onNone: () => Effect.void, onSome: handle }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError(`Failed to handle a Letta ${frame.header.type} frame`, cause)
                )
              )
              : Effect.void
          ),
          Effect.forever
        )
      }

      /** Ends the active turn with an error if the connection drops. */
      const watch = (session: Session, attachment: Attachment) =>
        attachment.connection.closed.pipe(
          Effect.catch((error) =>
            Option.isSome(session.turn)
              ? completeTurn(session, {
                stopReason: "error",
                error: Option.some({ code: -32603, message: error.message })
              })
              : Effect.void
          )
        )

      // --- runtimes ---------------------------------------------------------

      interface RuntimeTarget {
        readonly agentId: string
        readonly conversationId: Option.Option<string>
        readonly cwd: string
        readonly tools: ReadonlyArray<ExternalToolDefinition>
        readonly mode: Option.Option<PermissionMode>
      }

      /**
       * Starts a runtime in a new scope and subscribes to its frames (before
       * `runtime_start`, so nothing is missed). The scope is closed again if
       * starting fails or is interrupted.
       */
      const startRuntime = Effect.fnUntraced(
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
                ...(Option.isSome(target.mode) ? { mode: target.mode.value } : {}),
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
            return { scope, subscription, response, runtime: response.runtime }
          }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
        }
      )

      /** Makes a started runtime the session's attachment (closing the previous one) and starts routing its frames. */
      const attach = Effect.fnUntraced(function*(
        session: Session,
        started: Effect.Success<ReturnType<typeof startRuntime>>,
        conn: LettaConnection
      ) {
        if (Option.isSome(session.attachment)) yield* Scope.close(session.attachment.value.scope, Exit.void)
        const attachment: Attachment = {
          generation: conn.generation,
          scope: started.scope,
          connection: conn,
          runtime: started.runtime
        }
        session.attachment = Option.some(attachment)
        yield* consume(session, attachment, started.subscription).pipe(Effect.forkIn(started.scope))
        yield* watch(session, attachment).pipe(Effect.forkIn(started.scope))
        return attachment
      })

      /** Returns a live attachment to the session's conversation, re-attaching after an App Server restart. */
      const ensureAttached = Effect.fnUntraced(function*(session: Session, current: Attachment) {
        const conn = yield* connection
        if (current.generation === conn.generation) return current
        yield* Effect.logInfo(`Re-attaching session ${session.id} to the restarted Letta Code App Server`)
        const agentId = Option.orElse(session.agentId, () => Option.fromNullishOr(current.runtime.agent_id))
        if (Option.isNone(agentId)) {
          return yield* new AgentUnavailable({ message: `Session ${session.id} has no Letta agent`, auth: false })
        }
        const started = yield* startRuntime(conn, session.scope, {
          agentId: agentId.value,
          conversationId: Option.some(current.runtime.conversation_id),
          cwd: session.cwd,
          tools: yield* session.mcp.tools,
          mode: config.permissionMode
        })
        const attachment = yield* attach(session, started, conn)
        if (Option.isSome(session.settings.mode) && Option.isNone(config.permissionMode)) {
          yield* conn.send({
            type: "change_device_state",
            runtime: started.runtime,
            payload: { mode: session.settings.mode.value }
          }).pipe(Effect.ignore)
        }
        return attachment
      })

      interface SessionInput {
        readonly id: string
        readonly agentId: Option.Option<string>
        readonly cwd: string
        readonly scope: Scope.Closeable
        readonly mcp: Bridge.McpBridge
        readonly mcpServers: ReadonlyArray<McpServerConfig>
        readonly settings: SessionSettings
        readonly commands: ReadonlyArray<Command>
      }

      /** What a session's translators need: its directory, its model's context window and its MCP tools. */
      const translatorContext = (
        cwd: string,
        settings: SessionSettings,
        mcp: Bridge.McpBridge
      ): Translator.TranslatorContext => ({
        cwd,
        path,
        contextWindow: () => settings.contextWindow,
        externalTool: (name) => mcp.describe(name)
      })

      const makeSession = Effect.fnUntraced(function*(input: SessionInput) {
        const session: Session = {
          id: input.id,
          agentId: input.agentId,
          cwd: input.cwd,
          scope: input.scope,
          translator: Translator.make(translatorContext(input.cwd, input.settings, input.mcp)),
          turnLock: yield* Semaphore.make(1),
          permissions: yield* Scope.provide(FiberSet.make<void, never>(), input.scope),
          grace: yield* Scope.provide(FiberHandle.make<void, never>(), input.scope),
          attachment: Option.none(),
          setupLock: yield* Semaphore.make(1),
          announced: false,
          settings: input.settings,
          commands: input.commands,
          ownMessages: new Set(),
          abandonedRuns: new Set(),
          backgroundSubagents: new Set(),
          queuedNotifications: 0,
          mcpServers: input.mcpServers,
          turn: Option.none(),
          foreground: "idle",
          deviceStatus: yield* Deferred.make<void>(),
          localCommand: false,
          approvals: 0,
          mcp: input.mcp
        }
        sessions.set(session.id, session)
        yield* input.mcp.changes.pipe(Stream.runForEach(() => updateTools(session)), Effect.forkIn(input.scope))
        return session
      })

      /**
       * Opens a session in a new scope: Letta and the client's MCP servers
       * (rooted at the session's directory) connect concurrently, then `open`
       * builds the session. The scope is closed again if opening fails.
       */
      const inSessionScope = <A, E>(
        input: { readonly cwd: string; readonly mcpServers: ReadonlyArray<McpServerConfig> },
        open: (scope: Scope.Closeable, conn: LettaConnection, mcp: Bridge.McpBridge) => Effect.Effect<A, E>
      ) =>
        Scope.fork(layerScope).pipe(Effect.flatMap((scope) =>
          Effect.all([
            connection,
            bridges.connectAll(input.mcpServers, {
              roots: [input.cwd],
              clientInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: VERSION }
            }).pipe(Scope.provide(scope))
          ], { concurrency: "unbounded" }).pipe(
            Effect.flatMap(([conn, mcp]) => open(scope, conn, mcp)),
            Effect.onError(() => Scope.close(scope, Exit.void))
          )
        ))

      /** Waits briefly for the runtime's first device status (mode and commands). */
      const settle = Effect.fnUntraced(function*(session: Session, attachment: Attachment) {
        const seen = yield* Deferred.await(session.deviceStatus).pipe(Effect.timeoutOption("5 seconds"))
        if (Option.isNone(seen) && Option.isNone(session.settings.mode)) {
          // Letta did not say: make the runtime match the mode the client is shown.
          session.settings.mode = Option.some(DEFAULT_PERMISSION_MODE)
          yield* attachment.connection.send({
            type: "change_device_state",
            runtime: attachment.runtime,
            payload: { mode: DEFAULT_PERMISSION_MODE }
          }).pipe(Effect.ignore)
        }
      })

      /**
       * The session's setup for the client, which then has its commands and
       * config options. The commands and any unavailable MCP servers follow as
       * updates, right after the response.
       */
      const publish = Effect.fnUntraced(function*(session: Session) {
        yield* Effect.gen(function*() {
          if (session.commands.length > 0) {
            yield* emit(session, { _tag: "AvailableCommands", commands: session.commands })
          }
          for (const failure of session.mcp.failures) {
            yield* emit(session, {
              _tag: "Notice",
              severity: "warning",
              title: `MCP server "${failure.server}" is unavailable`,
              description: failure.message
            })
          }
        }).pipe(Effect.delay("10 millis"), Effect.forkIn(session.scope))
        session.announced = true
        return {
          sessionId: session.id,
          configOptions: configOptions(session.settings),
          commands: session.commands
        } satisfies SessionSetup
      })

      // --- history ----------------------------------------------------------

      /** Emits the conversation's history (its latest 1,000 messages), oldest first. */
      const replay = Effect.fnUntraced(function*(session: Session, conn: LettaConnection, conversationId: string) {
        const pages = yield* History.pages(conn, conversationId).pipe(
          Stream.take(10),
          Stream.runCollect,
          Effect.mapError(unavailable)
        )
        const history = Translator.make(translatorContext(session.cwd, session.settings, session.mcp))
        for (const row of pages.flat().toReversed()) yield* emitAll(session, history.history(row))
        yield* emitAll(session, history.finishTurn("end_turn"))
      })

      // --- operations -------------------------------------------------------

      /**
       * Opens a session that has no Letta conversation yet, without touching
       * Letta beyond reading the agent and its models: the conversation (and,
       * where none is set up, the agent) is created by the first prompt.
       */
      const openPending = (input: {
        readonly sessionId: string
        readonly cwd: string
        readonly mcpServers: ReadonlyArray<McpServerConfig>
      }) =>
        inSessionScope(input, (scope, conn, mcp) =>
          Effect.gen(function*() {
            const agentId = yield* agents.find(conn, input.cwd)
            const [agent, models] = yield* Effect.all([
              Option.match(agentId, {
                onNone: () => Effect.succeedNone,
                onSome: (id) => agents.retrieve(conn, id).pipe(Effect.asSome)
              }),
              settings.catalog(conn)
            ], { concurrency: "unbounded" })
            const session = yield* makeSession({
              id: input.sessionId,
              agentId,
              cwd: input.cwd,
              scope,
              mcp,
              mcpServers: input.mcpServers,
              settings: initialSettings(
                { agent: Option.getOrNull(agent) },
                models,
                Option.orElse(config.permissionMode, () => Option.some(DEFAULT_PERMISSION_MODE))
              ),
              commands: Commands.builtins
            })
            yield* settings.preferConfiguredModel(session.settings)
            return session
          }))

      /**
       * Runs `pending` while the session has no conversation yet, or `attached`
       * with a live attachment to it, under the session's setup lock: creating
       * the conversation and changing its settings never interleave.
       */
      const withConversation = <A, E>(session: Session, on: {
        readonly pending: Effect.Effect<A, E>
        readonly attached: (attachment: Attachment) => Effect.Effect<A, E>
      }) =>
        Semaphore.withPermits(session.setupLock, 1)(Effect.suspend(() =>
          Option.match(session.attachment, {
            onNone: () => on.pending,
            onSome: (current) => ensureAttached(session, current).pipe(Effect.flatMap(on.attached))
          })
        ))

      /**
       * Returns a live attachment to the session's conversation, creating the
       * conversation (and the agent, for a session without one) on first use.
       */
      const materialize = (session: Session) =>
        withConversation(session, { pending: createConversation(session), attached: Effect.succeed })

      /** Creates a pending session's conversation and applies the model, effort and mode chosen meanwhile. */
      const createConversation = Effect.fnUntraced(function*(session: Session) {
        const before = configOptions(session.settings)
        const conn = yield* connection
        const agentId = Option.isSome(session.agentId)
          ? session.agentId.value
          : yield* agents.findOrCreate(conn, session.cwd)
        const started = yield* startRuntime(conn, session.scope, {
          agentId,
          conversationId: Option.none(),
          cwd: session.cwd,
          tools: yield* session.mcp.tools,
          mode: session.settings.mode
        })
        const conversationId = started.runtime.conversation_id
        session.agentId = Option.some(agentId)
        const attachment = yield* attach(session, started, conn)
        yield* settings.realize(
          session.settings,
          targetOf(attachment),
          initialSettings(started.response, session.settings.models, session.settings.mode)
        )
        yield* settle(session, attachment)
        yield* sessionIds.record(session.id, conversationId)
        yield* Effect.logInfo(`Session ${session.id} now has Letta conversation ${conversationId} (agent ${agentId})`)
        const after = configOptions(session.settings)
        if (!Equal.equals(before, after)) yield* emit(session, { _tag: "ConfigOptions", options: after })
        return attachment
      })

      /**
       * Opens a session on a stored conversation in a new scope: Letta and the
       * client's MCP servers connect concurrently, then the runtime starts with
       * the MCP tools. Replayed history comes before the session goes live. The
       * scope is closed again if opening fails.
       */
      const openSession = (input: {
        readonly sessionId: string
        readonly conversationId: string
        readonly cwd: string
        readonly mcpServers: ReadonlyArray<McpServerConfig>
        readonly replay: boolean
      }) =>
        inSessionScope(input, (scope, conn, mcp) =>
          Effect.gen(function*() {
            const stored = yield* storedConversation(conn, input.sessionId, input.conversationId, input.cwd)
            const started = yield* startRuntime(conn, scope, {
              agentId: stored.agentId,
              conversationId: Option.some(input.conversationId),
              cwd: input.cwd,
              tools: yield* mcp.tools,
              mode: config.permissionMode
            })
            const session = yield* makeSession({
              id: input.sessionId,
              agentId: Option.some(stored.agentId),
              cwd: input.cwd,
              scope,
              mcp,
              mcpServers: input.mcpServers,
              settings: initialSettings(started.response, yield* settings.catalog(conn), config.permissionMode),
              commands: []
            })
            if (input.replay) yield* replay(session, conn, input.conversationId)
            yield* settle(session, yield* attach(session, started, conn))
            return { session, conversation: stored.conversation }
          }))

      const newSession = Effect.fn("Agent.newSession")(function*(input: {
        readonly cwd: string
        readonly mcpServers: ReadonlyArray<McpServerConfig>
      }) {
        const session = yield* openPending({ ...input, sessionId: yield* sessionIds.make })
        yield* Effect.logInfo(
          `Opened session ${session.id}` +
            Option.match(session.agentId, { onNone: () => "", onSome: (id) => ` (agent ${id})` }) +
            ` in ${input.cwd}` +
            (session.mcp.connected.length > 0 ? ` with MCP servers: ${session.mcp.connected.join(", ")}` : "") +
            "; Letta creates its conversation with the first prompt"
        )
        return yield* publish(session)
      })

      /** The stored conversation behind a session, and its agent. */
      const storedConversation = Effect.fnUntraced(
        function*(conn: LettaConnection, sessionId: string, conversationId: string, cwd: string) {
          const notFound = new SessionNotFound({ sessionId })
          const retrieved = yield* conn.call(
            (request_id) => ({ type: "conversation_retrieve", request_id, conversation_id: conversationId }),
            ConversationRetrieveResponse
          ).pipe(Effect.mapError(() => notFound))
          const conversation = retrieved.conversation
          if (conversation === null) return yield* notFound
          const agentId = conversation.agent_id ?? Option.getOrUndefined(yield* agents.find(conn, cwd))
          if (agentId === undefined) return yield* notFound
          return { agentId, conversation }
        }
      )

      const loadSession = Effect.fn("Agent.loadSession")(function*(input: {
        readonly sessionId: string
        readonly cwd: string
        readonly replay: boolean
        readonly mcpServers: ReadonlyArray<McpServerConfig>
      }) {
        const open = sessions.get(input.sessionId)
        // A session reopened from another directory or with other MCP servers gets a new runtime.
        const existing = open !== undefined && open.cwd === input.cwd && Equal.equals(open.mcpServers, input.mcpServers)
          ? open
          : undefined
        if (open !== undefined && existing === undefined) yield* closeSession(open.id)
        if (existing !== undefined) {
          if (Option.isSome(existing.attachment)) {
            const attachment = yield* ensureAttached(existing, existing.attachment.value)
            if (input.replay) yield* replay(existing, attachment.connection, attachment.runtime.conversation_id)
          }
          return yield* publish(existing)
        }
        const conversationId = sessionIds.isProvisional(input.sessionId)
          ? yield* sessionIds.conversationOf(input.sessionId)
          : Option.some(input.sessionId)
        if (Option.isNone(conversationId)) {
          // A session that never had a prompt: there is nothing to replay, and still no conversation.
          return yield* publish(yield* openPending(input))
        }
        const { conversation, session } = yield* openSession({ ...input, conversationId: conversationId.value })
        const title = conversation.summary ?? conversation.description
        if (title !== undefined && title !== null && title !== "") {
          yield* emit(session, {
            _tag: "SessionInfo",
            title,
            ...(conversation.last_message_at ? { updatedAt: conversation.last_message_at } : {})
          })
        }
        return yield* publish(session)
      })

      const listSessions = Effect.fn("Agent.listSessions")(function*(input: {
        readonly cwd: Option.Option<string>
        readonly cursor: Option.Option<string>
      }) {
        const conn = yield* connection
        const agentId = yield* agents.find(conn, Option.getOrElse(input.cwd, () => host.cwd))
        if (Option.isNone(agentId)) return { sessions: [], nextCursor: Option.none<string>() }
        const limit = 50
        const response = yield* conn.call(
          (request_id) => ({
            type: "conversation_list",
            request_id,
            query: {
              agent_id: agentId.value,
              limit,
              order: "desc",
              order_by: "last_message_at",
              ...(Option.isSome(input.cursor) ? { after: input.cursor.value } : {})
            }
          }),
          ConversationListResponse
        ).pipe(Effect.mapError(unavailable))
        const cwdMap = yield* conn.call((request_id) => ({ type: "get_cwd_map", request_id }), GetCwdMapResponse).pipe(
          Effect.map((r) => r.cwd_map ?? {}),
          Effect.orElseSucceed((): Record<string, string> => ({}))
        )
        const summaries = yield* Effect.forEach(
          response.conversations.filter((c) => c.archived !== true),
          (c) =>
            // A conversation created for a session lacp opened first is listed under that session's id.
            sessionIds.sessionOf(c.id).pipe(Effect.map((sessionId) => {
              const id = Option.getOrElse(sessionId, () => c.id)
              const mapped = cwdMap[`conversation:${c.id}`] ?? sessions.get(id)?.cwd
              return {
                sessionId: id,
                cwd: mapped ?? host.cwd,
                mapped: mapped !== undefined,
                title: Option.fromNullishOr(c.summary ?? c.description).pipe(Option.filter((t) => t !== "")),
                updatedAt: Option.fromNullishOr(c.last_message_at ?? c.updated_at ?? c.created_at)
              }
            }))
        )
        const last = response.conversations.at(-1)
        return {
          sessions: summaries
            .filter((s) =>
              Option.isNone(input.cwd) || (s.mapped && path.resolve(s.cwd) === path.resolve(input.cwd.value))
            )
            .map(({ mapped: _mapped, ...summary }): SessionSummary => summary),
          nextCursor: response.conversations.length >= limit && last !== undefined
            ? Option.some(last.id)
            : Option.none()
        }
      })

      /** Makes a new turn the session's turn. */
      const beginTurn = Effect.fnUntraced(function*(session: Session, state: { readonly accepted: boolean }) {
        const turn: Turn.Turn = {
          clientMessageId: yield* uuid,
          done: yield* Deferred.make<TurnResult>(),
          runs: new Set(),
          preexisting: new Set(session.backgroundSubagents),
          phase: state.accepted ? Turn.Phase.Running() : Turn.Phase.Submitted({ started: false, early: Option.none() }),
          error: Option.none()
        }
        session.turn = Option.some(turn)
        return turn
      })

      /**
       * The client's handle on a turn that has begun. The turn lock follows the
       * turn, not the request: it is released when the turn ends, so a turn
       * that was cancelled cannot hold up the next prompt.
       */
      const handleOf = (session: Session, turn: Turn.Turn, release: Effect.Effect<void>) =>
        Deferred.await(turn.done).pipe(
          Effect.ensuring(release),
          Effect.forkIn(session.scope),
          Effect.as<PromptHandle>({ messageId: turn.clientMessageId, completion: Deferred.await(turn.done) })
        )

      const runCommand = Effect.fnUntraced(function*(
        session: Session,
        attachment: Attachment,
        prompt: ReadonlyArray<ContentBlock>,
        command: { readonly name: string; readonly args: string },
        release: Effect.Effect<void>
      ) {
        const turn = yield* beginTurn(session, { accepted: true })
        const messageId = turn.clientMessageId
        session.localCommand = true
        yield* emit(session, { _tag: "UserMessage", messageId, content: prompt })
        yield* setForeground(session, "running")
        const handle = yield* handleOf(session, turn, release)
        yield* Effect.gen(function*() {
          const result = yield* attachment.connection.call(
            (request_id) => ({
              type: "execute_command",
              request_id,
              command_id: command.name,
              runtime: attachment.runtime,
              ...(command.args === "" ? {} : { args: command.args })
            }),
            ExecuteCommandResponse,
            { timeout: "10 minutes" }
          ).pipe(Effect.result)
          // A command that outlived its (cancelled) turn has nothing left to report.
          if (!Option.exists(session.turn, (current) => current === turn)) return
          const output = result._tag === "Success" ? result.success.output ?? "" : result.failure.message
          if (output !== "") {
            yield* emit(session, { _tag: "AgentMessageChunk", messageId: yield* uuid, content: Content.text(output) })
          }
          yield* completeTurn(
            session,
            result._tag === "Success"
              ? { stopReason: "end_turn", error: Option.none() }
              : { stopReason: "error", error: Option.some({ code: -32603, message: output }) }
          )
        }).pipe(Effect.forkIn(session.scope))
        return handle
      })

      const prompt = Effect.fn("Agent.prompt")(function*(sessionId: string, blocks: ReadonlyArray<ContentBlock>) {
        const session = yield* getSession(sessionId)
        // Waiting for the previous turn stays interruptible even where the caller makes
        // inserting the prompt uninterruptible (the v2 receipt).
        yield* Effect.interruptible(Semaphore.take(session.turnLock, 1))
        const release = Semaphore.release(session.turnLock, 1).pipe(Effect.asVoid)
        return yield* Effect.gen(function*() {
          const attachment = yield* materialize(session)
          const command = slashCommand(plainText(blocks), session.commands)
          if (Option.isSome(command)) return yield* runCommand(session, attachment, blocks, command.value, release)

          const turn = yield* beginTurn(session, { accepted: false })
          const clientMessageId = turn.clientMessageId
          session.ownMessages.add(clientMessageId)
          /** Letta did not take the prompt: the turn never began. */
          const withdraw = Effect.sync(() => {
            session.turn = Option.none()
            session.ownMessages.delete(clientMessageId)
          })
          const accepted = yield* attachment.connection.call(
            (request_id) => ({
              type: "input",
              request_id,
              runtime: attachment.runtime,
              payload: {
                kind: "create_message",
                messages: [{ role: "user", content: toLettaContent(blocks), client_message_id: clientMessageId }],
                exclude_interactive_tools: true
              }
            }),
            InputAccepted,
            { timeout: "60 seconds" }
          ).pipe(
            Effect.mapError((error) => new PromptRejected({ message: error.message })),
            Effect.tapError(() => withdraw)
          )
          if (!accepted.accepted) {
            yield* withdraw
            return yield* new PromptRejected({ message: accepted.error ?? "Letta Code did not accept the prompt" })
          }
          const early = turn.phase._tag === "Submitted" ? turn.phase.early : Option.none()
          Turn.accept(turn, accepted.disposition === "queued")
          yield* emit(session, { _tag: "UserMessage", messageId: clientMessageId, content: blocks })
          yield* setForeground(session, "running")
          // With nothing ahead of it in Letta's queue, an early turn_finished can only be ours.
          if (Option.isSome(early) && Turn.started(turn)) yield* onTurnFinished(session, early.value)
          return yield* handleOf(session, turn, release)
        }).pipe(Effect.onError(() => release))
      })

      const cancel = Effect.fn("Agent.cancel")(function*(sessionId: string) {
        const session = sessions.get(sessionId)
        if (session === undefined || Option.isNone(session.turn)) return
        const turn = session.turn.value
        // Only waiting for background work: stop waiting (the work itself carries on in Letta).
        if (Turn.waitingForBackground(turn)) {
          yield* completeTurn(session, { stopReason: "cancelled", error: Option.none() })
          return
        }
        /** Ends the turn without waiting for Letta to report its end, dropping the turn's late output. */
        const abandon = Effect.suspend(() =>
          Option.isSome(session.turn) && session.turn.value === turn
            ? Effect.sync(() => turn.runs.forEach((run) => session.abandonedRuns.add(run))).pipe(
              Effect.andThen(completeTurn(session, { stopReason: "cancelled", error: Option.none() }))
            )
            : Effect.void
        )
        const attachment = session.attachment
        if (Option.isSome(attachment)) {
          yield* attachment.value.connection.call(
            (request_id) => ({ type: "abort_message", request_id, runtime: attachment.value.runtime }),
            AbortMessageResponse,
            { timeout: "10 seconds" }
          ).pipe(
            // Letta reports the end of an aborted turn only once the model request settles,
            // which can take as long as the model stays silent; its acknowledgement is enough.
            Effect.flatMap((response) => response.aborted === true ? abandon : Effect.void),
            Effect.catch((error) => Effect.logWarning(`Letta did not acknowledge the cancellation: ${error.message}`)),
            Effect.forkIn(session.scope)
          )
        }
        // If Letta never reports the end of the turn, end it ourselves.
        yield* Effect.sleep(config.cancelGrace).pipe(Effect.andThen(abandon), Effect.forkIn(session.scope))
      })

      const setConfigOption = Effect.fn("Agent.setConfigOption")(
        function*(sessionId: string, configId: string, value: string) {
          const session = yield* getSession(sessionId)
          yield* withConversation(session, {
            // Kept until the first prompt creates the conversation.
            pending: settings.choose(session.settings, configId, value),
            attached: (attachment) => settings.set(session.settings, targetOf(attachment), configId, value)
          })
          const options = configOptions(session.settings)
          yield* emit(session, { _tag: "ConfigOptions", options })
          return options
        }
      )

      const closeSession = Effect.fn("Agent.closeSession")(function*(sessionId: string) {
        const session = sessions.get(sessionId)
        if (session === undefined) return
        if (Option.isSome(session.turn)) {
          const done = session.turn.value.done
          yield* cancel(sessionId)
          yield* Deferred.await(done).pipe(Effect.timeoutOption("5 seconds"))
          if (Option.isSome(session.turn)) {
            yield* completeTurn(session, { stopReason: "cancelled", error: Option.none() })
          }
        }
        sessions.delete(sessionId)
        yield* Scope.close(session.scope, Exit.void)
      })

      return Agent.of({
        warmup: appServer.warmup,
        newSession,
        loadSession,
        listSessions,
        prompt,
        cancel,
        setConfigOption,
        closeSession,
        foreground: (sessionId) => Effect.sync(() => sessions.get(sessionId)?.foreground ?? "idle")
      })
    })
  )
}
