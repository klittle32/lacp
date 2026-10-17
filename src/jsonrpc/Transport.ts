/**
 * Newline-delimited transport for JSON-RPC.
 *
 * stdout is the protocol channel, so a single writer fiber owns it: concurrent
 * senders enqueue whole lines and can never interleave partial writes.
 */
import { type Cause, Context, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { Stdio } from "effect/Stdio"

export class Transport extends Context.Service<Transport, {
  /** Incoming non-empty lines, without the trailing newline. Ends on EOF. */
  readonly incoming: Stream.Stream<string>
  /** Enqueues one line; it must not contain a newline. */
  send(line: string): Effect.Effect<void>
}>()("lacp/jsonrpc/Transport") {
  /** The ACP stdio transport: stdin in, stdout out. */
  static readonly layerStdio = Layer.effect(
    Transport,
    Effect.gen(function*() {
      const stdio = yield* Stdio
      const outbox = yield* Queue.unbounded<string, Cause.Done>()
      const writer = yield* Stream.fromQueue(outbox).pipe(
        Stream.map((line) => `${line}\n`),
        Stream.run(stdio.stdout({ endOnDone: false })),
        Effect.catchCause((cause) => Effect.logError("stdout writer failed", cause)),
        Effect.forkScoped
      )
      // Flush everything already enqueued before the scope finishes closing.
      yield* Effect.addFinalizer(() => Queue.end(outbox).pipe(Effect.andThen(Fiber.join(writer))))
      const incoming = stdio.stdin.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.catchCause((cause) =>
          Stream.fromEffect(Effect.logError("stdin reader failed", cause)).pipe(Stream.drain)
        )
      )
      return Transport.of({
        incoming,
        send: (line) => Queue.offer(outbox, line).pipe(Effect.asVoid)
      })
    })
  )

  /**
   * An in-memory transport for tests: `incoming` reads from `input`, and every
   * sent line is offered to `output`.
   */
  static readonly layerQueues = (options: {
    readonly input: Queue.Dequeue<string, Cause.Done>
    readonly output: Queue.Queue<string>
  }) =>
    Layer.succeed(
      Transport,
      Transport.of({
        incoming: Stream.fromQueue(options.input),
        send: (line) => Queue.offer(options.output, line).pipe(Effect.asVoid)
      })
    )
}
