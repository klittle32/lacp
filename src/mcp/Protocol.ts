/**
 * The Model Context Protocol (client side), as far as this bridge needs it:
 * lifecycle, tools, and the few server-to-client requests a client must answer.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25
 */
import { Schema } from "effect"
import { notification, request } from "../jsonrpc/Method.ts"

export const LATEST_PROTOCOL_VERSION = "2025-11-25"
export const SUPPORTED_PROTOCOL_VERSIONS: ReadonlyArray<string> = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]

const opt = Schema.optionalKey
const Meta = opt(Schema.Record(Schema.String, Schema.Unknown))

export const Implementation = Schema.Struct({
  name: Schema.String,
  title: opt(Schema.String),
  version: Schema.String
})

export const InitializeParams = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.Struct({
    roots: opt(Schema.Struct({ listChanged: opt(Schema.Boolean) }))
  }),
  clientInfo: Implementation
})

export const InitializeResult = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.Struct({
    tools: opt(Schema.Struct({ listChanged: opt(Schema.Boolean) }))
  }),
  serverInfo: Schema.Struct({ name: Schema.String, version: opt(Schema.String), title: opt(Schema.String) }),
  instructions: opt(Schema.String)
})
export type InitializeResult = typeof InitializeResult.Type

export const ToolAnnotations = Schema.Struct({
  title: opt(Schema.String),
  readOnlyHint: opt(Schema.Boolean),
  destructiveHint: opt(Schema.Boolean),
  idempotentHint: opt(Schema.Boolean),
  openWorldHint: opt(Schema.Boolean)
})

export const Tool = Schema.Struct({
  name: Schema.String,
  title: opt(Schema.String),
  description: opt(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  annotations: opt(ToolAnnotations),
  _meta: Meta
})
export type Tool = typeof Tool.Type

export const ListToolsParams = Schema.Struct({ cursor: opt(Schema.String) })

export const ListToolsResult = Schema.Struct({
  tools: Schema.Array(Tool),
  nextCursor: opt(Schema.String)
})

export const CallToolParams = Schema.Struct({
  name: Schema.String,
  arguments: opt(Schema.Record(Schema.String, Schema.Unknown))
})

export const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
export const ImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String
})
export const AudioContent = Schema.Struct({
  type: Schema.Literal("audio"),
  data: Schema.String,
  mimeType: Schema.String
})
export const ResourceLink = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: opt(Schema.String),
  description: opt(Schema.String)
})
export const EmbeddedResource = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: Schema.Struct({
    uri: Schema.String,
    mimeType: opt(Schema.String),
    text: opt(Schema.String),
    blob: opt(Schema.String)
  })
})

export const Content = Schema.Union([TextContent, ImageContent, AudioContent, ResourceLink, EmbeddedResource])
export type Content = typeof Content.Type

export const CallToolResult = Schema.Struct({
  // Unknown content types are kept as-is and rendered generically.
  content: Schema.Array(Schema.Unknown),
  structuredContent: opt(Schema.Unknown),
  isError: opt(Schema.Boolean)
})
export type CallToolResult = typeof CallToolResult.Type

export const Root = Schema.Struct({ uri: Schema.String, name: opt(Schema.String) })

// --- methods (client -> server) ---

export const Initialize = request("initialize", InitializeParams, InitializeResult)
export const Initialized = notification("notifications/initialized", Schema.Struct({}))
export const ListTools = request("tools/list", ListToolsParams, ListToolsResult)
export const CallTool = request("tools/call", CallToolParams, CallToolResult)

// --- methods (server -> client) ---

export const Ping = request("ping", Schema.Struct({}), Schema.Struct({}))
export const ListRoots = request("roots/list", Schema.Struct({}), Schema.Struct({ roots: Schema.Array(Root) }))
export const ToolsListChanged = notification("notifications/tools/list_changed", Schema.Struct({}))
export const LogMessage = notification(
  "notifications/message",
  Schema.Struct({ level: Schema.String, logger: opt(Schema.String), data: opt(Schema.Unknown) })
)
