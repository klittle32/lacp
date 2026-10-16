import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Ref } from "effect"
import { initializeHybrid, initializeV1, start } from "./helpers/AcpClient.ts"
import * as Fake from "./helpers/FakeLetta.ts"

const text = (value: string) => [{ type: "text", text: value }]

const isInput = (c: any) => c.type === "input" && c.payload.kind === "create_message"

describe("initialize", () => {
  it.live("negotiates v1 with a v1 client", () =>
    Effect.gen(function*() {
      const client = yield* start(yield* Fake.make)
      const reply = yield* client.request("initialize", initializeV1)
      assert.strictEqual(reply.result.protocolVersion, 1)
      assert.deepStrictEqual(reply.result.agentInfo, { name: "lacp", title: "Letta Code", version: "0.1.0" })
      assert.strictEqual(reply.result.agentCapabilities.loadSession, true)
      assert.deepStrictEqual(reply.result.agentCapabilities.sessionCapabilities, { list: {}, resume: {}, close: {} })
      assert.deepStrictEqual(reply.result.authMethods, [])
    }))

  it.live("negotiates v2 with T3 Code's hybrid request and answers with `info`", () =>
    Effect.gen(function*() {
      const client = yield* start(yield* Fake.make)
      const reply = yield* client.request("initialize", initializeHybrid)
      assert.strictEqual(reply.result.protocolVersion, 2)
      assert.strictEqual(reply.result.info.name, "lacp")
      assert.deepStrictEqual(reply.result.capabilities, {
        session: { prompt: { image: {}, embeddedContext: {} }, mcp: { stdio: {}, http: {} } }
      })
      assert.isUndefined(reply.result.agentInfo)
    }))

  it.live("falls back to v1 when v2 is disabled", () =>
    Effect.gen(function*() {
      const client = yield* start(yield* Fake.make, { maxAcpVersion: 1 })
      const reply = yield* client.request("initialize", initializeHybrid)
      assert.strictEqual(reply.result.protocolVersion, 1)
      assert.isDefined(reply.result.agentInfo)
    }))

  it.live("rejects versions below 1 with -32022 and the supported list", () =>
    Effect.gen(function*() {
      const client = yield* start(yield* Fake.make)
      const reply = yield* client.request("initialize", { protocolVersion: 0, clientInfo: { name: "x", version: "0" } })
      assert.strictEqual(reply.error?.code, -32022)
      assert.deepStrictEqual(reply.error?.data, { requested: 0, supported: [1, 2] })
    }))

  it.live("offers terminal auth only to terminal-capable clients", () =>
    Effect.gen(function*() {
      const client = yield* start(yield* Fake.make)
      const reply = yield* client.request("initialize", {
        ...initializeV1,
        clientCapabilities: { ...initializeV1.clientCapabilities, auth: { terminal: true } }
      })
      assert.deepStrictEqual(reply.result.authMethods, [{
        type: "terminal",
        id: "letta-setup",
        name: "Sign in to Letta",
        description: "Runs `letta setup` in a terminal to sign in to Letta (once per machine).",
        args: ["setup"]
      }])
    }))

  it.live("guards the connection lifecycle", () =>
    Effect.gen(function*() {
      const client = yield* start(yield* Fake.make)
      assert.strictEqual((yield* client.request("session/new", { cwd: "/work", mcpServers: [] })).error?.code, -32600)
      yield* client.request("initialize", initializeV1)
      assert.strictEqual((yield* client.request("initialize", initializeV1)).error?.code, -32600)
      assert.strictEqual((yield* client.request("session/fork", { sessionId: "x" })).error?.code, -32601)
      assert.strictEqual((yield* client.request("auth/login", { methodId: "x" })).error?.code, -32601)
    }))
})

describe("ACP v1 sessions", () => {
  const setup = (fake: Fake.FakeLetta) =>
    Effect.gen(function*() {
      const client = yield* start(fake)
      yield* client.request("initialize", initializeV1)
      const created = yield* client.request("session/new", { cwd: "/work", mcpServers: [] })
      return { client, sessionId: created.result.sessionId as string, created }
    })

  it.live("creates a session with modes, config options and commands", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, created } = yield* setup(fake)
      assert.strictEqual(created.result.sessionId, "conv-1")
      assert.strictEqual(created.result.modes.currentModeId, "standard")
      const [mode, model] = created.result.configOptions
      assert.strictEqual(mode.id, "mode")
      assert.strictEqual(mode.category, "mode")
      assert.strictEqual(model.id, "model")
      assert.strictEqual(model.currentValue, Fake.MODEL)
      assert.deepStrictEqual(model.options.map((o: any) => o.value), [Fake.MODEL, "openai/gpt-5"])
      const commands = yield* client.update((u) => u.sessionUpdate === "available_commands_update")
      assert.deepStrictEqual(commands.availableCommands.map((c: any) => c.name), ["compact", "init", "plan"])
      assert.deepStrictEqual(commands.availableCommands[2].input, { hint: "<on|off>" })
      const start = (yield* Ref.get(fake.commands)).find((c) => c.type === "runtime_start") as any
      assert.strictEqual(start.agent_id, Fake.AGENT_ID)
      assert.strictEqual(start.cwd, "/work")
      assert.deepStrictEqual(start.client_info, { name: "lacp", title: "Letta Code", version: "0.1.0" })
    }))

  it.live("streams a turn and resolves session/prompt with the stop reason", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      const prompt = yield* client.request("session/prompt", { sessionId, prompt: text("hello") }).pipe(
        Effect.forkChild
      )
      const input = (yield* fake.waitFor(isInput)) as any
      assert.strictEqual(input.payload.messages[0].content, "hello")
      yield* fake.emit(
        Fake.delta(sessionId, { message_type: "reasoning_message", id: "r1", otid: "o-r", reasoning: "Thinking" })
      )
      yield* fake.emit(
        Fake.delta(sessionId, { message_type: "assistant_message", id: "a1", otid: "o-a", content: "Hel" })
      )
      yield* fake.emit(
        Fake.delta(sessionId, {
          message_type: "assistant_message",
          id: "a1",
          otid: "o-a",
          content: [{ type: "text", text: "lo" }]
        })
      )
      yield* fake.emit(Fake.turnFinished(sessionId, "end_turn", { usage: { context_tokens: 1234 } }))
      const reply = yield* Fiber.join(prompt)
      assert.deepStrictEqual(reply.result, { stopReason: "end_turn" })
      const updates = yield* client.updates
      const kinds = updates.map((u) => u.sessionUpdate)
      assert.include(kinds, "agent_thought_chunk")
      assert.deepStrictEqual(
        updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => [u.messageId, u.content.text]),
        [["o-a", "Hel"], ["o-a", "lo"]]
      )
      assert.deepStrictEqual(updates.find((u) => u.sessionUpdate === "usage_update"), {
        sessionUpdate: "usage_update",
        used: 1234,
        size: 200_000
      })
      assert.notInclude(kinds, "state_update")
      assert.notInclude(kinds, "user_message")
    }))

  it.live("reports a failed turn as a JSON-RPC error", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      const prompt = yield* client.request("session/prompt", { sessionId, prompt: text("hi") }).pipe(Effect.forkChild)
      yield* fake.waitFor(isInput)
      yield* fake.emit(Fake.turnFinished(sessionId, "llm_api_error", { error: "Provider is not configured" }))
      const reply = yield* Fiber.join(prompt)
      assert.strictEqual(reply.error?.message, "Provider is not configured")
    }))

  it.live("cancels a turn: aborts in Letta and resolves with `cancelled`", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      const prompt = yield* client.request("session/prompt", { sessionId, prompt: text("long task") }).pipe(
        Effect.forkChild
      )
      yield* fake.waitFor(isInput)
      yield* fake.emit(Fake.delta(sessionId, {
        message_type: "approval_request_message",
        id: "t",
        tool_call: { tool_call_id: "call-1", name: "Bash", arguments: "{\"command\":\"sleep 100\"}" }
      }))
      yield* client.notify("session/cancel", { sessionId })
      yield* fake.waitFor((c) => c.type === "abort_message")
      yield* fake.emit(Fake.turnFinished(sessionId, "cancelled"))
      assert.deepStrictEqual((yield* Fiber.join(prompt)).result, { stopReason: "cancelled" })
      const last = (yield* client.updates).findLast((u) => u.toolCallId === "call-1")
      assert.strictEqual(last.status, "failed")
    }))

  it.live("asks for permission and forwards the decision to Letta", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      const prompt = yield* client.request("session/prompt", { sessionId, prompt: text("edit it") }).pipe(
        Effect.forkChild
      )
      yield* fake.waitFor(isInput)
      yield* fake.emit({
        type: "control_request",
        request_id: "perm-call-2",
        runtime: Fake.runtime(sessionId),
        request: {
          subtype: "can_use_tool",
          tool_name: "Edit",
          input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
          tool_call_id: "call-2",
          permission_suggestions: [{ id: "save-default", text: "Yes, and don't ask again for edits" }],
          blocked_path: null,
          diffs: [{
            mode: "advanced",
            fileName: "/work/src/a.ts",
            hunks: [{
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [{ type: "remove", content: "a" }, { type: "add", content: "b" }]
            }]
          }]
        }
      })
      const answer = (yield* fake.waitFor((c: any) =>
        c.type === "input" && c.payload.kind === "approval_response"
      )) as any
      assert.deepStrictEqual(answer.payload, {
        kind: "approval_response",
        request_id: "perm-call-2",
        decision: { behavior: "allow" }
      })
      const [request] = yield* client.agentRequests
      assert.strictEqual(request?.method, "session/request_permission")
      assert.deepStrictEqual(request?.params.options.map((o: any) => [o.optionId, o.kind]), [
        ["allow", "allow_once"],
        ["always:save-default", "allow_always"],
        ["reject", "reject_once"]
      ])
      assert.strictEqual(request?.params.toolCall.title, "Edit src/a.ts")
      assert.deepStrictEqual(request?.params.toolCall.content, [{
        type: "diff",
        path: "/work/src/a.ts",
        oldText: "a",
        newText: "b"
      }])
      yield* fake.emit(Fake.turnFinished(sessionId))
      yield* Fiber.join(prompt)
    }))

  it.live("maps allow-always and reject decisions", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      const permission = (id: string) => ({
        type: "control_request",
        request_id: `perm-${id}`,
        runtime: Fake.runtime(sessionId),
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "npm test", description: "Run tests" },
          tool_call_id: id,
          permission_suggestions: [{ id: "s1", text: "Always allow npm test" }],
          blocked_path: null
        }
      })
      const decisions: Array<unknown> = []
      for (const [id, optionId] of [["c-always", "always:s1"], ["c-reject", "reject"]] as const) {
        yield* client.setPermissionPolicy(() => ({ outcome: { outcome: "selected", optionId } }))
        yield* fake.emit(permission(id))
        const answer = (yield* fake.waitFor((c: any) =>
          c.type === "input" && c.payload.request_id === `perm-${id}`
        )) as any
        decisions.push(answer.payload.decision)
      }
      assert.deepStrictEqual(decisions, [
        { behavior: "allow", selected_permission_suggestion_ids: ["s1"] },
        { behavior: "deny", message: "The user rejected this tool call." }
      ])
    }))

  it.live("switches mode and model through config options", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      const mode = yield* client.request("session/set_mode", { sessionId, modeId: "acceptEdits" })
      assert.deepStrictEqual(mode.result, {})
      const change = (yield* fake.waitFor((c) => c.type === "change_device_state")) as any
      assert.deepStrictEqual(change.payload, { mode: "acceptEdits" })
      yield* client.update((u) => u.sessionUpdate === "current_mode_update" && u.currentModeId === "acceptEdits")

      const model = yield* client.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: "openai/gpt-5"
      })
      assert.strictEqual(model.result.configOptions[1].currentValue, "openai/gpt-5")
      const update = (yield* fake.waitFor((c) => c.type === "update_model")) as any
      assert.deepStrictEqual(update.payload, { model_handle: "openai/gpt-5" })

      const bad = yield* client.request("session/set_config_option", { sessionId, configId: "mode", value: "yolo" })
      assert.strictEqual(bad.error?.code, -32602)
    }))

  it.live("runs Letta slash commands typed into the prompt", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      yield* client.update((u) => u.sessionUpdate === "available_commands_update")
      const reply = yield* client.request("session/prompt", { sessionId, prompt: text("/compact now") })
      assert.deepStrictEqual(reply.result, { stopReason: "end_turn" })
      const command = (yield* fake.waitFor((c) => c.type === "execute_command")) as any
      assert.strictEqual(command.command_id, "compact")
      assert.strictEqual(command.args, "now")
      const output = (yield* client.updates).find((u) => u.sessionUpdate === "agent_message_chunk")
      assert.strictEqual(output.content.text, "Compacted.")
      assert.isUndefined((yield* Ref.get(fake.commands)).find(isInput))
    }))

  it.live("loads a session by replaying its history before responding", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("conversation_messages_list", () => ({
        success: true,
        has_more: false,
        next_before: null,
        messages: [
          { id: "m3", message_type: "assistant_message", content: "Done!", date: "" },
          {
            id: "m2",
            message_type: "tool_call_message",
            tool_call: { tool_call_id: "h1", name: "Read", arguments: "{\"file_path\":\"/work/README.md\"}" },
            date: ""
          },
          {
            id: "m1",
            message_type: "user_message",
            content: "<system-reminder>ctx</system-reminder>Read the readme",
            date: ""
          }
        ]
      }))
      const client = yield* start(fake)
      yield* client.request("initialize", initializeV1)
      const loaded = yield* client.request("session/load", { sessionId: "conv-old", cwd: "/work", mcpServers: [] })
      assert.strictEqual(loaded.result.modes.currentModeId, "standard")
      const updates = yield* client.updates
      assert.deepStrictEqual(updates.slice(0, 3).map((u) => u.sessionUpdate), [
        "user_message_chunk",
        "tool_call",
        "agent_message_chunk"
      ])
      assert.strictEqual(updates[0].content.text, "Read the readme")
      assert.strictEqual(updates[1].title, "Read README.md")

      const missing = yield* client.request("session/load", { sessionId: "missing", cwd: "/work", mcpServers: [] })
      assert.strictEqual(missing.error?.code, -32002)
    }))

  it.live("lists sessions for a project", () =>
    Effect.gen(function*() {
      const client = yield* start(yield* Fake.make, { agentId: Option.some(Fake.AGENT_ID) })
      yield* client.request("initialize", initializeV1)
      const scoped = yield* client.request("session/list", { cwd: "/work" })
      assert.deepStrictEqual(scoped.result.sessions, [{
        sessionId: "conv-a",
        cwd: "/work",
        title: "Fix the build",
        updatedAt: "2026-10-15T10:00:00Z"
      }])
      const all = yield* client.request("session/list", {})
      assert.deepStrictEqual(all.result.sessions.map((s: any) => s.sessionId), ["conv-a", "conv-b"])
    }))

  it.live("waits for a queued prompt to start before honouring turn_finished", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("input", () => ({ success: true, accepted: true, disposition: "queued" }))
      const { client, sessionId } = yield* setup(fake)
      const prompt = yield* client.request("session/prompt", { sessionId, prompt: text("next") }).pipe(Effect.forkChild)
      const input = (yield* fake.waitFor(isInput)) as any
      const clientMessageId = input.payload.messages[0].client_message_id
      // The end of earlier background work must not end our queued turn.
      yield* fake.emit(Fake.turnFinished(sessionId))
      yield* Effect.sleep("50 millis")
      assert.isUndefined(prompt.pollUnsafe())
      yield* fake.emit(
        Fake.delta(sessionId, { message_type: "user_message", id: "u", otid: clientMessageId, content: "next" })
      )
      yield* fake.emit(Fake.delta(sessionId, { message_type: "assistant_message", id: "a", otid: "o", content: "ok" }))
      yield* fake.emit(Fake.turnFinished(sessionId))
      assert.deepStrictEqual((yield* Fiber.join(prompt)).result, { stopReason: "end_turn" })
      assert.notInclude((yield* client.updates).map((u) => u.sessionUpdate), "user_message_chunk")
    }))
})

describe("ACP v2 sessions", () => {
  const setup = (fake: Fake.FakeLetta) =>
    Effect.gen(function*() {
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const created = yield* client.request("session/new", { cwd: "/work" })
      return { client, sessionId: created.result.sessionId as string, created }
    })

  it.live("returns availableCommands and v2 config options from session/new", () =>
    Effect.gen(function*() {
      const { created } = yield* setup(yield* Fake.make)
      assert.deepStrictEqual(created.result.configOptions.map((o: any) => o.configId), ["mode", "model"])
      assert.deepStrictEqual(created.result.availableCommands[2], {
        name: "plan",
        description: "Toggle plan mode",
        input: { type: "text", hint: "<on|off>" }
      })
    }))

  it.live("answers session/prompt on insertion and ends the turn with state_update", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      const reply = yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      const messageId = reply.result.messageId as string
      assert.isString(messageId)
      const echo = yield* client.update((u) => u.sessionUpdate === "user_message")
      assert.strictEqual(echo.messageId, messageId)
      yield* client.update((u) => u.sessionUpdate === "state_update" && u.state === "running")
      yield* fake.emit(Fake.delta(sessionId, { message_type: "assistant_message", id: "a", otid: "o", content: "hi" }))
      yield* fake.emit(Fake.turnFinished(sessionId))
      const idle = yield* client.update((u) => u.sessionUpdate === "state_update" && u.state === "idle")
      assert.deepStrictEqual(idle, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" })
    }))

  it.live("reports errors after insertion as idle with stopReason error", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      yield* client.request("session/prompt", { sessionId, prompt: text("hello") })
      yield* fake.emit(Fake.turnFinished(sessionId, "insufficient_credits", { error: "Out of credits" }))
      const idle = yield* client.update((u) => u.sessionUpdate === "state_update" && u.state === "idle")
      assert.deepStrictEqual(idle, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "error",
        error: { code: -32603, message: "Out of credits" }
      })
    }))

  it.live("shows shell tools as agent-owned terminals and blocks on approval", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      yield* client.request("session/prompt", { sessionId, prompt: text("test it") })
      yield* fake.emit({
        type: "control_request",
        request_id: "perm-sh",
        runtime: Fake.runtime(sessionId),
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "npm test", description: "Run tests" },
          tool_call_id: "sh",
          permission_suggestions: [],
          blocked_path: null
        }
      })
      yield* client.update((u) => u.sessionUpdate === "state_update" && u.state === "requires_action")
      yield* fake.waitFor((c: any) => c.type === "input" && c.payload.kind === "approval_response")
      const [request] = yield* client.agentRequests
      assert.strictEqual(request?.params.title, "`npm test`")
      assert.strictEqual(request?.params.subject.type, "tool_call")
      yield* fake.emit(
        Fake.delta(sessionId, { message_type: "client_tool_start", tool_call_id: "sh", tool_name: "Bash" })
      )
      yield* fake.emit(Fake.delta(sessionId, {
        message_type: "tool_return_message",
        id: "tool-return-sh",
        tool_call_id: "sh",
        status: "success",
        tool_return: "all tests passed\n"
      }))
      yield* fake.emit(Fake.turnFinished(sessionId))
      yield* client.update((u) => u.sessionUpdate === "state_update" && u.state === "idle")
      const terminals = (yield* client.updates).filter((u) => u.sessionUpdate === "terminal_update")
      assert.strictEqual(terminals[0].command, "npm test")
      assert.strictEqual(Buffer.from(terminals[1].output.data, "base64").toString(), "all tests passed\n")
      assert.deepStrictEqual(terminals[1].exitStatus, { exitCode: 0 })
      const final = (yield* client.updates).findLast((u) =>
        u.sessionUpdate === "tool_call_update" && u.toolCallId === "sh"
      )
      assert.strictEqual(final.status, "completed")
      assert.deepStrictEqual(final.content, [{ type: "terminal", terminalId: "sh" }])
    }))

  it.live("emits plan_update from UpdatePlan", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      const { client, sessionId } = yield* setup(fake)
      yield* fake.emit(Fake.delta(sessionId, {
        message_type: "tool_call_message",
        id: "p",
        tool_call: {
          tool_call_id: "plan-1",
          name: "UpdatePlan",
          arguments:
            "{\"plan\":[{\"step\":\"Write tests\",\"status\":\"completed\"},{\"step\":\"Ship\",\"status\":\"in_progress\"}]}"
        }
      }))
      const plan = yield* client.update((u) => u.sessionUpdate === "plan_update")
      assert.deepStrictEqual(plan.plan.entries, [
        { content: "Write tests", status: "completed", priority: "medium" },
        { content: "Ship", status: "in_progress", priority: "medium" }
      ])
    }))

  it.live("resumes with replay and reports the foreground state first", () =>
    Effect.gen(function*() {
      const fake = yield* Fake.make
      yield* fake.on("conversation_messages_list", () => ({
        success: true,
        has_more: false,
        next_before: null,
        messages: [{ id: "m1", message_type: "assistant_message", content: "Earlier answer", date: "" }]
      }))
      const client = yield* start(fake)
      yield* client.request("initialize", initializeHybrid)
      const resumed = yield* client.request("session/resume", {
        sessionId: "conv-old",
        cwd: "/work",
        replayFrom: { type: "start" }
      })
      assert.deepStrictEqual(resumed.result.configOptions.map((o: any) => o.configId), ["mode", "model"])
      const updates = yield* client.updates
      assert.deepStrictEqual(updates.slice(0, 2), [
        { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Earlier answer" } },
        { sessionUpdate: "session_info_update", title: "Earlier work" }
      ])
      assert.isTrue(updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"))

      const bad = yield* client.request("session/resume", {
        sessionId: "conv-old",
        cwd: "/work",
        replayFrom: { type: "_later" }
      })
      assert.strictEqual(bad.error?.code, -32602)
    }))

  it.live("closes a session", () =>
    Effect.gen(function*() {
      const { client, sessionId } = yield* setup(yield* Fake.make)
      assert.deepStrictEqual((yield* client.request("session/close", { sessionId })).result, {})
      assert.strictEqual(
        (yield* client.request("session/prompt", { sessionId, prompt: text("x") })).error?.code,
        -32002
      )
    }))
})
