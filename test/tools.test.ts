import { NodeServices } from "@effect/platform-node"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Option, Path } from "effect"
import * as Tools from "../src/letta/Tools.ts"

const present = (name: string, input: unknown) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    return Tools.present(name, input, { cwd: "/work", path })
  }).pipe(Effect.provide(NodeServices.layer))

describe("Tools.present", () => {
  it.effect("titles and kinds for common tools", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [string, unknown, string, string]> = [
        ["Edit", { file_path: "/work/a.ts", old_string: "x", new_string: "y" }, "Edit a.ts", "edit"],
        ["Write", { file_path: "b/c.md", content: "" }, "Write b/c.md", "edit"],
        ["Read", { file_path: "/etc/hosts" }, "Read /etc/hosts", "read"],
        ["Bash", { command: "npm test", description: "Run tests" }, "`npm test`", "execute"],
        ["exec_command", { cmd: "ls -la", description: "List" }, "`ls -la`", "execute"],
        ["Grep", { pattern: "TODO", path: "src" }, "grep \"TODO\" src", "search"],
        ["Glob", { pattern: "**/*.ts" }, "Find **/*.ts", "search"],
        ["web_search", { query: "effect v4" }, "Search the web: effect v4", "fetch"],
        [
          "Task",
          { description: "Review", prompt: "p", subagent_type: "general-purpose" },
          "general-purpose: Review",
          "think"
        ],
        ["mcp__github__create_issue", {}, "github: create_issue", "other"],
        ["SomethingNew", {}, "SomethingNew", "other"]
      ]
      for (const [name, input, title, kind] of cases) {
        const p = yield* present(name, input)
        assert.strictEqual(p.title, title, name)
        assert.strictEqual(p.kind, kind, name)
      }
    }))

  it.effect("diffs edits and resolves paths against the session cwd", () =>
    Effect.gen(function*() {
      const p = yield* present("Edit", { file_path: "src/a.ts", old_string: "old", new_string: "new" })
      assert.deepStrictEqual(p.locations, [{ path: "/work/src/a.ts" }])
      // No hunks without an approval request: the field is `undefined`, which `toEqual` ignores.
      expect(p.content).toEqual([{ _tag: "Diff", path: "/work/src/a.ts", oldText: "old", newText: "new" }])
    }))

  it.effect("treats shell tools as terminals", () =>
    Effect.gen(function*() {
      const bash = yield* present("Bash", { command: "make" })
      assert.deepStrictEqual(bash.terminal, Option.some({ command: "make", cwd: "/work" }))
      const exec = yield* present("exec_command", { cmd: "make", workdir: "sub" })
      assert.deepStrictEqual(exec.terminal, Option.some({ command: "make", cwd: "/work/sub" }))
    }))

  it.effect("parses ApplyPatch envelopes", () =>
    Effect.gen(function*() {
      const patch = [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "*** Move to: src/b.ts",
        "@@",
        "-x",
        "+y",
        "*** Delete File: old.txt",
        "*** End Patch"
      ].join("\n")
      assert.deepStrictEqual(Tools.patchFiles(patch), [
        { operation: "update", path: "src/a.ts", moveTo: "src/b.ts" },
        { operation: "delete", path: "old.txt" }
      ])
      const p = yield* present("ApplyPatch", { input: patch })
      assert.strictEqual(p.title, "Apply patch to src/b.ts, old.txt")
    }))
})

describe("Tools helpers", () => {
  it("reads plans from UpdatePlan and TodoWrite", () => {
    assert.deepStrictEqual(
      Tools.planFromInput("UpdatePlan", { plan: [{ step: "a", status: "pending" }] }),
      Option.some([{ content: "a", status: "pending", priority: "medium" }])
    )
    assert.deepStrictEqual(
      Tools.planFromInput("TodoWrite", { todos: [{ content: "b", status: "completed", priority: "high" }] }),
      Option.some([{ content: "b", status: "completed", priority: "high" }])
    )
    assert.deepStrictEqual(Tools.planFromInput("Read", {}), Option.none())
  })

  it("extracts exit codes and task ids", () => {
    assert.deepStrictEqual(Tools.exitCodeOf("boom\nExit code: 127"), Option.some(127))
    assert.deepStrictEqual(Tools.exitCodeOf("fine"), Option.none())
    assert.deepStrictEqual(Tools.createdTaskId("Task #12 created successfully: x"), Option.some("12"))
  })

  it("rebuilds hunk sides", () => {
    const hunks = [{
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { type: "context" as const, content: "keep" },
        { type: "remove" as const, content: "old" },
        { type: "add" as const, content: "new" }
      ]
    }]
    assert.strictEqual(Tools.hunkSide(hunks, "old"), "keep\nold")
    assert.strictEqual(Tools.hunkSide(hunks, "new"), "keep\nnew")
  })
})
