/**
 * The version-neutral session model.
 *
 * The agent core speaks only these types. They are shaped after ACP v2
 * (entities with stable ids, upserts, an explicit foreground state machine),
 * and each protocol adapter projects them onto its wire format.
 */
import { Schema } from "effect"
import { ContentBlock, PermissionOptionKind, ToolKind } from "../acp/Content.ts"
import { opt, optNull } from "../SchemaUtil.ts"

export const StopReason = Schema.Literals([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
  "error"
])
export type StopReason = typeof StopReason.Type

export const ToolStatus = Schema.Literals(["pending", "in_progress", "completed", "failed", "cancelled"])
export type ToolStatus = typeof ToolStatus.Type

export const DiffHunk = Schema.Struct({
  oldStart: Schema.Int,
  oldLines: Schema.Int,
  newStart: Schema.Int,
  newLines: Schema.Int,
  lines: Schema.Array(Schema.Struct({
    type: Schema.Literals(["context", "add", "remove"]),
    content: Schema.String
  }))
})
export type DiffHunk = typeof DiffHunk.Type

export const ToolContent = Schema.TaggedUnion({
  Content: { content: ContentBlock },
  /** A file change. `oldText` is `null` for a new file. `hunks`, when present, describe the exact patch. */
  Diff: {
    path: Schema.String,
    oldText: Schema.NullOr(Schema.String),
    newText: Schema.String,
    hunks: opt(Schema.Array(DiffHunk))
  },
  Terminal: { terminalId: Schema.String }
})
export type ToolContent = typeof ToolContent.Type

export const Location = Schema.Struct({
  path: Schema.String,
  line: opt(Schema.Int)
})
export type Location = typeof Location.Type

/** A tool call upsert: omitted fields are unchanged; arrays replace. */
export const ToolCallPatch = Schema.Struct({
  toolCallId: Schema.String,
  name: opt(Schema.String),
  title: opt(Schema.String),
  kind: opt(ToolKind),
  status: opt(ToolStatus),
  content: opt(Schema.Array(ToolContent)),
  locations: opt(Schema.Array(Location)),
  rawInput: opt(Schema.Unknown),
  rawOutput: opt(Schema.Unknown)
})
export type ToolCallPatch = typeof ToolCallPatch.Type

export const PlanEntry = Schema.Struct({
  content: Schema.String,
  priority: Schema.Literals(["high", "medium", "low"]),
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"])
})
export type PlanEntry = typeof PlanEntry.Type

export const SelectChoice = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  description: opt(Schema.String)
})
export type SelectChoice = typeof SelectChoice.Type

/** A select-type session config option (the only kind this agent exposes). */
export const ConfigOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: opt(Schema.String),
  category: Schema.Literals(["mode", "model", "thought_level", "model_config"]),
  currentValue: Schema.String,
  /** The choices of the session's model; none means the option does not apply to it. */
  options: Schema.Array(SelectChoice),
  /**
   * The choices of every model, for clients that show one session's options
   * for all models (T3 Code).
   */
  everyModelOptions: opt(Schema.Array(SelectChoice))
})
export type ConfigOption = typeof ConfigOption.Type

export const Command = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  hint: opt(Schema.String)
})
export type Command = typeof Command.Type

export const ErrorInfo = Schema.Struct({ code: Schema.Int, message: Schema.String })
export type ErrorInfo = typeof ErrorInfo.Type

export const SessionEvent = Schema.TaggedUnion({
  /** A user prompt was inserted into the conversation (the live echo of `session/prompt`). */
  UserMessage: { messageId: Schema.String, content: Schema.Array(ContentBlock) },
  /** A fragment of a user message, as replayed from history. */
  UserMessageChunk: { messageId: Schema.String, content: ContentBlock },
  AgentMessageChunk: { messageId: Schema.String, content: ContentBlock },
  AgentThoughtChunk: { messageId: Schema.String, content: ContentBlock },
  ToolCall: { patch: ToolCallPatch },
  Plan: { planId: Schema.String, entries: Schema.Array(PlanEntry) },
  /** Foreground state. `idle` ends a turn (or agent-initiated work). */
  State: {
    state: Schema.Literals(["running", "requires_action", "idle"]),
    stopReason: opt(StopReason),
    error: opt(ErrorInfo)
  },
  /** An agent-owned, display-only terminal. `output` is the full output so far. */
  Terminal: {
    terminalId: Schema.String,
    command: opt(Schema.String),
    cwd: opt(Schema.String),
    output: opt(Schema.String),
    exitCode: optNull(Schema.Int)
  },
  AvailableCommands: { commands: Schema.Array(Command) },
  ConfigOptions: { options: Schema.Array(ConfigOption) },
  SessionInfo: { title: opt(Schema.String), updatedAt: opt(Schema.String) },
  Usage: { used: Schema.Int, size: Schema.Int },
  Notice: {
    severity: Schema.Literals(["info", "warning", "error"]),
    title: Schema.String,
    description: opt(Schema.String)
  }
})
export type SessionEvent = typeof SessionEvent.Type

export const PermissionChoice = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  kind: PermissionOptionKind
})
export type PermissionChoice = typeof PermissionChoice.Type

export const PermissionRequest = Schema.Struct({
  title: Schema.String,
  toolCall: ToolCallPatch,
  options: Schema.Array(PermissionChoice)
})
export type PermissionRequest = typeof PermissionRequest.Type

export const PermissionDecision = Schema.TaggedUnion({
  Selected: { optionId: Schema.String },
  Cancelled: {}
})
export type PermissionDecision = typeof PermissionDecision.Type
