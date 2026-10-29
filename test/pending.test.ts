import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import * as Pending from "../src/jsonrpc/Pending.ts"

describe("Pending", () => {
  it.effect("answers a request by its key and forgets it", () =>
    Effect.gen(function*() {
      const pending = yield* Pending.make<string>()
      const fiber = yield* Effect.forkChild(pending.request("1", Effect.void))
      yield* Effect.yieldNow
      assert.isTrue(pending.has("1"))
      assert.isTrue(yield* pending.succeed("1", "answer"))
      assert.strictEqual(yield* Fiber.join(fiber), "answer")
      assert.isFalse(pending.has("1"))
      assert.isFalse(yield* pending.succeed("1", "again"))
    }))

  it.effect("fails a request by its key", () =>
    Effect.gen(function*() {
      const pending = yield* Pending.make<string>()
      const fiber = yield* Effect.forkChild(pending.request("1", Effect.void))
      yield* Effect.yieldNow
      assert.isTrue(yield* pending.fail("1", "no"))
      assert.deepStrictEqual(yield* Fiber.await(fiber), Exit.fail("no"))
      assert.isFalse(yield* pending.fail("2", "nothing"))
    }))

  it.effect("a failed send fails the request and forgets its key", () =>
    Effect.gen(function*() {
      const pending = yield* Pending.make<string>()
      const result = yield* pending.request("1", Effect.fail("unsent")).pipe(Effect.result)
      assert.deepStrictEqual(result._tag, "Failure")
      assert.isFalse(pending.has("1"))
    }))

  it.effect("closing fails every outstanding request and every later one", () =>
    Effect.gen(function*() {
      const pending = yield* Pending.make<string>()
      const first = yield* Effect.forkChild(pending.request("1", Effect.void))
      const second = yield* Effect.forkChild(pending.request("2", Effect.void))
      yield* Effect.yieldNow
      assert.isFalse(yield* pending.isClosed)
      yield* pending.close("gone")
      assert.deepStrictEqual(yield* Fiber.await(first), Exit.fail("gone"))
      assert.deepStrictEqual(yield* Fiber.await(second), Exit.fail("gone"))
      assert.isTrue(yield* pending.isClosed)
      assert.isFalse(pending.has("1"))
      assert.deepStrictEqual(yield* pending.request("3", Effect.void).pipe(Effect.exit), Exit.fail("gone"))
      assert.deepStrictEqual(yield* pending.closed.pipe(Effect.exit), Exit.fail("gone"))
      // The first close stands.
      yield* pending.close("again")
      assert.deepStrictEqual(yield* pending.closed.pipe(Effect.exit), Exit.fail("gone"))
    }))

  it.effect("runs the interrupt hook only while the request is outstanding", () =>
    Effect.gen(function*() {
      const pending = yield* Pending.make<string>()
      const told: Array<string> = []
      const tell = (key: string) => Effect.sync(() => void told.push(key))
      const outstanding = yield* Effect.forkChild(pending.request("1", Effect.void, { onInterrupt: tell("1") }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(outstanding)
      const answered = yield* Effect.forkChild(pending.request("2", Effect.void, { onInterrupt: tell("2") }))
      yield* Effect.yieldNow
      yield* pending.succeed("2", "done")
      yield* Fiber.join(answered)
      yield* Fiber.interrupt(answered)
      assert.deepStrictEqual(told, ["1"])
      assert.isFalse(pending.has("1"))
    }))
})
