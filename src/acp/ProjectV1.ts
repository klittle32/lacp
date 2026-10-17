/**
 * Projects version-neutral session events onto ACP v1 wire shapes.
 *
 * v1 has no foreground-state notifications (the `session/prompt` response ends
 * the turn), creates tool calls with `tool_call` before `tool_call_update`, has
 * no `cancelled` tool status, and has no agent-owned terminal display, so
 * terminal output is rendered as tool-call text.
 */
import {
  type ConfigOption,
  type PermissionRequest,
  SessionEvent,
  type ToolCallPatch,
  ToolContent,
  type ToolStatus
} from "../domain/Events.ts"
import * as Content from "./Content.ts"
import type * as V1 from "./V1.ts"

export interface ClientFeatures {
  readonly notices: boolean
}

type Updates = ReadonlyArray<V1.SessionUpdate>

const status = (s: ToolStatus): V1.ToolCallStatus => (s === "cancelled" ? "failed" : s)

export const configOption = (option: ConfigOption): V1.SessionConfigOption => ({
  type: "select",
  id: option.id,
  name: option.name,
  ...(option.description === undefined ? {} : { description: option.description }),
  category: option.category,
  currentValue: option.currentValue,
  options: option.options.map((o) => ({
    value: o.value,
    name: o.name,
    ...(o.description === undefined ? {} : { description: o.description })
  }))
})

/** The legacy `modes` state, kept in sync with the `mode` config option. */
export const modeState = (options: ReadonlyArray<ConfigOption>) => {
  const mode = options.find((o) => o.category === "mode")
  return mode === undefined ? undefined : {
    currentModeId: mode.currentValue,
    availableModes: mode.options.map((o) => ({
      id: o.value,
      name: o.name,
      ...(o.description === undefined ? {} : { description: o.description })
    }))
  }
}

interface TerminalState {
  readonly command: string
  readonly output: string
  readonly exitCode: number | null | undefined
}

export interface ProjectorV1 {
  readonly project: (sessionId: string, event: SessionEvent) => Updates
  readonly toolCall: (sessionId: string, patch: ToolCallPatch) => V1.ToolCallUpdate
}

interface TurnProjector {
  readonly project: (event: SessionEvent) => Updates
  readonly toolCall: (patch: ToolCallPatch) => V1.ToolCallUpdate
}

/** Projects one session's turn: the tool calls it announced and the terminal output it has seen. */
const makeTurnProjector = (features: ClientFeatures): TurnProjector => {
  const announced = new Set<string>()
  const terminals = new Map<string, TerminalState>()

  const renderTerminal = (id: string): V1.ToolCallContent => {
    const t = terminals.get(id)
    const exit = t?.exitCode === undefined || t.exitCode === null ? "" : `\n[exit code ${t.exitCode}]`
    const body = t === undefined ? "" : `$ ${t.command}\n${t.output}${exit}`
    return { type: "content", content: Content.text(`\`\`\`console\n${body.trimEnd()}\n\`\`\``) }
  }

  const content = ToolContent.match({
    Content: (item): V1.ToolCallContent => ({ type: "content", content: item.content }),
    Diff: (item): V1.ToolCallContent => ({
      type: "diff",
      path: item.path,
      oldText: item.oldText,
      newText: item.newText
    }),
    Terminal: (item): V1.ToolCallContent => renderTerminal(item.terminalId)
  })

  const toolCall = (patch: ToolCallPatch): V1.ToolCallUpdate => ({
    toolCallId: patch.toolCallId,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.kind === undefined ? {} : { kind: patch.kind }),
    ...(patch.status === undefined ? {} : { status: status(patch.status) }),
    ...(patch.content === undefined ? {} : { content: patch.content.map(content) }),
    ...(patch.locations === undefined ? {} : { locations: patch.locations }),
    ...(patch.rawInput === undefined ? {} : { rawInput: patch.rawInput }),
    ...(patch.rawOutput === undefined ? {} : { rawOutput: patch.rawOutput })
  })

  const announce = (patch: ToolCallPatch): Updates => {
    const update = toolCall(patch)
    if (announced.has(update.toolCallId)) return [{ sessionUpdate: "tool_call_update", ...update }]
    announced.add(update.toolCallId)
    return [{
      sessionUpdate: "tool_call",
      toolCallId: update.toolCallId,
      title: update.title ?? update.name ?? "Tool call",
      ...(update.name === undefined || update.name === null ? {} : { name: update.name }),
      ...(update.kind === undefined || update.kind === null ? {} : { kind: update.kind }),
      status: update.status ?? "pending",
      ...(update.content === undefined || update.content === null ? {} : { content: update.content }),
      ...(update.locations === undefined || update.locations === null ? {} : { locations: update.locations }),
      ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
      ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput })
    }]
  }

  const project = SessionEvent.match({
    UserMessage: (): Updates => [],
    State: (): Updates => [],
    UserMessageChunk: (
      e
    ): Updates => [{ sessionUpdate: "user_message_chunk", content: e.content, messageId: e.messageId }],
    AgentMessageChunk: (
      e
    ): Updates => [{ sessionUpdate: "agent_message_chunk", content: e.content, messageId: e.messageId }],
    AgentThoughtChunk: (
      e
    ): Updates => [{ sessionUpdate: "agent_thought_chunk", content: e.content, messageId: e.messageId }],
    ToolCall: (e): Updates => announce(e.patch),
    Terminal: (e): Updates => {
      const previous = terminals.get(e.terminalId)
      terminals.set(e.terminalId, {
        command: e.command ?? previous?.command ?? "",
        output: e.output ?? previous?.output ?? "",
        exitCode: e.exitCode === undefined ? previous?.exitCode : e.exitCode
      })
      if (!announced.has(e.terminalId) || e.output === undefined) return []
      return [{ sessionUpdate: "tool_call_update", toolCallId: e.terminalId, content: [renderTerminal(e.terminalId)] }]
    },
    Plan: (e): Updates => [{
      sessionUpdate: "plan",
      entries: e.entries.map((entry) => ({
        content: entry.content,
        priority: entry.priority,
        status: entry.status === "cancelled" ? "completed" : entry.status
      }))
    }],
    AvailableCommands: (e): Updates => [{
      sessionUpdate: "available_commands_update",
      availableCommands: e.commands.map((c) => ({
        name: c.name,
        description: c.description,
        ...(c.hint === undefined ? {} : { input: { hint: c.hint } })
      }))
    }],
    ConfigOptions: (
      e
    ): Updates => [{ sessionUpdate: "config_option_update", configOptions: e.options.map(configOption) }],
    SessionInfo: (e): Updates => [{
      sessionUpdate: "session_info_update",
      ...(e.title === undefined ? {} : { title: e.title }),
      ...(e.updatedAt === undefined ? {} : { updatedAt: e.updatedAt })
    }],
    Usage: (e): Updates => [{ sessionUpdate: "usage_update", used: e.used, size: e.size }],
    Notice: (e): Updates =>
      features.notices
        ? [{
          sessionUpdate: "notice",
          severity: e.severity,
          title: e.title,
          ...(e.description === undefined ? {} : { description: e.description })
        }]
        : []
  })

  return { project, toolCall }
}

export const makeProjector = (features: ClientFeatures): ProjectorV1 => {
  const turns = new Map<string, TurnProjector>()
  /** The last mode reported per session (the initial one travels in the session response). */
  const modes = new Map<string, string>()

  const turnOf = (sessionId: string) => {
    const existing = turns.get(sessionId)
    if (existing !== undefined) return existing
    const created = makeTurnProjector(features)
    turns.set(sessionId, created)
    return created
  }

  return {
    project: (sessionId, event) => {
      const updates = turnOf(sessionId).project(event)
      // Nothing refers back to a finished turn's tool calls, so its state is dropped.
      if (event._tag === "State" && event.state === "idle") turns.delete(sessionId)
      if (event._tag !== "ConfigOptions") return updates
      const mode = event.options.find((o) => o.category === "mode")?.currentValue
      if (mode === undefined || modes.get(sessionId) === mode) return updates
      modes.set(sessionId, mode)
      return [...updates, { sessionUpdate: "current_mode_update", currentModeId: mode }]
    },
    toolCall: (sessionId, patch) => turnOf(sessionId).toolCall(patch)
  }
}

/** `session/request_permission` params for v1. */
export const permissionParams = (projector: ProjectorV1, sessionId: string, request: PermissionRequest) => ({
  sessionId,
  toolCall: projector.toolCall(sessionId, request.toolCall),
  options: request.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
})
