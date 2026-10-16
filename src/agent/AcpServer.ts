/**
 * The ACP agent surface: version negotiation plus the v1 and v2 method sets,
 * both thin adapters over the version-neutral {@link Agent} core.
 *
 * Negotiation follows the v2 rules (which also satisfy v1 clients): the agent
 * selects the highest version it supports that is at or below the requested
 * one. A client that asks for v2 but sends a v1-shaped request is answered as
 * v1, which keeps hybrid clients working.
 */
import { Context, Effect, Layer, Match, Option, Ref, Schema } from "effect"
import * as Mcp from "../acp/Mcp.ts"
import * as ProjectV1 from "../acp/ProjectV1.ts"
import * as ProjectV2 from "../acp/ProjectV2.ts"
import * as V1 from "../acp/V1.ts"
import * as V2 from "../acp/V2.ts"
import { LacpConfig } from "../Config.ts"
import type { Command, ConfigOption } from "../domain/Events.ts"
import { ErrorCode, RpcError } from "../jsonrpc/JsonRpc.ts"
import * as Method from "../jsonrpc/Method.ts"
import { JsonRpcPeer } from "../jsonrpc/Peer.ts"
import { AGENT_NAME, AGENT_TITLE, VERSION } from "../Version.ts"
import { Agent, type AgentError, MODE_CONFIG_ID, MODEL_CONFIG_ID, type SessionSummary } from "./Agent.ts"
import { AcpClient } from "./Client.ts"

/** The terminal-auth method: the client re-runs `lacp setup`, which runs the host's `letta setup`. */
export const SETUP_METHOD_ID = "letta-setup"
const SETUP_NAME = "Sign in to Letta"
const SETUP_DESCRIPTION = "Runs `letta setup` in a terminal to sign in to Letta (once per machine)."

const agentInfo = { name: AGENT_NAME, title: AGENT_TITLE, version: VERSION }

const InitializeHeader = Schema.Struct({ protocolVersion: Schema.Int })
const decodeHeader = Schema.decodeUnknownEffect(InitializeHeader)
const decodeV1Initialize = Schema.decodeUnknownOption(V1.InitializeRequest)
const decodeV2Initialize = Schema.decodeUnknownOption(V2.InitializeRequest)
const encodeV1Initialize = Schema.encodeEffect(V1.InitializeResponse)
const encodeV2Initialize = Schema.encodeEffect(V2.InitializeResponse)

/** Maps agent-core failures onto JSON-RPC errors. */
export const toRpcError: (error: AgentError) => RpcError = Match.type<AgentError>().pipe(
  Match.tagsExhaustive({
    SessionNotFound: (e) => RpcError.resourceNotFound(`Session not found: ${e.sessionId}`, { sessionId: e.sessionId }),
    AgentUnavailable: (e) => (e.auth ? RpcError.authRequired(e.message) : RpcError.internal(e.message)),
    InvalidConfigValue: (e) => RpcError.invalidParams({ configId: e.configId, value: e.value }),
    PromptRejected: (e) => RpcError.internal(e.message)
  })
)

const rpc = <A>(effect: Effect.Effect<A, AgentError>) => Effect.mapError(effect, toRpcError)

const summary = (s: SessionSummary) => ({
  sessionId: s.sessionId,
  cwd: s.cwd,
  ...(Option.isSome(s.title) ? { title: s.title.value } : {}),
  ...(Option.isSome(s.updatedAt) ? { updatedAt: s.updatedAt.value } : {})
})

const commandsV2 = (commands: ReadonlyArray<Command>) =>
  commands.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.hint === undefined ? {} : { input: { type: "text" as const, hint: c.hint } })
  }))

export class AcpServer extends Context.Service<AcpServer, {
  /** Serves ACP on the peer's transport until the client disconnects. */
  readonly serve: Effect.Effect<void>
}>()("lacp/agent/AcpServer") {
  static readonly layer = Layer.effect(
    AcpServer,
    Effect.gen(function*() {
      const peer = yield* JsonRpcPeer
      const client = yield* AcpClient
      const agent = yield* Agent
      const config = yield* LacpConfig
      const surface = yield* Ref.make(Option.none<Method.Dispatcher>())

      /** Terminal auth is only offered where it can work: a terminal-capable client and an interactive login. */
      const offerSetup = (terminalAuth: boolean) =>
        terminalAuth && (config.auth === "host" || config.auth === "cloud-oauth")

      // --- v1 ---------------------------------------------------------------

      const v1 = Method.router([
        Method.handle(
          V1.Authenticate,
          ({ methodId }) =>
            methodId === SETUP_METHOD_ID ? Effect.succeed({}) : Effect.fail(RpcError.invalidParams({ methodId }))
        ),
        Method.handle(V1.NewSession, (params) =>
          Mcp.fromWire(1, params.mcpServers).pipe(
            Effect.flatMap((mcpServers) => rpc(agent.newSession({ cwd: params.cwd, mcpServers }))),
            Effect.map((setup) => ({
              sessionId: setup.sessionId,
              ...v1Options(setup.configOptions)
            }))
          )),
        Method.handle(
          V1.LoadSession,
          (params) =>
            Mcp.fromWire(1, params.mcpServers).pipe(
              Effect.flatMap((mcpServers) =>
                rpc(agent.loadSession({ sessionId: params.sessionId, cwd: params.cwd, replay: true, mcpServers }))
              ),
              Effect.map((setup) => v1Options(setup.configOptions))
            )
        ),
        Method.handle(
          V1.ResumeSession,
          (params) =>
            Mcp.fromWire(1, params.mcpServers).pipe(
              Effect.flatMap((mcpServers) =>
                rpc(agent.loadSession({ sessionId: params.sessionId, cwd: params.cwd, replay: false, mcpServers }))
              ),
              Effect.map((setup) => v1Options(setup.configOptions))
            )
        ),
        Method.handle(V1.ListSessions, (params) =>
          rpc(agent.listSessions({
            cwd: Option.fromNullishOr(params.cwd),
            cursor: Option.fromNullishOr(params.cursor)
          })).pipe(Effect.map((r) => ({
            sessions: r.sessions.map(summary),
            ...(Option.isSome(r.nextCursor) ? { nextCursor: r.nextCursor.value } : {})
          })))),
        Method.handle(V1.CloseSession, ({ sessionId }) => agent.closeSession(sessionId).pipe(Effect.as({}))),
        Method.handle(
          V1.SetSessionMode,
          ({ modeId, sessionId }) => rpc(agent.setConfigOption(sessionId, MODE_CONFIG_ID, modeId)).pipe(Effect.as({}))
        ),
        Method.handle(
          LegacySetModel,
          ({ modelId, sessionId }) =>
            rpc(agent.setConfigOption(sessionId, MODEL_CONFIG_ID, modelId)).pipe(Effect.as({}))
        ),
        Method.handle(V1.SetSessionConfigOption, (params) =>
          "type" in params
            ? Effect.fail(
              RpcError.invalidParams({ configId: params.configId, reason: "boolean options are not supported" })
            )
            : rpc(agent.setConfigOption(params.sessionId, params.configId, params.value)).pipe(
              Effect.map((options) => ({ configOptions: options.map(ProjectV1.configOption) }))
            )),
        Method.handle(V1.Prompt, ({ prompt, sessionId }) =>
          Effect.gen(function*() {
            const handle = yield* rpc(agent.prompt(sessionId, prompt))
            const result = yield* handle.completion.pipe(Effect.onInterrupt(() => agent.cancel(sessionId)))
            if (result.stopReason === "error") {
              const error = Option.getOrElse(
                result.error,
                () => ({ code: ErrorCode.InternalError, message: "Letta Code failed" })
              )
              return yield* RpcError.of(error.code, error.message)
            }
            return { stopReason: result.stopReason }
          })),
        Method.handleNotification(V1.Cancel, ({ sessionId }) => agent.cancel(sessionId))
      ])

      // --- v2 ---------------------------------------------------------------

      /** v2 `session/resume` must report the current foreground state before responding. */
      const snapshot = (sessionId: string) =>
        agent.foreground(sessionId).pipe(
          Effect.flatMap((state) => client.emit(sessionId, { _tag: "State", state }))
        )

      const v2 = Method.router([
        Method.handle(
          V2.Login,
          ({ methodId }) =>
            methodId === SETUP_METHOD_ID ? Effect.succeed({}) : Effect.fail(RpcError.invalidParams({ methodId }))
        ),
        Method.handle(
          V2.Logout,
          () =>
            Effect.logInfo("auth/logout: sign out with Letta Code itself (`letta setup`); nothing to do here").pipe(
              Effect.as({})
            )
        ),
        Method.handle(V2.NewSession, (params) =>
          Mcp.fromWire(2, params.mcpServers).pipe(
            Effect.flatMap((mcpServers) => rpc(agent.newSession({ cwd: params.cwd, mcpServers }))),
            Effect.map((setup) => ({
              sessionId: setup.sessionId,
              configOptions: setup.configOptions.map(ProjectV2.configOption),
              availableCommands: commandsV2(setup.commands)
            }))
          )),
        Method.handle(V2.ResumeSession, (params) => {
          const replayFrom = params.replayFrom
          if (replayFrom !== undefined && replayFrom !== null && replayFrom.type !== "start") {
            return Effect.fail(RpcError.invalidParams({ replayFrom }))
          }
          return Mcp.fromWire(2, params.mcpServers).pipe(
            Effect.flatMap((mcpServers) =>
              rpc(agent.loadSession({
                sessionId: params.sessionId,
                cwd: params.cwd,
                replay: replayFrom?.type === "start",
                mcpServers
              }))
            ),
            Effect.tap((setup) => snapshot(setup.sessionId)),
            Effect.map((setup) => ({
              configOptions: setup.configOptions.map(ProjectV2.configOption),
              availableCommands: commandsV2(setup.commands)
            }))
          )
        }),
        Method.handle(V2.ListSessions, (params) =>
          rpc(agent.listSessions({
            cwd: Option.fromNullishOr(params.cwd),
            cursor: Option.fromNullishOr(params.cursor)
          })).pipe(Effect.map((r) => ({
            sessions: r.sessions.map(summary),
            ...(Option.isSome(r.nextCursor) ? { nextCursor: r.nextCursor.value } : {})
          })))),
        Method.handle(V2.CloseSession, ({ sessionId }) => agent.closeSession(sessionId).pipe(Effect.as({}))),
        Method.handle(V2.SetSessionConfigOption, (params) =>
          params.type !== "id" || typeof params.value !== "string"
            ? Effect.fail(RpcError.invalidParams({ configId: params.configId, type: params.type }))
            : rpc(agent.setConfigOption(params.sessionId, params.configId, params.value)).pipe(
              Effect.map((options) => ({ configOptions: options.map(ProjectV2.configOption) }))
            )),
        Method.handle(V2.Prompt, ({ prompt, sessionId }) =>
          // Once inserted, a v2 prompt must not be answered with an error, so the
          // receipt is produced uninterruptibly. Waiting for the session's previous
          // turn stays interruptible (see Agent.prompt), so it can be cancelled.
          rpc(agent.prompt(sessionId, prompt)).pipe(
            Effect.map((handle) => ({ messageId: handle.messageId })),
            Effect.uninterruptible
          )),
        Method.handleNotification(V2.Cancel, ({ sessionId }) => agent.cancel(sessionId))
      ])

      // --- initialize -------------------------------------------------------

      const initialize = (raw: unknown): Effect.Effect<unknown, RpcError> =>
        Effect.gen(function*() {
          if (Option.isSome(yield* Ref.get(surface))) {
            return yield* RpcError.invalidRequest({ reason: "already initialized" })
          }
          const { protocolVersion: requested } = yield* decodeHeader(raw ?? {}).pipe(
            Effect.mapError((e) => RpcError.invalidParams({ reason: e.message }))
          )
          const v2Request = config.maxAcpVersion >= 2 && requested >= 2 ? decodeV2Initialize(raw) : Option.none()

          if (Option.isSome(v2Request)) {
            const capabilities = v2Request.value.capabilities ?? {}
            yield* client.select({ version: 2, capabilities })
            yield* Ref.set(surface, Option.some(v2))
            yield* Effect.logInfo(`ACP v2 negotiated with ${v2Request.value.info.name} ${v2Request.value.info.version}`)
            yield* agent.warmup
            const terminal = capabilities.auth?.terminal !== undefined && capabilities.auth.terminal !== null
            return yield* encodeV2Initialize({
              protocolVersion: V2.PROTOCOL_VERSION,
              info: agentInfo,
              capabilities: {
                session: { prompt: { image: {}, embeddedContext: {} }, mcp: { stdio: {}, http: {} } }
              },
              authMethods: offerSetup(terminal)
                ? [{
                  type: "terminal",
                  methodId: SETUP_METHOD_ID,
                  name: SETUP_NAME,
                  description: SETUP_DESCRIPTION,
                  args: ["setup"]
                }]
                : []
            }).pipe(Effect.mapError((e) => RpcError.internal(e.message)))
          }

          if (requested < 1 && config.maxAcpVersion >= 2) {
            return yield* RpcError.of(ErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version", {
              requested,
              supported: [1, 2]
            })
          }

          const v1Request = Option.getOrElse(
            decodeV1Initialize(raw),
            (): V1.InitializeRequest => ({ protocolVersion: requested })
          )
          const capabilities = v1Request.clientCapabilities ?? {}
          yield* client.select({ version: 1, capabilities })
          yield* Ref.set(surface, Option.some(v1))
          const name = v1Request.clientInfo?.name ?? "an unnamed client"
          yield* Effect.logInfo(`ACP v1 negotiated with ${name} (requested v${requested})`)
          yield* agent.warmup
          const terminal = capabilities.auth?.terminal === true || capabilities._meta?.["terminal-auth"] === true
          return yield* encodeV1Initialize({
            protocolVersion: V1.PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, audio: false, embeddedContext: true },
              mcpCapabilities: { http: true, sse: false },
              sessionCapabilities: { list: {}, resume: {}, close: {} }
            },
            authMethods: offerSetup(terminal)
              ? [{
                type: "terminal",
                id: SETUP_METHOD_ID,
                name: SETUP_NAME,
                description: SETUP_DESCRIPTION,
                args: ["setup"]
              }]
              : [],
            agentInfo
          }).pipe(Effect.mapError((e) => RpcError.internal(e.message)))
        })

      const dispatcher: Method.Dispatcher = {
        request: (method) =>
          Option.some((params: unknown) =>
            Ref.get(surface).pipe(
              Effect.flatMap(Option.match({
                onNone: () =>
                  method === V1.Initialize.name
                    ? initialize(params)
                    : Effect.fail(RpcError.invalidRequest({ reason: "the connection is not initialized" })),
                onSome: (d) =>
                  method === V1.Initialize.name
                    ? initialize(params)
                    : Option.match(d.request(method), {
                      onNone: () => Effect.fail(RpcError.methodNotFound(method)),
                      onSome: (run) => run(params)
                    })
              }))
            )
          ),
        notification: (method) =>
          Option.some((params: unknown) =>
            Ref.get(surface).pipe(
              Effect.flatMap(Option.match({
                onNone: () => Effect.logDebug(`Ignoring ${method} before initialize`),
                onSome: (d) =>
                  Option.match(d.notification(method), {
                    onNone: () => Effect.logDebug(`Ignoring unknown notification ${method}`),
                    onSome: (run) => run(params)
                  })
              }))
            )
          )
      }

      return AcpServer.of({ serve: peer.serve(dispatcher) })
    })
  )
}

/** `session/set_model`: removed from the schema in 0.13.5, still sent by some v1 clients. */
const LegacySetModel = Method.request(
  "session/set_model",
  Schema.Struct({ sessionId: Schema.String, modelId: Schema.String }),
  Schema.Struct({})
)

const v1Options = (options: ReadonlyArray<ConfigOption>) => {
  const modes = ProjectV1.modeState(options)
  return {
    configOptions: options.map(ProjectV1.configOption),
    ...(modes === undefined ? {} : { modes })
  }
}
