import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect"
import { AgentResolver } from "../src/agent/AgentResolver.ts"
import { LacpConfig, type LacpConfigShape } from "../src/Config.ts"
import { Host } from "../src/Host.ts"
import * as Fake from "./helpers/FakeLetta.ts"

/** A resolver on a fresh host home and project directory. */
const setup = (config: Partial<LacpConfigShape> = {}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped()
    const cwd = yield* fs.makeTempDirectoryScoped()
    const context = yield* Layer.build(AgentResolver.layer.pipe(
      Layer.provide(LacpConfig.layerTest({ agentId: Option.none(), ...config })),
      Layer.provide(Host.layerTest({ home, cwd })),
      Layer.provide(NodeServices.layer)
    ))
    return { resolver: Context.get(context, AgentResolver), home, cwd }
  })

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const writeSettings = (dir: string, file: string, settings: unknown) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.join(dir, ".letta"), { recursive: true })
    yield* fs.writeFileString(path.join(dir, ".letta", file), yield* encodeJson(settings))
  })

/** How Letta Code answers `agent_retrieve` for an agent it does not have. */
const missing = (agentId: string) => ({ success: false, agent: null, error: `Agent ${agentId} not found` })

describe("AgentResolver", () => {
  it.live("uses the configured agent", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { resolver, cwd } = yield* setup({ agentId: Option.some("agent-configured") })
      assert.deepStrictEqual(yield* resolver.find(fake.connection, cwd), Option.some("agent-configured"))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("uses the agent the host last used in the project, skipping ones Letta no longer has", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("agent_retrieve", (command: any) =>
        command.agent_id === "agent-gone"
          ? { success: true, agent: null }
          : { success: true, agent: { id: command.agent_id } })
      const { resolver, home, cwd } = yield* setup()
      yield* writeSettings(cwd, "settings.local.json", { lastSession: { agentId: "agent-gone" } })
      yield* writeSettings(home, "settings.json", { lastAgent: "agent-global" })
      assert.deepStrictEqual(yield* resolver.find(fake.connection, cwd), Option.some("agent-global"))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("skips host agents Letta reports as missing, in the shape Letta Code reports them", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("agent_retrieve", (command: any) =>
        command.agent_id === "agent-gone"
          ? missing(command.agent_id)
          : { success: true, agent: { id: command.agent_id } })
      const { resolver, home, cwd } = yield* setup()
      yield* writeSettings(cwd, "settings.local.json", { lastAgent: "agent-gone" })
      yield* writeSettings(home, "settings.json", { lastAgent: "agent-global" })
      assert.deepStrictEqual(yield* resolver.find(fake.connection, cwd), Option.some("agent-global"))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("reports a failure to reach Letta instead of moving on to another host agent", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("agent_retrieve", () => ({ success: false, agent: null, error: "fetch failed: ECONNREFUSED" }))
      const { resolver, home, cwd } = yield* setup()
      yield* writeSettings(cwd, "settings.local.json", { lastAgent: "agent-project" })
      yield* writeSettings(home, "settings.json", { lastAgent: "agent-global" })
      const error = yield* resolver.find(fake.connection, cwd).pipe(Effect.flip)
      assert.strictEqual(error._tag, "AgentUnavailable")
      assert.isFalse(error.auth)
      assert.include(error.message, "ECONNREFUSED")
      const asked = (yield* Ref.get(fake.commands)).filter((c) => c.type === "agent_retrieve")
      assert.strictEqual(asked.length, 1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("marks a failed lookup that needs a sign-in", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("agent_retrieve", () => ({ success: false, agent: null, error: "401 Unauthorized" }))
      const { resolver, home, cwd } = yield* setup()
      yield* writeSettings(home, "settings.json", { lastAgent: "agent-global" })
      const error = yield* resolver.resolve(fake.connection, cwd).pipe(Effect.flip)
      assert.strictEqual(error._tag, "AgentUnavailable")
      assert.isTrue(error._tag === "AgentUnavailable" && error.auth)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("fails clearly with no usable agent, and writes nothing to the project", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const fake = yield* Fake.make
      const { resolver, cwd } = yield* setup()
      assert.isTrue(Option.isNone(yield* resolver.find(fake.connection, cwd)))
      const error = yield* resolver.resolve(fake.connection, cwd).pipe(Effect.flip)
      assert.strictEqual(error._tag, "AgentNotFound")
      assert.include(error.message, "LETTA_AGENT_ID")
      assert.include(error.message, cwd)
      assert.deepStrictEqual(yield* fs.readDirectory(cwd), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("resolves to the host's agent, remembered for the directory", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { resolver, cwd } = yield* setup()
      yield* writeSettings(cwd, "settings.local.json", { lastAgent: "agent-project" })
      assert.strictEqual(yield* resolver.resolve(fake.connection, cwd), "agent-project")
      assert.strictEqual(yield* resolver.resolve(fake.connection, cwd), "agent-project")
      const asked = (yield* Ref.get(fake.commands)).filter((c) => c.type === "agent_retrieve")
      assert.strictEqual(asked.length, 1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("tells a missing agent from a failure to look it up", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { resolver } = yield* setup()
      yield* fake.on("agent_retrieve", (command: any) => missing(command.agent_id))
      const absent = yield* resolver.retrieve(fake.connection, "agent-x").pipe(Effect.flip)
      assert.strictEqual(absent._tag, "AgentNotFound")
      yield* fake.on("agent_retrieve", () => ({ success: false, agent: null, error: "socket hang up" }))
      const unreachable = yield* resolver.retrieve(fake.connection, "agent-x").pipe(Effect.flip)
      assert.strictEqual(unreachable._tag, "AgentUnavailable")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
