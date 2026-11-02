/**
 * Sessions get their Letta conversation (and, where none is set up, their
 * agent) with their first prompt, so a client that opens sessions only to
 * read their settings, as T3 Code does each time it checks its providers,
 * leaves nothing behind in Letta.
 */
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Option } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { SessionIds } from "../src/agent/SessionIds.ts"
import { Host } from "../src/Host.ts"
import { initializeHybrid, isInput, projectDir, sent, start, text } from "./helpers/AcpClient.ts"
import * as Fake from "./helpers/FakeLetta.ts"

describe("lazy conversations", () => {
  it.live("opens a session without creating anything in Letta, and creates it with the first prompt", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const cwd = projectDir()
      // No agent is configured or known on this host, so the first prompt creates one too.
      const client = yield* start(fake, { agentId: Option.none() })
      yield* client.request("initialize", initializeHybrid)
      // T3 Code's provider check: open a session, read its settings, close it.
      const probe = yield* client.request("session/new", { cwd })
      yield* client.request("session/close", { sessionId: probe.result.sessionId })

      const created = yield* client.request("session/new", { cwd })
      const sessionId = created.result.sessionId as string
      assert.match(sessionId, /^lacp-/)
      assert.notStrictEqual(sessionId, probe.result.sessionId)
      assert.strictEqual(
        created.result.configOptions.find((o: any) => o.configId === "mode").currentValue,
        "unrestricted"
      )
      assert.strictEqual((yield* sent(fake, "create_agent")).length, 0)
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 0)

      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      assert.strictEqual((yield* sent(fake, "create_agent")).length, 1)
      const [runtimeStart] = yield* sent(fake, "runtime_start")
      assert.deepStrictEqual(runtimeStart.create_conversation, { body: {} })
      assert.strictEqual(runtimeStart.mode, "unrestricted")
      const input = (yield* fake.waitFor(isInput)) as any
      assert.strictEqual(input.runtime.conversation_id, yield* fake.conversation)
    }))

  it.live("starts the conversation in the mode chosen before the first prompt", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      const chosen = yield* client.request("session/set_config_option", {
        sessionId,
        configId: "mode",
        type: "id",
        value: "acceptEdits"
      })
      assert.strictEqual(
        chosen.result.configOptions.find((o: any) => o.configId === "mode").currentValue,
        "acceptEdits"
      )
      assert.strictEqual((yield* sent(fake, "change_device_state")).length, 0)

      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      const [runtimeStart] = yield* sent(fake, "runtime_start")
      assert.strictEqual(runtimeStart.mode, "acceptEdits")
    }))

  it.live("starts new sessions in the mode LACP_PERMISSION_MODE sets", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake, { permissionMode: Option.some("strict") })
      yield* client.request("initialize", initializeHybrid)
      const created = yield* client.request("session/new", { cwd: "/work" })
      const sessionId = created.result.sessionId as string
      assert.strictEqual(created.result.configOptions.find((o: any) => o.configId === "mode").currentValue, "strict")
      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      const [runtimeStart] = yield* sent(fake, "runtime_start")
      assert.strictEqual(runtimeStart.mode, "strict")
    }))

  it.live("rejects unknown config options, before and after the first prompt", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      const set = (configId: string) =>
        client.request("session/set_config_option", { sessionId, configId, type: "id", value: "x" })
      // Names an object has anyway are no exception.
      assert.strictEqual((yield* set("constructor")).error?.code, -32602)
      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      assert.strictEqual((yield* set("constructor")).error?.code, -32602)
      assert.strictEqual((yield* set("toString")).error?.code, -32602)
    }))

  it.live("reopens a session closed before its first prompt, still without a conversation", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* client.request("session/close", { sessionId })
      const resumed = yield* client.request("session/resume", { sessionId, cwd: "/work" })
      assert.isDefined(resumed.result)
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 0)

      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      const [runtimeStart] = yield* sent(fake, "runtime_start")
      assert.deepStrictEqual(runtimeStart.create_conversation, { body: {} })
    }))

  it.live("resumes and lists a prompted session under its own id", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      const conversation = yield* fake.conversation
      yield* fake.emit(Fake.turnFinished(conversation))
      yield* client.update((u) => u.sessionUpdate === "state_update" && u.state === "idle")

      yield* fake.on("conversation_list", () => ({
        success: true,
        conversations: [{ id: conversation, agent_id: Fake.AGENT_ID, summary: "Say hello", last_message_at: null }]
      }))
      const listed = yield* client.request("session/list", {})
      assert.deepStrictEqual(listed.result.sessions.map((s: any) => s.sessionId), [sessionId])

      yield* client.request("session/close", { sessionId })
      const resumed = yield* client.request("session/resume", { sessionId, cwd: "/work" })
      assert.isDefined(resumed.result)
      const starts = yield* sent(fake, "runtime_start")
      assert.strictEqual(starts.length, 2)
      assert.strictEqual(starts[1].conversation_id, conversation)
    }))
})

describe("concurrent session requests", () => {
  /** A conversation lookup slow enough for concurrent requests to overlap. */
  const slowRetrieve = (fake: Fake.FakeLetta) =>
    fake.on("conversation_retrieve", (command: any) =>
      Effect.sleep("30 millis").pipe(Effect.as({
        success: true,
        conversation: { id: command.conversation_id, agent_id: Fake.AGENT_ID }
      })))

  const chunks = (client: { readonly updates: Effect.Effect<ReadonlyArray<any>> }) =>
    client.updates.pipe(Effect.map((all) => all.filter((u) => u.sessionUpdate === "agent_message_chunk")))

  const say = (fake: Fake.FakeLetta, conversation: string) =>
    fake.emit(Fake.delta(conversation, {
      message_type: "assistant_message",
      id: "m1",
      otid: "m1",
      run_id: "r1",
      seq_id: 1,
      content: [{ type: "text", text: "hi" }]
    }))

  it.live("gives several prompts' sessions in one directory one new agent", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("create_agent", () =>
        Effect.sleep("20 millis").pipe(Effect.as({ success: true, agent_id: Fake.AGENT_ID })))
      const cwd = projectDir()
      const client = yield* start(fake, { agentId: Option.none() })
      yield* client.request("initialize", initializeHybrid)
      const first = (yield* client.request("session/new", { cwd })).result.sessionId as string
      const second = (yield* client.request("session/new", { cwd })).result.sessionId as string
      yield* Effect.forEach(
        [first, second],
        (sessionId) =>
          client.request("session/prompt", { sessionId, prompt: text("hello") }),
        { concurrency: "unbounded" }
      )
      assert.strictEqual((yield* sent(fake, "create_agent")).length, 1)
    }))

  it.live("opens a session resumed twice at once only once", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* slowRetrieve(fake)
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const resumes = yield* Effect.forEach(
        [1, 2],
        () => client.request("session/resume", { sessionId: "conv-old", cwd: "/work" }),
        { concurrency: "unbounded" }
      )
      assert.isTrue(resumes.every((r) => r.result !== undefined))
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 1)

      // Only one runtime follows the conversation, so its output reaches the client once.
      yield* say(fake, "conv-old")
      yield* client.update((u) => u.sessionUpdate === "agent_message_chunk")
      yield* Effect.sleep("30 millis")
      assert.strictEqual((yield* chunks(client)).length, 1)
    }))

  it.live("opens a session that has no conversation yet, resumed twice at once, only once", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* client.request("session/close", { sessionId })
      const before = (yield* sent(fake, "agent_retrieve")).length
      yield* Effect.forEach(
        [1, 2],
        () => client.request("session/resume", { sessionId, cwd: "/work" }),
        { concurrency: "unbounded" }
      )
      assert.strictEqual((yield* sent(fake, "agent_retrieve")).length - before, 1)
    }))

  it.live("leaves one live runtime when a session is resumed from two directories at once", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* slowRetrieve(fake)
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      yield* Effect.forEach(
        ["/work", "/elsewhere"],
        (cwd) => client.request("session/resume", { sessionId: "conv-old", cwd }),
        { concurrency: "unbounded" }
      )
      yield* say(fake, "conv-old")
      yield* client.update((u) => u.sessionUpdate === "agent_message_chunk")
      yield* Effect.sleep("30 millis")
      assert.strictEqual((yield* chunks(client)).length, 1)
    }))

  it.live("lets a session open after a cancelled attempt to open it", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("conversation_retrieve", () => Effect.never)
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      yield* client.raw(JSON.stringify({
        jsonrpc: "2.0",
        id: "stuck",
        method: "session/resume",
        params: { sessionId: "conv-old", cwd: "/work" }
      }))
      yield* fake.waitFor((c) => c.type === "conversation_retrieve")
      yield* client.notify("$/cancel_request", { requestId: "stuck" })
      yield* client.next((m) => m.id === "stuck")

      yield* slowRetrieve(fake)
      const resumed = yield* client.request("session/resume", { sessionId: "conv-old", cwd: "/work" })
      assert.isDefined(resumed.result)
    }))

  it.live("closes a session whose close arrives while it is still opening", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* slowRetrieve(fake)
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      yield* Effect.all([
        client.request("session/resume", { sessionId: "conv-old", cwd: "/work" }),
        Effect.sleep("5 millis").pipe(
          Effect.andThen(client.request("session/close", { sessionId: "conv-old" }))
        )
      ], { concurrency: "unbounded" })
      assert.strictEqual(
        (yield* client.request("session/prompt", { sessionId: "conv-old", prompt: text("x") })).error?.code,
        -32002
      )
    }))
})

describe("SessionIds", () => {
  const ids = (home: string) =>
    Layer.build(SessionIds.layer.pipe(
      Layer.provide(Host.layerTest({ home })),
      Layer.provide(NodeServices.layer),
      Layer.provide(SecureRandom.layerWebCrypto)
    )).pipe(Effect.map((context) => Context.get(context, SessionIds)))

  it.live("remembers a session's conversation across processes", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const first = yield* ids(home)
      const sessionId = yield* first.make
      assert.isTrue(first.isProvisional(sessionId))
      assert.isTrue(Option.isNone(yield* first.conversationOf(sessionId)))
      yield* first.record(sessionId, "conv-1")

      // A later lacp process reads what this one wrote.
      const later = yield* ids(home)
      assert.deepStrictEqual(yield* later.conversationOf(sessionId), Option.some("conv-1"))
      assert.deepStrictEqual(yield* later.sessionOf("conv-1"), Option.some(sessionId))
      assert.isTrue(Option.isNone(yield* later.sessionOf("conv-2")))
      // Ids that are not safe file names are never read from disk.
      assert.isTrue(Option.isNone(yield* later.conversationOf("../lacp-x")))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
