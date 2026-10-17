/**
 * Letta Code's models, shaped for the session config options: one choice per
 * model (handle and context window, so `…-1M` variants stay separate) and the
 * effort levels that model supports.
 *
 * Letta Code expresses effort in two ways:
 *
 * - Hosted models come as catalog presets, one per effort level
 *   (`updateArgs.reasoning_effort`), selected by id through `update_model`.
 * - Models from the user's own providers (API keys, a ChatGPT subscription)
 *   and the local backend report their levels themselves, and effort is a
 *   model setting. Only `letta model list` reports those levels, and
 *   `letta model set --reasoning` applies them with Letta's own translation
 *   for each provider.
 * - A model on a provider the user added (a BYOK entry, with `provider_type`
 *   in its `updateArgs`, such as `lc-xai/grok-4.7`) may report no levels.
 *   Letta Code then offers the levels of the same model on the hosted
 *   provider (`xai/grok-4.7`), and so does lacp. Effort is a model setting
 *   there too: the entry's own `reasoning_effort` is copied from the hosted
 *   model's first preset and selects nothing.
 */
import { Equal, Option, Predicate, Schema } from "effect"
import type { SelectChoice } from "../domain/Events.ts"
import type { ModelEntry, ModelSettings } from "./Protocol.ts"

export const Effort = Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
export type Effort = typeof Effort.Type
const EFFORTS: ReadonlyArray<Effort> = Effort.literals
export const decodeEffort = Schema.decodeUnknownOption(Effort)

const EFFORT_NAMES: Record<Effort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
}

/** A row of `letta model list` (JSON). */
export const ModelListRow = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  context_window_limit: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  reasoning_levels: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
})
export type ModelListRow = typeof ModelListRow.Type
export const decodeModelList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ModelListRow)))

export interface Preset {
  readonly effort: Effort
  readonly id: string
}

export interface ModelChoice {
  /** Whether the levels are the hosted model's (a model on the user's own provider that reports none). */
  readonly hostedLevels: boolean
  /** Whether Letta Code gives new agents this model (its catalog's `auto` entry, else the one marked default). */
  readonly rank: number
  /** The config option value: the handle, plus `@<context window>` when the handle has several. */
  readonly key: string
  readonly handle: string
  readonly contextWindow: Option.Option<number>
  readonly name: string
  readonly description: Option.Option<string>
  /** Catalog presets by effort, in effort order. */
  readonly presets: ReadonlyArray<Preset>
  /** The entry selected when no preset fits. */
  readonly defaultId: string
  /** The effort levels the model supports, in order. */
  readonly levels: ReadonlyArray<Effort>
}

const contextWindowOf = (entry: ModelEntry) =>
  Option.filter(Option.fromNullishOr(entry.updateArgs?.["context_window"]), Predicate.isNumber)

const effortOf = (entry: ModelEntry) =>
  Option.flatMap(Option.fromNullishOr(entry.updateArgs?.["reasoning_effort"]), decodeEffort)

const inOrder = (efforts: Iterable<Effort>) => {
  const set = new Set(efforts)
  return EFFORTS.filter((effort) => set.has(effort))
}

/** `200K`, `1M`, … */
export const formatTokens = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(1))}M`
    : tokens >= 1000
    ? `${Math.round(tokens / 1000)}K`
    : `${tokens}`

const provider = (handle: string) => handle.includes("/") ? handle.slice(0, handle.indexOf("/")) : undefined

/** For a model on a provider the user added, the same model on the hosted provider of its type. */
const hostedHandle = (entry: ModelEntry): string | undefined => {
  const type = entry.updateArgs?.["provider_type"]
  const name = provider(entry.handle)
  return Predicate.isString(type) && name !== undefined && name !== type
    ? `${type}/${entry.handle.slice(name.length + 1)}`
    : undefined
}

/** Letta Code's choice for new agents ranks 2 (`auto`), else 1 (marked default), else 0. */
const rankOf = (entries: ReadonlyArray<ModelEntry>) =>
  entries.some((e) => e.id === "auto") ? 2 : entries.some((e) => e.isDefault === true) ? 1 : 0

/**
 * Groups `list_models` entries into model choices, taking each model's levels
 * from `letta model list` rows when available and from its presets otherwise.
 */
export const catalog = (
  entries: ReadonlyArray<ModelEntry>,
  rows: ReadonlyArray<ModelListRow> = []
): ReadonlyArray<ModelChoice> => {
  const groups = new Map<string, { readonly first: ModelEntry; readonly entries: Array<ModelEntry> }>()
  for (const entry of entries) {
    const key = `${entry.handle}\u0000${Option.getOrElse(contextWindowOf(entry), () => "")}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { first: entry, entries: [entry] })
    else group.entries.push(entry)
  }
  const variants = new Map<string, number>()
  for (const { first } of groups.values()) variants.set(first.handle, (variants.get(first.handle) ?? 0) + 1)

  const reportedFor = (handle: string, contextWindow: Option.Option<number>) =>
    rows
      .filter((row) =>
        row.handle === handle &&
        (Option.isNone(contextWindow) || row.context_window_limit == null ||
          row.context_window_limit === contextWindow.value)
      )
      .flatMap((row) => (row.reasoning_levels ?? []).flatMap((level) => Option.toArray(decodeEffort(level))))

  const presetsOf = (group: ReadonlyArray<ModelEntry>) => {
    const presets: Array<Preset> = []
    for (const entry of group) {
      const effort = effortOf(entry)
      if (Option.isSome(effort) && !presets.some((p) => p.effort === effort.value)) {
        presets.push({ effort: effort.value, id: entry.id })
      }
    }
    return presets.toSorted((a, b) => EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort))
  }

  /** The levels of a hosted model, matching the context window where one of its variants does. */
  const hostedLevels = (handle: string, contextWindow: Option.Option<number>): ReadonlyArray<Effort> => {
    const hosted = Array.from(groups.values()).filter(({ first }) => first.handle === handle)
    const group = hosted.find(({ first }) => Equal.equals(contextWindowOf(first), contextWindow)) ??
      hosted[0]
    if (group === undefined) return []
    const reported = reportedFor(handle, contextWindowOf(group.first))
    return reported.length > 0 ? inOrder(reported) : presetsOf(group.entries).map((p) => p.effort)
  }

  return Array.from(groups.values(), ({ entries: group, first }): ModelChoice => {
    const handle = first.handle
    const contextWindow = contextWindowOf(first)
    const several = (variants.get(handle) ?? 0) > 1
    const hosted = hostedHandle(first)
    const presets = hosted === undefined ? presetsOf(group) : []
    const reported = reportedFor(handle, contextWindow)
    const label = [
      first.label,
      provider(handle),
      several ? Option.getOrUndefined(Option.map(contextWindow, formatTokens)) : undefined
    ].filter(Predicate.isNotUndefined)
    return {
      hostedLevels: reported.length === 0 && hosted !== undefined,
      rank: rankOf(group),
      key: several ? `${handle}@${Option.getOrElse(Option.map(contextWindow, String), () => "default")}` : handle,
      handle,
      contextWindow,
      name: label.join(" · "),
      description: Option.filter(Option.fromNullishOr(group.find((e) => e.description)?.description), (d) => d !== ""),
      presets,
      defaultId: first.id,
      levels: reported.length > 0
        ? inOrder(reported)
        : hosted !== undefined
        ? hostedLevels(hosted, contextWindow)
        : presets.map((p) => p.effort)
    }
  })
}

/** The model Letta Code gives a new agent: its `auto` entry, else the one marked default, else the first. */
export const defaultChoice = (choices: ReadonlyArray<ModelChoice>): Option.Option<ModelChoice> =>
  Option.fromUndefinedOr(choices.find((c) => c.rank === 2) ?? choices.find((c) => c.rank === 1) ?? choices[0])

/**
 * The level of `choice` closest to `effort` (the lower one between two), so
 * a level picked for another model still means about as much reasoning.
 */
export const nearestLevel = (choice: ModelChoice, effort: Effort): Option.Option<Effort> => {
  const wanted = EFFORTS.indexOf(effort)
  let best: Effort | undefined
  for (const level of choice.levels) {
    const distance = Math.abs(EFFORTS.indexOf(level) - wanted)
    if (best === undefined || distance < Math.abs(EFFORTS.indexOf(best) - wanted)) best = level
  }
  return Option.fromUndefinedOr(best)
}

/** Every level some model supports, in order. */
export const allLevels = (choices: ReadonlyArray<ModelChoice>): ReadonlyArray<Effort> =>
  inOrder(choices.flatMap((c) => c.levels))

/**
 * Model settings with the effort changed wherever the provider keeps it
 * (`reasoning.reasoning_effort`, `reasoning_effort`, `effort`), under
 * `reasoning` when they hold none yet.
 */
export const withEffort = (
  settings: Readonly<Record<string, unknown>>,
  effort: Effort
): Record<string, unknown> => {
  const reasoning = settings["reasoning"]
  const patched: Record<string, unknown> = { ...settings }
  if (Predicate.isObject(reasoning)) patched["reasoning"] = { ...reasoning, reasoning_effort: effort }
  if ("reasoning_effort" in settings) patched["reasoning_effort"] = effort
  if ("effort" in settings) patched["effort"] = effort
  if (!Predicate.isObject(reasoning) && !("reasoning_effort" in settings) && !("effort" in settings)) {
    patched["reasoning"] = { reasoning_effort: effort }
  }
  return patched
}

/** The effort recorded in an agent's or conversation's model settings. */
export const settingsEffort = (settings: ModelSettings | null | undefined): Option.Option<Effort> => {
  for (const value of [settings?.reasoning_effort, settings?.reasoning?.reasoning_effort, settings?.effort]) {
    const effort = Option.flatMap(Option.fromNullishOr(value), decodeEffort)
    if (Option.isSome(effort)) return effort
  }
  return Option.none()
}

/** The choice for a handle and context window (any of the handle's when the window does not match). */
export const findChoice = (
  choices: ReadonlyArray<ModelChoice>,
  handle: string,
  contextWindow: Option.Option<number>
): Option.Option<ModelChoice> =>
  Option.fromUndefinedOr(
    choices.find((c) =>
      c.handle === handle && Option.isSome(contextWindow) && Option.contains(c.contextWindow, contextWindow.value)
    ) ?? choices.find((c) => c.handle === handle)
  )

/** The choice a config value names: its key, or a model handle. */
export const choiceFor = (choices: ReadonlyArray<ModelChoice>, keyOrHandle: string): Option.Option<ModelChoice> =>
  Option.orElse(
    Option.fromUndefinedOr(choices.find((c) => c.key === keyOrHandle)),
    () => findChoice(choices, keyOrHandle, Option.none())
  )

export const presetFor = (choice: ModelChoice, effort: Effort): Option.Option<string> =>
  Option.fromUndefinedOr(choice.presets.find((p) => p.effort === effort)?.id)

/**
 * The entry to select when switching to `choice`: the preset for the current
 * effort if it has one, else its medium preset, else its default entry (never
 * simply the first preset, which is often `none`).
 */
export const selectionId = (choice: ModelChoice, effort: Option.Option<Effort>): string =>
  Option.getOrElse(
    Option.orElse(Option.flatMap(effort, (e) => presetFor(choice, e)), () => presetFor(choice, "medium")),
    () => choice.defaultId
  )

export const modelChoices = (choices: ReadonlyArray<ModelChoice>): Array<SelectChoice> =>
  choices.map((c) => ({
    value: c.key,
    name: c.name,
    description: Option.getOrElse(c.description, () => c.handle)
  }))

export const effortChoices = (levels: ReadonlyArray<Effort>): Array<SelectChoice> =>
  levels.map((level) => ({ value: level, name: EFFORT_NAMES[level] }))

/**
 * The effort shown among `levels`: the recorded one if it is there, else
 * medium, else the first, as Letta Code preselects in its model picker.
 */
export const shownEffort = (levels: ReadonlyArray<Effort>, effort: Option.Option<Effort>): Effort | undefined =>
  Option.isSome(effort) && levels.includes(effort.value)
    ? effort.value
    : levels.includes("medium")
    ? "medium"
    : levels[0]
