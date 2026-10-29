/**
 * Session ids for sessions that do not have a Letta conversation yet.
 *
 * A new session gets an id of lacp's own (`lacp-<uuid>`) and no Letta
 * conversation until its first prompt, so a client that opens a session only
 * to read its settings leaves nothing behind in Letta. T3 Code does that each
 * time it checks its providers. Once the conversation exists, the pair is
 * kept in memory and in `~/.letta/lacp/sessions` (one file per side), so the
 * session resumes and lists under its own id, in this process and later ones.
 */
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { SecureRandom } from "effect/crypto/SecureRandom"
import { Host } from "../Host.ts"

const PREFIX = "lacp-"

const Pair = Schema.Struct({ sessionId: Schema.String, conversationId: Schema.String })
const PairJson = Schema.fromJsonString(Pair)
const decodePair = Schema.decodeUnknownOption(PairJson)
const encodePair = Schema.encodeEffect(PairJson)

/** Ids that are safe to use as file names (Letta's and lacp's all are). */
const safe = (id: string) => /^[A-Za-z0-9_-]+$/.test(id)

export class SessionIds extends Context.Service<SessionIds, {
  /** A new session id. */
  readonly make: Effect.Effect<string>
  /** Whether lacp issued the id, so that it may have no conversation yet. */
  readonly isProvisional: (sessionId: string) => boolean
  /** The conversation a provisional session id stands for, once it has one. */
  readonly conversationOf: (sessionId: string) => Effect.Effect<Option.Option<string>>
  /** The provisional session id a conversation was created for, if any. */
  readonly sessionOf: (conversationId: string) => Effect.Effect<Option.Option<string>>
  /** Records that a provisional session now has a conversation. */
  readonly record: (sessionId: string, conversationId: string) => Effect.Effect<void>
}>()("lacp/agent/SessionIds") {
  static readonly layer = Layer.effect(
    SessionIds,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const host = yield* Host
      const crypto = yield* SecureRandom
      const directory = path.join(host.home, ".letta", "lacp", "sessions")
      const known = new Map<string, typeof Pair.Type>()
      const fileOf = (kind: "session" | "conversation", id: string) => path.join(directory, `${kind}-${id}.json`)

      const read = (kind: "session" | "conversation", id: string) =>
        known.has(`${kind}:${id}`)
          ? Effect.succeed(Option.fromUndefinedOr(known.get(`${kind}:${id}`)))
          : safe(id)
          ? fs.readFileString(fileOf(kind, id)).pipe(
            Effect.map(decodePair),
            Effect.orElseSucceed(() => Option.none<typeof Pair.Type>())
          )
          : Effect.succeed(Option.none<typeof Pair.Type>())

      /** Writes a file whole: a reader never sees half of it. */
      const writeAtomically = Effect.fnUntraced(function*(file: string, text: string) {
        const temporary = `${file}.${yield* crypto.uuidV4()}.tmp`
        yield* fs.writeFileString(temporary, text)
        yield* fs.rename(temporary, file)
      })

      const write = Effect.fnUntraced(function*(sessionId: string, conversationId: string) {
        const text = yield* encodePair({ sessionId, conversationId })
        yield* fs.makeDirectory(directory, { recursive: true })
        yield* writeAtomically(fileOf("session", sessionId), text)
        yield* writeAtomically(fileOf("conversation", conversationId), text)
      })

      const record = Effect.fn("SessionIds.record")(function*(sessionId: string, conversationId: string) {
        const pair = { sessionId, conversationId }
        known.set(`session:${sessionId}`, pair)
        known.set(`conversation:${conversationId}`, pair)
        if (!safe(sessionId) || !safe(conversationId)) return
        yield* write(sessionId, conversationId).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Could not remember that session ${sessionId} is Letta conversation ${conversationId} ` +
                `(it will not resume under its id): ${error.message}`
            )
          )
        )
      })

      return SessionIds.of({
        make: crypto.uuidV4().pipe(Effect.map((uuid) => `${PREFIX}${uuid}`)),
        isProvisional: (sessionId) => sessionId.startsWith(PREFIX),
        conversationOf: (sessionId) =>
          read("session", sessionId).pipe(
            Effect.map(Option.filter((pair) => pair.sessionId === sessionId)),
            Effect.map(Option.map((pair) => pair.conversationId))
          ),
        sessionOf: (conversationId) =>
          read("conversation", conversationId).pipe(
            Effect.map(Option.filter((pair) => pair.conversationId === conversationId)),
            Effect.map(Option.map((pair) => pair.sessionId))
          ),
        record
      })
    })
  )
}
