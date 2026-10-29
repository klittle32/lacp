/**
 * Outstanding requests awaiting their answers, by id.
 *
 * Both connections this program keeps correlate requests the same way: an id
 * is registered before the request goes out, the reader answers it by id, and
 * a lost connection fails everything outstanding at once, and every request
 * made afterwards, instead of letting them time out. The JSON-RPC peer
 * (`Peer.ts`) and the Letta App Server connection (`letta/AppServer.ts`) share
 * this.
 */
import { Deferred, Effect } from "effect"

export interface RequestOptions {
  /** Runs when the request is interrupted while it still awaits its answer (to tell the other side). */
  readonly onInterrupt?: Effect.Effect<void> | undefined
}

export interface Pending<E> {
  /**
   * Sends a request with `send` and awaits the answer to `key`, which is
   * registered first so that an answer can never arrive unexpected. Fails
   * once the connection is closed. `key` is forgotten when the request ends,
   * however it ends.
   */
  request<E2>(key: string, send: Effect.Effect<void, E2>, options?: RequestOptions): Effect.Effect<unknown, E | E2>
  /** Whether `key` still awaits its answer. */
  has(key: string): boolean
  /** Answers `key`; `false` when nothing awaits it. */
  succeed(key: string, value: unknown): Effect.Effect<boolean>
  /** Fails `key`; `false` when nothing awaits it. */
  fail(key: string, error: E): Effect.Effect<boolean>
  /** Fails every outstanding request, and every later one, with `error`. The first close stands. */
  close(error: E): Effect.Effect<void>
  readonly isClosed: Effect.Effect<boolean>
  /** Fails once closed. */
  readonly closed: Effect.Effect<never, E>
}

export const make = <E>(): Effect.Effect<Pending<E>> =>
  Effect.gen(function*() {
    const waiters = new Map<string, Deferred.Deferred<unknown, E>>()
    const closed = yield* Deferred.make<never, E>()

    /** Removes and returns the waiter for `key`. */
    const take = (key: string) => {
      const waiter = waiters.get(key)
      if (waiter !== undefined) waiters.delete(key)
      return waiter
    }

    const pending: Pending<E> = {
      request: (key, send, options) =>
        Effect.gen(function*() {
          const waiter = yield* Deferred.make<unknown, E>()
          waiters.set(key, waiter)
          return yield* send.pipe(
            Effect.andThen(Effect.raceFirst(Deferred.await(waiter), Deferred.await(closed))),
            Effect.onInterrupt(() =>
              waiters.has(key) && options?.onInterrupt !== undefined ? options.onInterrupt : Effect.void
            ),
            Effect.ensuring(Effect.sync(() => waiters.delete(key)))
          )
        }),
      has: (key) => waiters.has(key),
      succeed: (key, value) =>
        Effect.suspend(() => {
          const waiter = take(key)
          return waiter === undefined ? Effect.succeed(false) : Deferred.succeed(waiter, value)
        }),
      fail: (key, error) =>
        Effect.suspend(() => {
          const waiter = take(key)
          return waiter === undefined ? Effect.succeed(false) : Deferred.fail(waiter, error)
        }),
      close: (error) =>
        Deferred.fail(closed, error).pipe(
          Effect.andThen(Effect.forEach(Array.from(waiters.values()), (waiter) => Deferred.fail(waiter, error), {
            discard: true
          })),
          Effect.ensuring(Effect.sync(() => waiters.clear()))
        ),
      isClosed: Deferred.isDone(closed),
      closed: Deferred.await(closed)
    }
    return pending
  })
