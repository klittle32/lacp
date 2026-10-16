import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { initializeHybrid, initializeV1, start } from "./helpers/AcpClient.ts"
import * as Fake from "./helpers/FakeLetta.ts"

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))
// stdio servers start in the session's cwd, so it has to exist.
const cwd = dirname(fixture)

const v2Server = { type: "stdio", name: "fixture", command: process.execPath, args: [fixture], env: [] }
const v1Server = { name: "fixture", command: process.execPath, args: [fixture], env: [] }

const toolNames = (command: any): ReadonlyArray<string> =>
  command.external_tools.flatMap((group: any) => group.tools.map((tool: any) => tool.name))

const callRequest = (sessionId: string, id: string, tool: string, input: Record<string, unknown>) => ({
  type: "external_tool_call_request",
  request_id: id,
  runtime: Fake.runtime(sessionId),
  tool_call_id: `call-${id}`,
  tool_name: tool,
  input
})

const isResponse = (id: string) => (c: any) => c.type === "external_tool_call_response" && c.request_id === id

describe("client MCP servers", () => {
  it.live("registers their tools with Letta and runs Letta's calls against them (v2)", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const created = yield* client.request("session/new", { cwd, mcpServers: [v2Server] })
      const sessionId = created.result.sessionId as string

      const runtimeStart = (yield* Ref.get(fake.commands)).find((c) => c.type === "runtime_start") as any
      assert.deepStrictEqual(toolNames(runtimeStart), [
        "mcp__fixture__echo",
        "mcp__fixture__add",
        "mcp__fixture__reveal",
        "mcp__fixture__roots"
      ])
      assert.strictEqual(runtimeStart.external_tools[0].tools[0].auto_background, false)

      yield* client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "echo hi" }] })
      yield* fake.emit(Fake.delta(sessionId, {
        message_type: "tool_call_message",
        id: "m1",
        tool_call: { tool_call_id: "call-1", name: "mcp__fixture__echo", arguments: "{\"text\":\"hi\"}" }
      }))
      const toolCall = yield* client.update((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-1")
      assert.strictEqual(toolCall.title, "fixture: Echo")
      assert.strictEqual(toolCall.kind, "read")

      yield* fake.emit(callRequest(sessionId, "1", "mcp__fixture__echo", { text: "hi" }))
      const response = (yield* fake.waitFor(isResponse("1"))) as any
      assert.deepStrictEqual(response.result, { content: [{ type: "text", text: "hi" }] })

      // The server's roots are the session's working directory.
      yield* fake.emit(callRequest(sessionId, "2", "mcp__fixture__roots", {}))
      const roots = (yield* fake.waitFor(isResponse("2"))) as any
      assert.strictEqual(JSON.parse(roots.result.content[0].text)[0].name, "fixtures")
    }))

  it.live("re-registers tools when a server's tool list changes", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeV1)
      const created = yield* client.request("session/new", { cwd, mcpServers: [v1Server] })
      const sessionId = created.result.sessionId as string

      yield* fake.emit(callRequest(sessionId, "r", "mcp__fixture__reveal", {}))
      const update = (yield* fake.waitFor((c) => c.type === "runtime_external_tools_update")) as any
      assert.deepStrictEqual(update.updates[0].runtimes, [Fake.runtime(sessionId)])
      assert.include(toolNames(update.updates[0]), "mcp__fixture__secret")

      yield* fake.emit(callRequest(sessionId, "s", "mcp__fixture__secret", {}))
      const response = (yield* fake.waitFor(isResponse("s"))) as any
      assert.deepStrictEqual(response.result, { content: [{ type: "text", text: "42" }] })
    }))

  it.live("starts the session without servers that fail, and says so", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const created = yield* client.request("session/new", {
        cwd,
        mcpServers: [v2Server, { type: "stdio", name: "broken", command: "/nonexistent/server", args: [], env: [] }]
      })
      assert.isString(created.result.sessionId)
      const notice = yield* client.update((u) => u.sessionUpdate === "notice")
      assert.strictEqual(notice.severity, "warning")
      assert.strictEqual(notice.title, "MCP server \"broken\" is unavailable")
      const runtimeStart = (yield* Ref.get(fake.commands)).find((c) => c.type === "runtime_start") as any
      assert.include(toolNames(runtimeStart), "mcp__fixture__echo")
    }))

  it.live("starts without external tools when the client offers no servers", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const client = yield* start(fake)
      yield* client.request("initialize", initializeV1)
      yield* client.request("session/new", { cwd: "/work", mcpServers: [] })
      const runtimeStart = (yield* Ref.get(fake.commands)).find((c) => c.type === "runtime_start") as any
      assert.notProperty(runtimeStart, "external_tools")
    }))
})
