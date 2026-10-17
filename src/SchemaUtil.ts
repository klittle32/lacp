/**
 * Optional struct fields that may hold `undefined`.
 *
 * Every outgoing message is encoded through `Schema.fromJsonString`, and
 * `JSON.stringify` drops undefined-valued keys, so producers can write an
 * optional field directly (`{ title: patch.title }`) instead of spreading it
 * in conditionally. Decoding from JSON never sees `undefined` either way.
 */
import { Schema } from "effect"

/** A field that may be absent or `undefined`. */
export const opt = Schema.optional

/** A field that may be absent, `undefined` or `null`. */
export const optNull = <S extends Schema.Constraint>(schema: S) => Schema.optional(Schema.NullOr(schema))
