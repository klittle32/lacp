/**
 * How a session handles its Letta runtime's frames, and how its turns end.
 *
 * A session's frame fiber ({@link consume}) decodes the App Server frames
 * addressed to its conversation and routes them by type ({@link route}):
 * stream deltas become events, control requests become permission requests,
 * and `turn_finished` ends the turn (or holds it while background work is
 * outstanding). {@link completeTurn} is the one place a turn ends, whichever
 * fiber ends it.
 *
 * Everything here is a plain function over a {@link Session} and the
 * {@link Deps} the agent core builds once: no service is captured.
 */
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Equal,
  FiberHandle,
  FiberSet,
  type LogLevel,
  Match,
  Option,
  PubSub,
  Schema
} from "effect"
import type { LacpConfig } from "../Config.ts"
import type { PermissionDecision, SessionEvent } from "../domain/Events.ts"
import type { Frame } from "../letta/AppServer.ts"
import * as Commands from "../letta/Commands.ts"
import {
  type ControlRequest,
  type DeviceStatus,
  type ExternalToolCallRequest,
  type LoopStatus,
  type QueueUpdate,
  RuntimeFrame,
  type StreamDelta,
  type SubagentState,
  type TurnFinished
} from "../letta/Protocol.ts"
import * as Translator from "../letta/Translator.ts"
import type { AcpClient } from "./Client.ts"
import type { Attachment, Session } from "./Session.ts"
import { configOptions, decodePermissionMode } from "./Settings.ts"
import * as Turn from "./Turn.ts"
import type { TurnResult } from "./Turn.ts"

/** What the handlers need from the agent core's services. */
export interface Deps {
  readonly config: Pick<LacpConfig["Service"], "waitForBackground" | "backgroundGrace">
  readonly client: AcpClient["Service"]
}

const decodeRuntimeFrame = Schema.decodeUnknownOption(RuntimeFrame)
const decodeDeltaRun = Schema.decodeUnknownOption(Schema.Struct({ run_id: Schema.String }))

// ---------------------------------------------------------------------------
// Events to the client
// ---------------------------------------------------------------------------

export const emit = (deps: Deps, session: Session, event: SessionEvent) => deps.client.emit(session.id, event)

export const emitAll = (deps: Deps, session: Session, events: ReadonlyArray<SessionEvent>) =>
  Effect.forEach(events, (event) => emit(deps, session, event), { discard: true })

export const setForeground = (deps: Deps, session: Session, state: "running" | "requires_action") =>
  Effect.suspend(() => {
    if (session.foreground === state) return Effect.void
    session.foreground = state
    return emit(deps, session, { _tag: "State", state })
  })

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * Logs a step of the session's turn, with the time since the turn began.
 * The log never holds prompts or tool input.
 */
export const logTurn = (session: Session, message: string, level: LogLevel.Severity = "Debug") =>
  Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const turn = Option.getOrUndefined(session.turn)
    yield* Effect.logWithLevel(level)(message).pipe(Effect.annotateLogs({
      session: session.id,
      ...(turn === undefined
        ? {}
        : { turn: turn.clientMessageId, elapsed: Duration.format(Duration.millis(now - turn.began)) })
    }))
  })

/** Logs the turn's first output, once Letta runs it (until then, output is earlier work's). */
const noteOutput = (session: Session) =>
  Effect.suspend(() => {
    const turn = Option.getOrUndefined(session.turn)
    if (turn === undefined || turn.streamed || !Turn.started(turn)) return Effect.void
    turn.streamed = true
    return logTurn(session, "First output from Letta")
  })

/** Letta started the turn (see Turn.start). */
const startTurn = (session: Session, turn: Turn.Turn) =>
  Effect.suspend(() => {
    const queued = turn.phase._tag === "Queued"
    Turn.start(turn)
    return queued ? logTurn(session, "Letta started the queued prompt") : Effect.void
  })

/** Ends the session's turn: closes its tool calls, reports idle, resolves its handle. */
export const completeTurn = Effect.fnUntraced(function*(deps: Deps, session: Session, result: TurnResult) {
  const ended = `${result.stopReason}${
    Option.match(result.error, { onNone: () => "", onSome: (error) => ` (${error.message})` })
  }`
  yield* Option.isSome(session.turn)
    ? logTurn(session, `The turn ended: ${ended}`, "Info")
    : logTurn(session, `A turn Letta ran on its own ended: ${ended}`)
  yield* emitAll(
    deps,
    session,
    session.translator.finishTurn(
      result.stopReason === "cancelled" ? "cancelled" : result.stopReason === "error" ? "error" : "end_turn"
    )
  )
  session.foreground = "idle"
  yield* emit(deps, session, {
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

/** Whether a turn has background work outstanding that will report back into the conversation. */
const awaitsBackground = (deps: Deps, session: Session, turn: Turn.Turn) =>
  deps.config.waitForBackground &&
  (session.queuedNotifications > 0 ||
    Array.from(session.backgroundSubagents).some((id) => !turn.preexisting.has(id)))

/** Whether `turn` still only waits for background work that is done. */
const settled = (deps: Deps, session: Session, turn: Turn.Turn) =>
  Option.exists(session.turn, (current) => current === turn) && Turn.waitingForBackground(turn) &&
  !awaitsBackground(deps, session, turn)

/**
 * Ends a held turn once its background work is done. The report starts a
 * follow-up turn, whose end ends the held turn; if none starts within the
 * grace period (counted from the last sign that the work is done), the
 * held result stands.
 */
const releaseWhenSettled = (deps: Deps, session: Session) =>
  Effect.suspend(() => {
    const turn = Option.getOrUndefined(session.turn)
    if (turn === undefined || !settled(deps, session, turn)) return Effect.void
    return Effect.sleep(deps.config.backgroundGrace).pipe(
      Effect.andThen(Effect.suspend(() =>
        settled(deps, session, turn) && turn.phase._tag === "Held"
          ? logTurn(
            session,
            `The background work is done and no follow-up turn started within ${
              Duration.format(deps.config.backgroundGrace)
            }`
          ).pipe(Effect.andThen(completeTurn(deps, session, turn.phase.result)))
          : Effect.void
      )),
      FiberHandle.run(session.grace),
      Effect.asVoid
    )
  })

// ---------------------------------------------------------------------------
// Frame handlers
// ---------------------------------------------------------------------------

export const onTurnFinished = Effect.fnUntraced(function*(deps: Deps, session: Session, frame: TurnFinished) {
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
      yield* emit(deps, session, { _tag: "Usage", used, size: session.settings.contextWindow.value })
    }
  }
  const result: TurnResult = {
    stopReason,
    error: stopReason === "error"
      ? Option.some({ code: -32603, message: message ?? `Letta Code stopped: ${frame.stop_reason}` })
      : Option.none()
  }
  // A cancelled turn ends now, whatever is still running in the background.
  if (stopReason !== "cancelled" && Option.isSome(turn) && awaitsBackground(deps, session, turn.value)) {
    if (turn.value.phase._tag !== "Held") {
      yield* logTurn(session, "Keeping the turn open until its background work reports back", "Info")
    }
    turn.value.phase = Turn.Phase.Held({ result, followUp: false })
    return
  }
  yield* completeTurn(deps, session, result)
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
  function*(deps: Deps, session: Session, attachment: Attachment, frame: ControlRequest) {
    const { events, request } = session.translator.permission(frame.request)
    const tool = frame.request.tool_name
    yield* emitAll(deps, session, events)
    session.approvals += 1
    yield* setForeground(deps, session, "requires_action")
    yield* logTurn(session, `Waiting for the client to approve ${tool}`)
    yield* deps.client.requestPermission(session.id, request).pipe(
      Effect.flatMap((decision) => {
        const answer = decide(decision)
        return logTurn(session, `The client answered the approval for ${tool}: ${answer.behavior}`).pipe(
          Effect.andThen(attachment.connection.send({
            type: "input",
            runtime: attachment.runtime,
            payload: { kind: "approval_response", request_id: frame.request_id, decision: answer }
          }))
        )
      }),
      Effect.catch((error) => Effect.logWarning(`Could not answer a Letta approval: ${error.message}`)),
      Effect.ensuring(Effect.sync(() => {
        session.approvals = Math.max(0, session.approvals - 1)
      })),
      Effect.andThen(
        Effect.suspend(() =>
          Option.isSome(session.turn) && session.approvals === 0 ? setForeground(deps, session, "running") : Effect.void
        )
      ),
      FiberSet.run(session.permissions)
    )
  }
)

const onDelta = Effect.fnUntraced(function*(deps: Deps, session: Session, frame: StreamDelta) {
  // Subagent streams are summarised by their parent tool call.
  if (frame.subagent_id !== undefined && frame.subagent_id !== null) return
  const run = Option.map(decodeDeltaRun(frame.delta), (d) => d.run_id)
  // Output of a turn lacp already ended (a cancel Letta never confirmed) is dropped.
  if (Option.isSome(run) && session.abandonedRuns.has(run.value)) return
  if (Option.isSome(run) && Option.isSome(session.turn)) session.turn.value.runs.add(run.value)
  if (Option.isSome(session.turn) && Turn.waitingForBackground(session.turn.value)) {
    session.turn.value.phase = Turn.Phase.Held({ ...session.turn.value.phase, followUp: true })
    yield* logTurn(session, "The background work reported back; following Letta's follow-up turn")
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
            yield* startTurn(session, session.turn.value)
          }
          continue
        }
        yield* setForeground(deps, session, "running")
        yield* emit(deps, session, item.event)
        continue
      }
      case "LoopError": {
        const turn = session.turn
        if (!item.terminal || Option.isNone(turn)) {
          yield* emit(deps, session, { _tag: "Notice", severity: "warning", title: item.message })
          continue
        }
        turn.value.error = Option.some(item.message)
        if (!Turn.started(turn.value) && item.clientMessageIds.includes(turn.value.clientMessageId)) {
          yield* completeTurn(deps, session, {
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
          yield* setForeground(deps, session, "running")
          yield* noteOutput(session)
        }
        yield* emit(deps, session, item.event)
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

const onDeviceStatus = Effect.fnUntraced(function*(deps: Deps, session: Session, frame: DeviceStatus) {
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
  if (commandsChanged) yield* emit(deps, session, { _tag: "AvailableCommands", commands })
  const after = configOptions(session.settings)
  if (!Equal.equals(before, after)) yield* emit(deps, session, { _tag: "ConfigOptions", options: after })
})

const onLoopStatus = (deps: Deps, session: Session, frame: LoopStatus) =>
  Effect.suspend(() =>
    // `requires_action` is driven by approval requests themselves; loop status
    // frames can lag behind an answer and must not re-block the session.
    frame.loop_status.status !== "WAITING_ON_APPROVAL" && frame.loop_status.status !== "WAITING_ON_INPUT" &&
      Option.isSome(session.turn) && session.approvals === 0
      ? setForeground(deps, session, "running")
      : Effect.void
  )

const onSubagentState = (deps: Deps, session: Session, frame: SubagentState) =>
  Effect.suspend(() => {
    session.backgroundSubagents = new Set(
      frame.subagents
        .filter((a) =>
          a.is_background === true && a.silent !== true && (a.status === "pending" || a.status === "running")
        )
        .map((a) => a.subagent_id)
    )
    return releaseWhenSettled(deps, session)
  })

const onQueueUpdate = Effect.fnUntraced(function*(deps: Deps, session: Session, frame: QueueUpdate) {
  if (frame.queue !== undefined) {
    session.queuedNotifications = frame.queue.filter((item) => item.kind === "task_notification").length
    yield* releaseWhenSettled(deps, session)
  }
  const turn = session.turn
  if (Option.isNone(turn)) return
  for (const removed of frame.removed ?? []) {
    if (removed.client_message_id !== turn.value.clientMessageId) continue
    if (removed.disposition === "dequeued") yield* startTurn(session, turn.value)
    if (removed.disposition === "cancelled") {
      yield* completeTurn(deps, session, { stopReason: "cancelled", error: Option.none() })
    }
  }
})

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Handles a runtime's frames for a session. */
export const route = (
  deps: Deps,
  session: Session,
  attachment: Attachment
): (frame: RuntimeFrame) => Effect.Effect<void> =>
  Match.type<RuntimeFrame>().pipe(
    Match.discriminatorsExhaustive("type")({
      stream_delta: (frame) => onDelta(deps, session, frame),
      turn_finished: (frame) => onTurnFinished(deps, session, frame),
      control_request: (frame) => onControlRequest(deps, session, attachment, frame),
      update_loop_status: (frame) => onLoopStatus(deps, session, frame),
      update_device_status: (frame) => onDeviceStatus(deps, session, frame),
      external_tool_call_request: (frame) => onExternalToolCall(session, attachment, frame),
      update_subagent_state: (frame) => onSubagentState(deps, session, frame),
      update_queue: (frame) => onQueueUpdate(deps, session, frame)
    })
  )

/** Routes this runtime's frames from the subscription into the session; other frames are ignored. */
export const consume = (
  deps: Deps,
  session: Session,
  attachment: Attachment,
  subscription: PubSub.Subscription<Frame>
) => {
  const handle = route(deps, session, attachment)
  return PubSub.take(subscription).pipe(
    Effect.flatMap((frame) =>
      (frame.header.runtime?.conversation_id ?? frame.header.conversation_id) ===
          attachment.runtime.conversation_id
        ? Option.match(decodeRuntimeFrame(frame.raw), { onNone: () => Effect.void, onSome: handle }).pipe(
          Effect.catchCause((cause) => Effect.logError(`Failed to handle a Letta ${frame.header.type} frame`, cause))
        )
        : Effect.void
    ),
    Effect.forever
  )
}

/** Ends the active turn with an error if the connection drops. */
export const watch = (deps: Deps, session: Session, attachment: Attachment) =>
  attachment.connection.closed.pipe(
    Effect.catch((error) =>
      Option.isSome(session.turn)
        ? completeTurn(deps, session, {
          stopReason: "error",
          error: Option.some({ code: -32603, message: error.message })
        })
        : Effect.void
    )
  )
