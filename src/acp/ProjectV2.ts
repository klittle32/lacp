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
  type SelectChoice,
  SessionEvent,
  type ToolCallPatch,
  ToolContent
} from "../domain/Events.ts"
import type * as V2 from "./V2.ts"

type Updates = ReadonlyArray<V2.SessionUpdate>

const configOption = (option: ConfigOption, choices: ReadonlyArray<SelectChoice>): V2.SessionConfigOption => ({
  type: "select",
  configId: option.id,
  name: option.name,
  description: option.description,
  category: option.category,
  currentValue: option.currentValue,
  options: choices.map((o) => ({ value: o.value, name: o.name, description: o.description }))
})

/**
 * The config options that apply to the session (those with choices). A
 * client that shows one session's options for all models gets every model's
 * choices where an option has them.
 */
export const configOptions = (
  options: ReadonlyArray<ConfigOption>,
  everyModel: boolean
): Array<V2.SessionConfigOption> =>
  options.flatMap((option) => {
    const choices = everyModel ? option.everyModelOptions ?? option.options : option.options
    return choices.length > 0 ? [configOption(option, choices)] : []
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
  name: patch.name,
  title: patch.title,
  kind: patch.kind,
  status: patch.status,
  content: patch.content?.map(content),
  locations: patch.locations,
  rawInput: patch.rawInput,
  rawOutput: patch.rawOutput
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
      ? [{ sessionUpdate: "state_update", state: "idle", stopReason: e.stopReason, error: e.error }]
      : [{ sessionUpdate: "state_update", state: e.state }],
  Terminal: (e): Updates => [{
    sessionUpdate: "terminal_update",
    terminalId: e.terminalId,
    command: e.command,
    cwd: e.cwd,
    output: e.output === undefined ? undefined : { data: Base64.encode(e.output) },
    exitStatus: e.exitCode === undefined ? undefined : { exitCode: e.exitCode }
  }],
  Plan: (
    e
  ): Updates => [{ sessionUpdate: "plan_update", plan: { type: "items", planId: e.planId, entries: e.entries } }],
  AvailableCommands: (e): Updates => [{
    sessionUpdate: "available_commands_update",
    availableCommands: e.commands.map((c) => ({
      name: c.name,
      description: c.description,
      input: c.hint === undefined ? undefined : { type: "text" as const, hint: c.hint }
    }))
  }],
  ConfigOptions: (
    e
  ): Updates => [{ sessionUpdate: "config_option_update", configOptions: configOptions(e.options, false) }],
  SessionInfo: (e): Updates => [{ sessionUpdate: "session_info_update", title: e.title, updatedAt: e.updatedAt }],
  Usage: (e): Updates => [{ sessionUpdate: "usage_update", used: e.used, size: e.size }],
  Notice: (
    e
  ): Updates => [{ sessionUpdate: "notice", severity: e.severity, title: e.title, description: e.description }]
})

export interface ProjectorV2 {
  readonly project: (event: SessionEvent) => Updates
}

export interface ProjectorFeatures {
  /** Send prompts back as `user_message`. */
  readonly echoPrompts: boolean
  /** The client presents `notice` updates; otherwise each notice becomes a finished tool call. */
  readonly notices: boolean
  /** Keeps the ids of those tool calls unique beyond this connection: clients keep tool calls per thread. */
  readonly noticeIdPrefix: string
  /** The client shows one session's config options for all models (see `configOptions`). */
  readonly everyModelOptions: boolean
}

/** A notice as a finished tool call, which every client shows. */
const noticeToolCall = (toolCallId: string, notice: Extract<SessionEvent, { readonly _tag: "Notice" }>): Updates => [{
  sessionUpdate: "tool_call_update",
  toolCallId,
  title: notice.title,
  kind: "other",
  status: notice.severity === "error" ? "failed" : "completed",
  content: notice.description === undefined
    ? undefined
    : [{ type: "content", content: { type: "text", text: notice.description } }]
}]

/** Projects events for one connection. */
export const makeProjector = (features: ProjectorFeatures): ProjectorV2 => {
  let notices = 0
  return {
    project: (event) => {
      if (event._tag === "UserMessage" && !features.echoPrompts) return []
      if (event._tag === "ConfigOptions") {
        return [{
          sessionUpdate: "config_option_update",
          configOptions: configOptions(event.options, features.everyModelOptions)
        }]
      }
      if (event._tag === "Notice" && !features.notices) {
        notices += 1
        return noticeToolCall(`${features.noticeIdPrefix}-${notices}`, event)
      }
      return project(event)
    }
  }
}

/** `session/request_permission` params for v2. */
export const permissionParams = (sessionId: string, request: PermissionRequest) => ({
  sessionId,
  title: request.title,
  subject: { type: "tool_call" as const, toolCall: toolCall(request.toolCall) },
  options: request.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
})
