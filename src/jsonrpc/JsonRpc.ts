/**
 * JSON-RPC 2.0 wire model shared by both ACP protocol versions.
 *
 * ACP frames JSON-RPC as newline-delimited JSON over stdio. Both peers send
 * requests, so this module only models the envelopes; method payloads are
 * described with {@link Method} descriptors.
 */
import { Schema } from "effect"

/** ACP allows `null`, integer and string request ids. */
export const RequestId = Schema.Union([Schema.String, Schema.Int, Schema.Null])
export type RequestId = typeof RequestId.Type

export const ErrorObject = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown)
})
export type ErrorObject = typeof ErrorObject.Type

const Version = Schema.Literal("2.0")

export const RequestMessage = Schema.Struct({
  jsonrpc: Version,
  id: RequestId,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown)
})
export type RequestMessage = typeof RequestMessage.Type

export const NotificationMessage = Schema.Struct({
  jsonrpc: Version,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown)
})
export type NotificationMessage = typeof NotificationMessage.Type

export const SuccessMessage = Schema.Struct({
  jsonrpc: Version,
  id: RequestId,
  result: Schema.Unknown
})
export type SuccessMessage = typeof SuccessMessage.Type

export const FailureMessage = Schema.Struct({
  jsonrpc: Version,
  id: RequestId,
  error: ErrorObject
})
export type FailureMessage = typeof FailureMessage.Type

export const ResponseMessage = Schema.Union([SuccessMessage, FailureMessage])
export type ResponseMessage = typeof ResponseMessage.Type

/** Order matters: a request carries both `id` and `method`. */
export const Message = Schema.Union([RequestMessage, NotificationMessage, SuccessMessage, FailureMessage])
export type Message = typeof Message.Type

/** One line on the wire: a single message or (ACP v2) a batch. */
export const Outgoing = Schema.Union([Message, Schema.NonEmptyArray(ResponseMessage)])
export type Outgoing = typeof Outgoing.Type

export const OutgoingJson = Schema.fromJsonString(Outgoing)

/** Lines are parsed in two steps so a malformed member of a batch only rejects itself. */
export const LineJson = Schema.fromJsonString(Schema.Unknown)

export const isRequest = Schema.is(RequestMessage)
export const isNotification = Schema.is(NotificationMessage)
export const isSuccess = Schema.is(SuccessMessage)

/** Error codes used by ACP (JSON-RPC standard codes plus ACP-specific ones). */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RequestCancelled: -32800,
  AuthRequired: -32000,
  ResourceNotFound: -32002,
  UnsupportedProtocolVersion: -32022
} as const

/** A JSON-RPC error, either received from the peer or raised by a local handler. */
export class RpcError extends Schema.TaggedError<RpcError, { readonly brand: unique symbol }>()("RpcError", {
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown)
}) {
  static readonly parseError = (data?: unknown) => RpcError.of(ErrorCode.ParseError, "Parse error", data)
  static readonly invalidRequest = (data?: unknown) => RpcError.of(ErrorCode.InvalidRequest, "Invalid request", data)
  static readonly methodNotFound = (method: string) =>
    RpcError.of(ErrorCode.MethodNotFound, `Method not found: ${method}`, { method })
  static readonly invalidParams = (data?: unknown) => RpcError.of(ErrorCode.InvalidParams, "Invalid params", data)
  static readonly internal = (message: string, data?: unknown) => RpcError.of(ErrorCode.InternalError, message, data)
  static readonly cancelled = () => RpcError.of(ErrorCode.RequestCancelled, "Request cancelled")
  static readonly authRequired = (message = "Authentication required", data?: unknown) =>
    RpcError.of(ErrorCode.AuthRequired, message, data)
  static readonly resourceNotFound = (message: string, data?: unknown) =>
    RpcError.of(ErrorCode.ResourceNotFound, message, data)

  static readonly of = (code: number, message: string, data?: unknown): RpcError =>
    data === undefined ? new RpcError({ code, message }) : new RpcError({ code, message, data })

  /** The wire representation of this error. */
  toErrorObject(): ErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data }
  }
}
