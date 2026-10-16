/**
 * Background work: a turn that starts a background subagent stays open until
 * the subagent reports back (in a follow-up turn Letta runs on its own), so
 * clients that only show turns they started, like T3 Code, show the report.
 */
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber } from "effect"
import type { LacpConfigShape } from "../src/Config.ts"
import { initializeHybrid, initializeV1, start } from "./helpers/AcpClient.ts"
import * as Fake from "./helpers/FakeLetta.ts"

const text = (value: string) => [{ type: "text", text: value }]
const backgroundGrace = Duration.millis(200)

const v2 = (fake: Fake.FakeLetta, config: Partial<LacpConfigShape> = {}) =>
  Effect.gen(function*() {
    const client = yield* start(fake, { backgroundGrace, ...config })
    yield* client.request("initialize", initializeHybrid)
    const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
    return { client, sessionId }
  })

const say = (fake: Fake.FakeLetta, sessionId: string, id: string, content: string, run: string) =>
  fake.emit(Fake.delta(sessionId, { message_type: "assistant_message", id, content, run_id: run }))

/** The turn that spawns a worker: Letta's turn ends while the worker runs. */
const spawnWorker = (fake: Fake.FakeLetta, sessionId: string) =>
  Effect.gen(function*() {
    yield* say(fake, sessionId, "a1", "Worker started", "run-1")
    yield* fake.emit(Fake.subagents(sessionId, [{ id: "worker", status: "running" }]))
    yield* fake.emit(Fake.turnFinished(sessionId, "end_turn", { run_id: "run-1" }))
  })

/** A subagent's report, as Letta Code writes it. */
const notification = (subagentId: string) =>
  `<task-notification>\n<task-id>task_1</task-id>\n<status>completed</status>\n` +
  `<summary>Agent "List directory" completed</summary>\n` +
  `<result>subagent_type=general-purpose subagent_id=${subagentId} subagent_status=success\n\na.txt</result>\n` +
  `</task-notification>\nFull transcript available at: /tmp/task_1.log`

/**
 * The worker finishes, and Letta runs the parent's follow-up turn with its
 * report. As in Letta Code 0.34.15, nothing reports the worker's final state:
 * once the turn that started it has ended, Letta drops that update.
 */
const reportBack = (
  fake: Fake.FakeLetta,
  sessionId: string,
  { id = "worker", reply = "Here is the listing", run = "run-2" } = {}
) =>
  Effect.gen(function*() {
    yield* fake.emit(Fake.queue(sessionId, ["task_notification"]))
    yield* fake.emit(Fake.delta(sessionId, { message_type: "user_message", id: `u-${run}`, content: notification(id) }))
    yield* fake.emit(Fake.queue(sessionId, []))
    yield* fake.emit(Fake.delta(sessionId, {
      message_type: "reasoning_message",
      id: `r-${run}`,
      reasoning: "The worker finished",
      run_id: run
    }))
    yield* say(fake, sessionId, `a-${run}`, reply, run)
    yield* fake.emit(Fake.turnFinished(sessionId, "end_turn", { run_id: run }))
  })

const idle = (u: any) => u.sessionUpdate === "state_update" && u.state === "idle"

describe("background work", () => {
  it.live("keeps the turn open until a background subagent reports back", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* v2(fake)
      yield* client.request("session/prompt", { sessionId, prompt: text("spawn a worker") })
      yield* spawnWorker(fake, sessionId)
      yield* Effect.sleep("300 millis")
      assert.isFalse((yield* client.updates).some(idle), "the turn ended while its worker was running")

      yield* reportBack(fake, sessionId)
      yield* client.update(idle)
      yield* Effect.sleep("20 millis")
      const updates = yield* client.updates
      const chunks = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text)
      assert.deepStrictEqual(chunks, ["Worker started", "Here is the listing"])
      assert.strictEqual(updates.filter(idle).length, 1)
      // The injected report is not shown as something the user said.
      assert.isFalse(updates.some((u) => u.sessionUpdate === "user_message_chunk"))
    }))

  it.live("waits for every worker the turn started", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* v2(fake)
      yield* client.request("session/prompt", { sessionId, prompt: text("spawn two workers") })
      yield* say(fake, sessionId, "a1", "Workers started", "run-1")
      yield* fake.emit(Fake.subagents(sessionId, [{ id: "w1", status: "running" }, { id: "w2", status: "running" }]))
      yield* fake.emit(Fake.turnFinished(sessionId, "end_turn", { run_id: "run-1" }))

      yield* reportBack(fake, sessionId, { id: "w1", reply: "First listing", run: "run-2" })
      yield* Effect.sleep("300 millis")
      assert.isFalse((yield* client.updates).some(idle), "the turn ended while a worker was running")

      yield* reportBack(fake, sessionId, { id: "w2", reply: "Second listing", run: "run-3" })
      yield* client.update(idle)
      yield* Effect.sleep("20 millis")
      const updates = yield* client.updates
      const chunks = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text)
      assert.deepStrictEqual(chunks, ["Workers started", "First listing", "Second listing"])
      assert.strictEqual(updates.filter(idle).length, 1)
    }))

  it.live("does not hold a turn Letta ends as cancelled", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      // Letta has nothing to abort yet, so only its end of the turn can end it before the cancel fallback.
      yield* fake.on("abort_message", () => ({ success: true, aborted: false }))
      const { client, sessionId } = yield* v2(fake)
      yield* client.request("session/prompt", { sessionId, prompt: text("spawn a worker") })
      yield* say(fake, sessionId, "a1", "Starting a worker", "run-1")
      yield* fake.emit(Fake.subagents(sessionId, [{ id: "worker", status: "running" }]))
      yield* client.notify("session/cancel", { sessionId })
      yield* fake.waitFor((c) => c.type === "abort_message")
      yield* fake.emit(Fake.turnFinished(sessionId, "cancelled", { run_id: "run-1" }))
      const ended = yield* client.update(idle).pipe(Effect.timeout("1 second"))
      assert.strictEqual(ended.stopReason, "cancelled")
    }))

  it.live("ends the turn after a grace period when no report follows", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* v2(fake)
      yield* client.request("session/prompt", { sessionId, prompt: text("spawn a worker") })
      yield* spawnWorker(fake, sessionId)
      yield* fake.emit(Fake.subagents(sessionId, [{ id: "worker", status: "completed" }]))
      const ended = yield* client.update(idle)
      assert.strictEqual(ended.stopReason, "end_turn")
    }))

  it.live("stops waiting when the user cancels", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* v2(fake)
      yield* client.request("session/prompt", { sessionId, prompt: text("spawn a worker") })
      yield* spawnWorker(fake, sessionId)
      yield* Effect.sleep("50 millis")
      yield* client.notify("session/cancel", { sessionId })
      const ended = yield* client.update(idle)
      assert.strictEqual(ended.stopReason, "cancelled")
    }))

  it.live("does not wait for silent subagents or ones started before the prompt", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* v2(fake)
      yield* fake.emit(Fake.subagents(sessionId, [{ id: "earlier", status: "running" }]))
      yield* Effect.sleep("20 millis")
      yield* client.request("session/prompt", { sessionId, prompt: text("hi") })
      yield* say(fake, sessionId, "a1", "Hello", "run-1")
      yield* fake.emit(Fake.subagents(sessionId, [
        { id: "earlier", status: "running" },
        { id: "reflection", status: "running", silent: true }
      ]))
      yield* fake.emit(Fake.turnFinished(sessionId, "end_turn", { run_id: "run-1" }))
      yield* client.update(idle)
    }))

  it.live("does not wait with --no-wait-for-background", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* v2(fake, { waitForBackground: false })
      yield* client.request("session/prompt", { sessionId, prompt: text("spawn a worker") })
      yield* spawnWorker(fake, sessionId)
      yield* client.update(idle)
    }))

  it.live("answers a v1 prompt only after the report", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake, { backgroundGrace })
      yield* client.request("initialize", initializeV1)
      const sessionId = (yield* client.request("session/new", { cwd: "/work", mcpServers: [] })).result
        .sessionId as string
      const prompt = yield* client.request("session/prompt", { sessionId, prompt: text("spawn a worker") }).pipe(
        Effect.forkChild
      )
      yield* fake.waitFor((c) => c.type === "input")
      yield* spawnWorker(fake, sessionId)
      yield* Effect.sleep("300 millis")
      assert.isUndefined(prompt.pollUnsafe())
      yield* reportBack(fake, sessionId)
      assert.deepStrictEqual((yield* Fiber.join(prompt)).result, { stopReason: "end_turn" })
      const chunks = (yield* client.updates).filter((u) => u.sessionUpdate === "agent_message_chunk")
      assert.include(chunks.map((u) => u.content.text), "Here is the listing")
    }))
})
