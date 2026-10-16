import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Path } from "effect"
import * as Translator from "../src/letta/Translator.ts"

const make = Effect.gen(function*() {
  const path = yield* Path.Path
  return Translator.make({ cwd: () => "/work", path, contextWindow: () => Option.some(100_000) })
}).pipe(Effect.provide(NodeServices.layer))

const events = (items: ReadonlyArray<Translator.TranslatedEvent>) =>
  items.flatMap((item) => (item._tag === "Event" ? [item.event] : []))

describe("Translator", () => {
  it.effect("keys assistant and reasoning fragments by otid and drops replays", () =>
    Effect.gen(function*() {
      const t = yield* make
      const a = { message_type: "assistant_message", id: "a", otid: "o1", run_id: "r", seq_id: 1, content: "Hi" }
      assert.deepStrictEqual(events(t.delta(a)), [{
        _tag: "AgentMessageChunk",
        messageId: "o1",
        content: { type: "text", text: "Hi" }
      }])
      assert.deepStrictEqual(events(t.delta(a)), [], "replayed (run_id, seq_id) is dropped")
      const r = events(t.delta({ message_type: "reasoning_message", id: "b", otid: "o1", reasoning: "hmm" }))
      assert.deepStrictEqual(r, [{
        _tag: "AgentThoughtChunk",
        messageId: "o1",
        content: { type: "text", text: "hmm" }
      }])
    }))

  it.effect("accumulates streamed tool arguments until they parse", () =>
    Effect.gen(function*() {
      const t = yield* make
      const fragment = (args: string) => ({
        message_type: "approval_request_message",
        id: "x",
        tool_call: { tool_call_id: "c1", name: "Read", arguments: args }
      })
      const first = events(t.delta(fragment("{\"file_path\":")))
      assert.strictEqual(first.length, 1)
      assert.strictEqual(first[0]?._tag === "ToolCall" && first[0].patch.title, "Read file")
      const second = events(t.delta(fragment("\"src/index.ts\",\"offset\":10,\"limit\":5}")))
      assert.deepStrictEqual(second[0]?._tag === "ToolCall" ? second[0].patch : undefined, {
        toolCallId: "c1",
        name: "Read",
        title: "Read src/index.ts (lines 10-14)",
        kind: "read",
        locations: [{ path: "/work/src/index.ts", line: 10 }],
        content: [],
        rawInput: { file_path: "src/index.ts", offset: 10, limit: 5 },
        status: "pending"
      })
    }))

  it.effect("completes tools with their output and status", () =>
    Effect.gen(function*() {
      const t = yield* make
      t.delta({
        message_type: "tool_call_message",
        id: "x",
        tool_call: { tool_call_id: "g", name: "Grep", arguments: "{\"pattern\":\"TODO\"}" }
      })
      const done = events(t.delta({
        message_type: "tool_return_message",
        id: "tool-return-g",
        tool_call_id: "g",
        status: "error",
        tool_return: "rg: not found"
      }))
      assert.deepStrictEqual(done, [{
        _tag: "ToolCall",
        patch: {
          toolCallId: "g",
          status: "failed",
          content: [{ _tag: "Content", content: { type: "text", text: "rg: not found" } }],
          rawOutput: "rg: not found"
        }
      }])
    }))

  it.effect("renders shell tools as terminals with live output", () =>
    Effect.gen(function*() {
      const t = yield* make
      t.delta({
        message_type: "tool_call_message",
        id: "x",
        tool_call: { tool_call_id: "b", name: "Bash", arguments: "{\"command\":\"ls\",\"description\":\"List\"}" }
      })
      const started = events(t.delta({ message_type: "client_tool_start", tool_call_id: "b" }))
      assert.deepStrictEqual(started[0], { _tag: "Terminal", terminalId: "b", command: "ls", cwd: "/work" })
      const live = events(t.delta({
        message_type: "tool_return_message",
        id: "synthetic-tool-return-stream-1",
        tool_call_id: "b",
        status: "success",
        tool_return: "a"
      }))
      assert.deepStrictEqual(live, [{ _tag: "Terminal", terminalId: "b", output: "a" }])
      const final = events(t.delta({
        message_type: "tool_return_message",
        id: "tool-return-b",
        tool_call_id: "b",
        status: "error",
        tool_return: "a\nExit code: 2"
      }))
      assert.deepStrictEqual(final[0], { _tag: "Terminal", terminalId: "b", output: "a\nExit code: 2", exitCode: 2 })
    }))

  it.effect("builds a plan from TaskCreate / TaskUpdate results", () =>
    Effect.gen(function*() {
      const t = yield* make
      const call = (id: string, name: string, args: unknown) =>
        t.delta({
          message_type: "tool_call_message",
          id,
          tool_call: { tool_call_id: id, name, arguments: JSON.stringify(args) }
        })
      const ret = (id: string, output: string) =>
        events(
          t.delta({
            message_type: "tool_return_message",
            id: `r-${id}`,
            tool_call_id: id,
            status: "success",
            tool_return: output
          })
        )
      call("t1", "TaskCreate", { subject: "Write docs", description: "" })
      const created = ret("t1", "Task #1 created successfully: Write docs")
      assert.deepStrictEqual(created.at(-1), {
        _tag: "Plan",
        planId: "plan",
        entries: [{ content: "Write docs", status: "pending", priority: "medium" }]
      })
      call("t2", "TaskUpdate", { taskId: "1", status: "completed" })
      const updated = ret("t2", "Updated")
      assert.deepStrictEqual(updated.at(-1), {
        _tag: "Plan",
        planId: "plan",
        entries: [{ content: "Write docs", status: "completed", priority: "medium" }]
      })
    }))

  it.effect("builds permission requests with Letta's suggestions and diffs", () =>
    Effect.gen(function*() {
      const t = yield* make
      const { request } = t.permission({
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: "/work/new.txt", content: "x" },
        tool_call_id: "w",
        permission_suggestions: [{ id: "s", text: "Always" }],
        blocked_path: null
      })
      assert.strictEqual(request.title, "Write new.txt")
      assert.deepStrictEqual(request.options.map((o) => o.optionId), ["allow", "always:s", "reject"])
      assert.deepStrictEqual(request.toolCall.content, [{
        _tag: "Diff",
        path: "/work/new.txt",
        oldText: null,
        newText: "x"
      }])
    }))

  it.effect("strips system reminders and flags user echoes", () =>
    Effect.gen(function*() {
      const t = yield* make
      const [echo] = t.delta({
        message_type: "user_message",
        id: "u",
        otid: "client-1",
        content: [{ type: "text", text: "<system-reminder>\nenv\n</system-reminder>\nfix it" }]
      })
      assert.strictEqual(echo?._tag, "UserEcho")
      if (echo?._tag === "UserEcho") {
        assert.deepStrictEqual(echo.otid, Option.some("client-1"))
        assert.deepStrictEqual(echo.event, {
          _tag: "UserMessageChunk",
          messageId: "client-1",
          content: { type: "text", text: "fix it" }
        })
      }
    }))

  it.effect("drops the task notifications Letta injects as user messages, live and in history", () =>
    Effect.gen(function*() {
      const t = yield* make
      const notification = "<task-notification>\n<task-id>task_1</task-id>\n<summary>Agent finished</summary>\n" +
        "</task-notification>\nFull transcript available at: /tmp/task_1.log\n"
      assert.deepStrictEqual(t.delta({ message_type: "user_message", id: "u1", content: notification }), [])
      assert.deepStrictEqual(t.history({ message_type: "user_message", id: "u2", content: notification }), [])
      assert.deepStrictEqual(
        t.history({ message_type: "user_message", id: "u3", content: `${notification}and also this` }),
        [{
          _tag: "UserMessageChunk",
          messageId: "u3",
          content: { type: "text", text: "and also this" }
        }]
      )
    }))

  it.effect("closes open tool calls when a turn ends", () =>
    Effect.gen(function*() {
      const t = yield* make
      t.delta({
        message_type: "tool_call_message",
        id: "x",
        tool_call: { tool_call_id: "open", name: "Glob", arguments: "{\"pattern\":\"*.ts\"}" }
      })
      assert.deepStrictEqual(t.finishTurn("cancelled"), [{
        _tag: "ToolCall",
        patch: { toolCallId: "open", status: "cancelled" }
      }])
      assert.deepStrictEqual(t.finishTurn("end_turn"), [])
    }))

  it.effect("reports usage against the context window", () =>
    Effect.gen(function*() {
      const t = yield* make
      assert.deepStrictEqual(events(t.delta({ message_type: "usage_statistics", context_tokens: 5000 })), [
        { _tag: "Usage", used: 5000, size: 100_000 }
      ])
    }))
})
