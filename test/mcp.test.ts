import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, PubSub } from "effect"
import { FetchHttpClient } from "effect/http"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Bridge from "../src/mcp/Bridge.ts"
import type { McpServerConfig } from "../src/mcp/Config.ts"
import { connect } from "../src/mcp/McpClient.ts"

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))

const stdioServer: McpServerConfig = {
  _tag: "Stdio",
  name: "fixture",
  command: process.execPath,
  args: [fixture],
  env: {}
}

const root = dirname(fixture)
const options = { roots: [root], clientInfo: { name: "lacp-test", version: "0.0.0" } }

const TestLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)

describe("McpClient over stdio", () => {
  it.live("initializes, pages through tools, calls them and follows list_changed", () =>
    Effect.gen(function*() {
      const mcp = yield* connect(stdioServer, options)
      assert.strictEqual(mcp.info.serverInfo.name, "fixture")
      assert.deepStrictEqual((yield* mcp.tools).map((t) => t.name), ["echo", "add", "reveal", "roots"])

      const echo = yield* mcp.callTool("echo", { text: "hi" }, "10 seconds")
      assert.deepStrictEqual(echo.content, [{ type: "text", text: "hi" }])

      // The server asked for roots after `initialized`; it reports what it got.
      const roots = yield* mcp.callTool("roots", {}, "10 seconds")
      assert.deepStrictEqual(roots.content, [{
        type: "text",
        text: JSON.stringify([{ uri: pathToFileURL(root).href, name: "fixtures" }])
      }])

      const changes = yield* mcp.changes
      yield* mcp.callTool("reveal", {}, "10 seconds")
      const updated = yield* PubSub.take(changes)
      assert.include(updated.map((t) => t.name), "secret")
    }).pipe(Effect.scoped, Effect.provide(TestLayer)))
})

describe("Bridge", () => {
  it("names tools for Letta: namespaced, sanitized, at most 64 characters", () => {
    assert.strictEqual(Bridge.lettaToolName("t3-code", "read_file"), "mcp__t3-code__read_file")
    assert.strictEqual(Bridge.lettaToolName("my server", "do.it!"), "mcp__my_server__do_it_")
    const long = Bridge.lettaToolName("a".repeat(40), "b".repeat(40))
    assert.strictEqual(long.length, 64)
    assert.notStrictEqual(long, Bridge.lettaToolName("a".repeat(40), "c".repeat(40)))
  })

  it("converts MCP results to Letta results", () => {
    assert.deepStrictEqual(
      Bridge.toLettaResult({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///x", text: "body" } },
          { type: "resource_link", uri: "file:///y", name: "y" }
        ],
        isError: true
      }),
      {
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "body" },
          { type: "text", text: "y: file:///y" }
        ],
        is_error: true
      }
    )
    assert.deepStrictEqual(Bridge.toLettaResult({ content: [], structuredContent: { sum: 3 } }), {
      content: [{ type: "text", text: "{\"sum\":3}" }]
    })
  })

  it.live("bridges reachable servers and reports the others", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge.connectAll([
        stdioServer,
        { _tag: "Stdio", name: "broken", command: "/nonexistent/mcp-server", args: [], env: {} }
      ], options)
      assert.deepStrictEqual(bridge.connected, ["fixture"])
      assert.strictEqual(bridge.failures.length, 1)
      assert.strictEqual(bridge.failures[0]?.server, "broken")

      const tools = yield* bridge.tools
      const echo = tools.find((t) => t.name === "mcp__fixture__echo")
      assert.deepStrictEqual(echo, {
        name: "mcp__fixture__echo",
        label: "fixture: Echo",
        description: "Echo text back (MCP tool `echo` from the editor's `fixture` server)",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        timeout_ms: 300_000,
        auto_background: false
      })
      assert.deepStrictEqual(Option.getOrUndefined(bridge.describe("mcp__fixture__echo")), {
        title: "fixture: Echo",
        kind: "read"
      })
      assert.deepStrictEqual(Option.getOrUndefined(bridge.describe("mcp__fixture__add")), {
        title: "fixture: add",
        kind: "other"
      })

      assert.deepStrictEqual(yield* bridge.call("mcp__fixture__echo", { text: "yo" }), {
        content: [{ type: "text", text: "yo" }]
      })
      assert.deepStrictEqual(yield* bridge.call("mcp__fixture__add", { a: 1, b: 2 }), {
        content: [{ type: "text", text: "{\"sum\":3}" }]
      })
      const unknown = yield* bridge.call("mcp__nope__x", {})
      assert.strictEqual(unknown.is_error, true)
    }).pipe(Effect.scoped, Effect.provide(TestLayer)))
})

interface HttpFixture {
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
  const result = (value: unknown) => JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value })
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
      send(answer(JSON.parse(body)))
    })
  }
}

/** A Streamable HTTP MCP endpoint: JSON for most replies, SSE for tools/list, 405 for GET. */
const startHttpServer = Effect.acquireRelease(
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

describe("McpClient over Streamable HTTP", () => {
  it.live("speaks JSON and SSE replies and keeps the session id", () =>
    Effect.gen(function*() {
      const { sessions, url, versions } = yield* startHttpServer
      const mcp = yield* connect({ _tag: "Http", name: "web", url, headers: { authorization: "Bearer t" } }, options)
      assert.strictEqual(mcp.info.protocolVersion, "2025-06-18")
      assert.deepStrictEqual((yield* mcp.tools).map((t) => t.name), ["search"])
      const result = yield* mcp.callTool("search", { q: "effect" }, "10 seconds")
      assert.deepStrictEqual(result.content, [{ type: "text", text: "found effect" }])
      assert.strictEqual(sessions[0], undefined)
      assert.isTrue(sessions.slice(1).every((s) => s === "session-123"))
      // The negotiated version is sent on every request after initialization.
      assert.deepStrictEqual(versions.slice(-2), ["2025-06-18", "2025-06-18"])
    }).pipe(Effect.scoped, Effect.provide(TestLayer)))

  it.live("turns HTTP failures into request errors", () =>
    Effect.gen(function*() {
      const error = yield* connect({ _tag: "Http", name: "down", url: "http://127.0.0.1:9/mcp", headers: {} }, {
        ...options,
        timeout: "5 seconds"
      }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "McpError")
      assert.include(error.message, "initialize failed")
    }).pipe(Effect.scoped, Effect.provide(TestLayer)))
})
