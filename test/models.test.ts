import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import * as Models from "../src/letta/Models.ts"
import type { ModelEntry } from "../src/letta/Protocol.ts"

const entry = (id: string, handle: string, updateArgs?: Record<string, unknown>): ModelEntry => ({
  id,
  handle,
  label: "Claude Opus",
  description: "",
  ...(updateArgs === undefined ? {} : { updateArgs })
})

const opus = (effort: string, contextWindow = 200_000) =>
  entry(`opus-${effort}-${contextWindow}`, "anthropic/claude-opus", {
    reasoning_effort: effort,
    context_window: contextWindow
  })

describe("Models.catalog", () => {
  it("groups effort presets into one model, with the levels in order", () => {
    const [choice] = Models.catalog([opus("high"), opus("none"), opus("medium")])
    assert.strictEqual(choice?.key, "anthropic/claude-opus")
    assert.strictEqual(choice?.name, "Claude Opus · anthropic")
    assert.deepStrictEqual(choice?.presets.map((p) => p.effort), ["none", "medium", "high"])
    assert.deepStrictEqual(choice?.levels, ["none", "medium", "high"])
  })

  it("keeps context-window variants as separate models", () => {
    const choices = Models.catalog([opus("medium"), opus("medium", 1_000_000)])
    assert.deepStrictEqual(choices.map((c) => c.key), [
      "anthropic/claude-opus@200000",
      "anthropic/claude-opus@1000000"
    ])
    assert.deepStrictEqual(choices.map((c) => c.name), [
      "Claude Opus · anthropic · 200K",
      "Claude Opus · anthropic · 1M"
    ])
  })

  it("takes the levels `letta model list` reports, for models without presets too", () => {
    const [byok] = Models.catalog([entry("my-openai/gpt-5", "my-openai/gpt-5")], [
      { id: "my-openai/gpt-5", handle: "my-openai/gpt-5", reasoning_levels: ["high", "low", "minimal", "bogus"] }
    ])
    assert.deepStrictEqual(byok?.levels, ["minimal", "low", "high"])
    assert.deepStrictEqual(byok?.presets, [])
  })
})

describe("Models helpers", () => {
  it("reads the effort from provider-specific model settings", () => {
    assert.deepStrictEqual(Models.settingsEffort({ reasoning_effort: "high" }), Option.some("high"))
    assert.deepStrictEqual(Models.settingsEffort({ reasoning: { reasoning_effort: "low" } }), Option.some("low"))
    assert.deepStrictEqual(Models.settingsEffort({ effort: "max" }), Option.some("max"))
    assert.isTrue(Option.isNone(Models.settingsEffort({ effort: "turbo" })))
    assert.isTrue(Option.isNone(Models.settingsEffort(null)))
  })

  it("selects the preset for the wanted effort, else medium, never just the first preset", () => {
    const choice = Models.catalog([opus("none"), opus("medium"), opus("high")]).at(0)
    assert.isDefined(choice)
    if (choice !== undefined) {
      assert.strictEqual(Models.selectionId(choice, Option.some("high")), "opus-high-200000")
      assert.strictEqual(Models.selectionId(choice, Option.some("xhigh")), "opus-medium-200000")
      assert.strictEqual(Models.selectionId(choice, Option.none()), "opus-medium-200000")
    }
  })

  it("finds the choice for a handle and context window", () => {
    const choices = Models.catalog([opus("medium"), opus("medium", 1_000_000)])
    const find = (contextWindow: Option.Option<number>) =>
      Option.map(Models.findChoice(choices, "anthropic/claude-opus", contextWindow), (c) => c.key)
    assert.deepStrictEqual(find(Option.some(1_000_000)), Option.some("anthropic/claude-opus@1000000"))
    assert.deepStrictEqual(find(Option.none()), Option.some("anthropic/claude-opus@200000"))
  })

  it("formats context windows", () => {
    assert.deepStrictEqual([200_000, 1_000_000, 1_500_000].map(Models.formatTokens), ["200K", "1M", "1.5M"])
  })
})
