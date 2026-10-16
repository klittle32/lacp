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
  Duration,
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
  Semaphore
} from "effect"
import { Crypto } from "effect/Crypto"
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
import { isAuthFailure, type LettaError } from "../letta/Errors.ts"
import {
  AgentRetrieveResponse,
  ControlRequest,
  ConversationListResponse,
  ConversationMessagesListResponse,
  ConversationRetrieveResponse,
  CreateAgentResponse,
  DeviceStatus,
  ExecuteCommandResponse,
  GetCwdMapResponse,
  InputAccepted,
  ListModelsResponse,
  LoopStatus,
  type ModelEntry,
  type PermissionMode,
  PermissionMode as PermissionModeSchema,
  QueueUpdate,
  type RuntimeScope,
  RuntimeStartResponse,
  StreamDelta,
  TurnFinished,
  UpdateModelResponse
} from "../letta/Protocol.ts"
import * as Translator from "../letta/Translator.ts"
import { AGENT_NAME, AGENT_TITLE, VERSION } from "../Version.ts"
import { AcpClient } from "./Client.ts"
import { plainText, slashCommand, toLettaContent } from "./Prompt.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SessionNotFound extends Schema.TaggedError<SessionNotFound, { readonly brand: unique symbol }>()(
  "SessionNotFound",
  { sessionId: Schema.String }
) {}

/** Letta Code could not be reached; `auth` marks failures that need a sign-in. */
export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable, { readonly brand: unique symbol }>()(
  "AgentUnavailable",
  { message: Schema.String, auth: Schema.Boolean }
) {}

export class InvalidConfigValue extends Schema.TaggedError<InvalidConfigValue, { readonly brand: unique symbol }>()(
  "InvalidConfigValue",
  { configId: Schema.String, value: Schema.String }
) {}

export class PromptRejected extends Schema.TaggedError<PromptRejected, { readonly brand: unique symbol }>()(
  "PromptRejected",
  { message: Schema.String }
) {}

export type AgentError = SessionNotFound | AgentUnavailable | InvalidConfigValue | PromptRejected

const unavailable = (error: LettaError) => new AgentUnavailable({ message: error.message, auth: isAuthFailure(error) })

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

export const MODE_CONFIG_ID = "mode"
export const MODEL_CONFIG_ID = "model"

const MODES: ReadonlyArray<{ readonly value: PermissionMode; readonly name: string; readonly description: string }> = [
  { value: "standard", name: "Standard", description: "Ask before running tools that change files or run commands" },
  {
    value: "acceptEdits",
    name: "Accept Edits",
    description: "Apply file edits automatically; ask for everything else"
  },
  { value: "unrestricted", name: "Unrestricted", description: "Run every tool without asking" },
  { value: "strict", name: "Strict", description: "Ask before every tool call" }
]

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

const decode = <S extends Schema.Codec<unknown, unknown>>(schema: S) => Schema.decodeUnknownOption(schema)
const decodeStreamDelta = decode(StreamDelta)
const decodeTurnFinished = decode(TurnFinished)
const decodeControlRequest = decode(ControlRequest)
const decodeLoopStatus = decode(LoopStatus)
const decodeDeviceStatus = decode(DeviceStatus)
const decodeQueueUpdate = decode(QueueUpdate)
const decodePermissionMode = decode(PermissionModeSchema)

/** Letta stop reasons onto ACP stop reasons. */
export const stopReasonOf = (reason: string): StopReason => {
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
}

interface Attachment {
  readonly generation: number
  readonly scope: Scope.Closeable
  readonly connection: LettaConnection
  readonly runtime: RuntimeScope
}

interface Session {
  readonly id: string
  readonly agentId: string
  cwd: string
  readonly scope: Scope.Closeable
  readonly translator: Translator.Translator
  readonly turnLock: Semaphore.Semaphore
  readonly permissions: FiberSet.FiberSet<void, never>
  attachment: Option.Option<Attachment>
  mode: Option.Option<PermissionMode>
  model: Option.Option<string>
  contextWindow: Option.Option<number>
  commands: ReadonlyArray<Command>
  models: ReadonlyArray<ModelEntry>
  readonly ownMessages: Set<string>
  turn: Option.Option<Turn>
  foreground: "idle" | "running" | "requires_action"
  readonly deviceStatus: Deferred.Deferred<void>
  localCommand: boolean
  /** Approval requests awaiting the client's answer. */
  approvals: number
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Agent extends Context.Service<Agent, {
  /** Starts Letta Code in the background. */
  readonly warmup: Effect.Effect<void>
  newSession(input: { readonly cwd: string }): Effect.Effect<SessionSetup, AgentError>
  /** Attaches to an existing conversation; with `replay`, its history is emitted first. */
  loadSession(input: {
    readonly sessionId: string
    readonly cwd: string
    readonly replay: boolean
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
      const client = yield* AcpClient
      const crypto = yield* Crypto
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layerScope = yield* Effect.scope
      const sessions = new Map<string, Session>()
      const agentsByCwd = new Map<string, string>()
      const modelsByGeneration = new Map<number, ReadonlyArray<ModelEntry>>()

      // A failing CSPRNG is not a recoverable condition.
      const uuid = crypto.randomUUIDv4().pipe(Effect.orDie)

      const connection = appServer.connection.pipe(Effect.mapError(unavailable))

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

      // --- config options --------------------------------------------------

      const configOptions = (session: Session): ReadonlyArray<ConfigOption> => {
        const options: Array<ConfigOption> = [{
          id: MODE_CONFIG_ID,
          name: "Mode",
          description: "When Letta Code asks before running tools",
          category: "mode",
          currentValue: Option.getOrElse(session.mode, () => "standard"),
          options: MODES.map((m) => ({ value: m.value, name: m.name, description: m.description }))
        }]
        if (Option.isSome(session.model) || session.models.length > 0) {
          const current = Option.getOrElse(session.model, () => session.models[0]?.handle ?? "")
          const choices = session.models.map((m) => ({
            value: m.handle,
            name: m.label,
            ...(m.description === undefined || m.description === null ? {} : { description: m.description })
          }))
          if (!choices.some((c) => c.value === current)) choices.unshift({ value: current, name: current })
          options.push({
            id: MODEL_CONFIG_ID,
            name: "Model",
            category: "model",
            currentValue: current,
            options: choices
          })
        }
        return options
      }

      const models = (connection: LettaConnection) =>
        Effect.suspend(() => {
          const cached = modelsByGeneration.get(connection.generation)
          if (cached !== undefined) return Effect.succeed(cached)
          return connection.call((request_id) => ({ type: "list_models", request_id }), ListModelsResponse, {
            timeout: "15 seconds"
          }).pipe(
            Effect.map((response) => response.entries),
            Effect.tap((entries) => Effect.sync(() => modelsByGeneration.set(connection.generation, entries))),
            Effect.catch((error) =>
              Effect.logWarning(`Could not list Letta models: ${error.message}`).pipe(Effect.as([]))
            )
          )
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
          const turn = session.turn
          if (Option.isSome(turn) && !turn.value.accepted) {
            turn.value.early = Option.some(frame)
            return
          }
          // A turn that finished before ours was dequeued belongs to earlier (background) work.
          if (Option.isSome(turn) && !turn.value.started) return
          const stopReason = stopReasonOf(frame.stop_reason)
          const message = frame.error ?? Option.getOrUndefined(Option.flatMap(turn, (t) => t.error))
          if (frame.usage !== undefined && frame.usage !== null && Option.isSome(session.contextWindow)) {
            const used = frame.usage.context_tokens ?? frame.usage.prompt_tokens
            if (used !== undefined && used !== null) {
              yield* emit(session, { _tag: "Usage", used, size: session.contextWindow.value })
            }
          }
          yield* completeTurn(session, {
            stopReason,
            error: stopReason === "error"
              ? Option.some({ code: -32603, message: message ?? `Letta Code stopped: ${frame.stop_reason}` })
              : Option.none()
          })
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
          for (const item of session.translator.delta(frame.delta)) {
            switch (item._tag) {
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

      const onDeviceStatus = (session: Session, frame: DeviceStatus) =>
        Effect.gen(function*() {
          const status = frame.device_status
          const before = configOptions(session)
          const mode = Option.flatMap(Option.fromUndefinedOr(status.current_permission_mode), decodePermissionMode)
          if (Option.isSome(mode)) session.mode = mode
          const commands = commandsFrom(status)
          const commandsChanged = !Equal.equals(commands, session.commands)
          session.commands = commands
          const firstReport = !(yield* Deferred.isDone(session.deviceStatus))
          yield* Deferred.succeed(session.deviceStatus, undefined)
          if (firstReport) return
          if (commandsChanged) yield* emit(session, { _tag: "AvailableCommands", commands })
          const after = configOptions(session)
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
          case "update_queue":
            return Option.match(decodeQueueUpdate(frame.raw), {
              onNone: () => Effect.void,
              onSome: (f) =>
                Effect.gen(function*() {
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
              ...(Option.isSome(config.permissionMode) ? { mode: config.permissionMode.value } : {}),
              client_info: { name: AGENT_NAME, title: AGENT_TITLE, version: VERSION },
              recover_approvals: true,
              force_device_status: true,
              wait_for_replay: true
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

      /** Returns a live attachment, re-attaching after an App Server restart. */
      const ensureAttached = Effect.fnUntraced(function*(session: Session) {
        const conn = yield* connection
        const current = session.attachment
        if (Option.isSome(current) && current.value.generation === conn.generation) return current.value
        yield* Effect.logInfo(`Re-attaching session ${session.id} to the restarted Letta Code App Server`)
        const started = yield* startRuntime(conn, session.scope, {
          agentId: session.agentId,
          conversationId: Option.some(session.id),
          cwd: session.cwd
        })
        yield* attach(session, started, conn)
        if (Option.isSome(session.mode) && Option.isNone(config.permissionMode)) {
          yield* conn.send({
            type: "change_device_state",
            runtime: started.runtime,
            payload: { mode: session.mode.value }
          }).pipe(
            Effect.ignore
          )
        }
        return Option.getOrThrow(session.attachment)
      })

      const makeSession = Effect.fnUntraced(function*(
        conn: LettaConnection,
        agentId: string,
        cwd: string,
        started: Effect.Success<ReturnType<typeof startRuntime>>
      ) {
        const scope = yield* Scope.fork(layerScope)
        const session: Session = {
          id: started.runtime.conversation_id,
          agentId,
          cwd,
          scope,
          translator: Translator.make({
            cwd: () => session.cwd,
            path,
            contextWindow: () => session.contextWindow
          }),
          turnLock: yield* Semaphore.make(1),
          permissions: yield* Scope.provide(FiberSet.make<void, never>(), scope),
          attachment: Option.none(),
          mode: config.permissionMode,
          model: Option.fromNullishOr(started.response.conversation?.model ?? started.response.agent?.model),
          contextWindow: Option.fromNullishOr(
            started.response.agent?.llm_config?.context_window ??
              started.response.agent?.model_settings?.context_window_limit
          ),
          commands: [],
          models: yield* models(conn),
          ownMessages: new Set(),
          turn: Option.none(),
          foreground: "idle",
          deviceStatus: yield* Deferred.make<void>(),
          localCommand: false,
          approvals: 0
        }
        // The runtime scope belongs to the session from now on.
        yield* Scope.addFinalizer(scope, Scope.close(started.scope, Exit.void))
        sessions.set(session.id, session)
        return session
      })

      /** Waits briefly for the runtime's first device status (mode and commands). */
      const settle = Effect.fnUntraced(function*(session: Session, attachment: Attachment) {
        const seen = yield* Deferred.await(session.deviceStatus).pipe(Effect.timeoutOption("5 seconds"))
        if (Option.isNone(seen) && Option.isNone(session.mode)) {
          // Never assume Letta's own default (unrestricted): ask before acting.
          session.mode = Option.some("standard")
          yield* attachment.connection.send({
            type: "change_device_state",
            runtime: attachment.runtime,
            payload: { mode: "standard" }
          }).pipe(Effect.ignore)
        }
      })

      const setup = (session: Session): SessionSetup => ({
        sessionId: session.id,
        configOptions: configOptions(session),
        commands: session.commands
      })

      /** Follow-up updates sent right after a session is set up. */
      const announce = (session: Session) =>
        Effect.gen(function*() {
          if (session.commands.length > 0) {
            yield* emit(session, { _tag: "AvailableCommands", commands: session.commands })
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

      const applyConfiguredModel = Effect.fnUntraced(function*(session: Session, attachment: Attachment) {
        if (Option.isNone(config.model) || Option.contains(session.model, config.model.value)) return
        const response = yield* attachment.connection.call(
          (request_id) => ({
            type: "update_model",
            request_id,
            runtime: attachment.runtime,
            payload: { model_handle: config.model.pipe(Option.getOrElse(() => "")) }
          }),
          UpdateModelResponse
        ).pipe(Effect.option)
        if (Option.isSome(response)) {
          session.model = Option.some(response.value.model_handle ?? Option.getOrElse(config.model, () => ""))
        }
      })

      // --- history ----------------------------------------------------------

      const replay = Effect.fnUntraced(function*(session: Session, conn: LettaConnection) {
        const rows: Array<unknown> = []
        let before: string | undefined
        for (let page = 0; page < 10; page++) {
          const response = yield* conn.call(
            (request_id) => ({
              type: "conversation_messages_list",
              request_id,
              conversation_id: session.id,
              query: { limit: 100, order: "desc", ...(before === undefined ? {} : { before }) }
            }),
            ConversationMessagesListResponse,
            { timeout: "60 seconds" }
          ).pipe(Effect.mapError(unavailable))
          rows.push(...response.messages)
          if (response.has_more !== true || response.next_before === undefined || response.next_before === null) break
          before = response.next_before
        }
        const history = Translator.make({ cwd: () => session.cwd, path, contextWindow: () => session.contextWindow })
        for (const row of rows.toReversed()) yield* emitAll(session, history.history(row))
        yield* emitAll(session, history.finishTurn("end_turn"))
      })

      // --- operations -------------------------------------------------------

      const newSession = Effect.fn("Agent.newSession")(function*(input: { readonly cwd: string }) {
        const conn = yield* connection
        const agentId = yield* resolveAgent(conn, input.cwd, true).pipe(Effect.map(Option.getOrThrow))
        const started = yield* startRuntime(conn, layerScope, {
          agentId,
          conversationId: Option.none(),
          cwd: input.cwd
        })
        const session = yield* makeSession(conn, agentId, input.cwd, started)
        yield* attach(session, started, conn)
        const attachment = Option.getOrThrow(session.attachment)
        yield* settle(session, attachment)
        yield* applyConfiguredModel(session, attachment)
        yield* announce(session)
        yield* Effect.logInfo(`Started session ${session.id} (agent ${agentId}) in ${input.cwd}`)
        return setup(session)
      })

      const loadSession = Effect.fn("Agent.loadSession")(function*(input: {
        readonly sessionId: string
        readonly cwd: string
        readonly replay: boolean
      }) {
        const conn = yield* connection
        const existing = sessions.get(input.sessionId)
        if (existing !== undefined) {
          existing.cwd = input.cwd
          yield* ensureAttached(existing)
          if (input.replay) yield* replay(existing, conn)
          yield* announce(existing)
          return setup(existing)
        }
        const retrieved = yield* conn.call(
          (request_id) => ({ type: "conversation_retrieve", request_id, conversation_id: input.sessionId }),
          ConversationRetrieveResponse
        ).pipe(Effect.mapError(() => new SessionNotFound({ sessionId: input.sessionId })))
        const conversation = retrieved.conversation
        if (conversation === null) return yield* new SessionNotFound({ sessionId: input.sessionId })
        const agentId = conversation.agent_id ?? Option.getOrUndefined(yield* resolveAgent(conn, input.cwd, false))
        if (agentId === undefined) return yield* new SessionNotFound({ sessionId: input.sessionId })
        const started = yield* startRuntime(conn, layerScope, {
          agentId,
          conversationId: Option.some(input.sessionId),
          cwd: input.cwd
        })
        const session = yield* makeSession(conn, agentId, input.cwd, started)
        if (input.replay) yield* replay(session, conn)
        yield* attach(session, started, conn)
        yield* settle(session, Option.getOrThrow(session.attachment))
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
        const summaries = response.conversations
          .filter((c) => c.archived !== true)
          .map((c): SessionSummary & { readonly mapped: boolean } => {
            const mapped = cwdMap[`conversation:${c.id}`] ?? sessions.get(c.id)?.cwd
            return {
              sessionId: c.id,
              cwd: mapped ?? host.cwd,
              mapped: mapped !== undefined,
              title: Option.fromNullishOr(c.summary ?? c.description).pipe(Option.filter((t) => t !== "")),
              updatedAt: Option.fromNullishOr(c.last_message_at ?? c.updated_at ?? c.created_at)
            }
          })
          .filter((s) =>
            Option.isNone(input.cwd) || (s.mapped && path.resolve(s.cwd) === path.resolve(input.cwd.value))
          )
          .map(({ mapped: _mapped, ...summary }) => summary)
        const last = response.conversations.at(-1)
        return {
          sessions: summaries,
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
          done
        })
        session.localCommand = true
        yield* emit(session, { _tag: "UserMessage", messageId, content: prompt })
        yield* setForeground(session, "running")
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
        }).pipe(Effect.ensuring(release), Effect.forkIn(session.scope))
        return { messageId, completion: Deferred.await(done) } satisfies PromptHandle
      })

      const prompt = Effect.fn("Agent.prompt")(function*(sessionId: string, blocks: ReadonlyArray<ContentBlock>) {
        const session = yield* getSession(sessionId)
        yield* Semaphore.take(session.turnLock, 1)
        const release = Semaphore.release(session.turnLock, 1).pipe(Effect.asVoid)
        return yield* Effect.gen(function*() {
          const attachment = yield* ensureAttached(session)
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
            done
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
        const attachment = session.attachment
        if (Option.isSome(attachment)) {
          yield* attachment.value.connection.call(
            (request_id) => ({ type: "abort_message", request_id, runtime: attachment.value.runtime }),
            Schema.Struct({
              success: Schema.optionalKey(Schema.Boolean),
              error: Schema.optionalKey(Schema.NullOr(Schema.String))
            }),
            { timeout: "10 seconds" }
          ).pipe(
            Effect.catch((error) => Effect.logWarning(`Letta did not acknowledge the cancellation: ${error.message}`)),
            Effect.forkIn(session.scope)
          )
        }
        // If Letta never reports the end of the turn, end it ourselves.
        yield* Effect.sleep(Duration.seconds(15)).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              Option.isSome(session.turn) && session.turn.value === turn
                ? completeTurn(session, { stopReason: "cancelled", error: Option.none() })
                : Effect.void
            )
          ),
          Effect.forkIn(session.scope)
        )
      })

      const setConfigOption = Effect.fn("Agent.setConfigOption")(
        function*(sessionId: string, configId: string, value: string) {
          const session = yield* getSession(sessionId)
          const attachment = yield* ensureAttached(session)
          if (configId === MODE_CONFIG_ID) {
            const mode = decodePermissionMode(value)
            if (Option.isNone(mode)) return yield* new InvalidConfigValue({ configId, value })
            yield* attachment.connection.send({
              type: "change_device_state",
              runtime: attachment.runtime,
              payload: { mode: mode.value }
            }).pipe(
              Effect.mapError(unavailable)
            )
            session.mode = mode
          } else if (configId === MODEL_CONFIG_ID) {
            const response = yield* attachment.connection.call(
              (request_id) => ({
                type: "update_model",
                request_id,
                runtime: attachment.runtime,
                payload: { model_handle: value }
              }),
              UpdateModelResponse,
              { timeout: "60 seconds" }
            ).pipe(
              Effect.mapError((error) =>
                error._tag === "LettaRequestFailed" ? new InvalidConfigValue({ configId, value }) : unavailable(error)
              )
            )
            session.model = Option.some(response.model_handle ?? value)
          } else {
            return yield* new InvalidConfigValue({ configId, value })
          }
          const options = configOptions(session)
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
