/**
 * Regression tests for turn handling at its edges: prompts waiting for a
 * running turn, cancellations Letta never confirms, slash commands, and
 * sessions reopened elsewhere.
 */
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Ref } from "effect"
import { idle, initializeHybrid, initializeV1, isInput, start, text } from "./helpers/AcpClient.ts"
import * as Fake from "./helpers/FakeLetta.ts"

const inputs = (fake: Fake.FakeLetta) => Ref.get(fake.commands).pipe(Effect.map((all) => all.filter(isInput)))

/** The cancel fallback, shortened from 15 seconds. */
const cancelGrace = Duration.millis(100)

describe("turns", () => {
  it.live("a v2 prompt waiting for the previous turn can still be cancelled", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* client.request("session/prompt", { sessionId, prompt: text("first") })

      const reply = yield* client.next((m) => m.id === "second").pipe(Effect.forkChild)
      yield* Effect.sleep("20 millis")
      yield* client.raw(JSON.stringify({
        jsonrpc: "2.0",
        id: "second",
        method: "session/prompt",
        params: { sessionId, prompt: text("second") }
      }))
      yield* Effect.sleep("20 millis")
      yield* client.notify("$/cancel_request", { requestId: "second" })
      assert.strictEqual((yield* Fiber.join(reply)).error?.code, -32800)
      // The cancelled prompt never reached Letta.
      assert.strictEqual((yield* inputs(fake)).length, 1)
    }))

  it.live("the late end of a turn lacp ended itself does not end the next one", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("abort_message", () => ({ success: true, aborted: false }))
      const client = yield* start(fake, { cancelGrace })
      yield* client.request("initialize", initializeV1)
      const sessionId = (yield* client.request("session/new", { cwd: "/work", mcpServers: [] })).result
        .sessionId as string

      const first = yield* client.request("session/prompt", { sessionId, prompt: text("long task") }).pipe(
        Effect.forkChild
      )
      yield* fake.waitFor(isInput)
      const conversation = yield* fake.conversation
      yield* fake.emit(
        Fake.delta(conversation, { message_type: "assistant_message", id: "a1", content: "Working", run_id: "run-old" })
      )
      // Letta never confirms the cancellation, so lacp ends the turn itself.
      yield* client.notify("session/cancel", { sessionId })
      assert.deepStrictEqual((yield* Fiber.join(first)).result, { stopReason: "cancelled" })

      const second = yield* client.request("session/prompt", { sessionId, prompt: text("next") }).pipe(
        Effect.forkChild
      )
      yield* Effect.sleep("50 millis")
      yield* fake.emit(Fake.turnFinished(conversation, "cancelled", { run_id: "run-old" }))
      yield* fake.emit(
        Fake.delta(conversation, { message_type: "assistant_message", id: "a2", content: "Late", run_id: "run-old" })
      )
      yield* Effect.sleep("50 millis")
      assert.isUndefined(second.pollUnsafe())
      yield* fake.emit(Fake.turnFinished(conversation, "end_turn", { run_id: "run-new" }))
      assert.deepStrictEqual((yield* Fiber.join(second)).result, { stopReason: "end_turn" })
      const chunks = (yield* client.updates).filter((u) => u.sessionUpdate === "agent_message_chunk")
      assert.notInclude(chunks.map((u) => u.content.text), "Late")
    }))

  it.live("a cancel Letta acknowledges ends the turn without waiting for Letta to end it", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      // The default cancel fallback (15 seconds) applies, so only the acknowledgement can end the turn in time.
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* client.request("session/prompt", { sessionId, prompt: text("think quietly") })
      yield* fake.waitFor(isInput)
      const conversation = yield* fake.conversation
      yield* client.notify("session/cancel", { sessionId })
      const ended = yield* client.update(idle).pipe(
        Effect.timeout("1 second")
      )
      assert.strictEqual(ended.stopReason, "cancelled")

      // Letta ends the aborted turn once its silent model request settles; lacp never saw that run.
      yield* fake.emit(Fake.turnFinished(conversation, "cancelled", { run_id: "run-unseen" }))
      yield* Effect.sleep("50 millis")
      const idles = (yield* client.updates).filter(idle)
      assert.strictEqual(idles.length, 1)
    }))

  it.live("a cancelled slash command does not hold up the next prompt", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("execute_command", () => Effect.never)
      const client = yield* start(fake, { cancelGrace })
      yield* client.request("initialize", initializeV1)
      const sessionId = (yield* client.request("session/new", { cwd: "/work", mcpServers: [] })).result
        .sessionId as string
      yield* client.update((u) => u.sessionUpdate === "available_commands_update")

      const command = yield* client.request("session/prompt", { sessionId, prompt: text("/compact") }).pipe(
        Effect.forkChild
      )
      yield* fake.waitFor((c) => c.type === "execute_command")
      yield* client.notify("session/cancel", { sessionId })
      assert.deepStrictEqual((yield* Fiber.join(command)).result, { stopReason: "cancelled" })

      const next = yield* client.request("session/prompt", { sessionId, prompt: text("hello") }).pipe(
        Effect.forkChild
      )
      yield* fake.waitFor(isInput)
      const conversation = yield* fake.conversation
      yield* fake.emit(Fake.turnFinished(conversation))
      assert.deepStrictEqual((yield* Fiber.join(next)).result, { stopReason: "end_turn" })
    }))

  it.live("a session reopened from another directory gets a runtime there", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      const conversation = yield* fake.conversation
      const resumed = yield* client.request("session/resume", { sessionId, cwd: "/work/worktree" })
      assert.isDefined(resumed.result)
      const starts = (yield* Ref.get(fake.commands)).filter((c) => c.type === "runtime_start") as Array<any>
      assert.deepStrictEqual(starts.map((c) => c.cwd), ["/work", "/work/worktree"])
      assert.strictEqual(starts[1].conversation_id, conversation)
    }))

  it.live("a session reopened unchanged keeps its runtime", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      yield* client.request("session/resume", { sessionId, cwd: "/work" })
      const starts = (yield* Ref.get(fake.commands)).filter((c) => c.type === "runtime_start")
      assert.strictEqual(starts.length, 1)
    }))
})
