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

  it("offers a model on the user's own provider the levels of the same hosted model", () => {
    const grok = (effort: string) =>
      entry(`grok-4.7-${effort}`, "xai/grok-4.7", { reasoning_effort: effort, context_window: 500_000 })
    // Letta copies the hosted model's first preset onto the entry, so `reasoning_effort` selects nothing.
    const own = entry("lc-xai/grok-4.7", "lc-xai/grok-4.7", {
      reasoning_effort: "low",
      context_window: 500_000,
      provider_type: "xai"
    })
    const choices = Models.catalog([grok("low"), grok("medium"), grok("high"), own], [
      { id: "lc-xai/grok-4.7", handle: "lc-xai/grok-4.7", context_window_limit: 500_000, reasoning_levels: [] }
    ])
    const byok = choices.find((c) => c.handle === "lc-xai/grok-4.7")
    assert.deepStrictEqual(byok?.levels, ["low", "medium", "high"])
    assert.deepStrictEqual(byok?.presets, [])
  })

  it("picks the model Letta Code gives new agents: auto, else the default, else the first", () => {
    const auto = { ...entry("auto", "letta/auto"), isDefault: false }
    const marked = { ...entry("opus", "anthropic/claude-opus"), isDefault: true }
    const plain = entry("sonnet", "anthropic/claude-sonnet")
    const handle = (entries: ReadonlyArray<ModelEntry>) =>
      Option.map(Models.defaultChoice(Models.catalog(entries)), (c) => c.handle)
    assert.deepStrictEqual(handle([plain, marked, auto]), Option.some("letta/auto"))
    assert.deepStrictEqual(handle([plain, marked]), Option.some("anthropic/claude-opus"))
    assert.deepStrictEqual(handle([plain]), Option.some("anthropic/claude-sonnet"))
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

  it("finds the level closest to an asked one, the lower between two", () => {
    const choice = Models.catalog([opus("low"), opus("high")]).at(0)
    assert.isDefined(choice)
    if (choice !== undefined) {
      const nearest = (effort: Models.Effort) => Models.nearestLevel(choice, effort)
      assert.deepStrictEqual(nearest("high"), Option.some("high"))
      assert.deepStrictEqual(nearest("max"), Option.some("high"))
      assert.deepStrictEqual(nearest("none"), Option.some("low"))
      assert.deepStrictEqual(nearest("medium"), Option.some("low"))
    }
  })

  it("changes the effort wherever the provider keeps it", () => {
    assert.deepStrictEqual(
      Models.withEffort({ provider_type: "xai", reasoning: { reasoning_effort: "high" }, temperature: 0.7 }, "low"),
      { provider_type: "xai", reasoning: { reasoning_effort: "low" }, temperature: 0.7 }
    )
    assert.deepStrictEqual(Models.withEffort({ effort: "high" }, "max"), { effort: "max" })
    assert.deepStrictEqual(Models.withEffort({}, "medium"), { reasoning: { reasoning_effort: "medium" } })
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
