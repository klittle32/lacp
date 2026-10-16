/**
 * A bidirectional JSON-RPC 2.0 peer.
 *
 * ACP is symmetric: the client calls the agent (`session/prompt`) while the
 * agent calls the client (`session/request_permission`) on the same stream.
 * This peer serves incoming requests through a {@link Dispatcher}, correlates
 * responses to its own outgoing requests, and implements request cancellation
 * in both directions (`$/cancel_request` for ACP, `notifications/cancelled` for
 * MCP, which reuses this peer for its connections).
 *
 * Ordering guarantees:
 * - notifications are handled inline, in arrival order;
 * - requests run concurrently, each in its own fiber;
 * - outgoing messages are written in the order they are produced.
 */
import {
  Array as Arr,
  Context,
  Deferred,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  Result,
  Schema,
  type Scope,
  Stream
} from "effect"
import {
  type FailureMessage,
  isNotification,
  isRequest,
  isSuccess,
  LineJson,
  Message,
  type NotificationMessage,
  type Outgoing,
  OutgoingJson,
  type RequestId,
  RequestId as RequestIdSchema,
  type RequestMessage,
  type ResponseMessage,
  RpcError
} from "./JsonRpc.ts"
import { type Dispatcher, notification, type NotificationMethod, type RequestMethod } from "./Method.ts"
import { Transport } from "./Transport.ts"

const CancelParams = Schema.Struct({ requestId: RequestIdSchema, reason: Schema.optionalKey(Schema.String) })

/** `$/cancel_request`: ACP's protocol-level cancellation, valid in both directions. */
export const CancelRequest = notification("$/cancel_request", CancelParams)

/** `notifications/cancelled`: MCP's cancellation notification. */
export const McpCancelled = notification("notifications/cancelled", CancelParams)

export interface RequestOptions {
  readonly timeout?: Duration.Input | undefined
}

export interface PeerOptions {
  /** The cancellation notification of the protocol spoken (default: ACP's `$/cancel_request`). */
  readonly cancelMethod?: string | undefined
  /** A label for trace logs. */
  readonly label?: string | undefined
}

export interface PeerShape {
  /** Sends a request to the remote peer and decodes its result. */
  request<P, PI, A, AI>(
    method: RequestMethod<P, PI, A, AI>,
    params: P,
    options?: RequestOptions
  ): Effect.Effect<A, RpcError>
  /** Sends a notification to the remote peer. */
  notify<P, PI>(method: NotificationMethod<P, PI>, params: P): Effect.Effect<void>
  /** Serves incoming messages until the transport reaches end of input. */
  serve(dispatcher: Dispatcher): Effect.Effect<void>
}

/** Builds a peer on the current {@link Transport}; it lives as long as the enclosing scope. */
export const makePeer = (options: PeerOptions = {}): Effect.Effect<PeerShape, never, Transport | Scope.Scope> =>
  Effect.gen(function*() {
    const cancelMethod = options.cancelMethod ?? CancelRequest.name
    const label = options.label ?? "acp"
    const transport = yield* Transport
    const fibers = yield* FiberSet.make()
    /** Our outgoing requests awaiting a response. */
    const pending = new Map<string, Deferred.Deferred<unknown, RpcError>>()
    /** Incoming requests in flight, with the signal that cancels them. */
    const inflight = new Map<string, Deferred.Deferred<void>>()
    /** Fails once the connection is gone, so that later requests fail at once instead of timing out. */
    const closed = yield* Deferred.make<never, RpcError>()
    let nextId = 0

    const encodeLine = Schema.encodeEffect(OutgoingJson)
    const decodeLine = Schema.decodeUnknownEffect(LineJson)
    const decodeMessage = Schema.decodeUnknownResult(Message)
    const decodeCancel = Schema.decodeUnknownResult(CancelRequest.params)

    const write = (message: Outgoing) =>
      encodeLine(message).pipe(
        Effect.tap((line) => Effect.logTrace(`${label} ->`, line)),
        Effect.flatMap((line) => transport.send(line)),
        Effect.catch((error) => Effect.logError("Failed to encode outgoing JSON-RPC message", error.message))
      )

    const failure = (id: RequestId, error: RpcError): FailureMessage => ({
      jsonrpc: "2.0",
      id,
      error: error.toErrorObject()
    })

    /** Runs one incoming request to its response. Interruption (shutdown) yields no response. */
    const execute = (dispatcher: Dispatcher, message: RequestMessage): Effect.Effect<ResponseMessage> => {
      const key = idKey(message.id)
      if (inflight.has(key)) {
        return Effect.succeed(failure(message.id, RpcError.invalidRequest({ reason: "duplicate request id" })))
      }
      const handler = dispatcher.request(message.method)
      if (Option.isNone(handler)) {
        return Effect.succeed(failure(message.id, RpcError.methodNotFound(message.method)))
      }
      return Effect.gen(function*() {
        const cancel = yield* Deferred.make<void>()
        inflight.set(key, cancel)
        const run: Effect.Effect<ResponseMessage> = handler.value(message.params).pipe(
          Effect.map((result): ResponseMessage => ({ jsonrpc: "2.0", id: message.id, result })),
          // Interruption (shutdown) propagates and produces no response.
          Effect.catch((error) => Effect.succeed(failure(message.id, error))),
          Effect.catchDefect((defect) =>
            Effect.logError(`JSON-RPC handler for ${message.method} died`, defect).pipe(
              Effect.as(failure(message.id, RpcError.internal("Internal error")))
            )
          )
        )
        return yield* run.pipe(
          Effect.raceFirst(Deferred.await(cancel).pipe(Effect.as(failure(message.id, RpcError.cancelled())))),
          Effect.ensuring(Effect.sync(() => inflight.delete(key)))
        )
      })
    }

    const handleNotification = (dispatcher: Dispatcher, message: NotificationMessage): Effect.Effect<void> => {
      if (message.method === cancelMethod) {
        return Result.match(decodeCancel(message.params), {
          onFailure: () => Effect.logWarning(`Ignoring malformed ${cancelMethod}`),
          onSuccess: ({ requestId }) => {
            const signal = inflight.get(idKey(requestId))
            return signal === undefined ? Effect.void : Deferred.succeed(signal, undefined).pipe(Effect.asVoid)
          }
        })
      }
      return Option.match(dispatcher.notification(message.method), {
        // Unknown notifications are ignored, as JSON-RPC requires.
        onNone: () => Effect.logDebug(`Ignoring unknown notification ${message.method}`),
        onSome: (run) =>
          run(message.params).pipe(
            Effect.catchCause((cause) => Effect.logWarning(`Notification ${message.method} failed`, cause))
          )
      })
    }

    const handleResponse = (message: ResponseMessage): Effect.Effect<void> => {
      const key = idKey(message.id)
      const deferred = pending.get(key)
      if (deferred === undefined) {
        return Effect.logWarning("Received a response for an unknown request id", message.id)
      }
      pending.delete(key)
      return isSuccess(message)
        ? Deferred.succeed(deferred, message.result).pipe(Effect.asVoid)
        : Deferred.fail(deferred, RpcError.of(message.error.code, message.error.message, message.error.data)).pipe(
          Effect.asVoid
        )
    }

    /**
     * Handles one decoded JSON value. Requests are returned (not executed) so the
     * caller decides whether they answer individually or as part of a batch.
     */
    const classify = (
      dispatcher: Dispatcher,
      raw: unknown
    ): Effect.Effect<Option.Option<RequestMessage | FailureMessage>> =>
      Result.match(decodeMessage(raw), {
        onFailure: () => Effect.succeedSome(failure(idOf(raw), RpcError.invalidRequest())),
        onSuccess: (message) => {
          if (isRequest(message)) return Effect.succeedSome(message)
          if (isNotification(message)) return handleNotification(dispatcher, message).pipe(Effect.as(Option.none()))
          return handleResponse(message).pipe(Effect.as(Option.none()))
        }
      })

    const respond = (dispatcher: Dispatcher, item: RequestMessage | FailureMessage) =>
      "method" in item ? execute(dispatcher, item) : Effect.succeed(item)

    const handleLine = (dispatcher: Dispatcher, line: string): Effect.Effect<void> =>
      Effect.logTrace(`${label} <-`, line).pipe(
        Effect.andThen(decodeLine(line)),
        Effect.matchEffect({
          onFailure: (error) => write(failure(null, RpcError.parseError({ reason: error.message }))),
          onSuccess: (json) => {
            if (!Array.isArray(json)) {
              return classify(dispatcher, json).pipe(
                Effect.flatMap(Option.match({
                  onNone: () => Effect.void,
                  onSome: (item) =>
                    respond(dispatcher, item).pipe(Effect.flatMap(write), FiberSet.run(fibers), Effect.asVoid)
                }))
              )
            }
            if (json.length === 0) return write(failure(null, RpcError.invalidRequest({ reason: "empty batch" })))
            // A batch: answered by one array holding a response per request.
            return Effect.forEach(json, (raw) => classify(dispatcher, raw)).pipe(
              Effect.map((items) => items.flatMap(Option.toArray)),
              Effect.flatMap((items) =>
                Effect.forEach(items, (item) => respond(dispatcher, item), { concurrency: "unbounded" }).pipe(
                  Effect.flatMap((responses) =>
                    Arr.isReadonlyArrayNonEmpty(responses) ? write(responses) : Effect.void
                  ),
                  FiberSet.run(fibers),
                  Effect.asVoid
                )
              )
            )
          }
        })
      )

    const closePending = Deferred.fail(closed, RpcError.internal("Connection closed")).pipe(
      Effect.andThen(
        Effect.forEach(
          Array.from(pending.values()),
          (deferred) => Deferred.fail(deferred, RpcError.internal("Connection closed")),
          {
            discard: true
          }
        )
      ),
      Effect.ensuring(Effect.sync(() => pending.clear()))
    )

    yield* Effect.addFinalizer(() => closePending)

    const sendCancel = (id: number) =>
      Schema.encodeEffect(CancelRequest.params)({ requestId: id }).pipe(
        Effect.flatMap((params) => write({ jsonrpc: "2.0", method: cancelMethod, params })),
        Effect.ignore
      )

    const peer: PeerShape = {
      request: (method, params, requestOptions) =>
        Effect.gen(function*() {
          const encoded = yield* Schema.encodeEffect(method.params)(params).pipe(
            Effect.mapError((error) =>
              RpcError.internal(`Failed to encode params for ${method.name}`, { reason: error.message })
            )
          )
          const id = nextId++
          const key = idKey(id)
          const deferred = yield* Deferred.make<unknown, RpcError>()
          pending.set(key, deferred)
          const raw = yield* write({ jsonrpc: "2.0", id, method: method.name, params: encoded }).pipe(
            Effect.andThen(Effect.raceFirst(Deferred.await(deferred), Deferred.await(closed))),
            Effect.timeoutOrElse({
              duration: requestOptions?.timeout ?? Duration.infinity,
              orElse: () =>
                sendCancel(id).pipe(
                  Effect.andThen(Effect.fail(RpcError.internal(`Request timed out: ${method.name}`)))
                )
            }),
            Effect.onInterrupt(() => pending.has(key) ? sendCancel(id) : Effect.void),
            Effect.ensuring(Effect.sync(() => pending.delete(key)))
          )
          return yield* Schema.decodeUnknownEffect(method.result)(raw).pipe(
            Effect.mapError((error) =>
              RpcError.internal(`Invalid result for ${method.name}`, { reason: error.message })
            )
          )
        }),
      notify: (method, params) =>
        Schema.encodeEffect(method.params)(params).pipe(
          Effect.flatMap((encoded) => write({ jsonrpc: "2.0", method: method.name, params: encoded })),
          Effect.catch((error) => Effect.logError(`Failed to encode notification ${method.name}`, error.message))
        ),
      serve: (dispatcher) =>
        transport.incoming.pipe(
          Stream.runForEach((line) => handleLine(dispatcher, line)),
          Effect.ensuring(closePending)
        )
    }
    return peer
  })

/** The ACP connection's peer (on the stdio transport). */
export class JsonRpcPeer extends Context.Service<JsonRpcPeer, PeerShape>()("lacp/jsonrpc/JsonRpcPeer") {
  static readonly layer = Layer.effect(JsonRpcPeer, makePeer())
}

const idKey = (id: RequestId): string =>
  typeof id === "string" ? `s:${id}` : typeof id === "number" ? `n:${id}` : "null"

const decodeId = Schema.decodeUnknownOption(Schema.Struct({ id: RequestIdSchema }))

/** Best-effort id recovery for invalid request objects. */
const idOf = (raw: unknown): RequestId => Option.match(decodeId(raw), { onNone: () => null, onSome: ({ id }) => id })
