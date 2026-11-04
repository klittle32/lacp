/**
 * Sessions get their Letta conversation with their first prompt, so a client
 * that opens sessions only to read their settings, as T3 Code does each time
 * it checks its providers, leaves nothing behind in Letta. Agents must already
 * exist: lacp never creates them.
 */
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { SessionIds } from "../src/agent/SessionIds.ts"
import { Host } from "../src/Host.ts"
import { ErrorCode } from "../src/jsonrpc/JsonRpc.ts"
import { LettaAppServer } from "../src/letta/AppServer.ts"
import { initializeHybrid, isInput, projectDir, sent, start, startWith, text } from "./helpers/AcpClient.ts"
import * as Fake from "./helpers/FakeLetta.ts"

describe("lazy conversations", () => {
  it.live("opens a session without creating anything in Letta, and creates it with the first prompt", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const cwd = yield* projectDir
      const client = yield* start(fake)
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
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 0)

      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
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

describe("sessions use existing agents only", () => {
  const missing = (agentId: string) => ({ success: false, agent: null, error: `Agent ${agentId} not found` })
  const NOT_FOUND = -32002
  const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

  /** A server on a host whose Letta settings are `settings`, with no agent configured unless `agentId` says so. */
  const startOnHost = (
    fake: Fake.FakeLetta,
    options: { readonly agentId?: string; readonly lastAgent?: string } = {}
  ) =>
    Effect.gen(function*() {
      const home = yield* projectDir
      if (options.lastAgent !== undefined) {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.makeDirectory(path.join(home, ".letta"))
        yield* fs.writeFileString(
          path.join(home, ".letta", "settings.json"),
          yield* encodeJson({ lastAgent: options.lastAgent })
        )
      }
      const client = yield* startWith(LettaAppServer.layerConnection(fake.connection, fake.cli), {
        config: { agentId: Option.fromUndefinedOr(options.agentId) },
        host: { home, cwd: "/work" }
      })
      yield* client.request("initialize", initializeHybrid)
      return client
    }).pipe(Effect.provide(NodeServices.layer))

  it.live("refuses a new session when there is no agent to use, and never asks Letta to create one", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const cwd = yield* projectDir
      const client = yield* startOnHost(fake)
      const created = yield* client.request("session/new", { cwd })
      assert.strictEqual(created.error?.code, NOT_FOUND)
      assert.include(created.error?.message, "LETTA_AGENT_ID")
      assert.deepStrictEqual((yield* Ref.get(fake.commands)).map((c) => c.type).filter((t) => t !== "list_models"), [])
      const fs = yield* FileSystem.FileSystem
      assert.deepStrictEqual(yield* fs.readDirectory(cwd), [])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("uses the host's last agent, creating only a conversation with the first prompt", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* startOnHost(fake, { lastAgent: "agent-host" })
      const sessionId = (yield* client.request("session/new", { cwd: yield* projectDir })).result.sessionId as string
      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      const [runtimeStart] = yield* sent(fake, "runtime_start")
      assert.strictEqual(runtimeStart.agent_id, "agent-host")
      assert.deepStrictEqual(runtimeStart.create_conversation, { body: {} })
      assert.strictEqual((yield* sent(fake, "create_agent")).length, 0)
    }))

  it.live("does not fall back from a configured agent Letta does not have", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("agent_retrieve", (command: any) =>
        command.agent_id === "agent-typo"
          ? missing(command.agent_id)
          : { success: true, agent: { id: command.agent_id } })
      const client = yield* startOnHost(fake, { agentId: "agent-typo", lastAgent: "agent-host" })
      const created = yield* client.request("session/new", { cwd: yield* projectDir })
      assert.strictEqual(created.error?.code, NOT_FOUND)
      assert.include(created.error?.message, "agent-typo")
      assert.include(created.error?.message, "LETTA_AGENT_ID")
      assert.deepStrictEqual((yield* sent(fake, "agent_retrieve")).map((c) => c.agent_id), ["agent-typo"])
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 0)
    }))

  it.live("reports a configured agent that cannot be looked up as what it is, not as missing", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* startOnHost(fake, { agentId: "agent-mine" })
      yield* fake.on("agent_retrieve", () => ({ success: false, agent: null, error: "401 Unauthorized" }))
      const unauthorized = yield* client.request("session/new", { cwd: yield* projectDir })
      assert.strictEqual(unauthorized.error?.code, ErrorCode.AuthRequired)
      yield* fake.on("agent_retrieve", () => ({ success: false, agent: null, error: "fetch failed: ECONNREFUSED" }))
      const unreachable = yield* client.request("session/new", { cwd: yield* projectDir })
      assert.strictEqual(unreachable.error?.code, ErrorCode.InternalError)
      assert.include(unreachable.error?.message, "ECONNREFUSED")
    }))

  it.live("reports a failure to reach Letta when looking for the host's agent, not a missing agent", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("agent_retrieve", () => ({ success: false, agent: null, error: "fetch failed: ECONNREFUSED" }))
      const client = yield* startOnHost(fake, { lastAgent: "agent-host" })
      const created = yield* client.request("session/new", { cwd: yield* projectDir })
      assert.strictEqual(created.error?.code, ErrorCode.InternalError)
    }))

  it.live("fails a prompt whose agent was deleted after the session opened, creating nothing", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* fake.on("runtime_start", (command: any) => ({ ...missing(command.agent_id), runtime: null }))
      const prompted = yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      assert.strictEqual(prompted.error?.code, NOT_FOUND)
      assert.strictEqual((yield* sent(fake, "create_agent")).length, 0)
    }))

  it.live("refuses to reopen a session without a conversation when its agent is gone", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* startOnHost(fake, { lastAgent: "agent-host" })
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* client.request("session/close", { sessionId })
      yield* fake.on("agent_retrieve", (command: any) => missing(command.agent_id))
      const resumed = yield* client.request("session/resume", { sessionId, cwd: "/work" })
      assert.strictEqual(resumed.error?.code, NOT_FOUND)
    }))
})

describe("concurrent session requests", () => {
  const resume = (cwd = "/work") => ({ sessionId: "conv-old", cwd })

  it.live("opens a session resumed twice at once only once", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const opening = yield* fake.gate("conversation_retrieve")
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const first = yield* client.start("session/resume", resume())
      yield* opening.entered
      const second = yield* client.start("session/resume", resume())
      yield* client.dispatched
      yield* opening.open
      assert.isDefined((yield* first.response).result)
      assert.isDefined((yield* second.response).result)
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 1)
      assert.strictEqual(yield* fake.runtimes, 1)
    }))

  it.live("opens a session that has no conversation yet, resumed twice at once, only once", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* client.request("session/close", { sessionId })
      const before = (yield* sent(fake, "agent_retrieve")).length
      const opening = yield* fake.gate("agent_retrieve")
      const first = yield* client.start("session/resume", { sessionId, cwd: "/work" })
      yield* opening.entered
      const second = yield* client.start("session/resume", { sessionId, cwd: "/work" })
      yield* client.dispatched
      yield* opening.open
      yield* first.response
      yield* second.response
      assert.strictEqual((yield* sent(fake, "agent_retrieve")).length - before, 1)
    }))

  it.live("leaves one live runtime when a session is resumed from two directories at once", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const opening = yield* fake.gate("conversation_retrieve")
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const first = yield* client.start("session/resume", resume("/work"))
      yield* opening.entered
      const second = yield* client.start("session/resume", resume("/elsewhere"))
      yield* client.dispatched
      yield* opening.open
      yield* first.response
      yield* second.response
      // The second replaces the first, so the conversation's output reaches the client once.
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 2)
      assert.strictEqual(yield* fake.runtimes, 1)
    }))

  it.live("lets a session open after a cancelled attempt to open it", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const opening = yield* fake.gate("conversation_retrieve")
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const stuck = yield* client.start("session/resume", resume())
      yield* opening.entered
      yield* client.notify("$/cancel_request", { requestId: stuck.id })
      assert.isDefined((yield* stuck.response).error)

      yield* opening.open
      assert.isDefined((yield* client.request("session/resume", resume())).result)
    }))

  it.live("closes a session whose close arrives while it is still opening", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const opening = yield* fake.gate("conversation_retrieve")
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const resumed = yield* client.start("session/resume", resume())
      yield* opening.entered
      const closed = yield* client.start("session/close", { sessionId: "conv-old" })
      yield* client.dispatched
      yield* opening.open
      assert.isDefined((yield* resumed.response).result)
      assert.isDefined((yield* closed.response).result)
      assert.strictEqual(yield* fake.runtimes, 0)
      assert.strictEqual(
        (yield* client.request("session/prompt", { sessionId: "conv-old", prompt: text("x") })).error?.code,
        -32002
      )
    }))
})

describe("requests for a session that is still opening", () => {
  const resumeWithReplay = { sessionId: "conv-old", cwd: "/work", replayFrom: { type: "start" } }

  it.live("sends a prompt to the session's own conversation, not a new one", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const replaying = yield* fake.gate("conversation_messages_list")
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const resumed = yield* client.start("session/resume", resumeWithReplay)
      yield* replaying.entered
      const prompted = yield* client.start("session/prompt", { sessionId: "conv-old", prompt: text("hello") })
      yield* client.dispatched
      yield* replaying.open
      assert.isDefined((yield* resumed.response).result)
      assert.isDefined((yield* prompted.response).result)
      const starts = yield* sent(fake, "runtime_start")
      assert.deepStrictEqual(starts.map((s) => s.conversation_id), ["conv-old"])
      assert.isUndefined(starts[0].create_conversation)
      const input = (yield* fake.waitFor(isInput)) as any
      assert.strictEqual(input.runtime.conversation_id, "conv-old")
    }))

  it.live("applies a config change to the session's own conversation", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const replaying = yield* fake.gate("conversation_messages_list")
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const resumed = yield* client.start("session/resume", resumeWithReplay)
      yield* replaying.entered
      const changed = yield* client.start("session/set_config_option", {
        sessionId: "conv-old",
        configId: "mode",
        type: "id",
        value: "acceptEdits"
      })
      yield* client.dispatched
      yield* replaying.open
      yield* resumed.response
      assert.isDefined((yield* changed.response).result)
      const changes = yield* sent(fake, "change_device_state")
      assert.deepStrictEqual(changes.at(-1).payload, { mode: "acceptEdits" })
      assert.strictEqual(changes.at(-1).runtime.conversation_id, "conv-old")
    }))

  it.live("reports a prompt as not found, and creates nothing, when the opening fails", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("conversation_messages_list", () => ({ success: false, error: "history unavailable" }))
      const replaying = yield* fake.gate("conversation_messages_list")
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const resumed = yield* client.start("session/resume", resumeWithReplay)
      yield* replaying.entered
      const prompted = yield* client.start("session/prompt", { sessionId: "conv-old", prompt: text("hello") })
      yield* client.dispatched
      yield* replaying.open
      assert.isDefined((yield* resumed.response).error)
      assert.strictEqual((yield* prompted.response).error?.code, -32002)
      assert.deepStrictEqual((yield* sent(fake, "runtime_start")).map((s) => s.conversation_id), ["conv-old"])
      assert.strictEqual(yield* fake.runtimes, 0)
    }))

  it.live("keeps an open session usable when replaying its history again fails", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      yield* client.request("session/resume", { sessionId: "conv-old", cwd: "/work" })
      yield* fake.on("conversation_messages_list", () => ({ success: false, error: "history unavailable" }))
      assert.isDefined((yield* client.request("session/resume", resumeWithReplay)).error)
      assert.strictEqual(yield* fake.runtimes, 1)

      assert.isDefined((yield* client.request("session/prompt", { sessionId: "conv-old", prompt: text("x") })).result)
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 1)
      const input = (yield* fake.waitFor(isInput)) as any
      assert.strictEqual(input.runtime.conversation_id, "conv-old")
    }))
})

describe("cancelling a close", () => {
  it.live("leaves the session open while the close still waits for its turn to end", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const aborting = yield* fake.gate("abort_message")
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      yield* fake.waitFor(isInput)

      const closing = yield* client.start("session/close", { sessionId })
      yield* aborting.entered
      yield* client.notify("$/cancel_request", { requestId: closing.id })
      assert.isDefined((yield* closing.response).error)
      assert.strictEqual(yield* fake.runtimes, 1)

      yield* aborting.open
      assert.isDefined((yield* client.request("session/close", { sessionId })).result)
      assert.strictEqual(yield* fake.runtimes, 0)
    }))
})

describe("a session that fails to open", () => {
  const failedReplay = { success: false, error: "history unavailable" }
  const emptyHistory = { success: true, messages: [], has_more: false, next_before: null }

  it.live("reopens on its own conversation after its history could not be replayed", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("conversation_messages_list", () => failedReplay)
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const failed = yield* client.request("session/resume", {
        sessionId: "conv-old",
        cwd: "/work",
        replayFrom: { type: "start" }
      })
      assert.isDefined(failed.error)

      yield* fake.on("conversation_messages_list", () => emptyHistory)
      const resumed = yield* client.request("session/resume", {
        sessionId: "conv-old",
        cwd: "/work",
        replayFrom: { type: "start" }
      })
      assert.isDefined(resumed.result)
      const starts = yield* sent(fake, "runtime_start")
      assert.deepStrictEqual(starts.map((s) => s.conversation_id), ["conv-old", "conv-old"])

      yield* client.request("session/prompt", { sessionId: "conv-old", prompt: text("hello") })
      const input = (yield* fake.waitFor(isInput)) as any
      assert.strictEqual(input.runtime.conversation_id, "conv-old")
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 2)
    }))

  it.live("is not found, rather than given a new conversation, until it is opened again", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("conversation_messages_list", () => failedReplay)
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      yield* client.request("session/resume", {
        sessionId: "conv-old",
        cwd: "/work",
        replayFrom: { type: "start" }
      })
      const prompted = yield* client.request("session/prompt", { sessionId: "conv-old", prompt: text("x") })
      assert.strictEqual(prompted.error?.code, -32002)
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 1)
    }))

  it.live("reopens after its opening was cancelled during the replay", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const replaying = yield* fake.gate("conversation_messages_list")
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const stuck = yield* client.start("session/resume", {
        sessionId: "conv-old",
        cwd: "/work",
        replayFrom: { type: "start" }
      })
      yield* replaying.entered
      yield* client.notify("$/cancel_request", { requestId: stuck.id })
      assert.isDefined((yield* stuck.response).error)

      const resumed = yield* client.request("session/resume", { sessionId: "conv-old", cwd: "/work" })
      assert.isDefined(resumed.result)
      assert.strictEqual((yield* sent(fake, "runtime_start")).length, 2)
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
