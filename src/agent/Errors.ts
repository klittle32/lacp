/**
 * The agent core's errors, as the ACP server maps them onto JSON-RPC errors.
 */
import { Schema } from "effect"
import { isAuthFailure, type LettaError } from "../letta/Errors.ts"

export class SessionNotFound extends Schema.TaggedError<SessionNotFound, { readonly brand: unique symbol }>()(
  "SessionNotFound",
  { sessionId: Schema.String }
) {}

/** Letta Code could not be reached; `auth` marks failures that need a sign-in. */
export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable, { readonly brand: unique symbol }>()(
  "AgentUnavailable",
  { message: Schema.String, auth: Schema.Boolean }
) {}

export class InvalidConfigValue extends Schema.TaggedError<InvalidConfigValue, { readonly brand: unique symbol }>()(
  "InvalidConfigValue",
  { configId: Schema.String, value: Schema.String }
) {}

export class PromptRejected extends Schema.TaggedError<PromptRejected, { readonly brand: unique symbol }>()(
  "PromptRejected",
  { message: Schema.String }
) {}

export type AgentError = SessionNotFound | AgentUnavailable | InvalidConfigValue | PromptRejected

export const unavailable = (error: LettaError) =>
  new AgentUnavailable({ message: error.message, auth: isAuthFailure(error) })

/** Letta rejecting a config change means the value is invalid; any other failure means Letta is unavailable. */
export const configFailure = (configId: string, value: string) => (error: LettaError) =>
  error._tag === "LettaRequestFailed" ? new InvalidConfigValue({ configId, value }) : unavailable(error)
