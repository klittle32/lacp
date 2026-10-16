/**
 * Projects version-neutral session events onto ACP v2 wire shapes.
 *
 * The domain model is already v2-shaped, so this is mostly a renaming: tool
 * calls are `tool_call_update` upserts, terminals are agent-owned displays,
 * diffs carry structured changes plus a `git_patch`, and the foreground state
 * machine is reported with `state_update`.
 */
import { Base64 } from "effect/encoding"
import {
  type ConfigOption,
  type DiffHunk,
  type PermissionRequest,
  SessionEvent,
  type ToolCallPatch,
  ToolContent
} from "../domain/Events.ts"
import type * as V2 from "./V2.ts"

type Updates = ReadonlyArray<V2.SessionUpdate>

export const configOption = (option: ConfigOption): V2.SessionConfigOption => ({
  type: "select",
  configId: option.id,
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

const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"))

/**
 * A `git_patch` for one file: absolute paths, no `a/`/`b/` prefixes. Without
 * Letta-provided hunks, the old and new snippets become a single hunk.
 */
export const gitPatch = (path: string, oldText: string | null, newText: string, hunks?: ReadonlyArray<DiffHunk>) => {
  const header = [`diff --git ${path} ${path}`, `--- ${oldText === null ? "/dev/null" : path}`, `+++ ${path}`]
  const body = hunks !== undefined && hunks.length > 0
    ? hunks.flatMap((h) => [
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      ...h.lines.map((l) => `${l.type === "add" ? "+" : l.type === "remove" ? "-" : " "}${l.content}`)
    ])
    : (() => {
      const before = oldText === null ? [] : lines(oldText)
      const after = lines(newText)
      return [
        `@@ -${before.length === 0 ? 0 : 1},${before.length} +${after.length === 0 ? 0 : 1},${after.length} @@`,
        ...before.map((l) => `-${l}`),
        ...after.map((l) => `+${l}`)
      ]
    })()
  return [...header, ...body].join("\n") + "\n"
}

const content = ToolContent.match({
  Content: (item): V2.ToolCallContent => ({ type: "content", content: item.content }),
  Diff: (item): V2.ToolCallContent => ({
    type: "diff",
    changes: [{ operation: item.oldText === null ? "add" : "modify", path: item.path, fileType: "text" }],
    patch: { format: "git_patch", text: gitPatch(item.path, item.oldText, item.newText, item.hunks) }
  }),
  Terminal: (item): V2.ToolCallContent => ({ type: "terminal", terminalId: item.terminalId })
})

export const toolCall = (patch: ToolCallPatch): V2.ToolCallUpdate => ({
  toolCallId: patch.toolCallId,
  ...(patch.name === undefined ? {} : { name: patch.name }),
  ...(patch.title === undefined ? {} : { title: patch.title }),
  ...(patch.kind === undefined ? {} : { kind: patch.kind }),
  ...(patch.status === undefined ? {} : { status: patch.status }),
  ...(patch.content === undefined ? {} : { content: patch.content.map(content) }),
  ...(patch.locations === undefined ? {} : { locations: patch.locations }),
  ...(patch.rawInput === undefined ? {} : { rawInput: patch.rawInput }),
  ...(patch.rawOutput === undefined ? {} : { rawOutput: patch.rawOutput })
})

export const project = SessionEvent.match({
  UserMessage: (e): Updates => [{ sessionUpdate: "user_message", messageId: e.messageId, content: e.content }],
  UserMessageChunk: (
    e
  ): Updates => [{ sessionUpdate: "user_message_chunk", messageId: e.messageId, content: e.content }],
  AgentMessageChunk: (
    e
  ): Updates => [{ sessionUpdate: "agent_message_chunk", messageId: e.messageId, content: e.content }],
  AgentThoughtChunk: (
    e
  ): Updates => [{ sessionUpdate: "agent_thought_chunk", messageId: e.messageId, content: e.content }],
  ToolCall: (e): Updates => [{ sessionUpdate: "tool_call_update", ...toolCall(e.patch) }],
  State: (e): Updates =>
    e.state === "idle"
      ? [{
        sessionUpdate: "state_update",
        state: "idle",
        ...(e.stopReason === undefined ? {} : { stopReason: e.stopReason }),
        ...(e.error === undefined ? {} : { error: e.error })
      }]
      : [{ sessionUpdate: "state_update", state: e.state }],
  Terminal: (e): Updates => [{
    sessionUpdate: "terminal_update",
    terminalId: e.terminalId,
    ...(e.command === undefined ? {} : { command: e.command }),
    ...(e.cwd === undefined ? {} : { cwd: e.cwd }),
    ...(e.output === undefined ? {} : { output: { data: Base64.encode(e.output) } }),
    ...(e.exitCode === undefined ? {} : { exitStatus: { exitCode: e.exitCode } })
  }],
  Plan: (
    e
  ): Updates => [{ sessionUpdate: "plan_update", plan: { type: "items", planId: e.planId, entries: e.entries } }],
  AvailableCommands: (e): Updates => [{
    sessionUpdate: "available_commands_update",
    availableCommands: e.commands.map((c) => ({
      name: c.name,
      description: c.description,
      ...(c.hint === undefined ? {} : { input: { type: "text" as const, hint: c.hint } })
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
  Notice: (e): Updates => [{
    sessionUpdate: "notice",
    severity: e.severity,
    title: e.title,
    ...(e.description === undefined ? {} : { description: e.description })
  }]
})

export interface ProjectorV2 {
  readonly project: (event: SessionEvent) => Updates
}

/** Projects events for one connection; without `echoPrompts`, prompts are not sent back as `user_message`. */
export const makeProjector = (features: { readonly echoPrompts: boolean }): ProjectorV2 => ({
  project: (event) => event._tag === "UserMessage" && !features.echoPrompts ? [] : project(event)
})

/** `session/request_permission` params for v2. */
export const permissionParams = (sessionId: string, request: PermissionRequest) => ({
  sessionId,
  title: request.title,
  subject: { type: "tool_call" as const, toolCall: toolCall(request.toolCall) },
  options: request.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
})
