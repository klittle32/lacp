import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Option, Path, Ref } from "effect"
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

const writeSettings = (dir: string, file: string, settings: unknown) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.join(dir, ".letta"), { recursive: true })
    yield* fs.writeFileString(path.join(dir, ".letta", file), JSON.stringify(settings))
  })

const created = (fake: Fake.FakeLetta) =>
  Ref.get(fake.commands).pipe(Effect.map((all) => all.filter((c) => c.type === "create_agent").length))

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
      assert.strictEqual(yield* created(fake), 0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("creates an agent only when asked to, once per directory", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { resolver, cwd } = yield* setup()
      assert.isTrue(Option.isNone(yield* resolver.find(fake.connection, cwd)))
      assert.strictEqual(yield* resolver.findOrCreate(fake.connection, cwd), Fake.AGENT_ID)
      assert.strictEqual(yield* resolver.findOrCreate(fake.connection, cwd), Fake.AGENT_ID)
      assert.deepStrictEqual(yield* resolver.find(fake.connection, cwd), Option.some(Fake.AGENT_ID))
      assert.strictEqual(yield* created(fake), 1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("records a new agent in the project's settings, so later processes keep talking to it", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const fake = yield* Fake.make
      const { resolver, cwd } = yield* setup()
      yield* writeSettings(cwd, "settings.local.json", { permissions: { allow: ["Read"] } })
      assert.strictEqual(yield* resolver.findOrCreate(fake.connection, cwd), Fake.AGENT_ID)
      const settings = JSON.parse(yield* fs.readFileString(path.join(cwd, ".letta", "settings.local.json")))
      assert.deepStrictEqual(settings, { permissions: { allow: ["Read"] }, lastAgent: Fake.AGENT_ID })

      // A later process on the same project finds it without creating another.
      const later = yield* Layer.build(AgentResolver.layer.pipe(
        Layer.provide(LacpConfig.layerTest({ agentId: Option.none() })),
        Layer.provide(Host.layerTest({ home: yield* fs.makeTempDirectoryScoped(), cwd })),
        Layer.provide(NodeServices.layer)
      ))
      assert.deepStrictEqual(
        yield* Context.get(later, AgentResolver).find(fake.connection, cwd),
        Option.some(Fake.AGENT_ID)
      )
      assert.strictEqual(yield* created(fake), 1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("leaves a project settings file that is not a JSON object alone", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const fake = yield* Fake.make
      const { resolver, cwd } = yield* setup()
      const file = path.join(cwd, ".letta", "settings.local.json")
      yield* fs.makeDirectory(path.join(cwd, ".letta"), { recursive: true })
      yield* fs.writeFileString(file, "{ not json")
      assert.strictEqual(yield* resolver.findOrCreate(fake.connection, cwd), Fake.AGENT_ID)
      assert.strictEqual(yield* fs.readFileString(file), "{ not json")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
