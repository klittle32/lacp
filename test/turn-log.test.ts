/**
 * The turn log: each step of a turn is logged with its session, its turn
 * (the id of the prompt's user message) and the time since it began, so a log
 * file shows where a turn waited. Prompts and tool input stay out of it.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Logger, References } from "effect"
import { idle, setupV2, text } from "./helpers/AcpClient.ts"
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

const say = (fake: Fake.FakeLetta, conversation: string, content: string, run: string) =>
  fake.emit(Fake.delta(conversation, { message_type: "assistant_message", id: `a-${run}`, content, run_id: run }))

describe("turn log", () => {
  it.live("logs a turn's steps with its session, turn and timing, and not the prompt", () =>
    logged((lines) =>
      Effect.gen(function*() {
        const fake = yield* Fake.make
        const { client, sessionId } = yield* setupV2(fake)
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
})
