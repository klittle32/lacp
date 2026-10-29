/**
 * The connection to a Letta Code App Server.
 *
 * By default the host's `letta` is started as `letta server --listen
 * ws://127.0.0.1:0` (one process for all ACP sessions) and spoken to over a
 * single loopback WebSocket. The server is started lazily, shared, and
 * restarted on the next use if it dies; sessions notice the new `generation`
 * and re-attach their runtimes.
 */
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Redacted,
  Schema,
  Scope,
  Stream,
  SynchronizedRef
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Socket from "effect/socket/Socket"
import { type AuthMode, LacpConfig } from "../Config.ts"
import { Host } from "../Host.ts"
import * as Pending from "../jsonrpc/Pending.ts"
import { LettaDisconnected, type LettaError, LettaRequestFailed, LettaStartFailed } from "./Errors.ts"
import { LettaExecutable, type LettaInstall, spawnable } from "./Executable.ts"
import * as Login from "./Login.ts"
import {
  AppServerInfo,
  type Command,
  CommandJson,
  FrameHeader,
  FrameJson,
  SUPPORTED_PROTOCOL_VERSION
} from "./Protocol.ts"

/** A frame from the App Server: its routing header plus the raw decoded JSON. */
export interface Frame {
  readonly header: FrameHeader
  readonly raw: unknown
}

/** Every `<command>_response` carries these. */
export interface Reply {
  readonly success?: boolean | undefined
  readonly error?: string | null | undefined
}

export interface CallOptions {
  readonly timeout?: Duration.Input | undefined
}

export interface LettaConnection {
  /** Increments every time a new App Server connection is established. */
  readonly generation: number
  readonly info: AppServerInfo
  /** Sends a command and awaits its `request_id`-correlated response. */
  call<A extends Reply, I>(
    make: (requestId: string) => Command,
    response: Schema.Codec<A, I>,
    options?: CallOptions
  ): Effect.Effect<A, LettaRequestFailed | LettaDisconnected>
  /** Sends a command without awaiting a response. */
  send(command: Command): Effect.Effect<void, LettaDisconnected>
  /** Subscribes to all frames that are not responses to `call`s. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<Frame>, never, Scope.Scope>
  readonly isAlive: Effect.Effect<boolean>
  /** Fails once the connection is lost. */
  readonly closed: Effect.Effect<never, LettaDisconnected>
}

/**
 * Environment variables a parent Letta session leaks to its children. They
 * would make the spawned App Server bind to someone else's agent or directory.
 */
const AMBIENT_LETTA_VARS: ReadonlySet<string> = new Set([
  "USER_CWD",
  "AGENT_ID",
  "LETTA_AGENT_ID",
  "CONVERSATION_ID",
  "LETTA_CONVERSATION_ID",
  "MEMORY_DIR",
  "LETTA_MEMORY_DIR",
  "LETTA_PARENT_AGENT_ID",
  "LETTA_CODE_AGENT_ROLE",
  "TRANSCRIPT_PATH"
])

/** Backend selection flags for each auth mode (`--backend` must precede `server`). */
const BACKEND_ARGS: Record<AuthMode, ReadonlyArray<string>> = {
  host: [],
  "cloud-oauth": ["--backend", "cloud"],
  "api-key": ["--backend", "cloud"],
  local: ["--backend", "local"]
}

const LISTEN_PATTERN = /WebSocket:\s+(wss?:\/\/\S+)/
const DEFAULT_CALL_TIMEOUT = Duration.seconds(60)

export class LettaAppServer extends Context.Service<LettaAppServer, {
  /** The live connection; starts the App Server on first use and after it dies. */
  readonly connection: Effect.Effect<LettaConnection, LettaError>
  /** Starts the App Server in the background so the first session is fast. */
  readonly warmup: Effect.Effect<void>
  /**
   * Runs a `letta` subcommand (e.g. `model list`) with the App Server's install,
   * runtime and environment, and returns its stdout. Unavailable when lacp
   * connects to an App Server it did not start.
   */
  cli(args: ReadonlyArray<string>): Effect.Effect<string, LettaRequestFailed>
}>()("lacp/letta/LettaAppServer") {
  static readonly layer = Layer.effect(
    LettaAppServer,
    Effect.gen(function*() {
      const host = yield* Host
      const config = yield* LacpConfig
      const executable = yield* LettaExecutable
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const webSocketConstructor = yield* Socket.WebSocketConstructor
      const layerScope = yield* Effect.scope
      const encodeCommand = Schema.encodeEffect(CommandJson)
      const decodeFrame = Schema.decodeUnknownEffect(FrameJson)
      const decodeHeader = Schema.decodeUnknownOption(FrameHeader)

      const childEnv = (): Record<string, string> => {
        const env: Record<string, string> = {}
        for (const [key, value] of Object.entries(host.env)) {
          if (value !== undefined && !AMBIENT_LETTA_VARS.has(key)) env[key] = value
        }
        if (config.auth === "api-key" && Option.isSome(config.apiKey)) {
          env["LETTA_API_KEY"] = Redacted.value(config.apiKey.value)
        }
        // Empty rather than removed: under Bun, Letta Code loads the project's `.env`
        // files, which never override a variable that is already set. Letta Code
        // treats an empty key as no key, so the stored login is used.
        if (config.auth === "cloud-oauth") env["LETTA_API_KEY"] = ""
        return env
      }

      /** Spawns `letta server --listen` and waits for its WebSocket URL. */
      const spawnServer = Effect.fnUntraced(
        function*(install: LettaInstall, pending: Pending.Pending<LettaDisconnected>) {
          const launch = spawnable(install, [...BACKEND_ARGS[config.auth], "server", "--listen", "ws://127.0.0.1:0"])
          yield* Effect.logInfo(`Starting Letta Code App Server: ${[launch.command, ...launch.args].join(" ")}`)
          const keyNote = Login.environmentKeyNote(config.auth, host.env)
          if (Option.isSome(keyNote)) yield* Effect.logInfo(keyNote.value)
          const handle = yield* spawner.spawn(
            ChildProcess.make(launch.command, launch.args, {
              cwd: host.cwd,
              env: childEnv(),
              extendEnv: false,
              shell: launch.shell,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
              forceKillAfter: "3 seconds"
            })
          ).pipe(
            Effect.mapError((cause) =>
              new LettaStartFailed({ message: `Failed to start ${install.command}: ${cause.message}` })
            )
          )

          const url = yield* Deferred.make<string>()
          const tail: Array<string> = []
          const remember = (line: string) => {
            tail.push(line)
            if (tail.length > 40) tail.shift()
          }
          const lines = (stream: Stream.Stream<Uint8Array, unknown>) =>
            stream.pipe(Stream.decodeText(), Stream.splitLines, Stream.filter((line) => line.trim() !== ""))

          yield* lines(handle.stdout).pipe(
            Stream.runForEach((line) => {
              remember(line)
              const match = LISTEN_PATTERN.exec(line)
              return match?.[1] === undefined
                ? Effect.logDebug(`[letta] ${line}`)
                : Deferred.succeed(url, match[1]).pipe(Effect.asVoid)
            }),
            Effect.ignore,
            Effect.forkScoped
          )
          yield* lines(handle.stderr).pipe(
            Stream.runForEach((line) => {
              remember(line)
              return Effect.logDebug(`[letta] ${line}`)
            }),
            Effect.ignore,
            Effect.forkScoped
          )
          yield* handle.exitCode.pipe(
            Effect.flatMap((code) =>
              pending.close(new LettaDisconnected({ message: `The Letta Code App Server exited with code ${code}` }))
            ),
            Effect.ignore,
            Effect.forkScoped
          )

          return yield* Deferred.await(url).pipe(
            Effect.raceFirst(
              pending.closed.pipe(
                Effect.mapError((error) => new LettaStartFailed({ message: error.message, output: tail.join("\n") }))
              )
            ),
            Effect.timeoutOrElse({
              duration: config.startupTimeout,
              orElse: () =>
                Effect.fail(
                  new LettaStartFailed({
                    message: `The Letta Code App Server did not start within ${Duration.format(config.startupTimeout)}`,
                    output: tail.join("\n")
                  })
                )
            })
          )
        }
      )

      /** Opens one connection inside the current scope. */
      const connect = Effect.fnUntraced(function*(generation: number) {
        /** Calls awaiting their responses; closed, with the reason, once the connection is lost. */
        const pending = yield* Pending.make<LettaDisconnected>()
        const url = yield* Option.match(config.appServerUrl, {
          onSome: Effect.succeed,
          onNone: () => executable.resolve.pipe(Effect.flatMap((install) => spawnServer(install, pending)))
        })
        yield* Effect.logDebug(`Connecting to Letta Code App Server at ${url}`)

        const socket = yield* Socket.makeWebSocket(url, { openTimeout: "15 seconds" }).pipe(
          Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)
        )
        const pull = yield* Socket.readerString(socket).pipe(
          Effect.mapError((error) =>
            new LettaStartFailed({
              message: `Could not connect to the Letta Code App Server at ${url}: ${error.message}`
            })
          )
        )
        const writer = yield* socket.writer
        const frames = yield* PubSub.unbounded<Frame>()
        let nextId = 0

        const route = (text: string) =>
          Effect.logTrace("letta <-", text).pipe(
            Effect.andThen(decodeFrame(text)),
            Effect.flatMap((raw) =>
              Option.match(decodeHeader(raw), {
                onNone: () => Effect.logDebug("Ignoring a Letta frame without a type"),
                onSome: (header) => {
                  const publish = PubSub.publish(frames, { header, raw }).pipe(Effect.asVoid)
                  // The id of a control request is its own (an approval response answers it), not a call's.
                  if (header.request_id === undefined || header.type === "control_request") return publish
                  return pending.succeed(header.request_id, raw).pipe(
                    Effect.flatMap((answered) => answered ? Effect.void : publish)
                  )
                }
              })
            ),
            Effect.catch((error) => Effect.logWarning("Ignoring a malformed Letta frame", error))
          )

        yield* pull.pipe(
          Effect.flatMap((batch) => Effect.forEach(batch, route, { discard: true })),
          Effect.forever,
          Effect.catch((error) =>
            pending.close(
              new LettaDisconnected({ message: `Lost the Letta Code App Server connection: ${error.message}` })
            )
          ),
          Effect.forkScoped
        )

        const send = (command: Command) =>
          encodeCommand(command).pipe(
            Effect.tap((line) => Effect.logTrace("letta ->", line)),
            Effect.flatMap((line) => writer.write(line)),
            Effect.mapError((error) => new LettaDisconnected({ message: `Failed to send to Letta: ${error.message}` }))
          )

        const call = Effect.fnUntraced(function*<A extends Reply, I>(
          make: (requestId: string) => Command,
          response: Schema.Codec<A, I>,
          options?: CallOptions
        ): Effect.fn.Return<A, LettaRequestFailed | LettaDisconnected> {
          const requestId = `lacp-${generation}-${nextId++}`
          const command = make(requestId)
          const raw = yield* pending.request(requestId, send(command)).pipe(
            Effect.timeoutOrElse({
              duration: options?.timeout ?? DEFAULT_CALL_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new LettaRequestFailed({ command: command.type, message: "Letta did not respond in time" })
                )
            })
          )
          const decoded = yield* Schema.decodeUnknownEffect(response)(raw).pipe(
            Effect.mapError((error) =>
              new LettaRequestFailed({ command: command.type, message: `Unexpected response: ${error.message}` })
            )
          )
          if (decoded.success === false) {
            return yield* new LettaRequestFailed({
              command: command.type,
              message: decoded.error ?? "Request failed"
            })
          }
          return decoded
        })

        const info = yield* call((request_id) => ({ type: "app_server_info", request_id }), AppServerInfo, {
          timeout: "20 seconds"
        }).pipe(
          Effect.mapError((error) =>
            new LettaStartFailed({
              message: `The Letta Code App Server did not answer app_server_info: ${error.message}`
            })
          )
        )
        if (info.protocol_version !== SUPPORTED_PROTOCOL_VERSION) {
          yield* Effect.logWarning(
            `Letta Code App Server protocol ${info.protocol_version} differs from the supported version ${SUPPORTED_PROTOCOL_VERSION}; continuing`
          )
        }
        yield* Effect.logInfo(
          `Connected to Letta Code ${info.letta_code_version} App Server (backend: ${info.backend}, protocol ${info.protocol_version})`
        )

        return {
          generation,
          info,
          call,
          send,
          subscribe: PubSub.subscribe(frames),
          isAlive: pending.isClosed.pipe(Effect.map((closed) => !closed)),
          closed: pending.closed
        } satisfies LettaConnection
      })

      interface Live {
        readonly connection: LettaConnection
        readonly scope: Scope.Closeable
      }
      const state = yield* SynchronizedRef.make({ live: Option.none<Live>(), generation: 0 })

      const connection = SynchronizedRef.modifyEffect(
        state,
        Effect.fnUntraced(function*({ live, generation }) {
          if (Option.isSome(live)) {
            if (yield* live.value.connection.isAlive) return [live.value.connection, { live, generation }] as const
            yield* Scope.close(live.value.scope, Exit.void)
          }
          const scope = yield* Scope.fork(layerScope)
          const next = yield* connect(generation + 1).pipe(
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void))
          )
          return [next, { live: Option.some({ connection: next, scope }), generation: next.generation }] as const
        })
      ).pipe(Effect.withSpan("LettaAppServer.connection"))

      const warmup = connection.pipe(
        Effect.tapError((error) => Effect.logWarning(`Letta Code is not ready yet: ${error.message}`)),
        Effect.ignore,
        Effect.forkIn(layerScope),
        Effect.asVoid
      )

      /** The failure of the `letta` subcommand `args`. */
      const cliFailed = (args: ReadonlyArray<string>) => (message: string) =>
        new LettaRequestFailed({ command: `letta ${args.join(" ")}`, message })

      const cli = Effect.fn("LettaAppServer.cli")(
        function*(args: ReadonlyArray<string>) {
          const failed = cliFailed(args)
          if (Option.isSome(config.appServerUrl)) {
            return yield* failed("not available when connecting to LACP_APP_SERVER_URL")
          }
          const install = yield* executable.resolve.pipe(Effect.mapError((error) => failed(error.message)))
          const launch = spawnable(install, [...BACKEND_ARGS[config.auth], ...args])
          const handle = yield* spawner.spawn(
            ChildProcess.make(launch.command, launch.args, {
              cwd: host.cwd,
              env: childEnv(),
              extendEnv: false,
              shell: launch.shell,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe"
            })
          )
          const [stdout, stderr, code] = yield* Effect.all([
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode
          ], { concurrency: "unbounded" })
          if (code !== 0) {
            return yield* failed(
              stderr.trim().split("\n").findLast((line) => line.trim() !== "") ?? `exit code ${code}`
            )
          }
          return stdout
        },
        (effect, args) =>
          effect.pipe(
            Effect.scoped,
            Effect.timeoutOrElse({ duration: "60 seconds", orElse: () => Effect.fail(cliFailed(args)("timed out")) }),
            Effect.catchTag("PlatformError", (error) => Effect.fail(cliFailed(args)(error.message)))
          )
      )

      return LettaAppServer.of({ connection, warmup, cli })
    })
  )

  /** A server backed by an already-established connection (for tests). */
  static readonly layerConnection = (
    connection: LettaConnection,
    cli: (args: ReadonlyArray<string>) => Effect.Effect<string, LettaRequestFailed> = (args) =>
      Effect.fail(new LettaRequestFailed({ command: `letta ${args.join(" ")}`, message: "not available" }))
  ) =>
    Layer.succeed(
      LettaAppServer,
      LettaAppServer.of({ connection: Effect.succeed(connection), warmup: Effect.void, cli })
    )
}

/** Provides the WebSocket constructor (Node >= 22 ships a global `WebSocket`). */
export const layerWebSocket = Socket.layerWebSocketConstructorGlobal
