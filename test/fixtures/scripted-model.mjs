// A scripted OpenAI-compatible model for the end-to-end tests, served on a free
// port (printed on stdout). Letta Code reaches it as an LM Studio endpoint.
//
// - "SPAWN_WORKER" makes the agent start a background subagent with the Agent tool.
// - The subagent ("WORKER_TASK") answers after SCRIPTED_MODEL_WORKER_MS (default 1500).
// - The follow-up turn Letta runs with the subagent's <task-notification> reports.
// - "FAIL_ONCE" fails the first request for it with HTTP 503 (Letta retries), then answers.
// - Anything else (titles, reflection) gets "ok".
import http from "node:http"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const textOf = (message) =>
  typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
    ? message.content.map((part) => part.text ?? "").join("")
    : ""

const chunk = (delta, finish = null) =>
  `data: ${
    JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })
  }\n\n`

let failedOnce = false

const reply = async (body) => {
  const messages = body.messages ?? []
  const last = messages.at(-1)
  const user = textOf([...messages].reverse().find((m) => m.role === "user"))
  if (user.includes("FAIL_ONCE")) {
    if (failedOnce) return [{ content: "Recovered after a retry." }]
    failedOnce = true
    return { status: 503, error: "The scripted model is overloaded" }
  }
  if (last?.role === "tool") return [{ content: "Started a worker; it will report back." }]
  if (user.includes("<task-notification>")) {
    return [{ reasoning_content: "The worker finished." }, { content: "Here is the listing: a.txt b.txt" }]
  }
  if (user.includes("WORKER_TASK")) {
    await sleep(Number(process.env.SCRIPTED_MODEL_WORKER_MS ?? 1500))
    return [{ content: "a.txt b.txt" }]
  }
  if (user.includes("SPAWN_WORKER")) {
    const tool = (body.tools ?? []).some((t) => t.function?.name === "Agent") ? "Agent" : "Task"
    const args = {
      description: "List directory",
      prompt: "WORKER_TASK list the directory",
      subagent_type: "general-purpose"
    }
    return [{
      tool_calls: [{
        index: 0,
        id: "call_agent_1",
        type: "function",
        function: { name: tool, arguments: JSON.stringify(args) }
      }]
    }]
  }
  return [{ content: "ok" }]
}

const server = http.createServer(async (req, res) => {
  let raw = ""
  for await (const part of req) raw += part
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }))
  }
  if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
    res.writeHead(404)
    return res.end()
  }
  const deltas = await reply(JSON.parse(raw))
  if (!Array.isArray(deltas)) {
    res.writeHead(deltas.status, { "content-type": "application/json" })
    return res.end(JSON.stringify({ error: { message: deltas.error, type: "server_error" } }))
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const delta of deltas) res.write(chunk({ role: "assistant", ...delta }))
  res.write(chunk({}, deltas.some((d) => d.tool_calls) ? "tool_calls" : "stop"))
  res.end("data: [DONE]\n\n")
})
server.listen(0, "127.0.0.1", () => console.log(server.address().port))
