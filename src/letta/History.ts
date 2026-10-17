/**
 * A conversation's stored messages, as Letta's App Server pages them.
 */
import { Effect, Option, Stream } from "effect"
import type { LettaConnection } from "./AppServer.ts"
import type { LettaDisconnected, LettaRequestFailed } from "./Errors.ts"
import { ConversationMessagesListResponse } from "./Protocol.ts"

/** The conversation's messages, one page (of up to 100) per element, newest first. */
export const pages = (conn: LettaConnection, conversationId: string) =>
  Stream.paginate<{ readonly before?: string }, ReadonlyArray<unknown>, LettaRequestFailed | LettaDisconnected>(
    {},
    (cursor) =>
      conn.call(
        (request_id) => ({
          type: "conversation_messages_list",
          request_id,
          conversation_id: conversationId,
          query: { limit: 100, order: "desc", ...cursor }
        }),
        ConversationMessagesListResponse,
        { timeout: "60 seconds" }
      ).pipe(Effect.map((response) =>
        [
          [response.messages],
          response.has_more === true
            ? Option.map(Option.fromNullishOr(response.next_before), (before) => ({ before }))
            : Option.none()
        ] as const
      ))
  )
