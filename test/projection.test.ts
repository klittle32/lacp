import { assert, describe, it } from "@effect/vitest"
import * as ProjectV1 from "../src/acp/ProjectV1.ts"
import * as ProjectV2 from "../src/acp/ProjectV2.ts"
import type { ConfigOption } from "../src/domain/Events.ts"

const mode = (value: string): ConfigOption => ({
  id: "mode",
  name: "Mode",
  category: "mode",
  currentValue: value,
  options: [{ value: "standard", name: "Standard" }, { value: "strict", name: "Strict" }]
})

describe("ACP v1 projection", () => {
  it("creates a tool call before updating it, without v2-only statuses", () => {
    const p = ProjectV1.makeProjector({ notices: false })
    const first = p.project("s", { _tag: "ToolCall", patch: { toolCallId: "t", name: "Read", status: "pending" } })
    assert.deepStrictEqual(first, [{
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "Read",
      name: "Read",
      status: "pending"
    }])
    const second = p.project("s", { _tag: "ToolCall", patch: { toolCallId: "t", status: "cancelled" } })
    assert.deepStrictEqual(second, [{ sessionUpdate: "tool_call_update", toolCallId: "t", status: "failed" }])
  })

  it("drops state updates and live user echoes, and gates notices", () => {
    const p = ProjectV1.makeProjector({ notices: false })
    assert.deepStrictEqual(p.project("s", { _tag: "State", state: "running" }), [])
    assert.deepStrictEqual(p.project("s", { _tag: "UserMessage", messageId: "m", content: [] }), [])
    assert.deepStrictEqual(p.project("s", { _tag: "Notice", severity: "info", title: "x" }), [])
    const withNotices = ProjectV1.makeProjector({ notices: true })
    assert.strictEqual(withNotices.project("s", { _tag: "Notice", severity: "info", title: "x" }).length, 1)
  })

  it("renders agent-owned terminals as text", () => {
    const p = ProjectV1.makeProjector({ notices: false })
    p.project("s", { _tag: "ToolCall", patch: { toolCallId: "b", title: "`ls`" } })
    p.project("s", { _tag: "Terminal", terminalId: "b", command: "ls" })
    const [update] = p.project("s", { _tag: "Terminal", terminalId: "b", output: "a.txt\n", exitCode: 0 })
    assert.deepStrictEqual(update, {
      sessionUpdate: "tool_call_update",
      toolCallId: "b",
      content: [{ type: "content", content: { type: "text", text: "```console\n$ ls\na.txt\n\n[exit code 0]\n```" } }]
    })
  })

  it("keeps modes in sync with the mode config option, per session", () => {
    const p = ProjectV1.makeProjector({ notices: false })
    const kinds = (sessionId: string, value: string) =>
      p.project(sessionId, { _tag: "ConfigOptions", options: [mode(value)] }).map((u) => u.sessionUpdate)
    assert.deepStrictEqual(kinds("a", "strict"), ["config_option_update", "current_mode_update"])
    assert.deepStrictEqual(kinds("a", "strict"), ["config_option_update"])
    assert.deepStrictEqual(kinds("b", "strict"), ["config_option_update", "current_mode_update"])
    assert.deepStrictEqual(ProjectV1.modeState([mode("standard")]), {
      currentModeId: "standard",
      availableModes: [{ id: "standard", name: "Standard" }, { id: "strict", name: "Strict" }]
    })
  })
})

describe("ACP v2 projection", () => {
  it("projects foreground state", () => {
    assert.deepStrictEqual(ProjectV2.project({ _tag: "State", state: "requires_action" }), [
      { sessionUpdate: "state_update", state: "requires_action" }
    ])
    assert.deepStrictEqual(
      ProjectV2.project({ _tag: "State", state: "idle", stopReason: "error", error: { code: -32603, message: "x" } }),
      [{ sessionUpdate: "state_update", state: "idle", stopReason: "error", error: { code: -32603, message: "x" } }]
    )
  })

  it("encodes terminal output as base64", () => {
    assert.deepStrictEqual(ProjectV2.project({ _tag: "Terminal", terminalId: "t", output: "hé\n", exitCode: 1 }), [{
      sessionUpdate: "terminal_update",
      terminalId: "t",
      output: { data: Buffer.from("hé\n").toString("base64") },
      exitStatus: { exitCode: 1 }
    }])
  })

  it("produces git_patch diffs with absolute paths", () => {
    const [update] = ProjectV2.project({
      _tag: "ToolCall",
      patch: {
        toolCallId: "e",
        content: [{
          _tag: "Diff",
          path: "/work/a.ts",
          oldText: "x",
          newText: "y",
          hunks: [{
            oldStart: 3,
            oldLines: 1,
            newStart: 3,
            newLines: 1,
            lines: [{ type: "remove", content: "x" }, { type: "add", content: "y" }]
          }]
        }]
      }
    })
    assert.deepStrictEqual(update, {
      sessionUpdate: "tool_call_update",
      toolCallId: "e",
      content: [{
        type: "diff",
        changes: [{ operation: "modify", path: "/work/a.ts", fileType: "text" }],
        patch: {
          format: "git_patch",
          text: "diff --git /work/a.ts /work/a.ts\n--- /work/a.ts\n+++ /work/a.ts\n@@ -3,1 +3,1 @@\n-x\n+y\n"
        }
      }]
    })
  })

  it("synthesizes a patch for new files without hunks", () => {
    assert.strictEqual(
      ProjectV2.gitPatch("/n.txt", null, "a\nb\n"),
      "diff --git /n.txt /n.txt\n--- /dev/null\n+++ /n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n"
    )
  })

  it("uses configId for config options and typed command input", () => {
    assert.strictEqual(ProjectV2.configOption(mode("strict")).configId, "mode")
    assert.deepStrictEqual(
      ProjectV2.project({ _tag: "AvailableCommands", commands: [{ name: "c", description: "d", hint: "h" }] }),
      [{
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "c", description: "d", input: { type: "text", hint: "h" } }]
      }]
    )
  })
})
