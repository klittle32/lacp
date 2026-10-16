#!/usr/bin/env node
// A minimal stdio MCP server for tests (newline-delimited JSON-RPC).
//
// Tools: `echo` (returns its text), `add` (returns a + b), and `reveal`, which
// adds a `secret` tool and announces it with notifications/tools/list_changed.
// tools/list is paginated (two tools per page). On `initialized` it asks the
// client for its roots and exposes them through the `roots` tool.
import { createInterface } from "node:readline"

const tools = [
  {
    name: "echo",
    title: "Echo",
    description: "Echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true }
  },
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } }
  },
  { name: "reveal", description: "Reveal another tool", inputSchema: { type: "object" } },
  { name: "roots", description: "Show the client's roots", inputSchema: { type: "object" } }
]
let roots = []
let nextId = 1
const pending = new Map()
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `s${nextId++}`
    pending.set(id, resolve)
    send({ jsonrpc: "2.0", id, method, params })
  })

const handle = async (message) => {
  if (message.id !== undefined && message.method === undefined) {
    pending.get(message.id)?.(message)
    pending.delete(message.id)
    return
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result })
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fixture", version: "1.0.0" }
      })
    case "notifications/initialized": {
      const response = await request("roots/list", {})
      roots = response.result?.roots ?? []
      return
    }
    case "ping":
      return reply({})
    case "tools/list": {
      const start = Number(message.params?.cursor ?? 0)
      const page = tools.slice(start, start + 2)
      return reply({ tools: page, ...(start + 2 < tools.length ? { nextCursor: String(start + 2) } : {}) })
    }
    case "tools/call": {
      const { name, arguments: args = {} } = message.params
      if (name === "echo") return reply({ content: [{ type: "text", text: args.text }] })
      if (name === "add") return reply({ content: [], structuredContent: { sum: args.a + args.b } })
      if (name === "roots") return reply({ content: [{ type: "text", text: JSON.stringify(roots) }] })
      if (name === "reveal") {
        tools.push({ name: "secret", description: "A late tool", inputSchema: { type: "object" } })
        reply({ content: [{ type: "text", text: "revealed" }] })
        return send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
      }
      if (name === "secret") return reply({ content: [{ type: "text", text: "42" }] })
      return reply({ content: [{ type: "text", text: `unknown tool ${name}` }], isError: true })
    }
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
      }
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() !== "") handle(JSON.parse(line))
})
