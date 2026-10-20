/**
 * A scripted ACP client for tests: it talks JSON-RPC to the server over an
 * in-memory transport, records every `session/update`, and answers the
 * agent's own requests (permissions) with a configurable policy.
 */
import { NodePath, NodeServices } from "@effect/platform-node"
import { type Cause, Context, Deferred, Effect, Layer, Option, PubSub, Queue, Ref, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpServer } from "../../src/agent/AcpServer.ts"
import { Agent } from "../../src/agent/Agent.ts"
import { AgentResolver } from "../../src/agent/AgentResolver.ts"
import { AcpClient } from "../../src/agent/Client.ts"
import { SessionIds } from "../../src/agent/SessionIds.ts"
import { Settings } from "../../src/agent/Settings.ts"
import { LacpConfig, type LacpConfigShape } from "../../src/Config.ts"
import { Host, type HostShape } from "../../src/Host.ts"
import { JsonRpcPeer } from "../../src/jsonrpc/Peer.ts"
import { Transport } from "../../src/jsonrpc/Transport.ts"
import { LettaAppServer } from "../../src/letta/AppServer.ts"
import { McpBridges } from "../../src/mcp/Bridge.ts"
import { AGENT_ID, type FakeLetta } from "./FakeLetta.ts"

/** What an App Server layer may depend on in tests. */
type LettaAppServerDeps = LacpConfig | Host | NodeServices.NodeServices

const Json = Schema.fromJsonString(Schema.Unknown)
const decode = Schema.decodeUnknownSync(Json)
const encode = Schema.encodeSync(Json)

export interface Message {
  readonly jsonrpc: "2.0"
  readonly id?: number | string | null
  readonly method?: string
  readonly params?: any
  readonly result?: any
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export type PermissionPolicy = (params: any) => unknown

export interface TestClient {
  request(method: string, params?: unknown): Effect.Effect<Message>
  notify(method: string, params?: unknown): Effect.Effect<void>
  /** Sends a raw line. */
  raw(line: string): Effect.Effect<void>
  /** The next message the server wrote that matches. */
  next(predicate: (message: Message) => boolean): Effect.Effect<Message>
  /** All `session/update` payloads so far. */
  readonly updates: Effect.Effect<ReadonlyArray<any>>
  /** Waits for a `session/update` whose `update` matches, at or after index `from`. */
  update(predicate: (update: any) => boolean, from?: number): Effect.Effect<any>
  /** Agent-to-client requests received so far. */
  readonly agentRequests: Effect.Effect<ReadonlyArray<Message>>
  setPermissionPolicy(policy: PermissionPolicy): Effect.Effect<void>
}

export const allowOnce: PermissionPolicy = (params) => ({
  outcome: { outcome: "selected", optionId: params.options.find((o: any) => o.kind === "allow_once").optionId }
})

/** Starts a full server (real AcpServer/Agent/peer) wired to `fake`, set up (as usual) with an agent to talk to. */
export const start = (fake: FakeLetta, config: Partial<LacpConfigShape> = {}) =>
  startWith(LettaAppServer.layerConnection(fake.connection, fake.cli), {
    config: { agentId: Option.some(AGENT_ID), ...config },
    host: { home: "/nonexistent-home", cwd: "/work" }
  })

/** Starts a full server on any App Server layer. */
export const startWith = <E>(
  appServer: Layer.Layer<LettaAppServer, E, Exclude<LettaAppServerDeps, never>>,
  options: { readonly config?: Partial<LacpConfigShape>; readonly host?: Partial<HostShape> }
) =>
  Effect.gen(function*() {
    const input = yield* Queue.unbounded<string, Cause.Done>()
    const output = yield* Queue.unbounded<string>()
    const messages = yield* PubSub.unbounded<Message>()
    const updates = yield* Ref.make<ReadonlyArray<any>>([])
    const agentRequests = yield* Ref.make<ReadonlyArray<Message>>([])
    const policy = yield* Ref.make<PermissionPolicy>(allowOnce)
    const pending = new Map<number, Deferred.Deferred<Message>>()
    let nextId = 1000

    const layer = AcpServer.layer.pipe(
      Layer.provide(Agent.layer),
      Layer.provide(Settings.layer),
      Layer.provide(SessionIds.layer),
      Layer.provide(AgentResolver.layer),
      Layer.provide(McpBridges.layer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(appServer),
      Layer.provideMerge(AcpClient.layer),
      Layer.provide(JsonRpcPeer.layer),
      Layer.provide(Transport.layerQueues({ input, output })),
      Layer.provide(LacpConfig.layerTest(options.config ?? {})),
      Layer.provide(Host.layerTest(options.host ?? {})),
      // Paths follow the described host (POSIX `/work` by default), whatever platform runs the tests.
      Layer.provide(options.host?.platform === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
      Layer.provide(NodeServices.layer)
    )
    const context = yield* Layer.build(layer)
    const server = Context.get(context, AcpServer)
    yield* Effect.forkScoped(server.serve)

    const write = (message: unknown) => Queue.offer(input, encode(message)).pipe(Effect.asVoid)

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function*() {
          const line = yield* Queue.take(output)
          const message = decode(line) as Message
          yield* PubSub.publish(messages, message)
          if (message.method === "session/update") {
            yield* Ref.update(updates, (all) => [...all, message.params])
          } else if (message.method !== undefined && message.id !== undefined) {
            yield* Ref.update(agentRequests, (all) => [...all, message])
            const answer = (yield* Ref.get(policy))(message.params)
            yield* write({ jsonrpc: "2.0", id: message.id, result: answer })
          } else if (message.id !== undefined && typeof message.id === "number") {
            const waiter = pending.get(message.id)
            if (waiter !== undefined) yield* Deferred.succeed(waiter, message)
          }
        })
      )
    )

    const client: TestClient = {
      request: (method, params) =>
        Effect.gen(function*() {
          const id = nextId++
          const waiter = yield* Deferred.make<Message>()
          pending.set(id, waiter)
          yield* write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
          return yield* Deferred.await(waiter)
        }),
      notify: (method, params) => write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
      raw: (line) => Queue.offer(input, line).pipe(Effect.asVoid),
      next: (predicate) =>
        Effect.gen(function*() {
          const subscription = yield* PubSub.subscribe(messages)
          while (true) {
            const message = yield* PubSub.take(subscription)
            if (predicate(message)) return message
          }
        }).pipe(Effect.scoped),
      updates: Ref.get(updates).pipe(Effect.map((all) => all.map((p) => p.update))),
      update: (predicate, from = 0) =>
        Effect.gen(function*() {
          const subscription = yield* PubSub.subscribe(messages)
          const seen = (yield* Ref.get(updates)).slice(from).map((p) => p.update).find(predicate)
          if (seen !== undefined) return seen
          while (true) {
            const message = yield* PubSub.take(subscription)
            if (message.method === "session/update" && predicate(message.params.update)) return message.params.update
          }
        }).pipe(Effect.scoped),
      agentRequests: Ref.get(agentRequests),
      setPermissionPolicy: (p) => Ref.set(policy, p)
    }
    return client
  })

export const initializeV1 = {
  protocolVersion: 1,
  clientInfo: { name: "test-client", version: "1.0.0" },
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
}

/**
 * A new empty directory for a session whose first prompt creates an agent:
 * lacp records the agent in the directory's `.letta/settings.local.json`.
 */
export const projectDir = () => mkdtempSync(join(tmpdir(), "lacp-project-"))

/** T3 Code's hybrid request: v2 fields plus v1 fields. */
export const initializeHybrid = {
  protocolVersion: 2,
  info: { name: "t3-code", version: "0.0.0" },
  capabilities: { elicitation: { form: {}, url: {} } },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "t3-code", version: "0.0.0" }
}

/** A prompt of one text block. */
export const text = (value: string) => [{ type: "text", text: value }]

/** A command Letta received that submits a prompt. */
export const isInput = (c: any) => c.type === "input" && c.payload.kind === "create_message"

/** The `state_update` that ends a turn. */
export const idle = (u: any) => u.sessionUpdate === "state_update" && u.state === "idle"

/** The commands of `type` sent to Letta so far. */
export const sent = (fake: FakeLetta, type: string) =>
  Ref.get(fake.commands).pipe(Effect.map((all) => all.filter((c) => c.type === type) as Array<any>))

/** A started server with a v1 client and one new session. */
export const setupV1 = (fake: FakeLetta, config: Partial<LacpConfigShape> = {}) =>
  Effect.gen(function*() {
    const client = yield* start(fake, config)
    yield* client.request("initialize", initializeV1)
    const created = yield* client.request("session/new", { cwd: "/work", mcpServers: [] })
    return { client, sessionId: created.result.sessionId as string, created }
  })

/** A started server with a v2 (T3 Code) client and one new session. */
export const setupV2 = (fake: FakeLetta, config: Partial<LacpConfigShape> = {}) =>
  Effect.gen(function*() {
    const client = yield* start(fake, config)
    yield* client.request("initialize", initializeHybrid)
    const created = yield* client.request("session/new", { cwd: "/work" })
    return { client, sessionId: created.result.sessionId as string, created }
  })
