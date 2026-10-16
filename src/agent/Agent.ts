/**
 * The agent core: ACP sessions backed by Letta Code App Server runtimes.
 *
 * Each ACP session is one Letta conversation (the ACP session id *is* the
 * Letta conversation id), attached to the App Server as a runtime. The core is
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
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Schema,
  Scope,
  Semaphore,
  Stream
} from "effect"
import { Crypto } from "effect/Crypto"
import { HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import type { ContentBlock } from "../acp/Content.ts"
import * as Content from "../acp/Content.ts"
import { LacpConfig } from "../Config.ts"
import type {
  Command,
  ConfigOption,
  ErrorInfo,
  PermissionDecision,
  SessionEvent,
  StopReason
} from "../domain/Events.ts"
import { Host } from "../Host.ts"
import { type Frame, LettaAppServer, type LettaConnection } from "../letta/AppServer.ts"
import {
  AgentRetrieveResponse,
  ControlRequest,
  ConversationListResponse,
  ConversationMessagesListResponse,
  ConversationRetrieveResponse,
  CreateAgentResponse,
  DeviceStatus,
  ExecuteCommandResponse,
  ExternalToolCallRequest,
  type ExternalToolDefinition,
  GetCwdMapResponse,
  InputAccepted,
  LoopStatus,
  type PermissionMode,
  QueueUpdate,
  RuntimeExternalToolsUpdateResponse,
  type RuntimeScope,
  RuntimeStartResponse,
  StreamDelta,
  SubagentState,
  TurnFinished
} from "../letta/Protocol.ts"
import * as Translator from "../letta/Translator.ts"
import * as Bridge from "../mcp/Bridge.ts"
import type { McpServerConfig } from "../mcp/Config.ts"
import { AGENT_NAME, AGENT_TITLE, VERSION } from "../Version.ts"
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

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

export interface SessionSetup {
  readonly sessionId: string
  readonly configOptions: ReadonlyArray<ConfigOption>
  readonly commands: ReadonlyArray<Command>
}

export interface TurnResult {
  readonly stopReason: StopReason
  readonly error: Option.Option<ErrorInfo>
}

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

// ---------------------------------------------------------------------------
// Presentation constants
// ---------------------------------------------------------------------------

/** Letta built-in slash commands worth surfacing in an editor. */
const BUILTIN_COMMANDS: Readonly<Record<string, string>> = {
  init: "Set up the agent's memory for this project",
  compact: "Summarize the conversation to free up context",
  reflect: "Reflect on recent work and update memory",
  dream: "Consolidate memory in the background",
  doctor: "Check and repair the agent's memory",
  reload: "Reload mods, skills and settings",
  "context-limit": "Show or change the context window limit",
  toolset: "Show or switch the agent's toolset"
}

/** The commands of a session that has no runtime yet to report its own. */
const builtinCommands: ReadonlyArray<Command> = Object.entries(BUILTIN_COMMANDS).map(([name, description]) => ({
  name,
  description
}))

const decode = <S extends Schema.Codec<unknown, unknown>>(schema: S) => Schema.decodeUnknownOption(schema)
const decodeStreamDelta = decode(StreamDelta)
const decodeDeltaRun = decode(Schema.Struct({ run_id: Schema.String }))
const decodeTurnFinished = decode(TurnFinished)
const decodeControlRequest = decode(ControlRequest)
const decodeLoopStatus = decode(LoopStatus)
const decodeDeviceStatus = decode(DeviceStatus)
const decodeQueueUpdate = decode(QueueUpdate)
const decodeSubagentState = decode(SubagentState)
const decodeExternalToolCall = decode(ExternalToolCallRequest)

/** Letta stop reasons onto ACP stop reasons. */
const stopReasonOf = (reason: string): StopReason => {
  switch (reason) {
    case "end_turn":
    case "no_tool_call":
    case "tool_rule":
    case "requires_approval":
      return "end_turn"
    case "cancelled":
      return "cancelled"
    case "max_steps":
      return "max_turn_requests"
    case "max_tokens_exceeded":
    case "context_window_overflow_in_system_prompt":
      return "max_tokens"
    default:
      return "error"
  }
}

/** The last agents the host's Letta Code used, from its settings files. */
const ProjectSettings = Schema.Struct({
  lastAgent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lastSession: Schema.optionalKey(Schema.NullOr(Schema.Struct({ agentId: Schema.String }))),
  sessionsByServer: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ agentId: Schema.String })))
})
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectSettings))

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface Turn {
  readonly clientMessageId: string
  /** Letta acknowledged the input (`input_accepted`). */
  accepted: boolean
  /** A `turn_finished` that raced ahead of the acknowledgement. */
  early: Option.Option<TurnFinished>
  started: boolean
  error: Option.Option<string>
  readonly done: Deferred.Deferred<TurnResult>
  /** Letta runs seen in this turn's stream, so a turn ended locally can disown them. */
  readonly runs: Set<string>
  /** Background subagents already running when the turn began; the turn does not wait for them. */
  readonly preexisting: ReadonlySet<string>
  /**
   * The result Letta reported, held while background work the turn started is
   * outstanding: its report arrives in a follow-up turn, which the client only
   * shows while this turn is open.
   */
  held: Option.Option<TurnResult>
  /** A follow-up turn has started streaming into the held turn. */
  followUp: boolean
}

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
  cwd: string
  readonly scope: Scope.Closeable
  readonly translator: Translator.Translator
  readonly turnLock: Semaphore.Semaphore
  readonly permissions: FiberSet.FiberSet<void, never>
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
  turn: Option.Option<Turn>
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
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const httpClient = yield* HttpClient.HttpClient
      const layerScope = yield* Effect.scope
      const sessions = new Map<string, Session>()
      const agentsByCwd = new Map<string, string>()

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

      const commandsFrom = (status: DeviceStatus["device_status"]): ReadonlyArray<Command> => [
        ...(status.supported_commands ?? []).flatMap((id): Array<Command> => {
          const description = BUILTIN_COMMANDS[id]
          return description === undefined ? [] : [{ name: id, description }]
        }),
        ...(status.mod_commands ?? []).map((c): Command => ({
          name: c.id,
          description: c.description,
          ...(c.args === undefined || c.args === null ? {} : { hint: c.args })
        }))
      ]

      // --- turns ------------------------------------------------------------

      const completeTurn = (session: Session, result: TurnResult) =>
        Effect.gen(function*() {
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

      const onTurnFinished = (session: Session, frame: TurnFinished) =>
        Effect.gen(function*() {
          // The late end of a turn lacp ended itself must not end the next one.
          if (frame.run_id != null && session.abandonedRuns.has(frame.run_id)) return
          const turn = session.turn
          // Nothing is running, so this is the late end of a turn lacp ended before seeing any of its runs.
          if (Option.isNone(turn) && session.foreground === "idle") return
          if (Option.isSome(turn) && !turn.value.accepted) {
            turn.value.early = Option.some(frame)
            return
          }
          // A turn that finished before ours was dequeued belongs to earlier (background) work.
          if (Option.isSome(turn) && !turn.value.started) return
          const stopReason = stopReasonOf(frame.stop_reason)
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
            if (Option.isNone(turn.value.held)) {
              yield* Effect.logInfo(`Keeping the turn open until its background work in ${session.id} reports back`)
            }
            turn.value.held = Option.some(result)
            turn.value.followUp = false
            return
          }
          yield* completeTurn(session, result)
        })

      /** Whether a turn has background work outstanding that will report back into the conversation. */
      const awaitsBackground = (session: Session, turn: Turn) =>
        config.waitForBackground &&
        (session.queuedNotifications > 0 ||
          Array.from(session.backgroundSubagents).some((id) => !turn.preexisting.has(id)))

      /**
       * Ends a held turn once its background work is done. The report starts a
       * follow-up turn, whose end ends the held turn; if none starts within the
       * grace period, the held result stands.
       */
      const releaseWhenSettled = (session: Session) =>
        Effect.suspend(() => {
          const turn = Option.getOrUndefined(session.turn)
          if (turn === undefined || Option.isNone(turn.held) || turn.followUp || awaitsBackground(session, turn)) {
            return Effect.void
          }
          return Effect.sleep(config.backgroundGrace).pipe(
            Effect.andThen(Effect.suspend(() =>
              Option.exists(session.turn, (current) => current === turn) && Option.isSome(turn.held) &&
                !turn.followUp && !awaitsBackground(session, turn)
                ? completeTurn(session, turn.held.value)
                : Effect.void
            )),
            Effect.forkIn(session.scope),
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

      const onControlRequest = (session: Session, attachment: Attachment, frame: ControlRequest) =>
        Effect.gen(function*() {
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
        })

      const onDelta = (session: Session, frame: StreamDelta) =>
        Effect.gen(function*() {
          // Subagent streams are summarised by their parent tool call.
          if (frame.subagent_id !== undefined && frame.subagent_id !== null) return
          const run = Option.map(decodeDeltaRun(frame.delta), (d) => d.run_id)
          // Output of a turn lacp already ended (a cancel Letta never confirmed) is dropped.
          if (Option.isSome(run) && session.abandonedRuns.has(run.value)) return
          if (Option.isSome(run) && Option.isSome(session.turn)) session.turn.value.runs.add(run.value)
          if (Option.isSome(session.turn) && Option.isSome(session.turn.value.held)) session.turn.value.followUp = true
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
                    session.turn.value.started = true
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
                if (!turn.value.started && item.clientMessageIds.includes(turn.value.clientMessageId)) {
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

      const onDeviceStatus = (session: Session, frame: DeviceStatus) =>
        Effect.gen(function*() {
          const status = frame.device_status
          const before = configOptions(session.settings)
          const mode = Option.flatMap(Option.fromUndefinedOr(status.current_permission_mode), decodePermissionMode)
          if (Option.isSome(mode)) session.settings.mode = mode
          const commands = commandsFrom(status)
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

      const onFrame = (
        session: Session,
        attachment: Attachment,
        frame: { readonly type: string; readonly raw: unknown }
      ) => {
        switch (frame.type) {
          case "stream_delta":
            return Option.match(decodeStreamDelta(frame.raw), {
              onNone: () => Effect.void,
              onSome: (f) => onDelta(session, f)
            })
          case "turn_finished":
            return Option.match(decodeTurnFinished(frame.raw), {
              onNone: () => Effect.void,
              onSome: (f) => onTurnFinished(session, f)
            })
          case "control_request":
            return Option.match(decodeControlRequest(frame.raw), {
              onNone: () => Effect.void,
              onSome: (f) => onControlRequest(session, attachment, f)
            })
          case "update_loop_status":
            return Option.match(decodeLoopStatus(frame.raw), {
              onNone: () => Effect.void,
              // `requires_action` is driven by approval requests themselves; loop status
              // frames can lag behind an answer and must not re-block the session.
              onSome: (f) =>
                f.loop_status.status !== "WAITING_ON_APPROVAL" && f.loop_status.status !== "WAITING_ON_INPUT" &&
                  Option.isSome(session.turn) && session.approvals === 0
                  ? setForeground(session, "running")
                  : Effect.void
            })
          case "update_device_status":
            return Option.match(decodeDeviceStatus(frame.raw), {
              onNone: () => Effect.void,
              onSome: (f) => onDeviceStatus(session, f)
            })
          case "external_tool_call_request":
            return Option.match(decodeExternalToolCall(frame.raw), {
              onNone: () => Effect.void,
              onSome: (f) => onExternalToolCall(session, attachment, f)
            })
          case "update_subagent_state":
            return Option.match(decodeSubagentState(frame.raw), {
              onNone: () => Effect.void,
              onSome: (f) =>
                Effect.suspend(() => {
                  session.backgroundSubagents = new Set(
                    f.subagents
                      .filter((a) =>
                        a.is_background === true && a.silent !== true &&
                        (a.status === "pending" || a.status === "running")
                      )
                      .map((a) => a.subagent_id)
                  )
                  return releaseWhenSettled(session)
                })
            })
          case "update_queue":
            return Option.match(decodeQueueUpdate(frame.raw), {
              onNone: () => Effect.void,
              onSome: (f) =>
                Effect.gen(function*() {
                  if (f.queue !== undefined) {
                    session.queuedNotifications = f.queue.filter((item) => item.kind === "task_notification").length
                    yield* releaseWhenSettled(session)
                  }
                  const turn = session.turn
                  if (Option.isNone(turn)) return
                  for (const removed of f.removed ?? []) {
                    if (removed.client_message_id !== turn.value.clientMessageId) continue
                    if (removed.disposition === "dequeued") turn.value.started = true
                    if (removed.disposition === "cancelled") {
                      yield* completeTurn(session, { stopReason: "cancelled", error: Option.none() })
                    }
                  }
                })
            })
          default:
            return Effect.void
        }
      }

      /** Routes this runtime's frames from the subscription into the session. */
      const consume = (session: Session, attachment: Attachment, subscription: PubSub.Subscription<Frame>) =>
        PubSub.take(subscription).pipe(
          Effect.flatMap((frame) => {
            const conversation = frame.header.runtime?.conversation_id ?? conversationOf(frame.raw)
            if (conversation !== attachment.runtime.conversation_id) return Effect.void
            return onFrame(session, attachment, { type: frame.header.type, raw: frame.raw }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`Failed to handle a Letta ${frame.header.type} frame`, cause)
              )
            )
          }),
          Effect.forever
        )

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

      /** Starts a runtime and subscribes to its frames (before `runtime_start`, so nothing is missed). */
      const startRuntime = Effect.fnUntraced(
        function*(conn: LettaConnection, parent: Scope.Scope, target: RuntimeTarget) {
          const scope = yield* Scope.fork(parent)
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
          ).pipe(
            Effect.mapError(unavailable),
            Effect.tapError(() => Scope.close(scope, Exit.void))
          )
          if (response.runtime === null) {
            yield* Scope.close(scope, Exit.void)
            return yield* new AgentUnavailable({
              message: response.error ?? "Letta Code did not start a runtime",
              auth: false
            })
          }
          return { scope, subscription, response, runtime: response.runtime }
        }
      )

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
        yield* attach(session, started, conn)
        if (Option.isSome(session.settings.mode) && Option.isNone(config.permissionMode)) {
          yield* conn.send({
            type: "change_device_state",
            runtime: started.runtime,
            payload: { mode: session.settings.mode.value }
          }).pipe(
            Effect.ignore
          )
        }
        return Option.getOrThrow(session.attachment)
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

      const makeSession = Effect.fnUntraced(function*(input: SessionInput) {
        const session: Session = {
          id: input.id,
          agentId: input.agentId,
          cwd: input.cwd,
          scope: input.scope,
          translator: Translator.make({
            cwd: () => session.cwd,
            path,
            contextWindow: () => session.settings.contextWindow,
            externalTool: (name) => session.mcp.describe(name)
          }),
          turnLock: yield* Semaphore.make(1),
          permissions: yield* Scope.provide(FiberSet.make<void, never>(), input.scope),
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

      /** Connects the client's MCP servers for a session (inside the session's scope). */
      const connectMcp = (servers: ReadonlyArray<McpServerConfig>, cwd: string, scope: Scope.Scope) =>
        Bridge.connectAll(servers, {
          roots: [cwd],
          clientInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: VERSION }
        }).pipe(
          Scope.provide(scope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, httpClient)
        )

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

      /** The session's setup for the client, which then has its commands and config options. */
      const setup = (session: Session): SessionSetup => {
        session.announced = true
        return {
          sessionId: session.id,
          configOptions: configOptions(session.settings),
          commands: session.commands
        }
      }

      /** Follow-up updates sent right after a session is set up. */
      const announce = (session: Session) =>
        Effect.gen(function*() {
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
        }).pipe(Effect.delay("10 millis"), Effect.forkIn(session.scope), Effect.asVoid)

      // --- agent resolution -------------------------------------------------

      const hostLastAgents = (cwd: string) =>
        Effect.gen(function*() {
          const read = (file: string) =>
            fs.readFileString(file).pipe(
              Effect.map((text) => decodeSettings(text)),
              Effect.orElseSucceed(() => Option.none())
            )
          const local = yield* read(path.join(cwd, ".letta", "settings.local.json"))
          const global = yield* read(path.join(host.home, ".letta", "settings.json"))
          const ids = [
            ...Option.toArray(local).flatMap((s) => [
              ...Object.values(s.sessionsByServer ?? {}).map((v) => v.agentId),
              ...(s.lastSession?.agentId === undefined ? [] : [s.lastSession.agentId]),
              ...(s.lastAgent === undefined || s.lastAgent === null ? [] : [s.lastAgent])
            ]),
            ...Option.toArray(global).flatMap((
              s
            ) => (s.lastAgent === undefined || s.lastAgent === null ? [] : [s.lastAgent]))
          ]
          return [...new Set(ids)]
        })

      const resolveAgent = Effect.fnUntraced(function*(conn: LettaConnection, cwd: string, create: boolean) {
        if (Option.isSome(config.agentId)) return Option.some(config.agentId.value)
        const cached = agentsByCwd.get(cwd)
        if (cached !== undefined) return Option.some(cached)
        for (const candidate of yield* hostLastAgents(cwd)) {
          const found = yield* conn.call(
            (request_id) => ({ type: "agent_retrieve", request_id, agent_id: candidate }),
            AgentRetrieveResponse,
            {
              timeout: "20 seconds"
            }
          ).pipe(Effect.map((r) => r.agent !== null), Effect.orElseSucceed(() => false))
          if (found) {
            agentsByCwd.set(cwd, candidate)
            yield* Effect.logInfo(`Using the host's last Letta agent ${candidate}`)
            return Option.some(candidate)
          }
        }
        if (!create) return Option.none<string>()
        const created = yield* conn.call(
          (request_id) => ({
            type: "create_agent",
            request_id,
            personality: "memo",
            pin_global: true,
            ...(Option.isSome(config.model) ? { model: config.model.value } : {})
          }),
          CreateAgentResponse,
          { timeout: "2 minutes" }
        ).pipe(Effect.mapError(unavailable))
        if (created.agent_id === undefined || created.agent_id === null) {
          return yield* new AgentUnavailable({
            message: created.error ?? "Letta Code could not create an agent",
            auth: false
          })
        }
        agentsByCwd.set(cwd, created.agent_id)
        yield* Effect.logWarning(
          `Created Letta agent ${created.agent_id}. Set LETTA_AGENT_ID=${created.agent_id} to keep talking to it.`
        )
        return Option.some(created.agent_id)
      })

      /** The agent's state, which also confirms that it exists. */
      const retrieveAgent = (conn: LettaConnection, agentId: string) =>
        conn.call(
          (request_id) => ({ type: "agent_retrieve", request_id, agent_id: agentId }),
          AgentRetrieveResponse,
          { timeout: "20 seconds" }
        ).pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((response) =>
            response.agent === null
              ? Effect.fail(new AgentUnavailable({ message: `Letta has no agent ${agentId}`, auth: false }))
              : Effect.succeed(response.agent)
          )
        )

      // --- history ----------------------------------------------------------

      const replay = Effect.fnUntraced(function*(session: Session, conn: LettaConnection, conversationId: string) {
        const rows: Array<unknown> = []
        let before: string | undefined
        for (let page = 0; page < 10; page++) {
          const response = yield* conn.call(
            (request_id) => ({
              type: "conversation_messages_list",
              request_id,
              conversation_id: conversationId,
              query: { limit: 100, order: "desc", ...(before === undefined ? {} : { before }) }
            }),
            ConversationMessagesListResponse,
            { timeout: "60 seconds" }
          ).pipe(Effect.mapError(unavailable))
          rows.push(...response.messages)
          if (response.has_more !== true || response.next_before === undefined || response.next_before === null) break
          before = response.next_before
        }
        const history = Translator.make({
          cwd: () => session.cwd,
          path,
          contextWindow: () => session.settings.contextWindow,
          externalTool: (name) => session.mcp.describe(name)
        })
        for (const row of rows.toReversed()) yield* emitAll(session, history.history(row))
        yield* emitAll(session, history.finishTurn("end_turn"))
      })

      // --- operations -------------------------------------------------------

      /**
       * Opens a session that has no Letta conversation yet, without touching
       * Letta beyond reading the agent and its models: the conversation (and,
       * where none is set up, the agent) is created by the first prompt.
       */
      const openPending = Effect.fnUntraced(function*(input: {
        readonly sessionId: string
        readonly cwd: string
        readonly mcpServers: ReadonlyArray<McpServerConfig>
      }) {
        const scope = yield* Scope.fork(layerScope)
        return yield* Effect.gen(function*() {
          const [conn, mcp] = yield* Effect.all([connection, connectMcp(input.mcpServers, input.cwd, scope)], {
            concurrency: "unbounded"
          })
          const agentId = yield* resolveAgent(conn, input.cwd, false)
          const [agent, models] = yield* Effect.all([
            Option.match(agentId, {
              onNone: () => Effect.succeedNone,
              onSome: (id) => retrieveAgent(conn, id).pipe(Effect.asSome)
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
            commands: builtinCommands
          })
          yield* settings.preferConfiguredModel(session.settings)
          return session
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
      })

      /**
       * Returns a live attachment to the session's conversation, creating the
       * conversation (and the agent, for a session without one) on first use.
       * The model, effort and mode chosen meanwhile are applied to it.
       */
      const materialize = (session: Session) =>
        Option.match(session.attachment, {
          onSome: (attachment) => ensureAttached(session, attachment),
          onNone: () => Semaphore.withPermits(session.setupLock, 1)(createConversation(session))
        })

      const createConversation = Effect.fnUntraced(function*(session: Session) {
        if (Option.isSome(session.attachment)) return yield* ensureAttached(session, session.attachment.value)
        const before = configOptions(session.settings)
        const conn = yield* connection
        const agentId = Option.isSome(session.agentId)
          ? session.agentId.value
          : Option.getOrThrow(yield* resolveAgent(conn, session.cwd, true))
        const started = yield* startRuntime(conn, session.scope, {
          agentId,
          conversationId: Option.none(),
          cwd: session.cwd,
          tools: yield* session.mcp.tools,
          mode: session.settings.mode
        })
        const conversationId = started.runtime.conversation_id
        session.agentId = Option.some(agentId)
        yield* attach(session, started, conn)
        const attachment = Option.getOrThrow(session.attachment)
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
      const openSession = Effect.fnUntraced(function*(input: {
        readonly sessionId: string
        readonly conversationId: string
        readonly cwd: string
        readonly mcpServers: ReadonlyArray<McpServerConfig>
        readonly replay: boolean
      }) {
        const scope = yield* Scope.fork(layerScope)
        return yield* Effect.gen(function*() {
          const [conn, mcp] = yield* Effect.all([connection, connectMcp(input.mcpServers, input.cwd, scope)], {
            concurrency: "unbounded"
          })
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
          yield* attach(session, started, conn)
          yield* settle(session, Option.getOrThrow(session.attachment))
          return { session, conversation: stored.conversation }
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
      })

      const newSession = Effect.fn("Agent.newSession")(function*(input: {
        readonly cwd: string
        readonly mcpServers: ReadonlyArray<McpServerConfig>
      }) {
        const session = yield* openPending({ ...input, sessionId: yield* sessionIds.make })
        yield* announce(session)
        yield* Effect.logInfo(
          `Opened session ${session.id}` +
            Option.match(session.agentId, { onNone: () => "", onSome: (id) => ` (agent ${id})` }) +
            ` in ${input.cwd}` +
            (session.mcp.connected.length > 0 ? ` with MCP servers: ${session.mcp.connected.join(", ")}` : "") +
            "; Letta creates its conversation with the first prompt"
        )
        return setup(session)
      })

      /** The stored conversation behind a session, and its agent. */
      const storedConversation = (conn: LettaConnection, sessionId: string, conversationId: string, cwd: string) =>
        Effect.gen(function*() {
          const notFound = new SessionNotFound({ sessionId })
          const retrieved = yield* conn.call(
            (request_id) => ({ type: "conversation_retrieve", request_id, conversation_id: conversationId }),
            ConversationRetrieveResponse
          ).pipe(Effect.mapError(() => notFound))
          const conversation = retrieved.conversation
          if (conversation === null) return yield* notFound
          const agentId = conversation.agent_id ?? Option.getOrUndefined(yield* resolveAgent(conn, cwd, false))
          if (agentId === undefined) return yield* notFound
          return { agentId, conversation }
        })

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
          yield* announce(existing)
          return setup(existing)
        }
        const conversationId = sessionIds.isProvisional(input.sessionId)
          ? yield* sessionIds.conversationOf(input.sessionId)
          : Option.some(input.sessionId)
        if (Option.isNone(conversationId)) {
          // A session that never had a prompt: there is nothing to replay, and still no conversation.
          const session = yield* openPending(input)
          yield* announce(session)
          return setup(session)
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
        yield* announce(session)
        return setup(session)
      })

      const listSessions = Effect.fn("Agent.listSessions")(function*(input: {
        readonly cwd: Option.Option<string>
        readonly cursor: Option.Option<string>
      }) {
        const conn = yield* connection
        const agentId = yield* resolveAgent(conn, Option.getOrElse(input.cwd, () => host.cwd), false)
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

      const runCommand = Effect.fnUntraced(function*(
        session: Session,
        attachment: Attachment,
        prompt: ReadonlyArray<ContentBlock>,
        command: { readonly name: string; readonly args: string },
        release: Effect.Effect<void>
      ) {
        const messageId = yield* uuid
        const done = yield* Deferred.make<TurnResult>()
        session.turn = Option.some({
          clientMessageId: messageId,
          accepted: true,
          early: Option.none(),
          started: true,
          error: Option.none(),
          done,
          runs: new Set(),
          preexisting: new Set(session.backgroundSubagents),
          held: Option.none(),
          followUp: false
        })
        session.localCommand = true
        yield* emit(session, { _tag: "UserMessage", messageId, content: prompt })
        yield* setForeground(session, "running")
        // The lock follows the turn, not the call: a cancelled command must not hold up the next prompt.
        yield* Deferred.await(done).pipe(Effect.ensuring(release), Effect.forkIn(session.scope))
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
          if (!Option.exists(session.turn, (t) => t.clientMessageId === messageId)) return
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
        return { messageId, completion: Deferred.await(done) } satisfies PromptHandle
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

          const clientMessageId = yield* uuid
          const done = yield* Deferred.make<TurnResult>()
          const turn: Turn = {
            clientMessageId,
            accepted: false,
            early: Option.none(),
            started: false,
            error: Option.none(),
            done,
            runs: new Set(),
            preexisting: new Set(session.backgroundSubagents),
            held: Option.none(),
            followUp: false
          }
          session.turn = Option.some(turn)
          session.ownMessages.add(clientMessageId)
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
            Effect.tapError(() =>
              Effect.sync(() => {
                session.turn = Option.none()
                session.ownMessages.delete(clientMessageId)
              })
            )
          )
          if (!accepted.accepted) {
            session.turn = Option.none()
            session.ownMessages.delete(clientMessageId)
            return yield* new PromptRejected({ message: accepted.error ?? "Letta Code did not accept the prompt" })
          }
          turn.accepted = true
          turn.started = turn.started || accepted.disposition !== "queued"
          yield* emit(session, { _tag: "UserMessage", messageId: clientMessageId, content: blocks })
          yield* setForeground(session, "running")
          // With nothing ahead of it in Letta's queue, an early turn_finished can only be ours.
          if (Option.isSome(turn.early) && turn.started) yield* onTurnFinished(session, turn.early.value)
          yield* Deferred.await(done).pipe(Effect.ensuring(release), Effect.forkIn(session.scope))
          return { messageId: clientMessageId, completion: Deferred.await(done) } satisfies PromptHandle
        }).pipe(Effect.onError(() => release))
      })

      const cancel = Effect.fn("Agent.cancel")(function*(sessionId: string) {
        const session = sessions.get(sessionId)
        if (session === undefined || Option.isNone(session.turn)) return
        const turn = session.turn.value
        // Only waiting for background work: stop waiting (the work itself carries on in Letta).
        if (Option.isSome(turn.held) && !turn.followUp) {
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
            Schema.Struct({
              aborted: Schema.optionalKey(Schema.Boolean),
              success: Schema.optionalKey(Schema.Boolean),
              error: Schema.optionalKey(Schema.NullOr(Schema.String))
            }),
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
          // Without a conversation yet, the choice is kept until the first prompt creates one.
          yield* Semaphore.withPermits(session.setupLock, 1)(Effect.suspend(() =>
            Option.match(session.attachment, {
              onNone: () => settings.choose(session.settings, configId, value),
              onSome: (current) =>
                ensureAttached(session, current).pipe(
                  Effect.flatMap((attachment) => settings.set(session.settings, targetOf(attachment), configId, value))
                )
            })
          ))
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

const ConversationRef = Schema.Struct({ conversation_id: Schema.String })
const decodeConversationRef = Schema.decodeUnknownOption(ConversationRef)

/** Frames like `control_request` carry the conversation at the top level. */
const conversationOf = (raw: unknown): string | undefined =>
  Option.getOrUndefined(Option.map(decodeConversationRef(raw), (r) => r.conversation_id))
