import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Option } from "effect"
import * as Turn from "../src/agent/Turn.ts"

const submitted = Effect.gen(function*() {
  const turn: Turn.Turn = {
    clientMessageId: "m1",
    done: yield* Deferred.make<Turn.TurnResult>(),
    runs: new Set(),
    preexisting: new Set(),
    phase: Turn.Phase.Submitted({ started: false, early: Option.none() }),
    error: Option.none(),
    began: 0,
    streamed: false
  }
  return turn
})

describe("turn phases", () => {
  it.effect("an input Letta queues starts once it is dequeued", () =>
    Effect.gen(function*() {
      const turn = yield* submitted
      Turn.accept(turn, true)
      assert.strictEqual(turn.phase._tag, "Queued")
      assert.isFalse(Turn.started(turn))
      Turn.start(turn)
      assert.strictEqual(turn.phase._tag, "Running")
    }))

  it.effect("an input Letta starts before acknowledging it runs when acknowledged, even if queued", () =>
    Effect.gen(function*() {
      const turn = yield* submitted
      Turn.start(turn)
      assert.isTrue(Turn.started(turn))
      assert.strictEqual(turn.phase._tag, "Submitted")
      Turn.accept(turn, true)
      assert.strictEqual(turn.phase._tag, "Running")
    }))

  it.effect("only a held turn without a follow-up waits for background work", () =>
    Effect.gen(function*() {
      const turn = yield* submitted
      Turn.accept(turn, false)
      assert.isFalse(Turn.waitingForBackground(turn))
      const result = { stopReason: "end_turn" as const, error: Option.none() }
      turn.phase = Turn.Phase.Held({ result, followUp: false })
      assert.isTrue(Turn.waitingForBackground(turn))
      turn.phase = Turn.Phase.Held({ result, followUp: true })
      assert.isFalse(Turn.waitingForBackground(turn))
      // Acknowledgements and starts no longer move a turn Letta has ended.
      Turn.start(turn)
      Turn.accept(turn, false)
      assert.strictEqual(turn.phase._tag, "Held")
    }))
})
