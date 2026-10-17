/**
 * Converts the `mcpServers` of ACP session requests (v1 or v2 shapes) into
 * version-neutral MCP server configs. Entries that do not decode, or use the
 * unsupported SSE transport, are skipped with a warning.
 */
import { Effect, Option, Schema } from "effect"
import type { McpServerConfig } from "../mcp/Config.ts"
import * as V1 from "./V1.ts"
import * as V2 from "./V2.ts"

const record = (pairs: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined) =>
  Object.fromEntries((pairs ?? []).map((p) => [p.name, p.value]))

const decodeV1 = Schema.decodeUnknownOption(V1.McpServer)
const decodeV2 = Schema.decodeUnknownOption(V2.McpServer)

type Wire = typeof V1.McpServer.Type | typeof V2.McpServer.Type

const toConfig = (server: Wire): Option.Option<McpServerConfig> => {
  if ("command" in server) {
    return Option.some({
      _tag: "Stdio",
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      env: record(server.env)
    })
  }
  if (server.type === "sse") return Option.none()
  return Option.some({ _tag: "Http", name: server.name, url: server.url, headers: record(server.headers) })
}

export const fromWire = Effect.fnUntraced(function*(version: 1 | 2, servers: ReadonlyArray<unknown> | undefined) {
  const configs: Array<McpServerConfig> = []
  for (const raw of servers ?? []) {
    const config = Option.flatMap(version === 1 ? decodeV1(raw) : decodeV2(raw), toConfig)
    if (Option.isSome(config)) configs.push(config.value)
    else yield* Effect.logWarning("Skipping an MCP server the client offered: unsupported or malformed entry", raw)
  }
  return configs
})
