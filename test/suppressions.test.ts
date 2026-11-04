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

  it("rejects a blanket disable and a wildcard diagnostic switch", () => {
    const samples = [
      "// oxlint-disable-next-line -- the host shell sets HOME\nexport const home = () => process.env[\"HOME\"]\n",
      "/* oxlint-disable -- legacy module, rewrite later */\nexport const home = () => process.env[\"HOME\"]\n",
      "// eslint-disable-next-line -- quick debugging aid\nexport const debug = (message: string) => console.log(message)\n",
      "// @effect-diagnostics-next-line *:off -- the host shell sets HOME\nexport const home = () => process.env[\"HOME\"]\n",
      "// @effect-diagnostics *:off -- generated module\nexport const now = () => Date.now()\n"
    ]
    for (const sample of samples) {
      const problems = suppressionProblems(sample)
      assert.strictEqual(problems.length, 1, sample)
      assert.include(problems[0]?.message, "silences an Effect-native rule")
    }
  })

  it("sees a disable comment after a regex quote and inside a template", () => {
    const samples = [
      "export const quoted = /\"/\n// oxlint-disable-next-line effecttsgo/process-env -- the host shell sets HOME\nexport const home = () => process.env[\"HOME\"]\n",
      "const marker = /'/\n// oxlint-disable-next-line effecttsgo/global-fetch -- fixture client\nexport const load = () => fetch(\"https://example.invalid\")\n",
      "export const home = () => `${\n// oxlint-disable-next-line effecttsgo/process-env -- the host shell sets HOME\nprocess.env[\"HOME\"]}`\n"
    ]
    for (const sample of samples) {
      const problems = suppressionProblems(sample)
      assert.strictEqual(problems.length, 1, sample)
      assert.include(problems[0]?.message, "silences an Effect-native rule")
    }
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
