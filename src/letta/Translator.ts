/**
 * Translates Letta Code App Server stream deltas (and history rows) into the
 * version-neutral {@link SessionEvent} model.
 *
 * Identity rules follow Letta's own guidance: assistant and reasoning
 * fragments are keyed by message type plus `otid`; tool arguments and results
 * are joined by `tool_call_id`; argument fragments are accumulated until they
 * parse as JSON.
 *
 * One translator lives per ACP session. It is synchronous and keeps only the
 * state needed to produce correct upserts, which keeps it easy to test.
 */
import { Array as Arr, Match, Option, type Path, Schema } from "effect"
import * as Content from "../acp/Content.ts"
import type { ToolKind } from "../acp/Content.ts"
import type {
  DiffHunk,
  PermissionChoice,
  PermissionRequest,
  PlanEntry,
  SessionEvent,
  StopReason,
  ToolCallPatch,
  ToolContent
} from "../domain/Events.ts"
import {
  type ClientToolStart,
  type CommandEnd,
  type ControlRequest,
  Delta,
  TextPart,
  type ToolCallDelta,
  type ToolReturnDelta,
  type UsageDelta
} from "./Protocol.ts"
import * as Tools from "./Tools.ts"

/** Letta stop reasons onto ACP stop reasons; any other is an error. */
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

export interface TranslatorContext {
  readonly cwd: string
  readonly path: Path.Path
  /** The model's context window, for usage updates. */
  readonly contextWindow: () => Option.Option<number>
  /** Presentation of controller-owned tools (bridged MCP tools), by tool name. */
  readonly externalTool?: (name: string) => Option.Option<{ readonly title: string; readonly kind: ToolKind }>
}

export interface Translator {
  /** Translates one live `stream_delta.delta`. User-message echoes are returned with their `otid`. */
  readonly delta: (delta: unknown) => ReadonlyArray<TranslatedEvent>
  /** Translates one history row from `conversation_messages_list`. */
  readonly history: (message: unknown) => ReadonlyArray<SessionEvent>
  /** Builds the ACP permission request for a Letta `can_use_tool` control request. */
  readonly permission: (request: ControlRequest["request"]) => {
    readonly events: ReadonlyArray<SessionEvent>
    readonly request: PermissionRequest
  }
  /** Closes tool calls left open when a turn ends. */
  readonly finishTurn: (stopReason: "cancelled" | "error" | "end_turn") => ReadonlyArray<SessionEvent>
}

/** A translated event, a user-message echo the session may want to drop, or a report of finished work. */
export type TranslatedEvent =
  | { readonly _tag: "Event"; readonly event: SessionEvent }
  | { readonly _tag: "UserEcho"; readonly otid: Option.Option<string>; readonly event: SessionEvent }
  /** Letta delivered the `<task-notification>` reports of these background subagents. */
  | { readonly _tag: "SubagentsReported"; readonly subagentIds: ReadonlyArray<string> }
  | {
    readonly _tag: "LoopError"
    readonly message: string
    readonly terminal: boolean
    readonly clientMessageIds: ReadonlyArray<string>
  }

interface ToolState {
  name: string
  rawArguments: string
  input: Option.Option<unknown>
  hunks: ReadonlyMap<string, ReadonlyArray<DiffHunk>>
  started: boolean
  finished: boolean
  terminal: Option.Option<{ readonly command: string; readonly cwd: string }>
  presented: Option.Option<Tools.Presentation>
}

interface Task {
  readonly id: string
  subject: string
  status: PlanEntry["status"]
}

const PERMISSION_ALLOW = "allow"
export const PERMISSION_REJECT = "reject"
export const PERMISSION_ALWAYS_PREFIX = "always:"
const LIVE_OUTPUT_PREFIX = "synthetic-tool-return-stream-"
const MAX_OUTPUT = 20_000
const PLAN_ID = "plan"

const decodeDelta = Schema.decodeUnknownOption(Delta)
const decodeArguments = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))
const isTextPart = Schema.is(TextPart)

/** Flattens Letta message content (a string or content parts) to text. */
const contentText = (content: string | ReadonlyArray<unknown>): string =>
  typeof content === "string" ? content : content.filter(isTextPart).map((part) => part.text).join("")

/**
 * Removes what Letta Code injects into user messages: `<system-reminder>`
 * context, and the `<task-notification>` reports of finished background work
 * (with the transcript line that may follow), which the agent's reply covers.
 */
const stripInjected = (text: string) =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(
      /<task-notification>[\s\S]*?(?:<\/task-notification>|$)(?:\s*Full transcript available at:[^\n]*\n?)?/g,
      ""
    )
    .trim()

/**
 * The background subagents whose reports a user message carries. Letta Code
 * opens each subagent report's result with `subagent_id=<id>`; reports of
 * background shell commands and monitors carry none.
 */
const reportedSubagents = (text: string): ReadonlyArray<string> =>
  Array.from(text.matchAll(/<task-notification>[\s\S]*?(?:<\/task-notification>|$)/g))
    .flatMap((report) => Option.toArray(Option.fromNullishOr(/\bsubagent_id=([^\s<]+)/.exec(report[0])?.[1])))

/** A retry of the model request, from the cloud backend's `retry` delta or the local backend's `retry` event. */
const retryNotice = (retry: {
  readonly message?: string | undefined
  readonly attempt?: number | undefined
  readonly max_attempts?: number | undefined
}): SessionEvent => ({
  _tag: "Notice",
  severity: "warning",
  title: retry.attempt === undefined
    ? "Retrying"
    : `Retrying (attempt ${retry.attempt}${retry.max_attempts === undefined ? "" : `/${retry.max_attempts}`})`,
  description: retry.message
})

const clip = (text: string) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (truncated)` : text)

export const make = (context: TranslatorContext): Translator => {
  const tools = new Map<string, ToolState>()
  const seen = new Set<string>()
  const tasks: Array<Task> = []

  const tool = (id: string, name?: string): ToolState => {
    let state = tools.get(id)
    if (state === undefined) {
      state = {
        name: name ?? "tool",
        rawArguments: "",
        input: Option.none(),
        hunks: new Map(),
        started: false,
        finished: false,
        terminal: Option.none(),
        presented: Option.none()
      }
      tools.set(id, state)
    } else if (name !== undefined && name !== "" && state.name === "tool") {
      state.name = name
    }
    return state
  }

  const toolContext = (): Tools.ToolContext => ({ cwd: context.cwd, path: context.path })

  const presentation = (state: ToolState): Tools.Presentation =>
    Option.match(context.externalTool?.(state.name) ?? Option.none(), {
      onNone: () => Tools.present(state.name, Option.getOrElse(state.input, () => ({})), toolContext(), state.hunks),
      onSome: ({ kind, title }): Tools.Presentation => ({
        title,
        kind,
        locations: [],
        content: [],
        terminal: Option.none()
      })
    })

  /** The full description of a tool call, from what is known so far. */
  const describe = (id: string, state: ToolState): ToolCallPatch => {
    const p = presentation(state)
    state.presented = Option.some(p)
    state.terminal = p.terminal
    const content: Array<ToolContent> = [...p.content]
    if (Option.isSome(p.terminal) && state.started) content.push({ _tag: "Terminal", terminalId: id })
    return {
      toolCallId: id,
      name: state.name,
      title: p.title,
      kind: p.kind,
      locations: p.locations,
      content,
      rawInput: Option.getOrUndefined(state.input)
    }
  }

  const planEvent = (entries: ReadonlyArray<PlanEntry>): SessionEvent => ({ _tag: "Plan", planId: PLAN_ID, entries })

  const tasksPlan = (): SessionEvent =>
    planEvent(tasks.map((task) => ({ content: task.subject, status: task.status, priority: "medium" })))

  /** Merges an argument fragment; returns whether the parsed input changed. */
  const mergeArguments = (state: ToolState, fragment: string | null | undefined): boolean => {
    if (fragment === undefined || fragment === null || fragment === "") return false
    const whole = decodeArguments(fragment)
    if (Option.isSome(whole)) {
      // A delivery that parses alone is the complete value (a final message or history row).
      state.rawArguments = fragment
      state.input = whole
      return true
    }
    state.rawArguments += fragment
    const parsed = decodeArguments(state.rawArguments)
    if (Option.isSome(parsed)) {
      state.input = parsed
      return true
    }
    return false
  }

  const onToolCall = (delta: typeof ToolCallDelta.Type): Array<SessionEvent> => {
    const fragments = delta.tool_call !== undefined && delta.tool_call !== null
      ? [delta.tool_call]
      : delta.tool_calls !== undefined && delta.tool_calls !== null
      ? Arr.ensure(delta.tool_calls)
      : []
    const events: Array<SessionEvent> = []
    for (const fragment of fragments) {
      const id = fragment.tool_call_id
      if (id === undefined || id === null || id === "") continue
      const isNew = !tools.has(id)
      const state = tool(id, fragment.name ?? undefined)
      const changed = mergeArguments(state, fragment.arguments)
      if (isNew || changed) {
        events.push({
          _tag: "ToolCall",
          patch: { ...describe(id, state), status: state.started ? "in_progress" : "pending" }
        })
      }
      if (changed && Option.isSome(state.input)) {
        const plan = Tools.planFromInput(state.name, state.input.value)
        if (Option.isSome(plan)) events.push(planEvent(plan.value))
      }
    }
    return events
  }

  const onToolStart = (delta: typeof ClientToolStart.Type): Array<SessionEvent> => {
    const state = tool(delta.tool_call_id, delta.tool_name ?? undefined)
    mergeArguments(state, delta.tool_args)
    state.started = true
    const events: Array<SessionEvent> = [{
      _tag: "ToolCall",
      patch: { ...describe(delta.tool_call_id, state), status: "in_progress" }
    }]
    if (Option.isSome(state.terminal)) {
      events.unshift({
        _tag: "Terminal",
        terminalId: delta.tool_call_id,
        command: state.terminal.value.command,
        cwd: state.terminal.value.cwd
      })
    }
    return events
  }

  const onToolReturn = (delta: typeof ToolReturnDelta.Type): Array<SessionEvent> => {
    const id = delta.tool_call_id
    const state = tool(id)
    const output = delta.tool_return
    const failed = delta.status === "error"
    if (delta.id.startsWith(LIVE_OUTPUT_PREFIX)) {
      // A live snapshot of a running tool's output.
      if (Option.isSome(state.terminal)) return [{ _tag: "Terminal", terminalId: id, output }]
      return [{
        _tag: "ToolCall",
        patch: {
          toolCallId: id,
          status: "in_progress",
          content: [{ _tag: "Content", content: Content.text(clip(output)) }]
        }
      }]
    }
    state.finished = true
    const events: Array<SessionEvent> = []
    const presented = Option.getOrElse(state.presented, () => presentation(state))
    if (Option.isSome(state.terminal)) {
      events.push({
        _tag: "Terminal",
        terminalId: id,
        output,
        exitCode: Option.getOrElse(Tools.exitCodeOf(output), () => (failed ? 1 : 0))
      })
      events.push({
        _tag: "ToolCall",
        patch: {
          toolCallId: id,
          status: failed ? "failed" : "completed",
          content: state.started
            ? [{ _tag: "Terminal", terminalId: id }]
            : [{ _tag: "Content", content: Content.text(clip(output)) }],
          rawOutput: output
        }
      })
      return events
    }
    const hasDiff = presented.content.some((c) => c._tag === "Diff")
    const content: Array<ToolContent> = [...presented.content]
    if (!hasDiff || failed) content.push({ _tag: "Content", content: Content.text(clip(output)) })
    events.push({
      _tag: "ToolCall",
      patch: { toolCallId: id, status: failed ? "failed" : "completed", content, rawOutput: output }
    })
    if (!failed) events.push(...planFromResult(state, output))
    return events
  }

  const planFromResult = (state: ToolState, output: string): Array<SessionEvent> => {
    if (state.name === "TaskCreate") {
      const subject = Option.flatMap(state.input, Tools.decodeTaskCreate)
      if (Option.isNone(subject)) return []
      const id = Option.getOrElse(Tools.createdTaskId(output), () => String(tasks.length + 1))
      tasks.push({ id, subject: subject.value.subject, status: "pending" })
      return [tasksPlan()]
    }
    if (state.name === "TaskUpdate") {
      const update = Option.flatMap(state.input, Tools.decodeTaskUpdate)
      if (Option.isNone(update)) return []
      const index = tasks.findIndex((task) => task.id === String(update.value.taskId))
      const task = tasks[index]
      if (task === undefined) return []
      if (update.value.status === "deleted") tasks.splice(index, 1)
      else {
        if (update.value.status !== undefined) task.status = update.value.status
        if (update.value.subject !== undefined) task.subject = update.value.subject
      }
      return [tasksPlan()]
    }
    return []
  }

  const usage = (delta: typeof UsageDelta.Type): Array<SessionEvent> => {
    const used = delta.context_tokens ?? delta.prompt_tokens
    const size = context.contextWindow()
    if (used === undefined || used === null || Option.isNone(size)) return []
    return [{ _tag: "Usage", used, size: size.value }]
  }

  /** Drops replayed fragments of assistant/reasoning streams. */
  const fresh = (type: string, runId: string | null | undefined, seq: number | null | undefined, id: string) => {
    if (runId === undefined || runId === null || seq === undefined || seq === null) return true
    const key = `${type}:${runId}:${seq}:${id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }

  const event = (e: SessionEvent): TranslatedEvent => ({ _tag: "Event", event: e })
  const events = (es: ReadonlyArray<SessionEvent>) => es.map(event)

  const translateDelta: (delta: Delta) => ReadonlyArray<TranslatedEvent> = Match.type<Delta>().pipe(
    Match.discriminatorsExhaustive("message_type")({
      assistant_message: (d) => {
        const text = contentText(d.content)
        if (text === "" || !fresh("assistant", d.run_id, d.seq_id, d.otid ?? d.id)) return []
        return [event({ _tag: "AgentMessageChunk", messageId: d.otid ?? d.id, content: Content.text(text) })]
      },
      reasoning_message: (d) => {
        if (d.reasoning === "" || !fresh("reasoning", d.run_id, d.seq_id, d.otid ?? d.id)) return []
        return [event({ _tag: "AgentThoughtChunk", messageId: d.otid ?? d.id, content: Content.text(d.reasoning) })]
      },
      user_message: (d): ReadonlyArray<TranslatedEvent> => {
        const raw = contentText(d.content)
        const reported = reportedSubagents(raw)
        const text = stripInjected(raw)
        return [
          ...(reported.length > 0 ? [{ _tag: "SubagentsReported", subagentIds: reported } as const] : []),
          ...(text === "" ? [] : [
            {
              _tag: "UserEcho",
              otid: Option.fromNullishOr(d.otid),
              event: { _tag: "UserMessageChunk", messageId: d.otid ?? d.id, content: Content.text(text) }
            } as const
          ])
        ]
      },
      tool_call_message: (d) => events(onToolCall(d)),
      approval_request_message: (d) => events(onToolCall(d)),
      client_tool_start: (d) => events(onToolStart(d)),
      client_tool_end: (d) => {
        tool(d.tool_call_id).started = true
        return []
      },
      tool_return_message: (d) => events(onToolReturn(d)),
      slash_command_end: (d) => commandOutput(d),
      command_end: (d) => commandOutput(d),
      retry: (d) => [event(retryNotice(d))],
      event_message: (d) => d.event_type === "retry" ? [event(retryNotice(d.event_data ?? {}))] : [],
      loop_error: (d) => [{
        _tag: "LoopError",
        message: d.message,
        terminal: d.is_terminal ?? true,
        clientMessageIds: d.client_message_ids ?? []
      }],
      error_message: (d) => [
        event({ _tag: "Notice", severity: "error", title: d.message, description: d.detail ? d.detail : undefined })
      ],
      usage_statistics: (d) => events(usage(d))
    })
  )

  const commandOutput = (d: typeof CommandEnd.Type): ReadonlyArray<TranslatedEvent> =>
    d.output === undefined || d.output === ""
      ? []
      : [event({ _tag: "AgentMessageChunk", messageId: `command-${d.command_id}`, content: Content.text(d.output) })]

  const translate = (delta: unknown): ReadonlyArray<TranslatedEvent> =>
    Option.match(decodeDelta(delta), { onNone: () => [], onSome: translateDelta })

  return {
    delta: translate,
    history: (message) =>
      translate(message).flatMap((item) => (item._tag === "Event" || item._tag === "UserEcho" ? [item.event] : [])),
    permission: (request) => {
      const isNew = !tools.has(request.tool_call_id)
      const state = tool(request.tool_call_id, request.tool_name)
      state.input = Option.some(request.input)
      state.hunks = Tools.hunksByFile(request.diffs)
      const patch: ToolCallPatch = { ...describe(request.tool_call_id, state), status: "pending" }
      const options: Array<PermissionChoice> = [
        { optionId: PERMISSION_ALLOW, name: "Allow", kind: "allow_once" },
        ...(request.permission_suggestions ?? []).map((suggestion): PermissionChoice => ({
          optionId: `${PERMISSION_ALWAYS_PREFIX}${suggestion.id}`,
          name: suggestion.text,
          kind: "allow_always"
        })),
        { optionId: PERMISSION_REJECT, name: "Reject", kind: "reject_once" }
      ]
      const events: Array<SessionEvent> = [{ _tag: "ToolCall", patch }]
      if (isNew && Option.isSome(state.input)) {
        const plan = Tools.planFromInput(state.name, state.input.value)
        if (Option.isSome(plan)) events.push(planEvent(plan.value))
      }
      return {
        events,
        request: {
          title: patch.title ?? request.tool_name,
          toolCall: patch,
          options
        }
      }
    },
    finishTurn: (stopReason) => {
      const events: Array<SessionEvent> = []
      for (const [id, state] of tools) {
        if (state.finished) continue
        state.finished = true
        events.push({
          _tag: "ToolCall",
          patch: {
            toolCallId: id,
            status: stopReason === "cancelled" ? "cancelled" : stopReason === "error" ? "failed" : "completed"
          }
        })
      }
      tools.clear()
      seen.clear()
      return events
    }
  }
}
