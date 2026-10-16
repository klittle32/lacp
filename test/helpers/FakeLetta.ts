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

export type Handler = (command: Command) => unknown

export interface FakeLetta {
  readonly connection: LettaConnection
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
        conversation: { id, agent_id: c.agent_id, summary: c.conversation_id === undefined ? null : "Earlier work" },
        created: { agent: false, conversation: c.conversation_id === undefined }
      }
    },
    input: () => ({ success: true, accepted: true, disposition: "started" }),
    list_models: () => ({
      success: true,
      entries: [
        { id: "sonnet", handle: MODEL, label: "Claude Sonnet", description: "Balanced" },
        { id: "gpt", handle: "openai/gpt-5", label: "GPT-5", description: null }
      ]
    }),
    update_model: (command) => ({
      success: true,
      model_handle: (command as Extract<Command, { type: "update_model" }>).payload.model_handle
    }),
    agent_retrieve: (command) => ({
      success: true,
      agent: { id: (command as Extract<Command, { type: "agent_retrieve" }>).agent_id }
    }),
    create_agent: () => ({ success: true, agent_id: AGENT_ID }),
    conversation_retrieve: (command) => {
      const id = (command as Extract<Command, { type: "conversation_retrieve" }>).conversation_id
      return id === "missing"
        ? { success: false, conversation: null, error: "not found" }
        : { success: true, conversation: { id, agent_id: AGENT_ID, summary: "Earlier work" } }
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

  const respond = (command: Command): unknown => {
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
        const raw = respond(command)
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

  const fake: FakeLetta = {
    connection,
    commands,
    emit,
    on: (type, handler) => Effect.sync(() => handlers.set(type, handler)),
    waitFor
  }
  return fake
})
