/**
 * The agent core: ACP sessions backed by Letta Code App Server runtimes.
 *
 * Each ACP session is one Letta conversation, attached to the App Server as a
 * runtime; a new session gets its conversation with its first prompt (see
 * {@link SessionIds} for the ids of such sessions). The core is
 * protocol-version neutral: it emits {@link SessionEvent}s and permission
 * requests through {@link AcpClient}, and exposes turn completion as an effect
 * that the v1 surface awaits and the v2 surface reports via `state_update`.
 *
 * This module owns the service, its sessions, their runtimes and the public
 * operations. The session record is `Session.ts`; the handling of a runtime's
 * frames and the end of a turn are `Frames.ts`; starting a runtime is `Runtime.ts`.
 */
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Layer,
  Option,
  Path,
  Scope,
  Semaphore,
  Stream
} from "effect"
import { Crypto } from "effect/Crypto"
import type { ContentBlock } from "../acp/Content.ts"
import * as Content from "../acp/Content.ts"
import { LacpConfig } from "../Config.ts"
import type { Command, ConfigOption, SessionEvent } from "../domain/Events.ts"
import { Host } from "../Host.ts"
import { LettaAppServer, type LettaConnection } from "../letta/AppServer.ts"
import * as Commands from "../letta/Commands.ts"
import * as History from "../letta/History.ts"
import {
  AbortMessageResponse,
  ConversationListResponse,
  ConversationRetrieveResponse,
  ExecuteCommandResponse,
  GetCwdMapResponse,
  InputAccepted
} from "../letta/Protocol.ts"
import * as Translator from "../letta/Translator.ts"
import * as Bridge from "../mcp/Bridge.ts"
import type { McpServerConfig } from "../mcp/Config.ts"
import { AGENT_NAME, AGENT_TITLE, VERSION } from "../Version.ts"
import { AgentResolver } from "./AgentResolver.ts"
import { AcpClient } from "./Client.ts"
import { type AgentError, AgentUnavailable, PromptRejected, SessionNotFound, unavailable } from "./Errors.ts"
import { completeTurn, consume, type Deps, emitAll, logTurn, onTurnFinished, setForeground, watch } from "./Frames.ts"
import { plainText, slashCommand, toLettaContent } from "./Prompt.ts"
import { type StartedRuntime, startRuntime } from "./Runtime.ts"
import { type Attachment, makeSession, type Session, targetOf, translatorContext } from "./Session.ts"
import { SessionIds } from "./SessionIds.ts"
import { configOptions, DEFAULT_PERMISSION_MODE, initialSettings, Settings } from "./Settings.ts"
import * as Turn from "./Turn.ts"
import type { TurnResult } from "./Turn.ts"

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

export interface SessionSetup {
  readonly sessionId: string
  readonly configOptions: ReadonlyArray<ConfigOption>
  readonly commands: ReadonlyArray<Command>
}

export type { TurnResult } from "./Turn.ts"

export interface PromptHandle {
  /** The id of the inserted user message. */
  readonly messageId: string
  /** Completes when the turn ends (never fails). */
  readonly completion: Effect.Effect<TurnResult>
}

export interface SessionSummary {
  readonly sessionId: string
  readonly cwd: string
  readonly title: Option.Option<string>
  readonly updatedAt: Option.Option<string>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Agent extends Context.Service<Agent, {
  /** Starts Letta Code in the background. */
  readonly warmup: Effect.Effect<void>
  newSession(input: {
    readonly cwd: string
    readonly mcpServers: ReadonlyArray<McpServerConfig>
  }): Effect.Effect<SessionSetup, AgentError>
  /** Attaches to an existing conversation; with `replay`, its history is emitted first. */
  loadSession(input: {
    readonly sessionId: string
    readonly cwd: string
    readonly replay: boolean
    readonly mcpServers: ReadonlyArray<McpServerConfig>
  }): Effect.Effect<SessionSetup, AgentError>
  listSessions(input: {
    readonly cwd: Option.Option<string>
    readonly cursor: Option.Option<string>
  }): Effect.Effect<
    { readonly sessions: ReadonlyArray<SessionSummary>; readonly nextCursor: Option.Option<string> },
    AgentError
  >
  /** Inserts a prompt. Resolves once Letta accepted it; `completion` resolves when the turn ends. */
  prompt(sessionId: string, prompt: ReadonlyArray<ContentBlock>): Effect.Effect<PromptHandle, AgentError>
  cancel(sessionId: string): Effect.Effect<void>
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Effect.Effect<ReadonlyArray<ConfigOption>, AgentError>
  closeSession(sessionId: string): Effect.Effect<void>
  /** The foreground state of a session, for v2 `session/resume` snapshots. */
  foreground(sessionId: string): Effect.Effect<"idle" | "running" | "requires_action">
}>()("lacp/agent/Agent") {
  static readonly layer = Layer.effect(
    Agent,
    Effect.gen(function*() {
      const config = yield* LacpConfig
      const host = yield* Host
      const appServer = yield* LettaAppServer
      const settings = yield* Settings
      const client = yield* AcpClient
      const crypto = yield* Crypto
      const sessionIds = yield* SessionIds
      const agents = yield* AgentResolver
      const path = yield* Path.Path
      const bridges = yield* Bridge.McpBridges
      const layerScope = yield* Effect.scope
      const sessions = new Map<string, Session>()
      /** What the frame handlers (Frames.ts) need from here. */
      const deps: Deps = { config, client }

      // A failing CSPRNG is not a recoverable condition.
      const uuid = crypto.randomUUIDv4().pipe(Effect.orDie)

      const connection = appServer.connection.pipe(Effect.mapError(unavailable))

      const getSession = (sessionId: string) =>
        Effect.suspend(() => {
          const session = sessions.get(sessionId)
          return session === undefined ? Effect.fail(new SessionNotFound({ sessionId })) : Effect.succeed(session)
        })

      const emit = (session: Session, event: SessionEvent) => client.emit(session.id, event)

      // --- runtimes ---------------------------------------------------------

      /** Makes a started runtime the session's attachment (closing the previous one) and starts routing its frames. */
      const attach = Effect.fnUntraced(function*(
        session: Session,
        started: StartedRuntime,
        conn: LettaConnection
      ) {
        if (Option.isSome(session.attachment)) yield* Scope.close(session.attachment.value.scope, Exit.void)
        const attachment: Attachment = {
          generation: conn.generation,
          scope: started.scope,
          connection: conn,
          runtime: started.runtime
        }
        session.attachment = Option.some(attachment)
        yield* consume(deps, session, attachment, started.subscription).pipe(
          Effect.annotateLogs("session", session.id),
          Effect.forkIn(started.scope)
        )
        yield* watch(deps, session, attachment).pipe(Effect.forkIn(started.scope))
        return attachment
      })

      /** Returns a live attachment to the session's conversation, re-attaching after an App Server restart. */
      const ensureAttached = Effect.fnUntraced(function*(session: Session, current: Attachment) {
        const conn = yield* connection
        if (current.generation === conn.generation) return current
        yield* Effect.logInfo(`Re-attaching session ${session.id} to the restarted Letta Code App Server`)
        const agentId = Option.orElse(session.agentId, () => Option.fromNullishOr(current.runtime.agent_id))
        if (Option.isNone(agentId)) {
          return yield* new AgentUnavailable({ message: `Session ${session.id} has no Letta agent`, auth: false })
        }
        const started = yield* startRuntime(conn, session.scope, {
          agentId: agentId.value,
          conversationId: Option.some(current.runtime.conversation_id),
          cwd: session.cwd,
          tools: yield* session.mcp.tools,
          mode: config.permissionMode
        })
        const attachment = yield* attach(session, started, conn)
        if (Option.isSome(session.settings.mode) && Option.isNone(config.permissionMode)) {
          yield* conn.send({
            type: "change_device_state",
            runtime: started.runtime,
            payload: { mode: session.settings.mode.value }
          }).pipe(Effect.ignore)
        }
        return attachment
      })

      // --- opening sessions -------------------------------------------------

      /**
       * Opens a session in a new scope: Letta and the client's MCP servers
       * (rooted at the session's directory) connect concurrently, then `open`
       * builds the session. The scope is closed again if opening fails.
       */
      const inSessionScope = <A, E>(
        input: { readonly cwd: string; readonly mcpServers: ReadonlyArray<McpServerConfig> },
        open: (scope: Scope.Closeable, conn: LettaConnection, mcp: Bridge.McpBridge) => Effect.Effect<A, E>
      ) =>
        Scope.fork(layerScope).pipe(Effect.flatMap((scope) =>
          Effect.all([
            connection,
            bridges.connectAll(input.mcpServers, {
              roots: [input.cwd],
              clientInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: VERSION }
            }).pipe(Scope.provide(scope))
          ], { concurrency: "unbounded" }).pipe(
            Effect.flatMap(([conn, mcp]) => open(scope, conn, mcp)),
            Effect.onError(() => Scope.close(scope, Exit.void))
          )
        ))

      /** Waits briefly for the runtime's first device status (mode and commands). */
      const settle = Effect.fnUntraced(function*(session: Session, attachment: Attachment) {
        const seen = yield* Deferred.await(session.deviceStatus).pipe(Effect.timeoutOption("5 seconds"))
        if (Option.isNone(seen) && Option.isNone(session.settings.mode)) {
          // Letta did not say: make the runtime match the mode the client is shown.
          session.settings.mode = Option.some(DEFAULT_PERMISSION_MODE)
          yield* attachment.connection.send({
            type: "change_device_state",
            runtime: attachment.runtime,
            payload: { mode: DEFAULT_PERMISSION_MODE }
          }).pipe(Effect.ignore)
        }
      })

      /**
       * The session's setup for the client, which then has its commands and
       * config options. The commands and any unavailable MCP servers follow as
       * updates, right after the response.
       */
      const publish = Effect.fnUntraced(function*(session: Session) {
        yield* Effect.gen(function*() {
          if (session.commands.length > 0) {
            yield* emit(session, { _tag: "AvailableCommands", commands: session.commands })
          }
          for (const failure of session.mcp.failures) {
            yield* emit(session, {
              _tag: "Notice",
              severity: "warning",
              title: `MCP server "${failure.server}" is unavailable`,
              description: failure.message
            })
          }
        }).pipe(Effect.delay("10 millis"), Effect.forkIn(session.scope))
        session.announced = true
        return {
          sessionId: session.id,
          configOptions: configOptions(session.settings),
          commands: session.commands
        } satisfies SessionSetup
      })

      /** Emits the conversation's history (its latest 1,000 messages), oldest first. */
      const replay = Effect.fnUntraced(function*(session: Session, conn: LettaConnection, conversationId: string) {
        const pages = yield* History.pages(conn, conversationId).pipe(
          Stream.take(10),
          Stream.runCollect,
          Effect.mapError(unavailable)
        )
        const history = Translator.make(translatorContext(path, session.cwd, session.settings, session.mcp))
        for (const row of pages.flat().toReversed()) yield* emitAll(deps, session, history.history(row))
        yield* emitAll(deps, session, history.finishTurn("end_turn"))
      })

      /**
       * Opens a session that has no Letta conversation yet, without touching
       * Letta beyond reading the agent and its models: the conversation (and,
       * where none is set up, the agent) is created by the first prompt.
       */
      const openPending = (input: {
        readonly sessionId: string
        readonly cwd: string
        readonly mcpServers: ReadonlyArray<McpServerConfig>
      }) =>
        inSessionScope(input, (scope, conn, mcp) =>
          Effect.gen(function*() {
            const agentId = yield* agents.find(conn, input.cwd)
            const [agent, models] = yield* Effect.all([
              Option.match(agentId, {
                onNone: () => Effect.succeedNone,
                onSome: (id) => agents.retrieve(conn, id).pipe(Effect.asSome)
              }),
              settings.catalog(conn)
            ], { concurrency: "unbounded" })
            const session = yield* makeSession({
              id: input.sessionId,
              agentId,
              cwd: input.cwd,
              scope,
              mcp,
              mcpServers: input.mcpServers,
              settings: initialSettings(
                { agent: Option.getOrNull(agent) },
                models,
                Option.orElse(config.permissionMode, () => Option.some(DEFAULT_PERMISSION_MODE))
              ),
              commands: Commands.builtins,
              path
            })
            sessions.set(session.id, session)
            yield* settings.preferConfiguredModel(session.settings)
            return session
          }))

      /**
       * Runs `pending` while the session has no conversation yet, or `attached`
       * with a live attachment to it, under the session's setup lock: creating
       * the conversation and changing its settings never interleave.
       */
      const withConversation = <A, E>(session: Session, on: {
        readonly pending: Effect.Effect<A, E>
        readonly attached: (attachment: Attachment) => Effect.Effect<A, E>
      }) =>
        Semaphore.withPermits(session.setupLock, 1)(Effect.suspend(() =>
          Option.match(session.attachment, {
            onNone: () => on.pending,
            onSome: (current) => ensureAttached(session, current).pipe(Effect.flatMap(on.attached))
          })
        ))

      /**
       * Returns a live attachment to the session's conversation, creating the
       * conversation (and the agent, for a session without one) on first use.
       */
      const materialize = (session: Session) =>
        withConversation(session, { pending: createConversation(session), attached: Effect.succeed })

      /** Creates a pending session's conversation and applies the model, effort and mode chosen meanwhile. */
      const createConversation = Effect.fnUntraced(function*(session: Session) {
        const before = configOptions(session.settings)
        const conn = yield* connection
        const agentId = Option.isSome(session.agentId)
          ? session.agentId.value
          : yield* agents.findOrCreate(conn, session.cwd)
        const started = yield* startRuntime(conn, session.scope, {
          agentId,
          conversationId: Option.none(),
          cwd: session.cwd,
          tools: yield* session.mcp.tools,
          mode: session.settings.mode
        })
        const conversationId = started.runtime.conversation_id
        session.agentId = Option.some(agentId)
        const attachment = yield* attach(session, started, conn)
        yield* settings.realize(
          session.settings,
          targetOf(attachment),
          initialSettings(started.response, session.settings.models, session.settings.mode)
        )
        yield* settle(session, attachment)
        yield* sessionIds.record(session.id, conversationId)
        yield* Effect.logInfo(`Session ${session.id} now has Letta conversation ${conversationId} (agent ${agentId})`)
        const after = configOptions(session.settings)
        if (!Equal.equals(before, after)) yield* emit(session, { _tag: "ConfigOptions", options: after })
        return attachment
      })

      /** The stored conversation behind a session, and its agent. */
      const storedConversation = Effect.fnUntraced(
        function*(conn: LettaConnection, sessionId: string, conversationId: string, cwd: string) {
          const notFound = new SessionNotFound({ sessionId })
          const retrieved = yield* conn.call(
            (request_id) => ({ type: "conversation_retrieve", request_id, conversation_id: conversationId }),
            ConversationRetrieveResponse
          ).pipe(Effect.mapError(() => notFound))
          const conversation = retrieved.conversation
          if (conversation === null) return yield* notFound
          const agentId = conversation.agent_id ?? Option.getOrUndefined(yield* agents.find(conn, cwd))
          if (agentId === undefined) return yield* notFound
          return { agentId, conversation }
        }
      )

      /**
       * Opens a session on a stored conversation in a new scope: Letta and the
       * client's MCP servers connect concurrently, then the runtime starts with
       * the MCP tools. Replayed history comes before the session goes live. The
       * scope is closed again if opening fails.
       */
      const openSession = (input: {
        readonly sessionId: string
        readonly conversationId: string
        readonly cwd: string
        readonly mcpServers: ReadonlyArray<McpServerConfig>
        readonly replay: boolean
      }) =>
        inSessionScope(input, (scope, conn, mcp) =>
          Effect.gen(function*() {
            const stored = yield* storedConversation(conn, input.sessionId, input.conversationId, input.cwd)
            const started = yield* startRuntime(conn, scope, {
              agentId: stored.agentId,
              conversationId: Option.some(input.conversationId),
              cwd: input.cwd,
              tools: yield* mcp.tools,
              mode: config.permissionMode
            })
            const session = yield* makeSession({
              id: input.sessionId,
              agentId: Option.some(stored.agentId),
              cwd: input.cwd,
              scope,
              mcp,
              mcpServers: input.mcpServers,
              settings: initialSettings(started.response, yield* settings.catalog(conn), config.permissionMode),
              commands: [],
              path
            })
            sessions.set(session.id, session)
            if (input.replay) yield* replay(session, conn, input.conversationId)
            yield* settle(session, yield* attach(session, started, conn))
            return { session, conversation: stored.conversation }
          }))

      // --- operations -------------------------------------------------------

      const newSession = Effect.fn("Agent.newSession")(function*(input: {
        readonly cwd: string
        readonly mcpServers: ReadonlyArray<McpServerConfig>
      }) {
        const session = yield* openPending({ ...input, sessionId: yield* sessionIds.make })
        yield* Effect.logInfo(
          `Opened session ${session.id}` +
            Option.match(session.agentId, { onNone: () => "", onSome: (id) => ` (agent ${id})` }) +
            ` in ${input.cwd}` +
            (session.mcp.connected.length > 0 ? ` with MCP servers: ${session.mcp.connected.join(", ")}` : "") +
            "; Letta creates its conversation with the first prompt"
        )
        return yield* publish(session)
      })

      const loadSession = Effect.fn("Agent.loadSession")(function*(input: {
        readonly sessionId: string
        readonly cwd: string
        readonly replay: boolean
        readonly mcpServers: ReadonlyArray<McpServerConfig>
      }) {
        const open = sessions.get(input.sessionId)
        // A session reopened from another directory or with other MCP servers gets a new runtime.
        const existing = open !== undefined && open.cwd === input.cwd && Equal.equals(open.mcpServers, input.mcpServers)
          ? open
          : undefined
        if (open !== undefined && existing === undefined) yield* closeSession(open.id)
        if (existing !== undefined) {
          if (Option.isSome(existing.attachment)) {
            const attachment = yield* ensureAttached(existing, existing.attachment.value)
            if (input.replay) yield* replay(existing, attachment.connection, attachment.runtime.conversation_id)
          }
          return yield* publish(existing)
        }
        const conversationId = sessionIds.isProvisional(input.sessionId)
          ? yield* sessionIds.conversationOf(input.sessionId)
          : Option.some(input.sessionId)
        if (Option.isNone(conversationId)) {
          // A session that never had a prompt: there is nothing to replay, and still no conversation.
          return yield* publish(yield* openPending(input))
        }
        const { conversation, session } = yield* openSession({ ...input, conversationId: conversationId.value })
        const title = conversation.summary ?? conversation.description
        if (title !== undefined && title !== null && title !== "") {
          yield* emit(session, {
            _tag: "SessionInfo",
            title,
            ...(conversation.last_message_at ? { updatedAt: conversation.last_message_at } : {})
          })
        }
        return yield* publish(session)
      })

      const listSessions = Effect.fn("Agent.listSessions")(function*(input: {
        readonly cwd: Option.Option<string>
        readonly cursor: Option.Option<string>
      }) {
        const conn = yield* connection
        const agentId = yield* agents.find(conn, Option.getOrElse(input.cwd, () => host.cwd))
        if (Option.isNone(agentId)) return { sessions: [], nextCursor: Option.none<string>() }
        const limit = 50
        const response = yield* conn.call(
          (request_id) => ({
            type: "conversation_list",
            request_id,
            query: {
              agent_id: agentId.value,
              limit,
              order: "desc",
              order_by: "last_message_at",
              ...(Option.isSome(input.cursor) ? { after: input.cursor.value } : {})
            }
          }),
          ConversationListResponse
        ).pipe(Effect.mapError(unavailable))
        const cwdMap = yield* conn.call((request_id) => ({ type: "get_cwd_map", request_id }), GetCwdMapResponse).pipe(
          Effect.map((r) => r.cwd_map ?? {}),
          Effect.orElseSucceed((): Record<string, string> => ({}))
        )
        const summaries = yield* Effect.forEach(
          response.conversations.filter((c) => c.archived !== true),
          (c) =>
            // A conversation created for a session lacp opened first is listed under that session's id.
            sessionIds.sessionOf(c.id).pipe(Effect.map((sessionId) => {
              const id = Option.getOrElse(sessionId, () => c.id)
              const mapped = cwdMap[`conversation:${c.id}`] ?? sessions.get(id)?.cwd
              return {
                sessionId: id,
                cwd: mapped ?? host.cwd,
                mapped: mapped !== undefined,
                title: Option.fromNullishOr(c.summary ?? c.description).pipe(Option.filter((t) => t !== "")),
                updatedAt: Option.fromNullishOr(c.last_message_at ?? c.updated_at ?? c.created_at)
              }
            }))
        )
        const last = response.conversations.at(-1)
        return {
          sessions: summaries
            .filter((s) =>
              Option.isNone(input.cwd) || (s.mapped && path.resolve(s.cwd) === path.resolve(input.cwd.value))
            )
            .map(({ mapped: _mapped, ...summary }): SessionSummary => summary),
          nextCursor: response.conversations.length >= limit && last !== undefined
            ? Option.some(last.id)
            : Option.none()
        }
      })

      /** Makes a new turn the session's turn. */
      const beginTurn = Effect.fnUntraced(function*(session: Session, state: { readonly accepted: boolean }) {
        const turn: Turn.Turn = {
          clientMessageId: yield* uuid,
          done: yield* Deferred.make<TurnResult>(),
          runs: new Set(),
          preexisting: new Set(session.backgroundSubagents),
          phase: state.accepted ? Turn.Phase.Running() : Turn.Phase.Submitted({ started: false, early: Option.none() }),
          error: Option.none(),
          began: yield* Clock.currentTimeMillis,
          streamed: false
        }
        session.turn = Option.some(turn)
        return turn
      })

      /**
       * The client's handle on a turn that has begun. The turn lock follows the
       * turn, not the request: it is released when the turn ends, so a turn
       * that was cancelled cannot hold up the next prompt.
       */
      const handleOf = (session: Session, turn: Turn.Turn, release: Effect.Effect<void>) =>
        Deferred.await(turn.done).pipe(
          Effect.ensuring(release),
          Effect.forkIn(session.scope),
          Effect.as<PromptHandle>({ messageId: turn.clientMessageId, completion: Deferred.await(turn.done) })
        )

      const runCommand = Effect.fnUntraced(function*(
        session: Session,
        attachment: Attachment,
        prompt: ReadonlyArray<ContentBlock>,
        command: { readonly name: string; readonly args: string },
        release: Effect.Effect<void>
      ) {
        const turn = yield* beginTurn(session, { accepted: true })
        const messageId = turn.clientMessageId
        session.localCommand = true
        yield* logTurn(session, `Running the /${command.name} command`)
        yield* emit(session, { _tag: "UserMessage", messageId, content: prompt })
        yield* setForeground(deps, session, "running")
        const handle = yield* handleOf(session, turn, release)
        yield* Effect.gen(function*() {
          const result = yield* attachment.connection.call(
            (request_id) => ({
              type: "execute_command",
              request_id,
              command_id: command.name,
              runtime: attachment.runtime,
              ...(command.args === "" ? {} : { args: command.args })
            }),
            ExecuteCommandResponse,
            { timeout: "10 minutes" }
          ).pipe(Effect.result)
          // A command that outlived its (cancelled) turn has nothing left to report.
          if (!Option.exists(session.turn, (current) => current === turn)) return
          const output = result._tag === "Success" ? result.success.output ?? "" : result.failure.message
          if (output !== "") {
            yield* emit(session, { _tag: "AgentMessageChunk", messageId: yield* uuid, content: Content.text(output) })
          }
          yield* completeTurn(
            deps,
            session,
            result._tag === "Success"
              ? { stopReason: "end_turn", error: Option.none() }
              : { stopReason: "error", error: Option.some({ code: -32603, message: output }) }
          )
        }).pipe(Effect.forkIn(session.scope))
        return handle
      })

      const prompt = Effect.fn("Agent.prompt")(function*(sessionId: string, blocks: ReadonlyArray<ContentBlock>) {
        const session = yield* getSession(sessionId)
        // Waiting for the previous turn stays interruptible even where the caller makes
        // inserting the prompt uninterruptible (the v2 receipt).
        yield* Effect.interruptible(Semaphore.take(session.turnLock, 1))
        const release = Semaphore.release(session.turnLock, 1).pipe(Effect.asVoid)
        return yield* Effect.gen(function*() {
          const attachment = yield* materialize(session)
          const command = slashCommand(plainText(blocks), session.commands)
          if (Option.isSome(command)) return yield* runCommand(session, attachment, blocks, command.value, release)

          const turn = yield* beginTurn(session, { accepted: false })
          const clientMessageId = turn.clientMessageId
          session.ownMessages.add(clientMessageId)
          /** Letta did not take the prompt: the turn never began. */
          const withdraw = Effect.sync(() => {
            session.turn = Option.none()
            session.ownMessages.delete(clientMessageId)
          })
          const accepted = yield* attachment.connection.call(
            (request_id) => ({
              type: "input",
              request_id,
              runtime: attachment.runtime,
              payload: {
                kind: "create_message",
                messages: [{ role: "user", content: toLettaContent(blocks), client_message_id: clientMessageId }],
                exclude_interactive_tools: true
              }
            }),
            InputAccepted,
            { timeout: "60 seconds" }
          ).pipe(
            Effect.mapError((error) => new PromptRejected({ message: error.message })),
            Effect.tapError((error) =>
              logTurn(session, `Letta did not take the prompt: ${error.message}`, "Info").pipe(Effect.andThen(withdraw))
            )
          )
          if (!accepted.accepted) {
            const message = accepted.error ?? "Letta Code did not accept the prompt"
            yield* logTurn(session, `Letta did not take the prompt: ${message}`, "Info")
            yield* withdraw
            return yield* new PromptRejected({ message })
          }
          const early = turn.phase._tag === "Submitted" ? turn.phase.early : Option.none()
          Turn.accept(turn, accepted.disposition === "queued")
          yield* logTurn(
            session,
            turn.phase._tag === "Queued" ? "Letta queued the prompt behind earlier work" : "Letta accepted the prompt"
          )
          yield* emit(session, { _tag: "UserMessage", messageId: clientMessageId, content: blocks })
          yield* setForeground(deps, session, "running")
          // With nothing ahead of it in Letta's queue, an early turn_finished can only be ours.
          if (Option.isSome(early) && Turn.started(turn)) yield* onTurnFinished(deps, session, early.value)
          return yield* handleOf(session, turn, release)
        }).pipe(Effect.onError(() => release))
      })

      const cancel = Effect.fn("Agent.cancel")(function*(sessionId: string) {
        const session = sessions.get(sessionId)
        if (session === undefined || Option.isNone(session.turn)) return
        const turn = session.turn.value
        // Only waiting for background work: stop waiting (the work itself carries on in Letta).
        if (Turn.waitingForBackground(turn)) {
          yield* completeTurn(deps, session, { stopReason: "cancelled", error: Option.none() })
          return
        }
        /** Ends the turn without waiting for Letta to report its end, dropping the turn's late output. */
        const abandon = (reason: string) =>
          Effect.suspend(() =>
            Option.isSome(session.turn) && session.turn.value === turn
              ? logTurn(session, reason).pipe(
                Effect.andThen(Effect.sync(() => turn.runs.forEach((run) => session.abandonedRuns.add(run)))),
                Effect.andThen(completeTurn(deps, session, { stopReason: "cancelled", error: Option.none() }))
              )
              : Effect.void
          )
        yield* logTurn(session, "Cancelling the turn")
        const attachment = session.attachment
        if (Option.isSome(attachment)) {
          yield* attachment.value.connection.call(
            (request_id) => ({ type: "abort_message", request_id, runtime: attachment.value.runtime }),
            AbortMessageResponse,
            { timeout: "10 seconds" }
          ).pipe(
            // Letta reports the end of an aborted turn only once the model request settles,
            // which can take as long as the model stays silent; its acknowledgement is enough.
            Effect.flatMap((response) =>
              response.aborted === true ? abandon("Letta acknowledged the cancellation") : Effect.void
            ),
            Effect.catch((error) => Effect.logWarning(`Letta did not acknowledge the cancellation: ${error.message}`)),
            Effect.annotateLogs("session", session.id),
            Effect.forkIn(session.scope)
          )
        }
        // If Letta never reports the end of the turn, end it ourselves.
        yield* Effect.sleep(config.cancelGrace).pipe(
          Effect.andThen(abandon(
            `Letta did not end the cancelled turn within ${Duration.format(config.cancelGrace)}; ending it`
          )),
          Effect.forkIn(session.scope)
        )
      })

      const setConfigOption = Effect.fn("Agent.setConfigOption")(
        function*(sessionId: string, configId: string, value: string) {
          const session = yield* getSession(sessionId)
          yield* withConversation(session, {
            // Kept until the first prompt creates the conversation.
            pending: settings.choose(session.settings, configId, value),
            attached: (attachment) => settings.set(session.settings, targetOf(attachment), configId, value)
          })
          const options = configOptions(session.settings)
          yield* emit(session, { _tag: "ConfigOptions", options })
          return options
        }
      )

      const closeSession = Effect.fn("Agent.closeSession")(function*(sessionId: string) {
        const session = sessions.get(sessionId)
        if (session === undefined) return
        if (Option.isSome(session.turn)) {
          const done = session.turn.value.done
          yield* cancel(sessionId)
          yield* Deferred.await(done).pipe(Effect.timeoutOption("5 seconds"))
          if (Option.isSome(session.turn)) {
            yield* completeTurn(deps, session, { stopReason: "cancelled", error: Option.none() })
          }
        }
        sessions.delete(sessionId)
        yield* Scope.close(session.scope, Exit.void)
      })

      return Agent.of({
        warmup: appServer.warmup,
        newSession,
        loadSession,
        listSessions,
        prompt,
        cancel,
        setConfigOption,
        closeSession,
        foreground: (sessionId) => Effect.sync(() => sessions.get(sessionId)?.foreground ?? "idle")
      })
    })
  )
}
