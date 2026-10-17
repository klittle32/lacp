import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import { LettaAppServer } from "../src/letta/AppServer.ts"
import { initializeHybrid, initializeV1, projectDir, sent, setupV2, start, startWith } from "./helpers/AcpClient.ts"
import * as Fake from "./helpers/FakeLetta.ts"

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
  it.live("offers the model's levels as a thought_level option after the model", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeV1)
      const created = yield* client.request("session/new", { cwd: "/work", mcpServers: [] })
      const options = created.result.configOptions
      assert.deepStrictEqual(options.map((o: any) => o.id), ["model", "reasoning_effort", "mode"])
      const effort = option(options, "reasoning_effort")
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
      const { client, sessionId } = yield* setupV2(fake)
      const reply = yield* set(client, sessionId, "reasoning_effort", "high")
      assert.strictEqual(option(reply.result.configOptions, "reasoning_effort").currentValue, "high")
      // Nothing is sent to Letta before the session has a conversation.
      assert.deepStrictEqual(yield* updates(fake), [])
      yield* prompt(client, sessionId)
      assert.deepStrictEqual(yield* updates(fake), [{ model_id: "sonnet-high", model_handle: Fake.MODEL }])
      // Afterwards, changes apply right away.
      yield* set(client, sessionId, "reasoning_effort", "low")
      assert.deepStrictEqual((yield* updates(fake)).at(-1), { model_id: "sonnet-low", model_handle: Fake.MODEL })
    }))

  it.live("keeps the effort when switching to a model that sets it with `letta model set`", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setupV2(fake)
      yield* prompt(client, sessionId)
      const conversation = yield* fake.conversation
      yield* set(client, sessionId, "reasoning_effort", "high")
      const reply = yield* set(client, sessionId, "model", Fake.BYOK_MODEL)
      const effort = option(reply.result.configOptions, "reasoning_effort")
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
      const { client, sessionId } = yield* setupV2(fake)
      yield* set(client, sessionId, "model", Fake.BYOK_MODEL)
      const reply = yield* set(client, sessionId, "reasoning_effort", "minimal")
      assert.strictEqual(option(reply.result.configOptions, "reasoning_effort").currentValue, "minimal")
      assert.deepStrictEqual(yield* updates(fake), [])
      yield* prompt(client, sessionId)
      const conversation = yield* fake.conversation
      assert.deepStrictEqual(yield* updates(fake), [{ model_id: Fake.BYOK_MODEL, model_handle: Fake.BYOK_MODEL }])
      assert.deepStrictEqual(
        (yield* Ref.get(fake.cliCalls)).at(-1),
        ["model", "set", "--conversation", conversation, "--reasoning", "minimal"]
      )
    }))

  it.live("offers effort before the first prompt creates the session's agent", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const cwd = projectDir()
      const client = yield* start(fake, { agentId: Option.none() })
      yield* client.request("initialize", initializeHybrid)
      const created = yield* client.request("session/new", { cwd })
      const sessionId = created.result.sessionId as string
      const options = created.result.configOptions
      assert.deepStrictEqual(options.map((o: any) => o.configId), ["model", "reasoning_effort", "mode"])
      assert.strictEqual(option(options, "model").currentValue, Fake.MODEL)
      assert.strictEqual(option(options, "reasoning_effort").currentValue, "medium")
      yield* set(client, sessionId, "reasoning_effort", "high")
      assert.strictEqual((yield* sent(fake, "create_agent")).length, 0)
      yield* prompt(client, sessionId)
      assert.strictEqual((yield* sent(fake, "create_agent")).length, 1)
      assert.deepStrictEqual(yield* updates(fake), [{ model_id: "sonnet-high", model_handle: Fake.MODEL }])
    }))

  it.live("gives a new conversation the effort shown before it existed", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const cwd = projectDir()
      // Letta creates the conversation without reasoning; the session showed medium.
      yield* fake.on("runtime_start", (command: any) => ({
        success: true,
        runtime: { agent_id: command.agent_id, conversation_id: "conv-new" },
        agent: { id: command.agent_id, name: "Test", model: Fake.MODEL },
        conversation: {
          id: "conv-new",
          agent_id: command.agent_id,
          summary: null,
          model: Fake.MODEL,
          model_settings: { reasoning_effort: "none", context_window_limit: 200_000 }
        },
        created: { agent: false, conversation: true }
      }))
      const client = yield* start(fake, { agentId: Option.none() })
      yield* client.request("initialize", initializeHybrid)
      const created = yield* client.request("session/new", { cwd })
      assert.strictEqual(option(created.result.configOptions, "reasoning_effort").currentValue, "medium")
      yield* prompt(client, created.result.sessionId)
      assert.deepStrictEqual(yield* updates(fake), [{ model_id: "sonnet-medium", model_handle: Fake.MODEL }])
    }))

  it.live("offers a model on the user's own provider the hosted model's levels, set in its model settings", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const grok = (effort: string) => ({
        id: `grok-${effort}`,
        handle: "xai/grok-4.7",
        label: "Grok 4.7",
        description: null,
        updateArgs: { reasoning_effort: effort, context_window: 500_000 }
      })
      yield* fake.on("list_models", () => ({
        success: true,
        entries: [
          ...Fake.MODEL_ENTRIES,
          grok("low"),
          grok("high"),
          {
            id: "lc-xai/grok-4.7",
            handle: "lc-xai/grok-4.7",
            label: "Grok 4.7",
            description: null,
            updateArgs: { reasoning_effort: "low", context_window: 500_000, provider_type: "xai" }
          }
        ]
      }))
      const { client, sessionId } = yield* setupV2(fake)
      yield* prompt(client, sessionId)
      const conversation = yield* fake.conversation
      yield* set(client, sessionId, "model", "lc-xai/grok-4.7")
      const reply = yield* set(client, sessionId, "reasoning_effort", "high")
      assert.strictEqual(option(reply.result.configOptions, "reasoning_effort").currentValue, "high")
      const update = (yield* Ref.get(fake.commands)).findLast((c) => c.type === "conversation_update") as any
      assert.strictEqual(update.conversation_id, conversation)
      assert.strictEqual(update.body.model, "lc-xai/grok-4.7")
      assert.deepStrictEqual(update.body.model_settings.reasoning_effort, "high")
      // `letta model set` refuses levels such a model does not advertise, so it is not used.
      assert.isFalse((yield* Ref.get(fake.cliCalls)).some((args) => args[1] === "set"))
    }))

  it.live("accepts the earlier `effort` id", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setupV2(fake)
      const reply = yield* set(client, sessionId, "effort", "high")
      assert.strictEqual(option(reply.result.configOptions, "reasoning_effort").currentValue, "high")
    }))

  it.live("offers T3 Code every model's levels, since it shows them for all models", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { created } = yield* setupV2(fake)
      const effort = option(created.result.configOptions, "reasoning_effort")
      assert.deepStrictEqual(effort.options.map((o: any) => o.value), ["minimal", "low", "medium", "high"])
      assert.strictEqual(effort.currentValue, "medium")
    }))

  it.live("sets the closest level the model supports, and rejects unknown levels", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setupV2(fake)
      const max = yield* set(client, sessionId, "reasoning_effort", "max")
      assert.strictEqual(option(max.result.configOptions, "reasoning_effort").currentValue, "high")
      const minimal = yield* set(client, sessionId, "reasoning_effort", "minimal")
      assert.strictEqual(option(minimal.result.configOptions, "reasoning_effort").currentValue, "low")
      const unknown = yield* set(client, sessionId, "reasoning_effort", "ultra")
      assert.strictEqual(unknown.error?.code, -32602)
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
      assert.deepStrictEqual(
        option(created.result.configOptions, "reasoning_effort").options.map((o: any) => o.value),
        [
          "low",
          "medium",
          "high"
        ]
      )
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
      assert.isUndefined(option(first.result.configOptions, "reasoning_effort"))
      const second = yield* client.request("session/new", { cwd: "/work" })
      assert.isDefined(option(second.result.configOptions, "reasoning_effort"))
    }))

  it.live("lists the models once for sessions that open together", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const release = yield* Deferred.make<void>()
      yield* fake.on("list_models", () =>
        Deferred.await(release).pipe(Effect.as({ success: true, entries: Fake.MODEL_ENTRIES })))
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const opening = yield* Effect.all([
        client.request("session/new", { cwd: "/work" }),
        client.request("session/new", { cwd: "/work" })
      ], { concurrency: "unbounded" }).pipe(Effect.forkChild)
      // Both sessions are reading their agent while the models are being listed.
      while ((yield* sent(fake, "agent_retrieve")).length < 2 || (yield* sent(fake, "list_models")).length < 1) {
        yield* Effect.sleep("5 millis")
      }
      yield* Effect.sleep("20 millis")
      yield* Deferred.succeed(release, undefined)
      const [first, second] = yield* Fiber.join(opening)
      assert.isDefined(option(first.result.configOptions, "reasoning_effort"))
      assert.isDefined(option(second.result.configOptions, "reasoning_effort"))
      assert.strictEqual((yield* sent(fake, "list_models")).length, 1)
      assert.deepStrictEqual(yield* Ref.get(fake.cliCalls), [["model", "list"]])
    }))

  it.live("lists the models again on a restarted App Server", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const current = yield* Ref.make(fake.connection)
      const client = yield* startWith(
        Layer.succeed(
          LettaAppServer,
          LettaAppServer.of({ connection: Ref.get(current), warmup: Effect.void, cli: fake.cli })
        ),
        { config: { agentId: Option.some(Fake.AGENT_ID) }, host: { home: "/nonexistent-home", cwd: "/work" } }
      )
      yield* client.request("initialize", initializeHybrid)
      const before = yield* client.request("session/new", { cwd: "/work" })
      assert.strictEqual(option(before.result.configOptions, "model").options.length, 2)

      // The restarted App Server offers one more model.
      yield* fake.on("list_models", () => ({
        success: true,
        entries: [...Fake.MODEL_ENTRIES, { id: "openai/gpt-5-mini", handle: "openai/gpt-5-mini", label: "GPT-5 mini" }]
      }))
      yield* Ref.set(current, { ...fake.connection, generation: 2 })
      const after = yield* client.request("session/new", { cwd: "/work" })
      assert.strictEqual(option(after.result.configOptions, "model").options.length, 3)
      assert.strictEqual((yield* sent(fake, "list_models")).length, 2)
    }))
})
