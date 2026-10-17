/**
 * A session's record: one ACP session backed by one Letta conversation.
 *
 * The record is mutable. It is written by a few known fibers, and each field
 * below says which (see {@link Session}). `Agent.ts` opens and operates
 * sessions; `Frames.ts` handles their runtime's frames.
 */
import { Deferred, Effect, FiberHandle, FiberSet, Option, type Path, Scope, Semaphore, Stream } from "effect"
import type { Command } from "../domain/Events.ts"
import type { LettaConnection } from "../letta/AppServer.ts"
import { RuntimeExternalToolsUpdateResponse, type RuntimeScope } from "../letta/Protocol.ts"
import * as Translator from "../letta/Translator.ts"
import type * as Bridge from "../mcp/Bridge.ts"
import type { McpServerConfig } from "../mcp/Config.ts"
import type { SessionSettings, Target } from "./Settings.ts"
import type * as Turn from "./Turn.ts"

/** A session's runtime on one App Server connection (generation); replaced after a restart. */
export interface Attachment {
  readonly generation: number
  readonly scope: Scope.Closeable
  readonly connection: LettaConnection
  readonly runtime: RuntimeScope
}

/**
 * One ACP session. Its mutable fields are written by these fibers:
 *
 * - the _request fiber_: the fiber running a public operation (`Agent.ts`),
 *   serialized by the setup lock (the conversation and its settings) or the
 *   turn lock (turns);
 * - the _frame fiber_: the attachment's fiber routing the runtime's frames
 *   (`Frames.consume`), one per attachment;
 * - the _turn-ending fibers_: whichever fiber runs `Frames.completeTurn`: the
 *   frame fiber, the held turn's grace fiber, a cancellation's fibers, the
 *   connection watch, a slash command's fiber, or a request fiber (cancel,
 *   close);
 * - the _permission fibers_: one per approval request (`Frames.onControlRequest`).
 */
export interface Session {
  /**
   * The ACP session id: the Letta conversation's id for a session opened on
   * one, lacp's own for a session opened before it had one (see SessionIds).
   */
  readonly id: string
  /** The Letta agent; a session opened without one gets it with its conversation (request fiber). */
  agentId: Option.Option<string>
  readonly cwd: string
  readonly scope: Scope.Closeable
  readonly translator: Translator.Translator
  readonly turnLock: Semaphore.Semaphore
  readonly permissions: FiberSet.FiberSet<void, never>
  /** The grace period of a held turn whose background work is done (see Frames.releaseWhenSettled). */
  readonly grace: FiberHandle.FiberHandle<void, never>
  /**
   * The runtime of the session's Letta conversation; none until the session
   * has a conversation (request fiber, under the setup lock).
   */
  attachment: Option.Option<Attachment>
  /** Serializes creating the conversation with config changes made meanwhile. */
  readonly setupLock: Semaphore.Semaphore
  /** The client has the session's commands and config options (they went out with its setup) (request fiber). */
  announced: boolean
  /**
   * Model, effort and mode: a record the Settings service updates on the
   * request fiber; its `mode` also follows Letta's device status (frame fiber).
   */
  readonly settings: SessionSettings
  /** Letta's commands for this runtime (frame fiber, from the device status). */
  commands: ReadonlyArray<Command>
  /** Client message ids of the prompts lacp sent (added by the request fiber, removed when the turn ends or is withdrawn). */
  readonly ownMessages: Set<string>
  /** Runs of turns lacp ended itself; their late frames are ignored (a cancellation's fibers). */
  readonly abandonedRuns: Set<string>
  /**
   * Background subagents that will report back (not silent): running in
   * Letta's last snapshot, not yet reported (frame fiber).
   */
  backgroundSubagents: ReadonlySet<string>
  /** Reports of finished background work waiting in Letta's queue (frame fiber). */
  queuedNotifications: number
  /** The client's MCP servers this session was opened with. */
  readonly mcpServers: ReadonlyArray<McpServerConfig>
  /**
   * The session's turn: begun and withdrawn by the request fiber, moved
   * between phases by the frame and request fibers, cleared by the
   * turn-ending fibers.
   */
  turn: Option.Option<Turn.Turn>
  /**
   * The state the client is shown: set by `Frames.setForeground` (frame,
   * request and permission fibers), reset to idle by the turn-ending fibers.
   */
  foreground: "idle" | "running" | "requires_action"
  readonly deviceStatus: Deferred.Deferred<void>
  /** The turn runs a slash command locally (request fiber; reset by the turn-ending fibers). */
  localCommand: boolean
  /**
   * Approval requests awaiting the client's answer: counted up by the frame
   * fiber, down by the permission fibers, reset by the turn-ending fibers.
   */
  approvals: number
  /** The client's MCP servers, bridged into Letta as external tools. */
  readonly mcp: Bridge.McpBridge
}

export const targetOf = (attachment: Attachment): Target => ({
  connection: attachment.connection,
  runtime: attachment.runtime,
  conversationId: attachment.runtime.conversation_id
})

/** What a session's translators need: its directory, its model's context window and its MCP tools. */
export const translatorContext = (
  path: Path.Path,
  cwd: string,
  settings: SessionSettings,
  mcp: Bridge.McpBridge
): Translator.TranslatorContext => ({
  cwd,
  path,
  contextWindow: () => settings.contextWindow,
  externalTool: (name) => mcp.describe(name)
})

/** Re-registers the bridged tools after an MCP server's tool list changed. */
export const updateTools = Effect.fnUntraced(function*(session: Session) {
  if (Option.isNone(session.attachment)) return
  const { connection: conn, runtime } = session.attachment.value
  if (conn.info.capabilities?.["runtime_external_tools_update"] !== true) {
    yield* Effect.logWarning("This Letta Code cannot update MCP tools live; they refresh on the next session")
    return
  }
  const tools = yield* session.mcp.tools
  yield* conn.call(
    (request_id) => ({
      type: "runtime_external_tools_update",
      request_id,
      updates: [{ runtimes: [runtime], external_tools: [{ tools }] }]
    }),
    RuntimeExternalToolsUpdateResponse
  ).pipe(Effect.catch((error) => Effect.logWarning(`Could not update MCP tools: ${error.message}`)))
})

export interface SessionInput {
  readonly id: string
  readonly agentId: Option.Option<string>
  readonly cwd: string
  readonly scope: Scope.Closeable
  readonly mcp: Bridge.McpBridge
  readonly mcpServers: ReadonlyArray<McpServerConfig>
  readonly settings: SessionSettings
  readonly commands: ReadonlyArray<Command>
  /** The host's path module, for the translator. */
  readonly path: Path.Path
}

/**
 * Builds a session with no attachment yet and follows its MCP servers' tool
 * changes in its scope. The caller registers it.
 */
export const makeSession = Effect.fnUntraced(function*(input: SessionInput) {
  const session: Session = {
    id: input.id,
    agentId: input.agentId,
    cwd: input.cwd,
    scope: input.scope,
    translator: Translator.make(translatorContext(input.path, input.cwd, input.settings, input.mcp)),
    turnLock: yield* Semaphore.make(1),
    permissions: yield* Scope.provide(FiberSet.make<void, never>(), input.scope),
    grace: yield* Scope.provide(FiberHandle.make<void, never>(), input.scope),
    attachment: Option.none(),
    setupLock: yield* Semaphore.make(1),
    announced: false,
    settings: input.settings,
    commands: input.commands,
    ownMessages: new Set(),
    abandonedRuns: new Set(),
    backgroundSubagents: new Set(),
    queuedNotifications: 0,
    mcpServers: input.mcpServers,
    turn: Option.none(),
    foreground: "idle",
    deviceStatus: yield* Deferred.make<void>(),
    localCommand: false,
    approvals: 0,
    mcp: input.mcp
  }
  yield* input.mcp.changes.pipe(Stream.runForEach(() => updateTools(session)), Effect.forkIn(input.scope))
  return session
})
