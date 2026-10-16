import { assert, describe, it } from "@effect/vitest"
import { type Cause, Context, Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect"
import { RpcError } from "../src/jsonrpc/JsonRpc.ts"
import * as Method from "../src/jsonrpc/Method.ts"
import { JsonRpcPeer } from "../src/jsonrpc/Peer.ts"
import { Transport } from "../src/jsonrpc/Transport.ts"

const Echo = Method.request("echo", Schema.Struct({ text: Schema.String }), Schema.Struct({ text: Schema.String }))
const Slow = Method.request("slow", Schema.Struct({}), Schema.Struct({}))
const Ask = Method.request("client/ask", Schema.Struct({ q: Schema.String }), Schema.Struct({ a: Schema.String }))
const Note = Method.notification("note", Schema.Struct({ n: Schema.Int }))

const Json = Schema.fromJsonString(Schema.Unknown)

/** A peer under test plus raw access to its wire. */
const harness = Effect.gen(function*() {
  const input = yield* Queue.unbounded<string, Cause.Done>()
  const output = yield* Queue.unbounded<string>()
  const context = yield* Layer.build(
    JsonRpcPeer.layer.pipe(Layer.provide(Transport.layerQueues({ input, output })))
  )
  const peer = Context.get(context, JsonRpcPeer)
  const send = (message: unknown) =>
    Schema.encodeEffect(Json)(message).pipe(Effect.orDie, Effect.flatMap((line) => Queue.offer(input, line)))
  const receive = Queue.take(output).pipe(
    Effect.flatMap((line) => Schema.decodeEffect(Json)(line)),
    Effect.orDie,
    Effect.map((m) => m as any)
  )
  return { peer, send, receive, input }
})

describe("JsonRpcPeer", () => {
  it.live("answers requests and reports standard errors", () =>
    Effect.gen(function*() {
      const { peer, receive, send } = yield* harness
      const notes: Array<number> = []
      yield* Effect.forkScoped(peer.serve(Method.router([
        Method.handle(Echo, ({ text }) => Effect.succeed({ text: text.toUpperCase() })),
        Method.handleNotification(Note, ({ n }) => Effect.sync(() => void notes.push(n)))
      ])))

      yield* send({ jsonrpc: "2.0", id: 1, method: "echo", params: { text: "hi" } })
      assert.deepStrictEqual(yield* receive, { jsonrpc: "2.0", id: 1, result: { text: "HI" } })

      yield* send({ jsonrpc: "2.0", id: "x", method: "nope" })
      const notFound = yield* receive
      assert.strictEqual(notFound.id, "x")
      assert.strictEqual(notFound.error.code, -32601)

      yield* send({ jsonrpc: "2.0", id: 2, method: "echo", params: { text: 42 } })
      assert.strictEqual((yield* receive).error.code, -32602)

      yield* send({ jsonrpc: "2.0", id: 3 })
      const invalid = yield* receive
      assert.strictEqual(invalid.error.code, -32600)
      assert.strictEqual(invalid.id, 3)
      assert.deepStrictEqual(notes, [])
    }))

  it.live("rejects malformed JSON with -32700 and a null id", () =>
    Effect.gen(function*() {
      const { input, peer, receive } = yield* harness
      yield* Effect.forkScoped(peer.serve(Method.router([])))
      yield* Queue.offer(input, "{not json")
      const reply = yield* receive
      assert.strictEqual(reply.id, null)
      assert.strictEqual(reply.error.code, -32700)
    }))

  it.live("answers a batch with one array", () =>
    Effect.gen(function*() {
      const { peer, receive, send } = yield* harness
      yield* Effect.forkScoped(peer.serve(Method.router([
        Method.handle(Echo, ({ text }) => Effect.succeed({ text }))
      ])))
      yield* send([
        { jsonrpc: "2.0", id: 1, method: "echo", params: { text: "a" } },
        { jsonrpc: "2.0", method: "note", params: { n: 1 } },
        { jsonrpc: "2.0", id: 2, method: "echo", params: { text: "b" } }
      ])
      const reply = yield* receive
      assert.isTrue(Array.isArray(reply))
      assert.deepStrictEqual(reply.map((r: any) => r.result.text), ["a", "b"])
    }))

  it.live("cancels an in-flight request with $/cancel_request (-32800)", () =>
    Effect.gen(function*() {
      const { peer, receive, send } = yield* harness
      const interrupted = yield* Deferred.make<void>()
      yield* Effect.forkScoped(peer.serve(Method.router([
        Method.handle(Slow, () => Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))))
      ])))
      yield* send({ jsonrpc: "2.0", id: 7, method: "slow", params: {} })
      yield* Effect.sleep("20 millis")
      yield* send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 7 } })
      const reply = yield* receive
      assert.strictEqual(reply.id, 7)
      assert.strictEqual(reply.error.code, -32800)
      yield* Deferred.await(interrupted)
    }))

  it.live("sends requests to the remote side and decodes the result", () =>
    Effect.gen(function*() {
      const { peer, receive, send } = yield* harness
      yield* Effect.forkScoped(peer.serve(Method.router([])))
      const fiber = yield* peer.request(Ask, { q: "why?" }).pipe(Effect.forkChild)
      const outgoing = yield* receive
      assert.strictEqual(outgoing.method, "client/ask")
      assert.deepStrictEqual(outgoing.params, { q: "why?" })
      yield* send({ jsonrpc: "2.0", id: outgoing.id, result: { a: "because" } })
      assert.deepStrictEqual(yield* Fiber.join(fiber), { a: "because" })

      const failing = yield* peer.request(Ask, { q: "no" }).pipe(Effect.flip, Effect.forkChild)
      const second = yield* receive
      yield* send({ jsonrpc: "2.0", id: second.id, error: { code: -32000, message: "auth" } })
      const error = yield* Fiber.join(failing)
      assert.instanceOf(error, RpcError)
      assert.strictEqual(error.code, -32000)
    }))

  it.live("lets a handler call back into the client mid-request", () =>
    Effect.gen(function*() {
      const { peer, receive, send } = yield* harness
      yield* Effect.forkScoped(peer.serve(Method.router([
        Method.handle(Echo, ({ text }) => peer.request(Ask, { q: text }).pipe(Effect.map(({ a }) => ({ text: a }))))
      ])))
      yield* send({ jsonrpc: "2.0", id: 1, method: "echo", params: { text: "ping" } })
      const callback = yield* receive
      assert.strictEqual(callback.method, "client/ask")
      yield* send({ jsonrpc: "2.0", id: callback.id, result: { a: "pong" } })
      assert.deepStrictEqual(yield* receive, { jsonrpc: "2.0", id: 1, result: { text: "pong" } })
    }))

  it.live("sends $/cancel_request when an outgoing request is interrupted", () =>
    Effect.gen(function*() {
      const { peer, receive } = yield* harness
      yield* Effect.forkScoped(peer.serve(Method.router([])))
      const fiber = yield* peer.request(Ask, { q: "wait" }).pipe(Effect.forkChild)
      const outgoing = yield* receive
      yield* Fiber.interrupt(fiber)
      const cancel = yield* receive
      assert.deepStrictEqual(cancel, { jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: outgoing.id } })
    }))
})
