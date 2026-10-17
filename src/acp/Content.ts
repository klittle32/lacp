/**
 * ACP content blocks (MCP-compatible), shared by protocol v1 and v2.
 *
 * v2 only adds optional fields (`resource_link.icons`) and opens the `type`
 * discriminator, so one definition serves both versions.
 */
import { Schema } from "effect"
import { opt, optNull } from "../SchemaUtil.ts"

/** `_meta`: the reserved ACP extensibility slot. */
export const Meta = optNull(Schema.Record(Schema.String, Schema.Unknown))

export const Role = Schema.Literals(["assistant", "user"])

export const Annotations = Schema.Struct({
  audience: optNull(Schema.Array(Role)),
  lastModified: optNull(Schema.String),
  priority: optNull(Schema.Finite),
  _meta: Meta
})

export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  annotations: optNull(Annotations),
  _meta: Meta
})
export type TextContent = typeof TextContent.Type

export const ImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
  uri: optNull(Schema.String),
  annotations: optNull(Annotations),
  _meta: Meta
})
export type ImageContent = typeof ImageContent.Type

export const AudioContent = Schema.Struct({
  type: Schema.Literal("audio"),
  data: Schema.String,
  mimeType: Schema.String,
  annotations: optNull(Annotations),
  _meta: Meta
})

export const ResourceLink = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: Schema.String,
  title: optNull(Schema.String),
  description: optNull(Schema.String),
  mimeType: optNull(Schema.String),
  size: optNull(Schema.Int),
  annotations: optNull(Annotations),
  _meta: Meta
})
export type ResourceLink = typeof ResourceLink.Type

export const TextResourceContents = Schema.Struct({
  uri: Schema.String,
  text: Schema.String,
  mimeType: optNull(Schema.String),
  _meta: Meta
})

export const BlobResourceContents = Schema.Struct({
  uri: Schema.String,
  blob: Schema.String,
  mimeType: optNull(Schema.String),
  _meta: Meta
})

export const EmbeddedResource = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: Schema.Union([TextResourceContents, BlobResourceContents]),
  annotations: optNull(Annotations),
  _meta: Meta
})
export type EmbeddedResource = typeof EmbeddedResource.Type

export const ContentBlock = Schema.Union([TextContent, ImageContent, AudioContent, ResourceLink, EmbeddedResource])
export type ContentBlock = typeof ContentBlock.Type

export const text = (value: string): TextContent => ({ type: "text", text: value })

export const Implementation = Schema.Struct({
  name: Schema.String,
  title: optNull(Schema.String),
  version: Schema.String,
  _meta: Meta
})
export type Implementation = typeof Implementation.Type

export const EnvVariable = Schema.Struct({ name: Schema.String, value: Schema.String, _meta: Meta })

export const ToolKind = Schema.Literals([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other"
])
export type ToolKind = typeof ToolKind.Type

export const ToolCallLocation = Schema.Struct({
  path: Schema.String,
  line: optNull(Schema.Int),
  _meta: Meta
})
export type ToolCallLocation = typeof ToolCallLocation.Type

export const PermissionOptionKind = Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"])
export type PermissionOptionKind = typeof PermissionOptionKind.Type

export const PermissionOption = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  kind: PermissionOptionKind,
  _meta: Meta
})
export type PermissionOption = typeof PermissionOption.Type

/** The outcome of `session/request_permission`. Unknown outcomes never mean approval. */
export const PermissionOutcome = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("cancelled") }),
  Schema.Struct({ outcome: Schema.Literal("selected"), optionId: Schema.String }),
  Schema.Struct({ outcome: Schema.String })
])

export const RequestPermissionResponse = Schema.Struct({ outcome: PermissionOutcome, _meta: Meta })

export const PlanEntryPriority = Schema.Literals(["high", "medium", "low"])

export const AvailableCommandInput = Schema.Struct({ hint: Schema.String, _meta: Meta })

export const SessionInfo = Schema.Struct({
  sessionId: Schema.String,
  cwd: Schema.String,
  additionalDirectories: opt(Schema.Array(Schema.String)),
  title: optNull(Schema.String),
  updatedAt: optNull(Schema.String),
  _meta: Meta
})

export const ListSessionsRequest = Schema.Struct({
  cwd: optNull(Schema.String),
  cursor: optNull(Schema.String),
  _meta: Meta
})

export const ListSessionsResponse = Schema.Struct({
  sessions: Schema.Array(SessionInfo),
  nextCursor: optNull(Schema.String),
  _meta: Meta
})

export const SessionIdParams = Schema.Struct({ sessionId: Schema.String, _meta: Meta })

export const EmptyResponse = Schema.Struct({ _meta: Meta })

export const StopReasonV1 = Schema.Literals(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"])
export type StopReasonV1 = typeof StopReasonV1.Type

export const UsageCost = Schema.Struct({ amount: Schema.Finite, currency: Schema.String })
