/**
 * Converts ACP prompt content into a Letta `MessageCreate` content payload,
 * and recognises Letta slash commands typed into the prompt.
 */
import { Match, Option } from "effect"
import type { ContentBlock } from "../acp/Content.ts"
import type { Command } from "../domain/Events.ts"
import type { MessageContentPart } from "../letta/Protocol.ts"

const fileUriPath = (uri: string) => (uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri)

/** Renders one block for the model. Images become image parts; everything else becomes text. */
const part: (block: ContentBlock) => MessageContentPart = Match.type<ContentBlock>().pipe(
  Match.discriminatorsExhaustive("type")({
    text: (block): MessageContentPart => ({ type: "text", text: block.text }),
    image: (block): MessageContentPart => ({
      type: "image",
      source: { type: "base64", media_type: block.mimeType, data: block.data }
    }),
    audio: (block): MessageContentPart => ({
      type: "text",
      text: `[An audio attachment (${block.mimeType}) was omitted: audio input is not supported.]`
    }),
    resource_link: (block): MessageContentPart => ({ type: "text", text: `@${fileUriPath(block.uri)}` }),
    resource: (block): MessageContentPart => {
      const path = fileUriPath(block.resource.uri)
      return "text" in block.resource
        ? { type: "text", text: `<file path="${path}">\n${block.resource.text}\n</file>` }
        : { type: "text", text: `[A binary attachment was omitted: ${path}]` }
    }
  })
)

/** Letta accepts a plain string or content parts; plain text stays a string. */
export const toLettaContent = (blocks: ReadonlyArray<ContentBlock>): string | ReadonlyArray<MessageContentPart> => {
  const parts = blocks.map(part)
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => ("text" in p ? p.text : "")).join("\n\n")
  }
  return parts
}

/** The prompt as plain text (for slash-command detection). */
export const plainText = (blocks: ReadonlyArray<ContentBlock>) =>
  blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim()

/** `/name rest` where `name` is an advertised command. */
export const slashCommand = (
  text: string,
  commands: ReadonlyArray<Command>
): Option.Option<{ readonly name: string; readonly args: string }> => {
  const match = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text)
  const name = match?.[1]
  if (name === undefined || !commands.some((c) => c.name === name)) return Option.none()
  return Option.some({ name, args: (match?.[2] ?? "").trim() })
}
