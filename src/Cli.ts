/**
 * The `lacp` command line.
 *
 * - `lacp` (no subcommand): serve ACP over stdio. This is what an editor runs.
 * - `lacp setup`: sign in by running the host's `letta setup` (the ACP
 *   terminal-auth method re-runs the agent command with this argument).
 * - `lacp doctor`: report which Letta Code install will be used and whether
 *   its App Server starts.
 *
 * Every flag falls back to an environment variable, so editors can configure
 * the server through `env` alone.
 */
import { Config, Console, Duration, Effect, Layer, Option, type Redacted, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { AcpServer } from "./agent/AcpServer.ts"
import { Agent } from "./agent/Agent.ts"
import { AcpClient } from "./agent/Client.ts"
import { type AuthMode, LacpConfig, type LacpConfigShape, type LettaRuntime } from "./Config.ts"
import { Host } from "./Host.ts"
import { JsonRpcPeer } from "./jsonrpc/Peer.ts"
import { Transport } from "./jsonrpc/Transport.ts"
import { layerWebSocket, LettaAppServer } from "./letta/AppServer.ts"
import { LettaExecutable, type LettaInstall } from "./letta/Executable.ts"
import * as Login from "./letta/Login.ts"
import { ListModelsResponse, type PermissionMode } from "./letta/Protocol.ts"
import { VERSION } from "./Version.ts"

export class InvalidConfiguration extends Schema.TaggedError<InvalidConfiguration, { readonly brand: unique symbol }>()(
  "InvalidConfiguration",
  { message: Schema.String }
) {}

export class SetupFailed extends Schema.TaggedError<SetupFailed, { readonly brand: unique symbol }>()(
  "SetupFailed",
  { exitCode: Schema.Int }
) {}

const AUTH_MODES = ["host", "cloud-oauth", "api-key", "local"] as const
const PERMISSION_MODES = ["standard", "acceptEdits", "unrestricted", "strict"] as const
const ACP_VERSIONS = ["1", "2"] as const
const LETTA_RUNTIMES = ["auto", "node", "bun"] as const

const flags = {
  auth: Flag.Literals("auth", AUTH_MODES).pipe(
    Flag.withDescription(
      "How Letta Code authenticates: host (use the host's own setup), cloud-oauth (`letta setup` login), " +
        "api-key (LETTA_API_KEY), or local (on-device backend). Env: LACP_AUTH"
    ),
    Flag.withFallbackConfig(Config.Literals(AUTH_MODES, "LACP_AUTH")),
    Flag.withDefault<AuthMode>("host")
  ),
  agentId: Flag.String("agent-id").pipe(
    Flag.withDescription("The Letta agent to talk to (default: the host's last-used agent). Env: LETTA_AGENT_ID"),
    Flag.withFallbackConfig(Config.String("LETTA_AGENT_ID")),
    Flag.optional
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("Model handle for new sessions, e.g. anthropic/claude-sonnet-4-5. Env: LACP_MODEL"),
    Flag.withFallbackConfig(Config.String("LACP_MODEL")),
    Flag.optional
  ),
  permissionMode: Flag.Literals("permission-mode", PERMISSION_MODES).pipe(
    Flag.withDescription("Initial permission mode (default: the host's). Env: LACP_PERMISSION_MODE"),
    Flag.withFallbackConfig(Config.Literals(PERMISSION_MODES, "LACP_PERMISSION_MODE")),
    Flag.optional
  ),
  lettaPath: Flag.String("letta-path").pipe(
    Flag.withDescription("Path to the `letta` executable (default: discovered). Env: LACP_LETTA_PATH"),
    Flag.withFallbackConfig(Config.String("LACP_LETTA_PATH")),
    Flag.optional
  ),
  lettaRuntime: Flag.Literals("letta-runtime", LETTA_RUNTIMES).pipe(
    Flag.withDescription(
      "Runtime for Letta Code: auto (Node while ~/.letta/settings.json holds your login, else Bun if installed), " +
        "node, or bun. Letta Code keeps its login in the system keychain only under Bun. Env: LACP_LETTA_RUNTIME"
    ),
    Flag.withFallbackConfig(Config.Literals(LETTA_RUNTIMES, "LACP_LETTA_RUNTIME")),
    Flag.withDefault<LettaRuntime>("auto")
  ),
  appServerUrl: Flag.String("app-server-url").pipe(
    Flag.withDescription(
      "Connect to a running `letta server --listen` instead of starting one. Env: LACP_APP_SERVER_URL"
    ),
    Flag.withFallbackConfig(Config.String("LACP_APP_SERVER_URL")),
    Flag.optional
  ),
  acpVersion: Flag.Literals("acp-version", ACP_VERSIONS).pipe(
    Flag.withDescription(
      "Highest ACP protocol version to negotiate (2 = draft v2 when the client asks). Env: LACP_ACP_VERSION"
    ),
    Flag.withFallbackConfig(Config.Literals(ACP_VERSIONS, "LACP_ACP_VERSION")),
    Flag.withDefault<"1" | "2">("2")
  ),
  startupTimeout: Flag.Int("startup-timeout").pipe(
    Flag.withDescription("Seconds to wait for the Letta Code App Server to start. Env: LACP_STARTUP_TIMEOUT"),
    Flag.withFallbackConfig(Config.Int("LACP_STARTUP_TIMEOUT")),
    Flag.withDefault(60)
  )
}

type Flags = {
  readonly auth: AuthMode
  readonly agentId: Option.Option<string>
  readonly model: Option.Option<string>
  readonly permissionMode: Option.Option<PermissionMode>
  readonly lettaPath: Option.Option<string>
  readonly lettaRuntime: LettaRuntime
  readonly appServerUrl: Option.Option<string>
  readonly acpVersion: "1" | "2"
  readonly startupTimeout: number
}

/** Builds the configuration from parsed flags plus `LETTA_API_KEY`. */
const configLayer = (input: Flags) =>
  Layer.effect(
    LacpConfig,
    Effect.gen(function*() {
      const apiKey: Option.Option<Redacted.Redacted> = yield* Config.option(Config.Redacted("LETTA_API_KEY"))
      if (input.auth === "api-key" && Option.isNone(apiKey)) {
        return yield* new InvalidConfiguration({ message: "--auth api-key requires LETTA_API_KEY to be set" })
      }
      const config: LacpConfigShape = {
        auth: input.auth,
        apiKey,
        agentId: input.agentId,
        model: input.model,
        permissionMode: input.permissionMode,
        lettaPath: input.lettaPath,
        lettaRuntime: input.lettaRuntime,
        appServerUrl: input.appServerUrl,
        maxAcpVersion: input.acpVersion === "1" ? 1 : 2,
        startupTimeout: Duration.seconds(input.startupTimeout)
      }
      return LacpConfig.of(config)
    }).pipe(Effect.orDie)
  )

/** Everything the ACP server needs, given its configuration. */
export const ServerLayer = AcpServer.layer.pipe(
  Layer.provide(Agent.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(LettaAppServer.layer),
  Layer.provide(LettaExecutable.layer),
  Layer.provide(layerWebSocket),
  Layer.provideMerge(AcpClient.layer),
  Layer.provide(JsonRpcPeer.layer),
  Layer.provide(Transport.layerStdio)
)

/** The root command; its flags are shared with the subcommands. */
const root = Command.make("lacp").pipe(
  Command.withSharedFlags(flags),
  Command.withDescription("An Agent Client Protocol (ACP) server for Letta Code")
)

/** Configuration for subcommands, from the root command's flags. */
const rootConfig = Layer.unwrap(Effect.map(root, configLayer))

const lacp = root.pipe(
  Command.withHandler(() =>
    Effect.gen(function*() {
      const server = yield* AcpServer
      yield* Effect.logDebug(`lacp ${VERSION} serving ACP on stdio`)
      yield* server.serve
    })
  ),
  Command.provide((input) => ServerLayer.pipe(Layer.provide(configLayer(input))))
)

const setup = Command.make("setup", {}, () =>
  Effect.gen(function*() {
    const executable = yield* LettaExecutable
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const install = yield* executable.resolve
    const code = yield* spawner.exitCode(
      ChildProcess.make(install.command, [...install.prefixArgs, "setup"], {
        extendEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      })
    )
    return yield* (code === 0 ? Effect.void : Effect.fail(new SetupFailed({ exitCode: code })))
  })).pipe(
    Command.withDescription("Sign in to Letta by running the host's `letta setup`"),
    Command.provide(() => LettaExecutable.layer.pipe(Layer.provide(rootConfig)))
  )

/** Where Letta Code's login lives, and whether the chosen runtime can read it. */
const loginReport = Effect.fnUntraced(function*(auth: AuthMode, runtime: LettaInstall["runtime"]) {
  if (auth === "api-key") return ["login: LETTA_API_KEY from the environment"]
  if (auth === "local") return ["login: not needed (local backend)"]
  const host = yield* Host
  const inFile = yield* Login.inSettingsFile(host.env["HOME"] ?? host.home)
  const keychain = Option.getOrUndefined(yield* Login.inKeychain(host.platform))
  const where = inFile && keychain === true
    ? "in ~/.letta/settings.json and in the macOS keychain"
    : inFile
    ? "in ~/.letta/settings.json (Letta Code reads it there under Node)"
    : keychain === true
    ? "in the macOS keychain (Letta Code reads it there under Bun)"
    : keychain === false
    ? "none found in ~/.letta/settings.json or the macOS keychain; run `lacp setup`"
    : "not in ~/.letta/settings.json (it may be in the system keychain, which Letta Code reads only under Bun)"
  return [
    `login: ${where}`,
    ...(runtime === "node" && !inFile && keychain === true
      ? ["warning: Letta Code under Node cannot read the keychain; set LACP_LETTA_RUNTIME=bun (or auto)"]
      : []),
    ...(runtime === "bun" && inFile
      ? [
        "note: Letta Code under Bun moves this login into the system keychain, where Letta Code under Node " +
        "no longer finds it"
      ]
      : [])
  ]
})

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function*() {
    const config = yield* LacpConfig
    const executable = yield* LettaExecutable
    const appServer = yield* LettaAppServer
    yield* Console.log(`lacp ${VERSION}`)
    yield* Console.log(`auth: ${config.auth}`)
    yield* Console.log(`agent: ${Option.getOrElse(config.agentId, () => "(host's last-used agent)")}`)
    yield* Console.log(`max ACP version: ${config.maxAcpVersion}`)
    if (Option.isNone(config.appServerUrl)) {
      const install = yield* executable.resolve
      yield* Console.log(`letta: ${install.path} (${install.version}, found via ${install.source})`)
      yield* Console.log(
        install.runtime === "launcher"
          ? `runtime: the launcher itself (${install.runtimeReason})`
          : `runtime: ${install.runtime} (${install.command}): ${install.runtimeReason}`
      )
      for (const line of yield* loginReport(config.auth, install.runtime)) yield* Console.log(line)
    } else {
      yield* Console.log(`app server: ${config.appServerUrl.value}`)
    }
    const conn = yield* appServer.connection
    yield* Console.log(
      `app server: OK (Letta Code ${conn.info.letta_code_version}, backend ${conn.info.backend}, protocol ${conn.info.protocol_version})`
    )
    const models = yield* conn.call((request_id) => ({ type: "list_models", request_id }), ListModelsResponse).pipe(
      Effect.map((r) => `${r.entries.length} available`),
      Effect.catch((e) => Effect.succeed(`unavailable (${e.message})`))
    )
    yield* Console.log(`models: ${models}`)
  })).pipe(
    Command.withDescription("Check the Letta Code installation and App Server"),
    Command.provide(() =>
      LettaAppServer.layer.pipe(
        Layer.provideMerge(LettaExecutable.layer),
        Layer.provide(layerWebSocket),
        Layer.provideMerge(rootConfig)
      )
    )
  )

export const command = lacp.pipe(Command.withSubcommands([setup, doctor]))

export const cli = Command.run(command, { version: VERSION })
