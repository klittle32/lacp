/**
 * An in-memory Letta Code App Server connection for tests.
 *
 * Commands are recorded and answered by overridable handlers; tests push
 * runtime frames (stream deltas, approvals, turn ends) with `emit`.
 */
import { Effect, Option, PubSub, Ref, Schema } from "effect"
import type { Frame, LettaConnection, Reply } from "../../src/letta/AppServer.ts"
import { LettaRequestFailed } from "../../src/letta/Errors.ts"
import { type Command, FrameHeader } from "../../src/letta/Protocol.ts"

/** Answers a command: with a response, or with an Effect producing one (e.g. one that never ends). */
export type Handler = (command: Command) => Effect.Effect<unknown> | Record<string, unknown>

export interface FakeLetta {
  readonly connection: LettaConnection
  /** Stands in for `letta <args>` (`model list` and `model set`). */
  readonly cli: (args: ReadonlyArray<string>) => Effect.Effect<string, LettaRequestFailed>
  /** Every `letta` subcommand run, in order. */
  readonly cliCalls: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>
  /** Every command sent or called, in order. */
  readonly commands: Ref.Ref<ReadonlyArray<Command>>
  /** Publishes a frame to subscribers. */
  emit(frame: Record<string, unknown>): Effect.Effect<void>
  /** Overrides the response to a command type. */
  on(type: Command["type"], handler: Handler): Effect.Effect<void>
  /** Waits until a command matching `predicate` has been sent. */
  waitFor(predicate: (command: Command) => boolean): Effect.Effect<Command>
}

export const AGENT_ID = "agent-test"
export const MODEL = "anthropic/claude-sonnet-4-5"
/** A model without effort presets: its levels come from `letta model list`. */
export const BYOK_MODEL = "openai/gpt-5"

const preset = (effort: string) => ({
  id: `sonnet-${effort}`,
  handle: MODEL,
  label: "Claude Sonnet",
  description: "Balanced",
  updateArgs: { reasoning_effort: effort, context_window: 200_000 }
})

interface FakeModelEntry {
  readonly id: string
  readonly handle: string
  readonly label: string
  readonly description: string | null
  readonly updateArgs?: { readonly reasoning_effort: string; readonly context_window: number }
}

/** `list_models`: Sonnet as three effort presets, GPT-5 as one entry. */
export const MODEL_ENTRIES: ReadonlyArray<FakeModelEntry> = [
  preset("low"),
  preset("medium"),
  preset("high"),
  { id: BYOK_MODEL, handle: BYOK_MODEL, label: "GPT-5", description: null }
]

/** `letta model list`. */
export const MODEL_LIST = [
  ...["low", "medium", "high"].map((effort) => ({
    id: `sonnet-${effort}`,
    handle: MODEL,
    label: "Claude Sonnet",
    context_window_limit: 200_000,
    reasoning_levels: ["low", "medium", "high"]
  })),
  {
    id: BYOK_MODEL,
    handle: BYOK_MODEL,
    label: "GPT-5",
    context_window_limit: 400_000,
    reasoning_levels: ["minimal", "low", "medium", "high"]
  }
]

export const runtime = (conversationId: string) => ({ agent_id: AGENT_ID, conversation_id: conversationId })

const envelope = (conversationId: string, n: number) => ({
  runtime: runtime(conversationId),
  event_seq: n,
  emitted_at: "2026-10-16T00:00:00.000Z",
  idempotency_key: `k-${n}`
})

export const deviceStatus = (conversationId: string, overrides: Record<string, unknown> = {}) => ({
  type: "update_device_status",
  ...envelope(conversationId, 0),
  device_status: {
    current_permission_mode: "standard",
    current_working_directory: "/work",
    supported_commands: ["compact", "init", "upgrade-letta-code"],
    mod_commands: [{ id: "plan", description: "Toggle plan mode", args: "<on|off>" }],
    ...overrides
  }
})

export const delta = (conversationId: string, payload: Record<string, unknown>) => ({
  type: "stream_delta",
  ...envelope(conversationId, 1),
  delta: payload
})

/** `update_subagent_state`: the conversation's subagents (background and reporting back unless said otherwise). */
export const subagents = (
  conversationId: string,
  list: ReadonlyArray<
    { readonly id: string; readonly status: string; readonly background?: boolean; readonly silent?: boolean }
  >
) => ({
  type: "update_subagent_state",
  ...envelope(conversationId, 3),
  subagents: list.map((a) => ({
    subagent_id: a.id,
    status: a.status,
    is_background: a.background ?? true,
    silent: a.silent ?? false
  }))
})

/** `update_queue` with items of the given kinds waiting. */
export const queue = (conversationId: string, kinds: ReadonlyArray<string>) => ({
  type: "update_queue",
  ...envelope(conversationId, 4),
  queue: kinds.map((kind, i) => ({ id: `q-${i}`, kind })),
  removed: []
})

export const turnFinished = (conversationId: string, stopReason = "end_turn", extra: Record<string, unknown> = {}) => ({
  type: "turn_finished",
  ...envelope(conversationId, 2),
  turn_id: "turn-1",
  stop_reason: stopReason,
  ...extra
})

export const make = Effect.gen(function*() {
  const frames = yield* PubSub.unbounded<Frame>()
  const commands = yield* Ref.make<ReadonlyArray<Command>>([])
  const sent = yield* PubSub.unbounded<Command>()
  const conversations = { next: 1 }
  /** Model settings per conversation, as Letta would store them. */
  const settings = new Map<string, Record<string, unknown>>()
  const settingsOf = (id: string) => settings.get(id) ?? { reasoning_effort: "medium", context_window_limit: 200_000 }
  const cliCalls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])

  const emit = (frame: Record<string, unknown>) =>
    Schema.decodeUnknownEffect(FrameHeader)(frame).pipe(
      Effect.orDie,
      Effect.flatMap((header) => PubSub.publish(frames, { header, raw: frame })),
      Effect.asVoid
    )

  const handlers = new Map<string, Handler>()
  const defaults: Record<string, Handler> = {
    app_server_info: () => ({ success: true, backend: "local", letta_code_version: "0.34.15", protocol_version: 1 }),
    runtime_start: (command) => {
      const c = command as Extract<Command, { type: "runtime_start" }>
      const id = c.conversation_id ?? `conv-${conversations.next++}`
      return {
        success: true,
        runtime: { agent_id: c.agent_id, conversation_id: id },
        agent: { id: c.agent_id, name: "Test", model: MODEL, llm_config: { model: "claude", context_window: 200_000 } },
        conversation: {
          id,
          agent_id: c.agent_id,
          summary: c.conversation_id === undefined ? null : "Earlier work",
          model: MODEL,
          model_settings: settingsOf(id)
        },
        created: { agent: false, conversation: c.conversation_id === undefined }
      }
    },
    input: () => ({ success: true, accepted: true, disposition: "started" }),
    list_models: () => ({ success: true, entries: MODEL_ENTRIES }),
    update_model: (command) => {
      const c = command as Extract<Command, { type: "update_model" }>
      const entry = MODEL_ENTRIES.find((e) => e.id === c.payload.model_id)
      const handle = entry?.handle ?? c.payload.model_handle
      const applied = {
        reasoning_effort: entry?.updateArgs?.reasoning_effort ?? c.payload.reasoning_effort ?? "medium",
        context_window_limit: entry?.updateArgs?.context_window ?? (handle === BYOK_MODEL ? 400_000 : 200_000)
      }
      settings.set(c.runtime.conversation_id, applied)
      return { success: true, model_id: entry?.id ?? null, model_handle: handle, model_settings: applied }
    },
    agent_retrieve: (command) => ({
      success: true,
      agent: { id: (command as Extract<Command, { type: "agent_retrieve" }>).agent_id }
    }),
    create_agent: () => ({ success: true, agent_id: AGENT_ID }),
    conversation_retrieve: (command) => {
      const id = (command as Extract<Command, { type: "conversation_retrieve" }>).conversation_id
      return id === "missing"
        ? { success: false, conversation: null, error: "not found" }
        : {
          success: true,
          conversation: { id, agent_id: AGENT_ID, summary: "Earlier work", model_settings: settingsOf(id) }
        }
    },
    conversation_messages_list: () => ({ success: true, messages: [], has_more: false, next_before: null }),
    conversation_list: () => ({
      success: true,
      conversations: [
        { id: "conv-a", agent_id: AGENT_ID, summary: "Fix the build", last_message_at: "2026-10-15T10:00:00Z" },
        { id: "conv-b", agent_id: AGENT_ID, summary: null, last_message_at: "2026-10-14T10:00:00Z" }
      ]
    }),
    get_cwd_map: () => ({
      success: true,
      cwd_map: { "conversation:conv-a": "/work" },
      boot_working_directory: "/work"
    }),
    abort_message: () => ({ success: true, aborted: true }),
    execute_command: () => ({ success: true, output: "Compacted." }),
    runtime_external_tools_update: () => ({ success: true })
  }

  const respond = (command: Command): Effect.Effect<unknown> | Record<string, unknown> => {
    const handler = handlers.get(command.type) ?? defaults[command.type]
    return handler === undefined ? { success: false, error: `unhandled ${command.type}` } : handler(command)
  }

  const record = (command: Command) =>
    Ref.update(commands, (all) => [...all, command]).pipe(Effect.andThen(PubSub.publish(sent, command)))

  const connection: LettaConnection = {
    generation: 1,
    info: {
      success: true,
      backend: "local",
      letta_code_version: "0.34.15",
      protocol_version: 1,
      capabilities: { runtime_external_tools_update: true }
    },
    install: Option.none(),
    call: <A extends Reply, I>(make: (requestId: string) => Command, response: Schema.Codec<A, I>) =>
      Effect.gen(function*() {
        const command = make("req")
        yield* record(command)
        const answer = respond(command)
        const raw = Effect.isEffect(answer) ? yield* answer : answer
        // runtime_start replays state before responding (wait_for_replay).
        if (command.type === "runtime_start") {
          const started = raw as { runtime: { conversation_id: string } }
          yield* emit(deviceStatus(started.runtime.conversation_id))
        }
        const decoded = yield* Schema.decodeUnknownEffect(response)(raw).pipe(
          Effect.mapError((e) => new LettaRequestFailed({ command: command.type, message: e.message }))
        )
        if (decoded.success === false) {
          return yield* new LettaRequestFailed({ command: command.type, message: decoded.error ?? "failed" })
        }
        return decoded
      }),
    send: (command) => record(command),
    subscribe: PubSub.subscribe(frames),
    isAlive: Effect.succeed(true),
    closed: Effect.never
  }

  const waitFor = (predicate: (command: Command) => boolean) =>
    Effect.gen(function*() {
      const subscription = yield* PubSub.subscribe(sent)
      const existing = (yield* Ref.get(commands)).find(predicate)
      if (existing !== undefined) return existing
      while (true) {
        const next = yield* PubSub.take(subscription)
        if (predicate(next)) return next
      }
    }).pipe(Effect.scoped)

  const cli = (args: ReadonlyArray<string>) =>
    Ref.update(cliCalls, (all) => [...all, args]).pipe(
      Effect.andThen(Effect.suspend(() => {
        if (args[0] === "model" && args[1] === "list") return Effect.succeed(JSON.stringify(MODEL_LIST))
        const flag = (name: string) => args[args.indexOf(name) + 1]
        if (args[0] === "model" && args[1] === "set") {
          const conversation = flag("--conversation") ?? ""
          settings.set(conversation, { ...settingsOf(conversation), reasoning_effort: flag("--reasoning") })
          return Effect.succeed("{}")
        }
        return Effect.fail(new LettaRequestFailed({ command: args.join(" "), message: "unsupported" }))
      }))
    )

  const fake: FakeLetta = {
    connection,
    cli,
    cliCalls,
    commands,
    emit,
    on: (type, handler) => Effect.sync(() => handlers.set(type, handler)),
    waitFor
  }
  return fake
})
