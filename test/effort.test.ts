import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Ref } from "effect"
import { LettaAppServer } from "../src/letta/AppServer.ts"
import { initializeHybrid, initializeV1, start, startWith } from "./helpers/AcpClient.ts"
import * as Fake from "./helpers/FakeLetta.ts"

const setup = (fake: Fake.FakeLetta) =>
  Effect.gen(function*() {
    const client = yield* start(fake)
    yield* client.request("initialize", initializeHybrid)
    const created = yield* client.request("session/new", { cwd: "/work" })
    return { client, sessionId: created.result.sessionId as string, created }
  })

/** `session/set_config_option` as T3 Code sends it (v2). */
const set = (client: Effect.Success<ReturnType<typeof start>>, sessionId: string, configId: string, value: string) =>
  client.request("session/set_config_option", { sessionId, configId, type: "id", value })

/** A v2 prompt, which gives the session its conversation. */
const prompt = (client: Effect.Success<ReturnType<typeof start>>, sessionId: string) =>
  client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })

const option = (options: ReadonlyArray<any>, id: string) => options.find((o) => o.configId === id || o.id === id)

const updates = (fake: Fake.FakeLetta) =>
  Ref.get(fake.commands).pipe(
    Effect.map((all) => all.flatMap((c) => (c.type === "update_model" ? [c.payload] : [])))
  )

describe("effort", () => {
  it.live("offers each model's levels as a thought_level option after the model", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { created } = yield* setup(fake)
      const options = created.result.configOptions
      assert.deepStrictEqual(options.map((o: any) => o.configId), ["model", "effort", "mode"])
      const effort = option(options, "effort")
      assert.strictEqual(effort.category, "thought_level")
      assert.strictEqual(effort.currentValue, "medium")
      assert.deepStrictEqual(effort.options.map((o: any) => [o.value, o.name]), [
        ["low", "Low"],
        ["medium", "Medium"],
        ["high", "High"]
      ])
      assert.deepStrictEqual(option(options, "model").options.map((o: any) => o.name), [
        "Claude Sonnet · anthropic",
        "GPT-5 · openai"
      ])
      assert.deepStrictEqual(yield* Ref.get(fake.cliCalls), [["model", "list"]])
    }))

  it.live("sets effort through the model's preset, once the first prompt creates the conversation", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      const reply = yield* set(client, sessionId, "effort", "high")
      assert.strictEqual(option(reply.result.configOptions, "effort").currentValue, "high")
      // Nothing is sent to Letta before the session has a conversation.
      assert.deepStrictEqual(yield* updates(fake), [])
      yield* prompt(client, sessionId)
      assert.deepStrictEqual(yield* updates(fake), [{ model_id: "sonnet-high", model_handle: Fake.MODEL }])
      // Afterwards, changes apply right away.
      yield* set(client, sessionId, "effort", "low")
      assert.deepStrictEqual((yield* updates(fake)).at(-1), { model_id: "sonnet-low", model_handle: Fake.MODEL })
    }))

  it.live("keeps the effort when switching to a model that sets it with `letta model set`", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      yield* prompt(client, sessionId)
      const conversation = yield* fake.conversation
      yield* set(client, sessionId, "effort", "high")
      const reply = yield* set(client, sessionId, "model", Fake.BYOK_MODEL)
      const effort = option(reply.result.configOptions, "effort")
      assert.deepStrictEqual(effort.options.map((o: any) => o.value), ["minimal", "low", "medium", "high"])
      assert.strictEqual(effort.currentValue, "high")
      assert.deepStrictEqual((yield* updates(fake)).at(-1), {
        model_id: Fake.BYOK_MODEL,
        model_handle: Fake.BYOK_MODEL
      })
      assert.deepStrictEqual(
        (yield* Ref.get(fake.cliCalls)).at(-1),
        ["model", "set", "--conversation", conversation, "--reasoning", "high"]
      )
    }))

  it.live("applies a model and effort chosen before the first prompt to the new conversation", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      yield* set(client, sessionId, "model", Fake.BYOK_MODEL)
      const reply = yield* set(client, sessionId, "effort", "minimal")
      assert.strictEqual(option(reply.result.configOptions, "effort").currentValue, "minimal")
      assert.deepStrictEqual(yield* updates(fake), [])
      yield* prompt(client, sessionId)
      const conversation = yield* fake.conversation
      assert.deepStrictEqual(yield* updates(fake), [{ model_id: Fake.BYOK_MODEL, model_handle: Fake.BYOK_MODEL }])
      assert.deepStrictEqual(
        (yield* Ref.get(fake.cliCalls)).at(-1),
        ["model", "set", "--conversation", conversation, "--reasoning", "minimal"]
      )
    }))

  it.live("rejects levels the model does not support", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      const reply = yield* set(client, sessionId, "effort", "max")
      assert.strictEqual(reply.error?.code, -32602)
    }))

  it.live("falls back to preset levels when `letta model list` is unavailable (v1)", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* startWith(LettaAppServer.layerConnection(fake.connection), {
        config: { agentId: Option.some(Fake.AGENT_ID) },
        host: { home: "/nonexistent-home", cwd: "/work" }
      })
      yield* client.request("initialize", initializeV1)
      const created = yield* client.request("session/new", { cwd: "/work", mcpServers: [] })
      const sessionId = created.result.sessionId as string
      assert.deepStrictEqual(option(created.result.configOptions, "effort").options.map((o: any) => o.value), [
        "low",
        "medium",
        "high"
      ])
      // A model without presets has no levels to offer without `letta model list`.
      const reply = yield* client.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: Fake.BYOK_MODEL
      })
      assert.deepStrictEqual(reply.result.configOptions.map((o: any) => o.id), ["model", "mode"])
    }))

  it.live("retries a failed model listing for the next session", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const failures = yield* Ref.make(1)
      yield* fake.on("list_models", () =>
        Ref.modify(failures, (n) => [n, n - 1]).pipe(
          Effect.map((n) =>
            n > 0 ? { success: false, error: "warming up" } : { success: true, entries: Fake.MODEL_ENTRIES }
          )
        ))
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const first = yield* client.request("session/new", { cwd: "/work" })
      assert.isUndefined(option(first.result.configOptions, "effort"))
      const second = yield* client.request("session/new", { cwd: "/work" })
      assert.isDefined(option(second.result.configOptions, "effort"))
    }))
})
