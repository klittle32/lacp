/**
 * An MCP server the ACP client asked the agent to connect to, independent of
 * the ACP version it arrived in.
 */
import { Schema } from "effect"

export const McpServerConfig = Schema.TaggedUnion({
  Stdio: {
    name: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String)
  },
  Http: {
    name: Schema.String,
    url: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String)
  }
})
export type McpServerConfig = typeof McpServerConfig.Type

export class McpError extends Schema.TaggedError<McpError, { readonly brand: unique symbol }>()("McpError", {
  server: Schema.String,
  message: Schema.String
}) {}
