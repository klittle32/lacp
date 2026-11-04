import { assert, describe, it } from "@effect/vitest"
import { suppressionProblems } from "../scripts/suppressions.ts"

describe("suppression comments", () => {
  it("accepts a reason and rejects a bare directive", () => {
    assert.deepStrictEqual(
      suppressionProblems("export const value = 1 // oxlint-disable-next-line no-console -- scratch log"),
      []
    )
    assert.strictEqual(
      suppressionProblems("export const value = 1 // oxlint-disable-next-line no-console").length,
      1
    )
    assert.strictEqual(
      suppressionProblems("export const value = 1 // @ts-expect-error the fixture is partial").length,
      0
    )
    assert.strictEqual(suppressionProblems("export const value = 1 // @ts-expect-error").length, 1)
  })

  it("rejects inline silencing of the Effect-native rules even with a reason", () => {
    const problems = suppressionProblems(
      "const value = process.env.PATH // oxlint-disable-next-line effecttsgo/process-env -- the child needs PATH"
    )
    assert.strictEqual(problems.length, 1)
    assert.include(problems[0]?.message, "scoped .oxlintrc.json override")
  })

  it("ignores the same words inside strings and prose", () => {
    assert.deepStrictEqual(
      suppressionProblems("export const sample = \"// oxlint-disable-next-line no-console\""),
      []
    )
    assert.deepStrictEqual(
      suppressionProblems("/** The language service calls this `@effect-diagnostics`. */\nexport const value = 1\n"),
      []
    )
  })
})
