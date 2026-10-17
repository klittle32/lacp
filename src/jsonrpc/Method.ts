/**
 * Typed JSON-RPC method descriptors.
 *
 * A descriptor pairs a method name with the Schemas of its params and result,
 * so the same value drives both sides: the caller encodes params and decodes
 * results, the handler decodes params and encodes results.
 */
import { Effect, Option, Schema } from "effect"
import { RpcError } from "./JsonRpc.ts"

export interface RequestMethod<P, PI, A, AI> {
  readonly _tag: "RequestMethod"
  readonly name: string
  readonly params: Schema.Codec<P, PI>
  readonly result: Schema.Codec<A, AI>
}

export interface NotificationMethod<P, PI> {
  readonly _tag: "NotificationMethod"
  readonly name: string
  readonly params: Schema.Codec<P, PI>
}

export const request = <P, PI, A, AI>(
  name: string,
  params: Schema.Codec<P, PI>,
  result: Schema.Codec<A, AI>
): RequestMethod<P, PI, A, AI> => ({ _tag: "RequestMethod", name, params, result })

export const notification = <P, PI>(name: string, params: Schema.Codec<P, PI>): NotificationMethod<P, PI> => ({
  _tag: "NotificationMethod",
  name,
  params
})

/** A handler with its params/result codecs erased, ready for dispatch. */
export interface Handler {
  readonly _tag: "Request" | "Notification"
  readonly method: string
  readonly run: (params: unknown) => Effect.Effect<unknown, RpcError>
}

const invalidParams = (error: Schema.SchemaError) => RpcError.invalidParams({ reason: error.message })

/** Builds a request handler from a descriptor. Invalid params become `-32602`. */
export const handle = <P, PI, A, AI>(
  method: RequestMethod<P, PI, A, AI>,
  f: (params: P) => Effect.Effect<A, RpcError>
): Handler => {
  const decode = Schema.decodeUnknownEffect(method.params)
  const encode = Schema.encodeEffect(method.result)
  return {
    _tag: "Request",
    method: method.name,
    run: (raw) =>
      decode(raw ?? {}).pipe(
        Effect.mapError(invalidParams),
        Effect.flatMap(f),
        Effect.flatMap((a) =>
          encode(a).pipe(Effect.mapError((e) => RpcError.internal("Failed to encode result", { reason: e.message })))
        )
      )
  }
}

/** Builds a notification handler from a descriptor. */
export const handleNotification = <P, PI>(
  method: NotificationMethod<P, PI>,
  f: (params: P) => Effect.Effect<void, RpcError>
): Handler => {
  const decode = Schema.decodeUnknownEffect(method.params)
  return {
    _tag: "Notification",
    method: method.name,
    run: (raw) => decode(raw ?? {}).pipe(Effect.mapError(invalidParams), Effect.flatMap(f))
  }
}

/** Resolves incoming method names to handlers. */
export interface Dispatcher {
  readonly request: (method: string) => Option.Option<Handler["run"]>
  readonly notification: (method: string) => Option.Option<Handler["run"]>
}

export const router = (handlers: Iterable<Handler>): Dispatcher => {
  const requests = new Map<string, Handler["run"]>()
  const notifications = new Map<string, Handler["run"]>()
  for (const handler of handlers) {
    ;(handler._tag === "Request" ? requests : notifications).set(handler.method, handler.run)
  }
  return {
    request: (method) => Option.fromUndefinedOr(requests.get(method)),
    notification: (method) => Option.fromUndefinedOr(notifications.get(method))
  }
}
