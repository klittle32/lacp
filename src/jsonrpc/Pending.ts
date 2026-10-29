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
   * registered first so that an answer can never arrive unexpected. Once the
   * connection is closed, nothing is sent and the request fails with the
   * close's reason. `key` is forgotten when the request ends, however it
   * ends. A `key` that is still outstanding is a defect: ids are unique.
   */
  request<E2>(key: string, send: Effect.Effect<void, E2>, options?: RequestOptions): Effect.Effect<unknown, E | E2>
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

/**
 * Every transition below is one synchronous step, so no other fiber can run
 * between a check and the change it guards: a close cannot slip in between a
 * request's check for it and its registration, two requests cannot both
 * register one key, and a close that fails the outstanding requests cannot be
 * interrupted after forgetting them. A close reaches a request through the
 * request's own waiter, so an answer that arrived first is never overridden.
 */
export const make = <E>(): Effect.Effect<Pending<E>> =>
  Effect.sync(() => {
    const waiters = new Map<string, Deferred.Deferred<unknown, E>>()
    const closed = Deferred.makeUnsafe<never, E>()

    /** Removes and returns the waiter for `key`. */
    const take = (key: string) => {
      const waiter = waiters.get(key)
      if (waiter !== undefined) waiters.delete(key)
      return waiter
    }

    const answer = (key: string, result: Effect.Effect<unknown, E>) =>
      Effect.sync(() => {
        const waiter = take(key)
        return waiter !== undefined && Deferred.doneUnsafe(waiter, result)
      })

    const pending: Pending<E> = {
      request: (key, send, options) =>
        // Registering and releasing the key cannot be interrupted; only sending and waiting can.
        Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            if (Deferred.isDoneUnsafe(closed)) return Deferred.await(closed)
            if (waiters.has(key)) return Effect.die(new Error(`A request with id ${key} is still outstanding`))
            const waiter = Deferred.makeUnsafe<unknown, E>()
            waiters.set(key, waiter)
            /** Whether this request (not a later one with the same key) is still outstanding. */
            const outstanding = () => waiters.get(key) === waiter
            return restore(send.pipe(Effect.andThen(Deferred.await(waiter)))).pipe(
              Effect.onInterrupt(() =>
                outstanding() && options?.onInterrupt !== undefined ? options.onInterrupt : Effect.void
              ),
              Effect.ensuring(Effect.sync(() => {
                if (outstanding()) waiters.delete(key)
              }))
            )
          })
        ),
      succeed: (key, value) => answer(key, Effect.succeed(value)),
      fail: (key, error) => answer(key, Effect.fail(error)),
      close: (error) =>
        // The outstanding requests are those at the time the close runs, not when it was built.
        Effect.sync(() => {
          Deferred.doneUnsafe(closed, Effect.fail(error))
          const outstanding = Array.from(waiters.values())
          waiters.clear()
          for (const waiter of outstanding) Deferred.doneUnsafe(waiter, Effect.fail(error))
        }),
      isClosed: Effect.sync(() => Deferred.isDoneUnsafe(closed)),
      closed: Deferred.await(closed)
    }
    return pending
  })
