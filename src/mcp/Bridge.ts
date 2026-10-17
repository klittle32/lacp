/**
 * Bridges the MCP servers an ACP client provides into Letta Code as
 * controller-owned "external tools".
 *
 * Each session connects to its servers (concurrently, each in its own scope so
 * a failing server cannot leak or block the others), registers their tools with
 * the session's Letta runtime, and executes Letta's tool calls against them.
 */
import { Context, Effect, Exit, Layer, Match, Option, PubSub, Schema, Scope, Semaphore, Stream } from "effect"
import { HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import type { ToolKind } from "../acp/Content.ts"
import type { ExternalToolDefinition, ExternalToolResult } from "../letta/Protocol.ts"
import type { McpServerConfig } from "./Config.ts"
import { connect, type ConnectOptions, type McpConnection } from "./McpClient.ts"
import * as Mcp from "./Protocol.ts"

/** Letta waits at most this long (its maximum) for one tool call. */
const TOOL_TIMEOUT_MS = 300_000
const MAX_NAME = 64

export interface McpFailure {
  readonly server: string
  readonly message: string
}

export interface McpBridge {
  /** The Letta definitions of every bridged tool. */
  readonly tools: Effect.Effect<ReadonlyArray<ExternalToolDefinition>>
  /** How a bridged tool should be presented, by its Letta name. */
  readonly describe: (lettaName: string) => Option.Option<{ readonly title: string; readonly kind: ToolKind }>
  /** Executes a Letta tool call. Failures become error results. */
  call(lettaName: string, input: Readonly<Record<string, unknown>>): Effect.Effect<ExternalToolResult>
  /** Emits when any server's tool list changes. */
  readonly changes: Stream.Stream<void>
  readonly connected: ReadonlyArray<string>
  readonly failures: ReadonlyArray<McpFailure>
}

export const empty: McpBridge = {
  tools: Effect.succeed([]),
  describe: () => Option.none(),
  call: (name) => Effect.succeed({ content: [{ type: "text", text: `Unknown tool: ${name}` }], is_error: true }),
  changes: Stream.empty,
  connected: [],
  failures: []
}

/** FNV-1a, for short stable suffixes on over-long names. */
const hash = (text: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

const sanitize = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "_")

/** `mcp__<server>__<tool>`, restricted to the characters and length model APIs accept. */
export const lettaToolName = (server: string, tool: string) => {
  const name = `mcp__${sanitize(server)}__${sanitize(tool)}`
  return name.length <= MAX_NAME ? name : `${name.slice(0, MAX_NAME - 9)}_${hash(name).padStart(8, "0").slice(0, 8)}`
}

const decodeContent = Schema.decodeUnknownOption(Mcp.Content)
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

type LettaPart = ExternalToolResult["content"][number]

const part: (content: Mcp.Content) => LettaPart = Match.type<Mcp.Content>().pipe(
  Match.discriminatorsExhaustive("type")({
    text: (c): LettaPart => ({ type: "text", text: c.text }),
    image: (c): LettaPart => ({ type: "image", data: c.data, mimeType: c.mimeType }),
    audio: (c): LettaPart => ({ type: "text", text: `[audio (${c.mimeType}) omitted]` }),
    resource_link: (c): LettaPart => ({ type: "text", text: `${c.name ?? c.uri}: ${c.uri}` }),
    resource: (c): LettaPart => ({ type: "text", text: c.resource.text ?? `[binary resource ${c.resource.uri}]` })
  })
)

/** Converts an MCP tool result into Letta's external tool result. */
export const toLettaResult = (result: Mcp.CallToolResult): ExternalToolResult => {
  const content = result.content.map((item) =>
    Option.match(decodeContent(item), {
      onNone: (): LettaPart => ({ type: "text", text: encodeJson(item) }),
      onSome: part
    })
  )
  if (content.length === 0 && result.structuredContent !== undefined) {
    content.push({ type: "text", text: encodeJson(result.structuredContent) })
  }
  return { content, ...(result.isError === true ? { is_error: true } : {}) }
}

interface Entry {
  readonly connection: McpConnection
  readonly tool: Mcp.Tool
}

/** Connects to `servers` within the current scope. Unreachable servers are reported, not fatal. */
export const connectAll = Effect.fnUntraced(function*(
  servers: ReadonlyArray<McpServerConfig>,
  options: ConnectOptions
): Effect.fn.Return<McpBridge, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient> {
  if (servers.length === 0) return empty
  const parent = yield* Effect.scope
  const results = yield* Effect.forEach(
    servers,
    (server) =>
      Effect.gen(function*() {
        const scope = yield* Scope.fork(parent)
        return yield* connect(server, options).pipe(
          Scope.provide(scope),
          Effect.timeoutOrElse({
            duration: options.timeout ?? "30 seconds",
            orElse: () => Effect.fail({ server: server.name, message: "timed out connecting" })
          }),
          Effect.onError(() => Scope.close(scope, Exit.void)),
          Effect.result
        )
      }),
    { concurrency: "unbounded" }
  )
  const connections = results.flatMap((r) => (r._tag === "Success" ? [r.success] : []))
  const failures = results.flatMap((r): Array<McpFailure> =>
    r._tag === "Failure" ? [{ server: r.failure.server, message: r.failure.message }] : []
  )
  for (const failure of failures) yield* Effect.logWarning(`MCP server ${failure.server}: ${failure.message}`)

  let entries = new Map<string, Entry>()
  // Servers change their tools independently; one rebuild at a time keeps the last one current.
  const rebuildLock = yield* Semaphore.make(1)
  const rebuild = Semaphore.withPermits(rebuildLock, 1)(Effect.gen(function*() {
    const next = new Map<string, Entry>()
    for (const connection of connections) {
      for (const tool of yield* connection.tools) {
        let name = lettaToolName(connection.server.name, tool.name)
        if (next.has(name)) name = lettaToolName(connection.server.name, `${tool.name}_${hash(connection.server.name)}`)
        next.set(name, { connection, tool })
      }
    }
    entries = next
  }))
  yield* rebuild

  const changes = yield* PubSub.unbounded<void>()
  for (const connection of connections) {
    const subscription = yield* connection.changes
    yield* PubSub.take(subscription).pipe(
      Effect.andThen(rebuild),
      Effect.andThen(PubSub.publish(changes, undefined)),
      Effect.forever,
      Effect.forkScoped
    )
  }

  const definition = (name: string, { connection, tool }: Entry): ExternalToolDefinition => {
    const title = tool.title ?? tool.annotations?.title
    return {
      name,
      label: title === undefined ? `${connection.server.name}: ${tool.name}` : `${connection.server.name}: ${title}`,
      description: `${
        tool.description ?? title ?? tool.name
      } (MCP tool \`${tool.name}\` from the editor's \`${connection.server.name}\` server)`,
      parameters: tool.inputSchema["type"] === undefined ? { type: "object", ...tool.inputSchema } : tool.inputSchema,
      timeout_ms: TOOL_TIMEOUT_MS,
      auto_background: false
    }
  }

  return {
    tools: Effect.sync(() => Array.from(entries, ([name, entry]) => definition(name, entry))),
    describe: (name) =>
      Option.map(Option.fromUndefinedOr(entries.get(name)), ({ connection, tool }) => ({
        title: `${connection.server.name}: ${tool.title ?? tool.annotations?.title ?? tool.name}`,
        kind: tool.annotations?.readOnlyHint === true ? "read" : "other"
      })),
    call: (name, input) =>
      Effect.suspend(() => {
        const entry = entries.get(name)
        if (entry === undefined) return empty.call(name, input)
        return entry.connection.callTool(entry.tool.name, input, TOOL_TIMEOUT_MS - 5_000).pipe(
          Effect.map(toLettaResult),
          Effect.catch((error) =>
            Effect.succeed<ExternalToolResult>({
              content: [{ type: "text", text: `MCP error from ${error.server}: ${error.message}` }],
              is_error: true
            })
          )
        )
      }),
    changes: Stream.fromPubSub(changes),
    connected: connections.map((c) => c.server.name),
    failures
  } satisfies McpBridge
})

/** Connects the MCP servers an ACP client provides to a session, as a {@link McpBridge}. */
export class McpBridges extends Context.Service<McpBridges, {
  /** Connects `servers` for as long as the current scope stays open. */
  connectAll(
    servers: ReadonlyArray<McpServerConfig>,
    options: ConnectOptions
  ): Effect.Effect<McpBridge, never, Scope.Scope>
}>()("lacp/mcp/McpBridges") {
  static readonly layer = Layer.effect(
    McpBridges,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const httpClient = yield* HttpClient.HttpClient
      return McpBridges.of({
        connectAll: (servers, options) =>
          connectAll(servers, options).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HttpClient.HttpClient, httpClient)
          )
      })
    })
  )
}
