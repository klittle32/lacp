/**
 * In-process Streamable HTTP MCP fixture.
 *
 * `node:http` stays here on purpose: `effecttsgo/node-builtin-import` maps that
 * module to `HttpClient`, which does not serve. See the override in `.oxlintrc.json`.
 */
import { Effect, Schema } from "effect"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

export interface HttpFixture {
  readonly url: string
  /** The `mcp-session-id` header of every POST, in order. */
  readonly sessions: Array<string | undefined>
  /** The `mcp-protocol-version` header of every POST, in order. */
  readonly versions: Array<string | undefined>
}

interface HttpReply {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly body?: string
}

/** The fixture's answer to one JSON-RPC message. */
const answer = (message: any): HttpReply => {
  if (message.id === undefined) return { status: 202 }
  const result = (value: unknown) => encodeJson({ jsonrpc: "2.0", id: message.id, result: value })
  switch (message.method) {
    case "initialize":
      return {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "session-123" },
        body: result({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "web" } })
      }
    case "tools/list":
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `event: message\ndata: ${result({ tools: [{ name: "search", inputSchema: { type: "object" } }] })}\n\n`
      }
    case "tools/call":
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: result({ content: [{ type: "text", text: `found ${message.params.arguments.q}` }] })
      }
    default:
      return { status: 500, body: "boom" }
  }
}

const handleMcp = (fixture: HttpFixture) => (req: IncomingMessage, res: ServerResponse) => {
  const send = ({ body, headers, status }: HttpReply) => res.writeHead(status, headers).end(body)
  // There is no server-initiated stream (405); DELETE ends the session.
  if (req.method === "GET") send({ status: 405 })
  else if (req.method === "DELETE") send({ status: 200 })
  else {
    let body = ""
    req.on("data", (chunk: Buffer) => (body += chunk.toString()))
    req.on("end", () => {
      const header = (name: string) => {
        const value = req.headers[name]
        return typeof value === "string" ? value : undefined
      }
      fixture.sessions.push(header("mcp-session-id"))
      fixture.versions.push(header("mcp-protocol-version"))
      send(answer(decodeJson(body)))
    })
  }
}

/** A Streamable HTTP MCP endpoint: JSON for most replies, SSE for tools/list, 405 for GET. */
export const startHttpServer = Effect.acquireRelease(
  Effect.callback<{ readonly fixture: HttpFixture; readonly server: Server }>((resume) => {
    const fixture: { url: string; sessions: Array<string | undefined>; versions: Array<string | undefined> } = {
      url: "",
      sessions: [],
      versions: []
    }
    const server = createServer(handleMcp(fixture))
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      fixture.url = `http://127.0.0.1:${port}/mcp`
      resume(Effect.succeed({ fixture, server }))
    })
  }),
  ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void)))
).pipe(Effect.map(({ fixture }) => fixture))
