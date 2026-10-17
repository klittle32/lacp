/**
 * A session's settings, offered as config options in this order: model,
 * reasoning effort and permission mode, and how a change is applied in Letta
 * Code.
 *
 * Models and their effort levels come from Letta's catalog (`letta/Models.ts`).
 * Effort is applied through the model's catalog preset where it has one, and
 * with `letta model set --reasoning` otherwise; the mode is device state.
 */
import { Cache, Context, Duration, Effect, Equal, Exit, Layer, Match, Option, Schema } from "effect"
import { LacpConfig } from "../Config.ts"
import type { ConfigOption } from "../domain/Events.ts"
import { LettaAppServer, type LettaConnection } from "../letta/AppServer.ts"
import * as Models from "../letta/Models.ts"
import {
  ConversationRetrieveResponse,
  ListModelsResponse,
  type ModelSettings,
  type PermissionMode,
  PermissionMode as PermissionModeSchema,
  type RuntimeScope,
  type RuntimeStartResponse,
  UpdateModelResponse
} from "../letta/Protocol.ts"
import { type AgentUnavailable, configFailure, InvalidConfigValue, unavailable } from "./Errors.ts"

export const MODE_CONFIG_ID = "mode"
export const MODEL_CONFIG_ID = "model"
export const EFFORT_CONFIG_ID = "effort"

const MODES: ReadonlyArray<{ readonly value: PermissionMode; readonly name: string; readonly description: string }> = [
  { value: "standard", name: "Standard", description: "Ask before running tools that change files or run commands" },
  {
    value: "acceptEdits",
    name: "Accept Edits",
    description: "Apply file edits automatically; ask for everything else"
  },
  { value: "unrestricted", name: "Unrestricted", description: "Run every tool without asking" },
  { value: "strict", name: "Strict", description: "Ask before every tool call" }
]

export const decodePermissionMode = Schema.decodeUnknownOption(PermissionModeSchema)

/** The mode of new sessions (and of sessions Letta reports none for), unless `LACP_PERMISSION_MODE` sets one. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "unrestricted"

/** A session's settings as Letta last reported them, updated in place as they change. */
export interface SessionSettings {
  mode: Option.Option<PermissionMode>
  /** The model handle. */
  model: Option.Option<string>
  /** The reasoning effort recorded in the conversation's model settings. */
  effort: Option.Option<Models.Effort>
  contextWindow: Option.Option<number>
  /** The App Server's model choices. */
  readonly models: ReadonlyArray<Models.ModelChoice>
}

/** The settings of a conversation, or of its agent's new conversations. */
export const initialSettings = (
  started: Pick<RuntimeStartResponse, "agent" | "conversation">,
  models: ReadonlyArray<Models.ModelChoice>,
  mode: Option.Option<PermissionMode>
): SessionSettings => ({
  mode,
  model: Option.fromNullishOr(started.conversation?.model ?? started.agent?.model),
  effort: Models.settingsEffort(started.conversation?.model_settings ?? started.agent?.model_settings),
  contextWindow: Option.fromNullishOr(
    started.conversation?.model_settings?.context_window_limit ??
      started.agent?.llm_config?.context_window ??
      started.agent?.model_settings?.context_window_limit
  ),
  models
})

const currentChoice = (settings: SessionSettings) =>
  Option.flatMap(settings.model, (handle) => Models.findChoice(settings.models, handle, settings.contextWindow))

/** Model, effort (when the model has levels to choose from) and mode, in that order. */
export const configOptions = (settings: SessionSettings): ReadonlyArray<ConfigOption> => {
  const options: Array<ConfigOption> = []
  const choice = currentChoice(settings)
  if (Option.isSome(settings.model) || settings.models.length > 0) {
    const current = Option.match(choice, {
      onSome: (c) => c.key,
      onNone: () => Option.getOrElse(settings.model, () => settings.models[0]?.key ?? "")
    })
    const choices = Models.modelChoices(settings.models)
    if (!choices.some((c) => c.value === current)) choices.unshift({ value: current, name: current })
    options.push({ id: MODEL_CONFIG_ID, name: "Model", category: "model", currentValue: current, options: choices })
  }
  if (Option.isSome(choice) && choice.value.levels.length > 1) {
    options.push({
      id: EFFORT_CONFIG_ID,
      name: "Effort",
      description: "How much the model reasons before it answers",
      category: "thought_level",
      currentValue: Models.shownEffort(choice.value, settings.effort) ?? "",
      options: Models.effortChoices(choice.value)
    })
  }
  options.push({
    id: MODE_CONFIG_ID,
    name: "Mode",
    description: "When Letta Code asks before running tools",
    category: "mode",
    currentValue: Option.getOrElse(settings.mode, () => DEFAULT_PERMISSION_MODE),
    options: MODES.map((m) => ({ value: m.value, name: m.name, description: m.description }))
  })
  return options
}

/** A change to one of a session's config options. */
type Change =
  | { readonly _tag: "Mode"; readonly mode: PermissionMode }
  | { readonly _tag: "Model"; readonly choice: Models.ModelChoice }
  | { readonly _tag: "Effort"; readonly choice: Models.ModelChoice; readonly effort: Models.Effort }

/** The change `value` makes to option `configId`, if the session's models allow it. */
const parseChange = (settings: SessionSettings, configId: string, value: string): Option.Option<Change> => {
  switch (configId) {
    case MODE_CONFIG_ID:
      return Option.map(decodePermissionMode(value), (mode) => ({ _tag: "Mode", mode }))
    case MODEL_CONFIG_ID:
      return Option.map(Models.choiceFor(settings.models, value), (choice) => ({ _tag: "Model", choice }))
    case EFFORT_CONFIG_ID:
      return Option.all({ choice: currentChoice(settings), effort: Models.decodeEffort(value) }).pipe(
        Option.filter(({ choice, effort }) => choice.levels.includes(effort)),
        Option.map(({ choice, effort }) => ({ _tag: "Effort", choice, effort }))
      )
    default:
      return Option.none()
  }
}

/** Where a change applies: the session's runtime, on its connection, and its conversation. */
export interface Target {
  readonly connection: LettaConnection
  readonly runtime: RuntimeScope
  readonly conversationId: string
}

export class Settings extends Context.Service<Settings, {
  /** The model choices of an App Server connection, listed once per connection (a failed listing is retried). */
  catalog(connection: LettaConnection): Effect.Effect<ReadonlyArray<Models.ModelChoice>>
  /** Applies a change to one of the config options. */
  set(
    settings: SessionSettings,
    target: Target,
    configId: string,
    value: string
  ): Effect.Effect<void, InvalidConfigValue | AgentUnavailable>
  /** Records a change for a session without a conversation; `realize` applies it once there is one. */
  choose(settings: SessionSettings, configId: string, value: string): Effect.Effect<void, InvalidConfigValue>
  /**
   * Brings a newly created conversation to the model and effort chosen before
   * it existed. `created` is what Letta gave it; `settings` ends up recording
   * what Letta applied.
   */
  realize(settings: SessionSettings, target: Target, created: SessionSettings): Effect.Effect<void>
  /** Gives a new session the configured model (`LACP_MODEL`), if any. */
  preferConfiguredModel(settings: SessionSettings): Effect.Effect<void>
}>()("lacp/agent/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function*() {
      const appServer = yield* LettaAppServer
      const config = yield* LacpConfig

      /**
       * `list_models`, with each model's effort levels from `letta model list`
       * (which also covers models without presets).
       */
      const listModels = (connection: LettaConnection) =>
        Effect.all([
          connection.call((request_id) => ({ type: "list_models", request_id }), ListModelsResponse, {
            timeout: "15 seconds"
          }),
          appServer.cli(["model", "list"]).pipe(
            Effect.map((output) => Option.getOrElse(Models.decodeModelList(output), () => [])),
            Effect.catch((error) =>
              Effect.logDebug(`Effort levels from \`letta model list\` are unavailable: ${error.message}`).pipe(
                Effect.as([])
              )
            )
          )
        ], { concurrency: "unbounded" }).pipe(
          Effect.map(([listed, rows]) => Models.catalog(listed.entries, rows)),
          Effect.tapError((error) => Effect.logWarning(`Could not list Letta models: ${error.message}`))
        )

      // One listing per connection, shared by the sessions that open while it runs. A failed
      // listing is dropped, so the next session tries again. A restarted App Server is a new
      // connection, and only the latest two are kept.
      const catalogs = yield* Cache.makeWith(listModels, {
        capacity: 2,
        timeToLive: (exit) => Exit.isSuccess(exit) ? Duration.infinity : Duration.zero
      })

      const catalog = (connection: LettaConnection) =>
        // Connections are keyed by identity: comparing two structurally would walk their internals.
        Cache.get(catalogs, Equal.byReferenceUnsafe(connection)).pipe(
          Effect.orElseSucceed((): ReadonlyArray<Models.ModelChoice> => [])
        )

      /** Records what Letta applied, as reported in model settings. */
      const record = (
        settings: SessionSettings,
        handle: Option.Option<string>,
        applied: ModelSettings | null | undefined
      ) => {
        if (Option.isSome(handle)) settings.model = handle
        const contextWindow = Option.fromNullishOr(applied?.context_window_limit)
        if (Option.isSome(contextWindow)) settings.contextWindow = contextWindow
        settings.effort = Models.settingsEffort(applied)
      }

      const updateModel = (target: Target, payload: { readonly model_id?: string; readonly model_handle?: string }) =>
        target.connection.call(
          (request_id) => ({ type: "update_model", request_id, runtime: target.runtime, payload }),
          UpdateModelResponse,
          { timeout: "60 seconds" }
        )

      /**
       * Sets the effort of the session's model: through its preset when it has
       * one, otherwise with `letta model set --reasoning`, read back from the
       * conversation.
       */
      const applyEffort = Effect.fnUntraced(function*(
        settings: SessionSettings,
        target: Target,
        choice: Models.ModelChoice,
        effort: Models.Effort
      ) {
        const preset = Models.presetFor(choice, effort)
        if (Option.isSome(preset)) {
          const response = yield* updateModel(target, { model_id: preset.value, model_handle: choice.handle })
          record(settings, Option.some(response.model_handle ?? choice.handle), response.model_settings)
          return
        }
        yield* appServer.cli(["model", "set", "--conversation", target.conversationId, "--reasoning", effort]).pipe(
          Effect.tapError((error) => Effect.logWarning(`Could not set the effort: ${error.message}`))
        )
        const retrieved = yield* target.connection.call(
          (request_id) => ({ type: "conversation_retrieve", request_id, conversation_id: target.conversationId }),
          ConversationRetrieveResponse
        )
        record(settings, Option.none(), retrieved.conversation?.model_settings)
      })

      /** Switches to `choice`, keeping the current effort when the new model supports it. */
      const applyModel = Effect.fnUntraced(function*(
        settings: SessionSettings,
        target: Target,
        choice: Models.ModelChoice
      ) {
        const wanted = settings.effort
        const response = yield* updateModel(target, {
          model_id: Models.selectionId(choice, wanted),
          model_handle: choice.handle
        })
        record(settings, Option.some(response.model_handle ?? choice.handle), response.model_settings)
        if (response.model_settings?.context_window_limit == null) settings.contextWindow = choice.contextWindow
        if (
          Option.isSome(wanted) && choice.levels.includes(wanted.value) &&
          !Option.contains(settings.effort, wanted.value)
        ) {
          yield* applyEffort(settings, target, choice, wanted.value).pipe(
            Effect.catch((error) => Effect.logWarning(`Could not keep the ${wanted.value} effort: ${error.message}`))
          )
        }
      })

      /** What a config change asks for, validated against the session's models. */
      const parse = (settings: SessionSettings, configId: string, value: string) =>
        Effect.fromOption(parseChange(settings, configId, value)).pipe(
          Effect.mapError(() => new InvalidConfigValue({ configId, value }))
        )

      const set = Effect.fn("Settings.set")(function*(
        settings: SessionSettings,
        target: Target,
        configId: string,
        value: string
      ) {
        yield* Match.valueTags(yield* parse(settings, configId, value), {
          Mode: ({ mode }) =>
            target.connection.send({ type: "change_device_state", runtime: target.runtime, payload: { mode } }).pipe(
              Effect.mapError(unavailable),
              Effect.andThen(Effect.sync(() => {
                settings.mode = Option.some(mode)
              }))
            ),
          Model: ({ choice }) =>
            applyModel(settings, target, choice).pipe(Effect.mapError(configFailure(configId, value))),
          Effort: ({ choice, effort }) =>
            applyEffort(settings, target, choice, effort).pipe(
              Effect.mapError(configFailure(configId, value)),
              Effect.andThen(Effect.suspend(() =>
                Option.contains(settings.effort, effort) ? Effect.void : Effect.logWarning(
                  `Asked Letta for ${effort} effort on ${choice.handle}; it reports ${
                    Option.getOrElse(settings.effort, () => "none recorded")
                  }`
                )
              ))
            )
        })
      })

      const choose = Effect.fn("Settings.choose")(
        function*(settings: SessionSettings, configId: string, value: string) {
          Match.valueTags(yield* parse(settings, configId, value), {
            Mode: ({ mode }) => {
              settings.mode = Option.some(mode)
            },
            Model: ({ choice }) => {
              settings.model = Option.some(choice.handle)
              settings.contextWindow = choice.contextWindow
            },
            Effort: ({ effort }) => {
              settings.effort = Option.some(effort)
            }
          })
        }
      )

      const realize = Effect.fn("Settings.realize")(
        function*(settings: SessionSettings, target: Target, created: SessionSettings) {
          const wanted = { model: settings.model, effort: settings.effort, contextWindow: settings.contextWindow }
          settings.model = created.model
          settings.effort = created.effort
          settings.contextWindow = created.contextWindow
          const wantedChoice = Option.flatMap(
            wanted.model,
            (handle) => Models.findChoice(settings.models, handle, wanted.contextWindow)
          )
          const createdChoice = currentChoice(settings)
          if (
            Option.isSome(wantedChoice) &&
            !Option.exists(createdChoice, (choice) => choice.key === wantedChoice.value.key)
          ) {
            settings.effort = wanted.effort
            yield* applyModel(settings, target, wantedChoice.value)
            return
          }
          if (
            Option.isNone(wantedChoice) && Option.isSome(wanted.model) && !Equal.equals(wanted.model, settings.model)
          ) {
            // A configured model that is not in the catalog.
            const response = yield* updateModel(target, { model_handle: wanted.model.value })
            record(settings, Option.some(response.model_handle ?? wanted.model.value), response.model_settings)
            return
          }
          const effort = Option.filter(
            wanted.effort,
            (effort) =>
              !Option.contains(settings.effort, effort) &&
              Option.exists(createdChoice, (choice) => choice.levels.includes(effort))
          )
          if (Option.isSome(effort) && Option.isSome(createdChoice)) {
            yield* applyEffort(settings, target, createdChoice.value, effort.value)
          }
        },
        Effect.catch((error) => Effect.logWarning(`Could not apply the chosen model or effort: ${error.message}`))
      )

      const preferConfiguredModel = (settings: SessionSettings) =>
        Effect.sync(() => {
          if (Option.isNone(config.model)) return
          const wanted = config.model.value
          const choice = Models.choiceFor(settings.models, wanted)
          settings.model = Option.some(Option.match(choice, { onNone: () => wanted, onSome: (c) => c.handle }))
          if (Option.isSome(choice)) settings.contextWindow = choice.value.contextWindow
        })

      return Settings.of({ catalog, set, choose, realize, preferConfiguredModel })
    })
  )
}
