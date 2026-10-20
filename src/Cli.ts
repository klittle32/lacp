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
import { AgentResolver } from "./agent/AgentResolver.ts"
import { AcpClient } from "./agent/Client.ts"
import { SessionIds } from "./agent/SessionIds.ts"
import { Settings } from "./agent/Settings.ts"
import { AcpVersion, AuthMode, LacpConfig, type LacpConfigShape, LettaRuntime } from "./Config.ts"
import { Host } from "./Host.ts"
import { JsonRpcPeer } from "./jsonrpc/Peer.ts"
import { Transport } from "./jsonrpc/Transport.ts"
import { layerWebSocket, LettaAppServer } from "./letta/AppServer.ts"
import { LettaExecutable, type LettaInstall, spawnable } from "./letta/Executable.ts"
import * as Login from "./letta/Login.ts"
import { ListModelsResponse, PermissionMode } from "./letta/Protocol.ts"
import * as LogFile from "./LogFile.ts"
import { McpBridges } from "./mcp/Bridge.ts"
import { VERSION } from "./Version.ts"

class InvalidConfiguration extends Schema.TaggedError<InvalidConfiguration, { readonly brand: unique symbol }>()(
  "InvalidConfiguration",
  { message: Schema.String }
) {}

class SetupFailed extends Schema.TaggedError<SetupFailed, { readonly brand: unique symbol }>()(
  "SetupFailed",
  { exitCode: Schema.Int }
) {}

/** A flag that falls back to the environment variable `env` (built with `config`), which its description names. */
const envFlag = <A>(flag: Flag.Flag<A>, env: string, config: (name: string) => Config.Config<A>, description: string) =>
  flag.pipe(Flag.withDescription(`${description} Env: ${env}`), Flag.withFallbackConfig(config(env)))

const literals = <const L extends ReadonlyArray<string>>(values: L) => (name: string) => Config.Literals(values, name)

const flags = {
  auth: envFlag(
    Flag.Literals("auth", AuthMode.literals),
    "LACP_AUTH",
    literals(AuthMode.literals),
    "How Letta Code authenticates: host (use the host's own setup), cloud-oauth (`letta setup` login), " +
      "api-key (LETTA_API_KEY), or local (on-device backend)."
  ).pipe(Flag.withDefault<AuthMode>("host")),
  agentId: envFlag(
    Flag.String("agent-id"),
    "LETTA_AGENT_ID",
    Config.String,
    "The Letta agent to talk to (default: the host's last-used agent)."
  ).pipe(Flag.optional),
  model: envFlag(
    Flag.String("model"),
    "LACP_MODEL",
    Config.String,
    "Model handle for new sessions, e.g. anthropic/claude-sonnet-4-5."
  ).pipe(Flag.optional),
  permissionMode: envFlag(
    Flag.Literals("permission-mode", PermissionMode.literals),
    "LACP_PERMISSION_MODE",
    literals(PermissionMode.literals),
    "Permission mode of new sessions (default: unrestricted)."
  ).pipe(Flag.optional),
  lettaPath: envFlag(
    Flag.String("letta-path"),
    "LACP_LETTA_PATH",
    Config.String,
    "Path to the `letta` executable (default: discovered)."
  ).pipe(Flag.optional),
  lettaRuntime: envFlag(
    Flag.Literals("letta-runtime", LettaRuntime.literals),
    "LACP_LETTA_RUNTIME",
    literals(LettaRuntime.literals),
    "Runtime for Letta Code: auto (Node while ~/.letta/settings.json holds your login, else Bun if installed), " +
      "node, or bun. Letta Code keeps its login in the system keychain only under Bun."
  ).pipe(Flag.withDefault<LettaRuntime>("auto")),
  appServerUrl: envFlag(
    Flag.String("app-server-url"),
    "LACP_APP_SERVER_URL",
    Config.String,
    "Connect to a running `letta server --listen` instead of starting one."
  ).pipe(Flag.optional),
  acpVersion: envFlag(
    Flag.Literals("acp-version", AcpVersion.literals),
    "LACP_ACP_VERSION",
    literals(AcpVersion.literals),
    "Highest ACP protocol version to negotiate (2 = draft v2 when the client asks)."
  ).pipe(Flag.withDefault<AcpVersion>("2")),
  echoPrompts: envFlag(
    Flag.Boolean("echo-prompts"),
    "LACP_ECHO_PROMPTS",
    Config.Boolean,
    "ACP v2: send each prompt back to the client as a user_message (T3 Code shows it as a second message)."
  ).pipe(Flag.withDefault(false)),
  waitForBackground: envFlag(
    Flag.Boolean("wait-for-background"),
    "LACP_WAIT_FOR_BACKGROUND",
    Config.Boolean,
    "Keep a turn open until background subagents it started report back (--no-wait-for-background to end it " +
      "right away)."
  ).pipe(Flag.withDefault(true)),
  startupTimeout: envFlag(
    Flag.Int("startup-timeout"),
    "LACP_STARTUP_TIMEOUT",
    Config.Int,
    "Seconds to wait for the Letta Code App Server to start."
  ).pipe(Flag.withDefault(60)),
  logFile: envFlag(
    Flag.String("log-file"),
    "LACP_LOG_FILE",
    Config.String,
    "Also append the server's log to this file (T3 Code keeps no agent stderr)."
  ).pipe(Flag.optional)
}

/** The root command; its flags are shared with the subcommands. */
const root = Command.make("lacp").pipe(
  Command.withSharedFlags(flags),
  Command.withDescription("An Agent Client Protocol (ACP) server for Letta Code")
)

/** The parsed flags. */
type Flags = Effect.Success<typeof root>

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
        cancelGrace: LacpConfig.defaults.cancelGrace,
        waitForBackground: input.waitForBackground,
        backgroundGrace: LacpConfig.defaults.backgroundGrace,
        echoPrompts: input.echoPrompts,
        startupTimeout: Duration.seconds(input.startupTimeout)
      }
      return LacpConfig.of(config)
    }).pipe(Effect.orDie)
  )

/** Everything the ACP server needs, given its configuration. */
const ServerLayer = AcpServer.layer.pipe(
  Layer.provide(Agent.layer),
  Layer.provide(Settings.layer),
  Layer.provide(SessionIds.layer),
  Layer.provide(AgentResolver.layer),
  Layer.provide(McpBridges.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(LettaAppServer.layer),
  Layer.provide(LettaExecutable.layer),
  Layer.provide(layerWebSocket),
  Layer.provideMerge(AcpClient.layer),
  Layer.provide(JsonRpcPeer.layer),
  Layer.provide(Transport.layerStdio)
)

/** Configuration for subcommands, from the root command's flags. */
const rootConfig = Layer.unwrap(Effect.map(root, configLayer))

const lacp = root.pipe(
  Command.withHandler(Effect.fnUntraced(function*() {
    const server = yield* AcpServer
    yield* Effect.logDebug(`lacp ${VERSION} serving ACP on stdio`)
    yield* server.serve
  })),
  Command.provide((input) =>
    ServerLayer.pipe(Layer.provide(configLayer(input)), Layer.provideMerge(LogFile.layer(input.logFile)))
  )
)

const setup = Command.make(
  "setup",
  {},
  Effect.fnUntraced(function*() {
    const executable = yield* LettaExecutable
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const launch = spawnable(yield* executable.resolve, ["setup"])
    const code = yield* spawner.exitCode(
      ChildProcess.make(launch.command, launch.args, {
        extendEnv: true,
        shell: launch.shell,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      })
    )
    return yield* (code === 0 ? Effect.void : Effect.fail(new SetupFailed({ exitCode: code })))
  })
).pipe(
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
    ...Option.toArray(Login.environmentKeyNote(auth, host.env)).map((note) => `note: ${note}`),
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

const doctor = Command.make(
  "doctor",
  {},
  Effect.fnUntraced(function*() {
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
  })
).pipe(
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
