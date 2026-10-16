import { Schema } from "effect"

/** No usable `letta` executable was found on this host. */
export class LettaNotFound
  extends Schema.TaggedError<LettaNotFound, { readonly brand: unique symbol }>()("LettaNotFound", {
    message: Schema.String,
    searched: Schema.Array(Schema.String)
  })
{}

/** A `letta` executable was found but is too old or failed its version probe. */
export class LettaUnsupported
  extends Schema.TaggedError<LettaUnsupported, { readonly brand: unique symbol }>()("LettaUnsupported", {
    message: Schema.String,
    command: Schema.String
  })
{}

/** The App Server could not be started or reached. */
export class LettaStartFailed
  extends Schema.TaggedError<LettaStartFailed, { readonly brand: unique symbol }>()("LettaStartFailed", {
    message: Schema.String,
    output: Schema.optionalKey(Schema.String)
  })
{}

/** The App Server connection dropped or the process exited. */
export class LettaDisconnected
  extends Schema.TaggedError<LettaDisconnected, { readonly brand: unique symbol }>()("LettaDisconnected", {
    message: Schema.String
  })
{}

/** An App Server command returned `success: false` or an undecodable response. */
export class LettaRequestFailed
  extends Schema.TaggedError<LettaRequestFailed, { readonly brand: unique symbol }>()("LettaRequestFailed", {
    command: Schema.String,
    message: Schema.String
  })
{}

export type LettaError = LettaNotFound | LettaUnsupported | LettaStartFailed | LettaDisconnected | LettaRequestFailed

const authPattern = /\b(unauthori[sz]ed|401|api key|not logged in|login|credentials|authenticat)/i

/** Heuristic: does this Letta failure mean the user needs to sign in? */
export const isAuthFailure = (error: LettaError): boolean =>
  (error._tag === "LettaStartFailed" || error._tag === "LettaRequestFailed") &&
  authPattern.test(`${error.message} ${"output" in error ? error.output ?? "" : ""}`)
