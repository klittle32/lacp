/**
 * MCP transports, as JSON-RPC {@link Transport}s so the MCP client can reuse
 * the same peer as the ACP connection.
 *
 * - stdio: the server is a child process speaking newline-delimited JSON-RPC.
 * - Streamable HTTP: each message is POSTed; the reply is JSON or an SSE stream.
 *   Server-initiated messages arrive on an optional GET event stream.
 */
import { type Cause, Effect, FiberSet, Option, Queue, Schema, type Scope, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { LineJson, RequestId } from "../jsonrpc/JsonRpc.ts"
import { Transport } from "../jsonrpc/Transport.ts"
import { McpError, type McpServerConfig } from "./Config.ts"

export interface OpenTransport {
  readonly transport: Transport["Service"]
  /** Called once the protocol version is negotiated. */
  readonly initialized: (protocolVersion: string) => Effect.Effect<void>
}

type Stdio = Extract<McpServerConfig, { readonly _tag: "Stdio" }>
type Http = Extract<McpServerConfig, { readonly _tag: "Http" }>

const lines = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.splitLines, Stream.filter((line) => line.trim() !== ""))

/** Spawns a stdio MCP server in `cwd`; it is stopped when the scope closes. */
export const stdio = Effect.fnUntraced(function*(config: Stdio, cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const encoder = new TextEncoder()
  const handle = yield* spawner.spawn(
    ChildProcess.make(config.command, config.args, {
      cwd,
      env: config.env,
      extendEnv: true,
      stdin: { stream: Stream.fromQueue(stdin), endOnDone: true },
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: "2 seconds"
    })
  ).pipe(
    Effect.mapError((error) =>
      new McpError({ server: config.name, message: `Failed to start ${config.command}: ${error.message}` })
    )
  )
  yield* lines(handle.stderr).pipe(
    Stream.runForEach((line) => Effect.logDebug(`[mcp:${config.name}] ${line}`)),
    Effect.ignore,
    Effect.forkScoped
  )
  // Close stdin first so the server can exit cleanly before it is killed.
  yield* Effect.addFinalizer(() => Queue.end(stdin))
  const open: OpenTransport = {
    transport: Transport.of({
      incoming: lines(handle.stdout).pipe(
        Stream.catchCause((cause) =>
          Stream.fromEffect(Effect.logDebug(`[mcp:${config.name}] stdout closed`, cause)).pipe(Stream.drain)
        )
      ),
      send: (line) => Queue.offer(stdin, encoder.encode(`${line}\n`)).pipe(Effect.asVoid)
    }),
    initialized: () => Effect.void
  }
  return open
})

const decodeRequestId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: RequestId, method: Schema.String }))
)
const encodeJson = Schema.encodeEffect(LineJson)

/** Connects to a Streamable HTTP MCP endpoint. */
export const http = Effect.fnUntraced(function*(config: Http): Effect.fn.Return<
  OpenTransport,
  never,
  HttpClient.HttpClient | Scope.Scope
> {
  const client = yield* HttpClient.HttpClient
  const incoming = yield* Queue.unbounded<string, Cause.Done>()
  const fibers = yield* FiberSet.make()
  let sessionId: string | undefined
  let protocolVersion: string | undefined

  const headers = (accept: string) => ({
    ...config.headers,
    accept,
    "mcp-session-id": sessionId,
    "mcp-protocol-version": protocolVersion
  })

  const remember = (response: HttpClientResponse.HttpClientResponse) => {
    const id = response.headers["mcp-session-id"]
    if (id !== undefined && id !== "") sessionId = id
  }

  /** Feeds each SSE `data` payload to the peer as one message. */
  const readEvents = (response: HttpClientResponse.HttpClientResponse) =>
    response.stream.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decode()),
      Stream.runForEach((event) => (event.data.trim() === "" ? Effect.void : Queue.offer(incoming, event.data))),
      Effect.catch((error) => Effect.logDebug(`[mcp:${config.name}] event stream ended`, error))
    )

  /** A failed POST of a request still has to answer it, or the caller would wait forever. */
  const failRequest = (line: string, message: string) =>
    Option.match(decodeRequestId(line), {
      onNone: () => Effect.logWarning(`[mcp:${config.name}] ${message}`),
      onSome: ({ id }) =>
        encodeJson({ jsonrpc: "2.0", id, error: { code: -32603, message } }).pipe(
          Effect.flatMap((reply) => Queue.offer(incoming, reply)),
          Effect.ignore
        )
    })

  const post = Effect.fnUntraced(
    function*(line: string) {
      const response = yield* client.execute(
        HttpClientRequest.post(config.url).pipe(
          HttpClientRequest.setHeaders(headers("application/json, text/event-stream")),
          HttpClientRequest.bodyText(line, "application/json")
        )
      )
      remember(response)
      if (response.status === 202) return
      if (response.status >= 400) {
        const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        yield* failRequest(
          line,
          `HTTP ${response.status} from ${config.url}${body === "" ? "" : `: ${body.slice(0, 500)}`}`
        )
        return
      }
      const type = response.headers["content-type"] ?? ""
      if (type.includes("text/event-stream")) {
        yield* readEvents(response)
        return
      }
      const body = yield* response.text
      if (body.trim() !== "") yield* Queue.offer(incoming, body)
    },
    (effect, line) =>
      Effect.catch(effect, (error) => failRequest(line, `Request to ${config.url} failed: ${error.message}`))
  )

  /** The optional GET stream for server-initiated messages (405 means the server has none). */
  const listen = Effect.gen(function*() {
    const response = yield* client.execute(
      HttpClientRequest.get(config.url).pipe(HttpClientRequest.setHeaders(headers("text/event-stream")))
    )
    if (response.status !== 200) return
    yield* readEvents(response)
  }).pipe(Effect.ignore)

  yield* Effect.addFinalizer(() =>
    sessionId === undefined
      ? Effect.void
      : client.execute(HttpClientRequest.delete(config.url).pipe(HttpClientRequest.setHeaders(headers("*/*")))).pipe(
        Effect.timeoutOption("2 seconds"),
        Effect.ignore
      )
  )

  const open: OpenTransport = {
    transport: Transport.of({
      incoming: Stream.fromQueue(incoming),
      send: (line) => post(line).pipe(FiberSet.run(fibers), Effect.asVoid)
    }),
    initialized: (version) =>
      Effect.sync(() => {
        protocolVersion = version
      }).pipe(Effect.andThen(listen.pipe(FiberSet.run(fibers))), Effect.asVoid)
  }
  return open
})
