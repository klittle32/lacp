/**
 * Which Letta agent a session talks to: the configured one (`LETTA_AGENT_ID`),
 * else the one the host's Letta Code last used in the session's directory (as
 * `letta` itself would pick it). The choice is remembered per directory for
 * the life of the process. lacp never creates agents: with none to use, a
 * session cannot open.
 */
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { LacpConfig } from "../Config.ts"
import { Host } from "../Host.ts"
import type { LettaConnection } from "../letta/AppServer.ts"
import { isAgentNotFound } from "../letta/Errors.ts"
import { AgentRetrieveResponse, type AgentState } from "../letta/Protocol.ts"
import { agentFailure, AgentNotFound, type AgentUnavailable, unavailable } from "./Errors.ts"

/** The agents the host's Letta Code last used, from its settings files. */
const HostSettings = Schema.Struct({
  lastAgent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lastSession: Schema.optionalKey(Schema.NullOr(Schema.Struct({ agentId: Schema.String }))),
  sessionsByServer: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ agentId: Schema.String })))
})
type HostSettings = typeof HostSettings.Type
const decodeHostSettings = Schema.decodeUnknownOption(Schema.fromJsonString(HostSettings))

const lastAgent = (settings: HostSettings) => Option.toArray(Option.fromNullishOr(settings.lastAgent))

export class AgentResolver extends Context.Service<AgentResolver, {
  /**
   * The configured agent, or the host's last-used one for `cwd` that still
   * exists. A failure to look one up fails: it says nothing about the others.
   */
  find(conn: LettaConnection, cwd: string): Effect.Effect<Option.Option<string>, AgentUnavailable>
  /** Like `find`, but fails when there is no agent to use. */
  resolve(conn: LettaConnection, cwd: string): Effect.Effect<string, AgentNotFound | AgentUnavailable>
  /** The agent's state, which also confirms that it exists. */
  retrieve(conn: LettaConnection, agentId: string): Effect.Effect<AgentState, AgentNotFound | AgentUnavailable>
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
            Effect.catch((error) => isAgentNotFound(error) ? Effect.succeed(false) : Effect.fail(unavailable(error)))
          ))
        if (Option.isSome(found)) {
          byCwd.set(cwd, found.value)
          yield* Effect.logInfo(`Using the host's last Letta agent ${found.value}`)
        }
        return found
      })

      const resolve = Effect.fn("AgentResolver.resolve")(function*(conn: LettaConnection, cwd: string) {
        const found = yield* find(conn, cwd)
        if (Option.isSome(found)) return found.value
        return yield* new AgentNotFound({
          message: `No Letta agent to use for ${cwd}, and lacp does not create agents. ` +
            "Set LETTA_AGENT_ID or --agent-id, or use an agent with `letta` in this project first."
        })
      })

      const retrieve = Effect.fn("AgentResolver.retrieve")(function*(conn: LettaConnection, agentId: string) {
        // A configured agent that is missing is a mistake to fix there, not a reason to use another.
        const hint = Option.contains(config.agentId, agentId) ? " (set by --agent-id or LETTA_AGENT_ID)" : ""
        const response = yield* retrieved(conn, agentId).pipe(Effect.mapError(agentFailure(agentId, hint)))
        if (response.agent === null) {
          return yield* new AgentNotFound({ message: `Letta has no agent ${agentId}${hint}` })
        }
        return response.agent
      })

      return AgentResolver.of({ find, resolve, retrieve })
    })
  )
}
