import { assert, describe, it } from "@effect/vitest"
import { bannedEffectProblems } from "../scripts/banned-effect.ts"

const problemsFor = (source: string, file = "src/example.ts") => bannedEffectProblems(source, file)

describe("banned Effect slips", () => {
  it("reports aliased, bracket, and globalThis spellings", () => {
    const source = `
      const { parse, stringify } = JSON
      const { log } = console
      const { random } = Math
      const { now } = Date
      const { env } = process
      const { setTimeout: later } = globalThis
      export const roundTrip = (text: string) => parse(stringify(parse(text)))
      export const reparse = (text: string) => JSON["parse"](text)
      export const announce = (message: string) => log(message)
      export const roll = () => Math["random"]() + random()
      export const stamp = () => Date["now"]() + now()
      export const home = () => env["HOME"] ?? process["env"]["HOME"]
      export const wait = (task: () => void) => later(task, 0) + globalThis["setTimeout"](task, 0)
      export const id = () => crypto["randomUUID"]()
      export const page = (url: string) => globalThis["fetch"](url)
      export const pending = () => new globalThis["Promise"]((resolve: (value: number) => void) => resolve(1))
      export const made = () => new Date()
      export class LettaFailed extends TypeError {}
      export const Boom = class extends Error {}
    `
    const messages = problemsFor(source).map((problem) => problem.message).join("\n")
    for (
      const needle of [
        "JSON.parse",
        "JSON.stringify",
        "console",
        "Math.random",
        "Date.now",
        "process.env",
        "setTimeout",
        "crypto.randomUUID",
        "fetch",
        "Promise",
        "Date",
        "TypeError",
        "Error"
      ]
    ) {
      assert.include(messages, needle)
    }
  })

  it("reports dynamic Node loads and a generator passed to Effect.gen", () => {
    const source = `
      import { createRequire } from "node:module"
      import { env } from "node:process"
      const req = createRequire(import.meta.url)
      const fs = await import("node:fs")
      export { readFileSync } from "node:fs"
      export { createServer } from "node:http"
      export const file = () => fs.readFileSync("a", "utf8")
      export const required = () => req("node:child_process")
      export const builtin = () => process.getBuiltinModule("node:fs")
      export const path = () => env.PATH
      function* readSettings() {
        try {
          return 1
        } catch {
          return 0
        }
      }
      export const settings = Effect.gen(readSettings)
    `
    const messages = problemsFor(source).map((problem) => problem.message).join("\n")
    assert.include(messages, "node:fs")
    assert.include(messages, "node:http")
    assert.include(messages, "node:child_process")
    assert.include(messages, "process.env")
    assert.include(messages, "try/catch")
  })

  it("allows the process.env object only as a direct capture in src/main.ts", () => {
    const source = "export const host = { env: process.env }\n"
    assert.deepStrictEqual(problemsFor(source, "src/main.ts"), [])
    assert.strictEqual(problemsFor(source, "src/other.ts").length, 1)
    assert.strictEqual(problemsFor("export const snapshot = () => ({ ...process.env })\n", "src/main.ts").length, 1)
  })

  it("allows only the Node module each boundary file needs", () => {
    assert.deepStrictEqual(
      problemsFor("import { spawn } from \"node:child_process\"\n", "test/helpers/E2eProcess.ts"),
      []
    )
    assert.strictEqual(
      problemsFor("import { readFileSync } from \"node:fs\"\n", "test/helpers/E2eProcess.ts").length,
      1
    )
    assert.deepStrictEqual(
      problemsFor(
        "import { createServer } from \"node:http\"\nimport type { AddressInfo } from \"node:net\"\n",
        "test/helpers/McpHttpServer.ts"
      ),
      []
    )
    assert.strictEqual(
      problemsFor("import { randomUUID } from \"node:crypto\"\n", "test/helpers/McpHttpServer.ts").length,
      1
    )
  })

  it("checks a script written as mjs", () => {
    assert.strictEqual(problemsFor("export const home = () => process.env[\"HOME\"]\n", "scripts/zzEnv.mjs").length, 1)
  })
})
