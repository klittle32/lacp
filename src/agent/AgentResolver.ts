/**
 * Which Letta agent a session talks to: the configured one (`LETTA_AGENT_ID`),
 * else the one the host's Letta Code last used in the session's directory (as
 * `letta` itself would pick it), else, where a session needs one, a new one.
 * The choice is remembered per directory for the life of the process, and a
 * new agent also in the directory's `.letta/settings.local.json`, as Letta
 * Code records the agents it creates, so later sessions (and `letta`) there
 * keep talking to it.
 */
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { LacpConfig } from "../Config.ts"
import { Host } from "../Host.ts"
import type { LettaConnection } from "../letta/AppServer.ts"
import { AgentRetrieveResponse, type AgentState, CreateAgentResponse } from "../letta/Protocol.ts"
import { AgentUnavailable, unavailable } from "./Errors.ts"

/** The agents the host's Letta Code last used, from its settings files. */
const HostSettings = Schema.Struct({
  lastAgent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lastSession: Schema.optionalKey(Schema.NullOr(Schema.Struct({ agentId: Schema.String }))),
  sessionsByServer: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ agentId: Schema.String })))
})
type HostSettings = typeof HostSettings.Type
const decodeHostSettings = Schema.decodeUnknownOption(Schema.fromJsonString(HostSettings))

const lastAgent = (settings: HostSettings) => Option.toArray(Option.fromNullishOr(settings.lastAgent))

/** A settings file as a JSON object, to update one key and keep the others. */
const SettingsObjectJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), { space: 2 })
const decodeSettingsObject = Schema.decodeUnknownOption(SettingsObjectJson)
const encodeSettingsObject = Schema.encodeEffect(SettingsObjectJson)

export class AgentResolver extends Context.Service<AgentResolver, {
  /** The configured agent, or the host's last-used one for `cwd` that still exists. */
  find(conn: LettaConnection, cwd: string): Effect.Effect<Option.Option<string>>
  /** Like `find`, but creates an agent when there is none. */
  findOrCreate(conn: LettaConnection, cwd: string): Effect.Effect<string, AgentUnavailable>
  /** The agent's state, which also confirms that it exists. */
  retrieve(conn: LettaConnection, agentId: string): Effect.Effect<AgentState, AgentUnavailable>
}>()("lacp/agent/AgentResolver") {
  static readonly layer = Layer.effect(
    AgentResolver,
    Effect.gen(function*() {
      const config = yield* LacpConfig
      const host = yield* Host
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const byCwd = new Map<string, string>()

      const readSettings = (file: string) =>
        fs.readFileString(file).pipe(
          Effect.map(decodeHostSettings),
          Effect.orElseSucceed(() => Option.none<HostSettings>())
        )

      /** The agents the host's Letta Code last used for `cwd`, the project's own first. */
      const hostLastAgents = Effect.fnUntraced(function*(cwd: string) {
        const project = yield* readSettings(path.join(cwd, ".letta", "settings.local.json"))
        const global = yield* readSettings(path.join(host.home, ".letta", "settings.json"))
        return new Set([
          ...Option.toArray(project).flatMap((settings) => [
            ...Object.values(settings.sessionsByServer ?? {}).map((session) => session.agentId),
            ...Option.toArray(Option.fromNullishOr(settings.lastSession?.agentId)),
            ...lastAgent(settings)
          ]),
          ...Option.toArray(global).flatMap(lastAgent)
        ])
      })

      const retrieved = (conn: LettaConnection, agentId: string) =>
        conn.call(
          (request_id) => ({ type: "agent_retrieve", request_id, agent_id: agentId }),
          AgentRetrieveResponse,
          { timeout: "20 seconds" }
        )

      const find = Effect.fn("AgentResolver.find")(function*(conn: LettaConnection, cwd: string) {
        if (Option.isSome(config.agentId)) return config.agentId
        const cached = byCwd.get(cwd)
        if (cached !== undefined) return Option.some(cached)
        const found = yield* Effect.findFirst(yield* hostLastAgents(cwd), (agentId) =>
          retrieved(conn, agentId).pipe(
            Effect.map((response) => response.agent !== null),
            Effect.orElseSucceed(() => false)
          ))
        if (Option.isSome(found)) {
          byCwd.set(cwd, found.value)
          yield* Effect.logInfo(`Using the host's last Letta agent ${found.value}`)
        }
        return found
      })

      /** Records `agentId` as the last agent of the project at `cwd`, keeping its other settings. */
      const remember = Effect.fnUntraced(
        function*(cwd: string, agentId: string) {
          const dir = path.join(cwd, ".letta")
          const file = path.join(dir, "settings.local.json")
          const existing = yield* fs.readFileString(file).pipe(
            Effect.asSome,
            Effect.catchTag(
              "PlatformError",
              (error) => error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error)
            )
          )
          const settings = Option.match(existing, {
            onNone: () => Option.some({}),
            onSome: decodeSettingsObject
          })
          yield* Option.match(settings, {
            onNone: () => Effect.logWarning(`Not recording agent ${agentId} in ${file}: it is not a JSON object`),
            onSome: (settings) =>
              encodeSettingsObject({ ...settings, lastAgent: agentId }).pipe(
                Effect.tap(() => fs.makeDirectory(dir, { recursive: true })),
                Effect.flatMap((text) => fs.writeFileString(file, `${text}\n`))
              )
          })
        },
        (effect, cwd, agentId) =>
          Effect.catch(
            effect,
            (error) => Effect.logWarning(`Could not record agent ${agentId} for ${cwd}: ${error.message}`)
          )
      )

      const create = Effect.fnUntraced(function*(conn: LettaConnection, cwd: string) {
        const created = yield* conn.call(
          (request_id) => ({
            type: "create_agent",
            request_id,
            personality: "memo",
            pin_global: true,
            model: Option.getOrUndefined(config.model)
          }),
          CreateAgentResponse,
          { timeout: "2 minutes" }
        ).pipe(Effect.mapError(unavailable))
        if (created.agent_id === undefined || created.agent_id === null) {
          return yield* new AgentUnavailable({
            message: created.error ?? "Letta Code could not create an agent",
            auth: false
          })
        }
        byCwd.set(cwd, created.agent_id)
        yield* remember(cwd, created.agent_id)
        yield* Effect.logWarning(
          `Created Letta agent ${created.agent_id} for ${cwd}, recorded in its .letta/settings.local.json.`
        )
        return created.agent_id
      })

      const findOrCreate = Effect.fn("AgentResolver.findOrCreate")(function*(conn: LettaConnection, cwd: string) {
        const found = yield* find(conn, cwd)
        return Option.isSome(found) ? found.value : yield* create(conn, cwd)
      })

      const retrieve = Effect.fn("AgentResolver.retrieve")(function*(conn: LettaConnection, agentId: string) {
        const response = yield* retrieved(conn, agentId).pipe(Effect.mapError(unavailable))
        if (response.agent === null) {
          return yield* new AgentUnavailable({ message: `Letta has no agent ${agentId}`, auth: false })
        }
        return response.agent
      })

      return AgentResolver.of({ find, findOrCreate, retrieve })
    })
  )
}
