/**
 * The turn log: each step of a turn is logged with its session, its turn
 * (the id of the prompt's user message) and the time since it began, so a log
 * file shows where a turn waited. Prompts and tool input stay out of it.
 */
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Logger, References } from "effect"
import type { LacpConfigShape } from "../src/Config.ts"
import { initializeHybrid, start } from "./helpers/AcpClient.ts"
import * as Fake from "./helpers/FakeLetta.ts"

interface Line {
  readonly level: string
  readonly message: string
  readonly annotations: Readonly<Record<string, unknown>>
}

/** Runs `body` with every log line at debug and above collected in `lines` instead of printed. */
const logged = <A, E, R>(body: (lines: ReadonlyArray<Line>) => Effect.Effect<A, E, R>) => {
  const lines: Array<Line> = []
  const collect = Logger.make<unknown, void>(({ fiber, logLevel, message }) => {
    lines.push({
      level: logLevel,
      message: (Array.isArray(message) ? message : [message]).join(" "),
      annotations: fiber.getRef(References.CurrentLogAnnotations)
    })
  })
  return body(lines).pipe(
    Effect.provide(Logger.layer([collect])),
    Effect.provideService(References.MinimumLogLevel, "Debug")
  )
}

/** The logged steps of the session's turns. */
const steps = (lines: ReadonlyArray<Line>, sessionId: string) =>
  lines.filter((line) => line.annotations["session"] === sessionId && line.annotations["turn"] !== undefined)

const text = (value: string) => [{ type: "text", text: value }]
const idle = (u: any) => u.sessionUpdate === "state_update" && u.state === "idle"

const v2 = (fake: Fake.FakeLetta, config: Partial<LacpConfigShape> = {}) =>
  Effect.gen(function*() {
    const client = yield* start(fake, config)
    yield* client.request("initialize", initializeHybrid)
    const sessionId = (yield* client.request("session/new", { cwd: "/work" })).result.sessionId as string
    return { client, sessionId }
  })

const say = (fake: Fake.FakeLetta, conversation: string, content: string, run: string) =>
  fake.emit(Fake.delta(conversation, { message_type: "assistant_message", id: `a-${run}`, content, run_id: run }))

describe("turn log", () => {
  it.live("logs a turn's steps with its session, turn and timing, and not the prompt", () =>
    logged((lines) =>
      Effect.gen(function*() {
        const fake = yield* Fake.make
        const { client, sessionId } = yield* v2(fake)
        yield* client.request("session/prompt", { sessionId, prompt: text("the secret plan") })
        const conversation = yield* fake.conversation
        yield* say(fake, conversation, "On it", "run-1")
        yield* fake.emit(Fake.turnFinished(conversation, "end_turn", { run_id: "run-1" }))
        yield* client.update(idle)

        const turn = steps(lines, sessionId)
        assert.deepStrictEqual(turn.map((line) => line.message), [
          "Letta accepted the prompt",
          "First output from Letta",
          "The turn ended: end_turn"
        ])
        assert.deepStrictEqual(turn.map((line) => line.level), ["Debug", "Debug", "Info"])
        assert.strictEqual(new Set(turn.map((line) => line.annotations["turn"])).size, 1)
        assert.isTrue(turn.every((line) => typeof line.annotations["elapsed"] === "string"))
        assert.isFalse(lines.some((line) => line.message.includes("secret plan")))
      })
    ))

  it.live("logs an approval wait and a cancellation Letta acknowledges", () =>
    logged((lines) =>
      Effect.gen(function*() {
        const fake = yield* Fake.make
        const { client, sessionId } = yield* v2(fake)
        yield* client.request("session/prompt", { sessionId, prompt: text("edit it") })
        const conversation = yield* fake.conversation
        yield* fake.emit({
          type: "control_request",
          request_id: "perm-1",
          runtime: Fake.runtime(conversation),
          request: {
            subtype: "can_use_tool",
            tool_name: "Edit",
            input: { file_path: "src/a.ts", old_string: "private", new_string: "public" },
            tool_call_id: "call-1"
          }
        })
        yield* fake.waitFor((c: any) => c.type === "input" && c.payload.kind === "approval_response")
        yield* client.notify("session/cancel", { sessionId })
        yield* client.update(idle)

        assert.deepStrictEqual(steps(lines, sessionId).map((line) => line.message), [
          "Letta accepted the prompt",
          "Waiting for the client to approve Edit",
          "The client answered the approval for Edit: allow",
          "Cancelling the turn",
          "Letta acknowledged the cancellation",
          "The turn ended: cancelled"
        ])
        assert.isFalse(lines.some((line) => line.message.includes("private")))
      })
    ))

  it.live("logs a turn held for background work until its grace period ends it", () =>
    logged((lines) =>
      Effect.gen(function*() {
        const fake = yield* Fake.make
        const { client, sessionId } = yield* v2(fake, { backgroundGrace: Duration.millis(100) })
        yield* client.request("session/prompt", { sessionId, prompt: text("spawn a worker") })
        const conversation = yield* fake.conversation
        yield* say(fake, conversation, "Worker started", "run-1")
        yield* fake.emit(Fake.subagents(conversation, [{ id: "worker", status: "running" }]))
        yield* fake.emit(Fake.turnFinished(conversation, "end_turn", { run_id: "run-1" }))
        yield* fake.emit(Fake.subagents(conversation, [{ id: "worker", status: "completed" }]))
        yield* client.update(idle)

        assert.deepStrictEqual(steps(lines, sessionId).map((line) => line.message), [
          "Letta accepted the prompt",
          "First output from Letta",
          "Keeping the turn open until its background work reports back",
          "The background work is done and no follow-up turn started within 100ms",
          "The turn ended: end_turn"
        ])
      })
    ))

  it.live("logs a prompt Letta does not take", () =>
    logged((lines) =>
      Effect.gen(function*() {
        const fake = yield* Fake.make
        yield* fake.on("input", () => ({ success: true, accepted: false, error: "busy" }))
        const { client, sessionId } = yield* v2(fake)
        const reply = yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
        assert.isDefined(reply.error)
        const turn = steps(lines, sessionId)
        assert.deepStrictEqual(turn.map((line) => [line.level, line.message]), [
          ["Info", "Letta did not take the prompt: busy"]
        ])
      })
    ))
})
