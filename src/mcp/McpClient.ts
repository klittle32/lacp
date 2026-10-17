/**
 * A Model Context Protocol client connection: initialization, tool discovery
 * (with pagination and `list_changed`), and tool calls.
 */
import { type Duration, Effect, Option, PubSub, Ref, type Scope, Stream } from "effect"
import type { HttpClient } from "effect/http"
import type { ChildProcessSpawner } from "effect/process"
import type { RpcError } from "../jsonrpc/JsonRpc.ts"
import * as Method from "../jsonrpc/Method.ts"
import { makePeer, McpCancelled } from "../jsonrpc/Peer.ts"
import { Transport } from "../jsonrpc/Transport.ts"
import { McpError, type McpServerConfig } from "./Config.ts"
import * as Mcp from "./Protocol.ts"
import * as Transports from "./Transports.ts"

export interface McpConnection {
  readonly server: McpServerConfig
  readonly info: Mcp.InitializeResult
  /** The server's current tools. */
  readonly tools: Effect.Effect<ReadonlyArray<Mcp.Tool>>
  /** Every refreshed tool list, after `notifications/tools/list_changed`. */
  readonly changes: Effect.Effect<PubSub.Subscription<ReadonlyArray<Mcp.Tool>>, never, Scope.Scope>
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    timeout: Duration.Input
  ): Effect.Effect<Mcp.CallToolResult, McpError>
}

export interface ConnectOptions {
  /** Workspace roots offered through `roots/list` (absolute paths). */
  readonly roots: ReadonlyArray<string>
  readonly clientInfo: { readonly name: string; readonly version: string; readonly title?: string }
  readonly timeout?: Duration.Input
}

const MAX_PAGES = 50

const fileUri = (path: string) => `file://${encodeURI(path.startsWith("/") ? path : `/${path.replaceAll("\\", "/")}`)}`

/** Connects to one MCP server inside the current scope. */
export const connect = Effect.fnUntraced(function*(server: McpServerConfig, options: ConnectOptions): Effect.fn.Return<
  McpConnection,
  McpError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> {
  const failure = (message: string) => new McpError({ server: server.name, message })
  const cwd = options.roots[0] ?? "/"
  const opened = server._tag === "Stdio" ? yield* Transports.stdio(server, cwd) : yield* Transports.http(server)
  const peer = yield* makePeer({ cancelMethod: McpCancelled.name, label: `mcp:${server.name}` }).pipe(
    Effect.provideService(Transport, opened.transport)
  )
  const scope = yield* Effect.scope
  const tools = yield* Ref.make<ReadonlyArray<Mcp.Tool>>([])
  const changes = yield* PubSub.unbounded<ReadonlyArray<Mcp.Tool>>()

  /** Every tool, from up to `MAX_PAGES` pages; each request's params carry the cursor of the page before. */
  const listAll = Stream.paginate<typeof Mcp.ListToolsParams.Type, ReadonlyArray<Mcp.Tool>, RpcError>(
    {},
    (params) =>
      peer.request(Mcp.ListTools, params, { timeout: "30 seconds" }).pipe(
        Effect.map((result) =>
          [
            [result.tools],
            Option.fromUndefinedOr(result.nextCursor).pipe(
              Option.filter((cursor) => cursor !== ""),
              Option.map((cursor) => ({ cursor }))
            )
          ] as const
        )
      )
  ).pipe(
    Stream.take(MAX_PAGES),
    Stream.runCollect,
    Effect.map((pages) => pages.flat()),
    Effect.mapError((error) => failure(`tools/list failed: ${error.message}`))
  )

  const refresh = listAll.pipe(
    Effect.tap((list) => Ref.set(tools, list)),
    Effect.tap((list) => PubSub.publish(changes, list)),
    Effect.tap((list) => Effect.logInfo(`MCP server ${server.name}: ${list.length} tool(s)`))
  )

  const dispatcher = Method.router([
    Method.handle(Mcp.Ping, () => Effect.succeed({})),
    Method.handle(Mcp.ListRoots, () =>
      Effect.succeed({
        roots: options.roots.map((root) => ({
          uri: fileUri(root),
          name: root.split(/[/\\]/).findLast((p) => p !== "") ?? root
        }))
      })),
    // A notification handler runs inline in the read loop, so a refresh (itself a
    // request awaiting a response from that loop) must be forked.
    Method.handleNotification(Mcp.ToolsListChanged, () =>
      refresh.pipe(
        Effect.catch((error) => Effect.logWarning(error.message)),
        Effect.forkIn(scope),
        Effect.asVoid
      )),
    Method.handleNotification(
      Mcp.LogMessage,
      (message) =>
        Effect.logDebug(
          `[mcp:${server.name}] ${message.level}: ${typeof message.data === "string" ? message.data : ""}`
        )
    )
  ])
  yield* Effect.forkScoped(peer.serve(dispatcher))

  const info = yield* peer.request(
    Mcp.Initialize,
    {
      protocolVersion: Mcp.LATEST_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: options.clientInfo
    },
    { timeout: options.timeout ?? "30 seconds" }
  ).pipe(Effect.mapError((error) => failure(`initialize failed: ${error.message}`)))
  if (!Mcp.SUPPORTED_PROTOCOL_VERSIONS.includes(info.protocolVersion)) {
    return yield* failure(`unsupported MCP protocol version ${info.protocolVersion}`)
  }
  yield* opened.initialized(info.protocolVersion)
  yield* peer.notify(Mcp.Initialized, {})
  if (info.capabilities.tools !== undefined) yield* refresh

  return {
    server,
    info,
    tools: Ref.get(tools),
    changes: PubSub.subscribe(changes),
    callTool: (name, args, timeout) =>
      peer.request(Mcp.CallTool, { name, arguments: args }, { timeout }).pipe(
        Effect.mapError((error) => failure(error.message))
      )
  } satisfies McpConnection
})
