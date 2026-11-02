/**
 * Interrupting the request that owns a session's scope. A session scope is
 * counted through the MCP bridge it opens: `live` is opened and not finalized.
 */
import { NodePath, NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Fiber, Layer, Logger, Option, Scheduler } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { FetchHttpClient } from "effect/http"
import { Agent } from "../src/agent/Agent.ts"
import { AgentResolver } from "../src/agent/AgentResolver.ts"
import { AcpClient } from "../src/agent/Client.ts"
import { SessionIds } from "../src/agent/SessionIds.ts"
import { Settings } from "../src/agent/Settings.ts"
import { LacpConfig } from "../src/Config.ts"
import { Host } from "../src/Host.ts"
import { LettaAppServer } from "../src/letta/AppServer.ts"
import * as Bridge from "../src/mcp/Bridge.ts"
import { projectDir } from "./helpers/AcpClient.ts"
import * as Fake from "./helpers/FakeLetta.ts"

/** Runs `effect` in a fiber of its own, which it may interrupt, and returns how that ended. */
const inOwnFiber = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.forkChild, Effect.flatMap(Fiber.await))

/** Interrupts the current fiber, at its next step. */
const interruptSelf = Effect.withFiber<void>((fiber) => Effect.sync(() => fiber.interruptUnsafe()))

interface Scopes {
  opened: number
  live: number
}

const setup = Effect.gen(function*() {
  const fake = yield* Fake.make
  const scopes: Scopes = { opened: 0, live: 0 }
  const interruptOnSessionInfo = { armed: false }
  const bridges = Layer.succeed(
    Bridge.McpBridges,
    Bridge.McpBridges.of({
      connectAll: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            scopes.opened++
            scopes.live++
            return Bridge.empty
          }),
          () =>
            Effect.sync(() => {
              scopes.live--
            })
        )
    })
  )
  const client = Layer.succeed(
    AcpClient,
    AcpClient.of({
      select: () => Effect.void,
      emit: (_sessionId, event) =>
        event._tag === "SessionInfo" && interruptOnSessionInfo.armed ? interruptSelf : Effect.void,
      requestPermission: () => Effect.die("no permission requests here")
    })
  )
  const context = yield* Layer.build(Agent.layer.pipe(
    Layer.provide(Settings.layer),
    Layer.provide(SessionIds.layer),
    Layer.provide(AgentResolver.layer),
    Layer.provide(bridges),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(LettaAppServer.layerConnection(fake.connection, fake.cli)),
    Layer.provide(client),
    Layer.provide(LacpConfig.layerTest({ agentId: Option.some(Fake.AGENT_ID) })),
    Layer.provide(Host.layerTest({ home: projectDir(), cwd: "/work" })),
    Layer.provide(NodePath.layerPosix),
    Layer.provide(NodeServices.layer),
    Layer.provide(SecureRandom.layerWebCrypto)
  ))
  return { agent: Context.get(context, Agent), scopes, interruptOnSessionInfo }
})

/** Interrupts the fiber that logs a message containing `text`, at its next step. */
const interruptOnLog = (text: string) =>
  Effect.provideService(
    Logger.CurrentLoggers,
    new Set([
      Logger.make(({ fiber, message }) => {
        if (String(message).includes(text)) fiber.interruptUnsafe()
      })
    ])
  )

const NEW = { cwd: "/work", mcpServers: [] }
const LOAD = { sessionId: "conv-old", cwd: "/work", replay: false, mcpServers: [] }

describe("interrupting a new session", () => {
  it.live("closes it when interrupted before it was handed over", () =>
    Effect.gen(function*() {
      const { agent, scopes } = yield* setup
      const exit = yield* inOwnFiber(agent.newSession(NEW).pipe(interruptOnLog("Opened session")))
      assert.isTrue(Exit.hasInterrupts(exit))
      assert.strictEqual(scopes.opened, 1)
      assert.strictEqual(scopes.live, 0)
    }).pipe(Effect.scoped))

  it.live("leaves it open once it was handed over, whatever happens to the caller next", () =>
    Effect.gen(function*() {
      const { agent, scopes } = yield* setup
      const handedOver = yield* inOwnFiber(agent.newSession(NEW).pipe(Effect.tap(() => interruptSelf)))
      assert.isTrue(Exit.hasInterrupts(handedOver))
      assert.strictEqual(scopes.live, 1)
    }).pipe(Effect.scoped))

  it.live("hands over a session that can be closed", () =>
    Effect.gen(function*() {
      const { agent, scopes } = yield* setup
      const setupResult = yield* agent.newSession(NEW)
      assert.strictEqual(scopes.live, 1)
      yield* agent.closeSession(setupResult.sessionId)
      assert.strictEqual(scopes.live, 0)
    }).pipe(Effect.scoped))
})

describe("interrupting an open of an existing session", () => {
  it.live("keeps a session that finished opening, so a retry reuses it", () =>
    Effect.gen(function*() {
      const { agent, interruptOnSessionInfo, scopes } = yield* setup
      interruptOnSessionInfo.armed = true
      const interrupted = yield* inOwnFiber(agent.loadSession(LOAD))
      assert.isTrue(Exit.hasInterrupts(interrupted))
      assert.strictEqual(scopes.live, 1)
      interruptOnSessionInfo.armed = false
      assert.isTrue(Exit.isSuccess(yield* agent.loadSession(LOAD).pipe(Effect.exit)))
      assert.strictEqual(scopes.opened, 1)
      assert.strictEqual(scopes.live, 1)
    }).pipe(Effect.scoped))
})

/**
 * Interrupts `operation`, yielding every few steps, after each number of
 * scheduler turns from its start to its end. Different yield settings land on
 * different steps (below 3 a fiber never finishes: it yields before each step
 * it resumes at). `check` then sees how it ended.
 */
const sweep = <A, E, B>(
  prepare: (agent: Agent["Service"]) => Effect.Effect<void>,
  operation: (agent: Agent["Service"]) => Effect.Effect<A, E>,
  check: (
    context: { readonly agent: Agent["Service"]; readonly scopes: Scopes },
    exit: Exit.Exit<A, E>,
    where: { readonly text: string; readonly turnsBeforeEnd: number }
  ) => Effect.Effect<B>
) =>
  Effect.gen(function*() {
    const results: Array<B> = []
    for (const maxOps of [3, 4, 5, 6, 7]) {
      const started = (agent: Agent["Service"]) =>
        operation(agent).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, maxOps), Effect.forkChild)
      const turnsToEnd = yield* Effect.gen(function*() {
        const { agent } = yield* setup
        yield* prepare(agent)
        const fiber = yield* started(agent)
        let turns = 0
        while (fiber.pollUnsafe() === undefined) {
          turns++
          yield* Effect.yieldNow
        }
        return turns
      }).pipe(Effect.scoped)
      for (let turns = 0; turns <= turnsToEnd; turns++) {
        yield* Effect.gen(function*() {
          const { agent, scopes } = yield* setup
          yield* prepare(agent)
          const fiber = yield* started(agent)
          for (let i = 0; i < turns; i++) yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          results.push(
            yield* check({ agent, scopes }, exit, {
              text: `every ${maxOps} ops, ${turns} of ${turnsToEnd} turns`,
              turnsBeforeEnd: turnsToEnd - turns
            })
          )
        }).pipe(Effect.scoped)
      }
    }
    return results
  })

const orDie = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.orDie, Effect.asVoid)

describe("interrupting at any step", () => {
  /**
   * An interrupt that lands after `newSession` has returned, in its caller's
   * last steps, still ends the fiber as interrupted. The session is the
   * caller's by then, so it stays open; only the end of the sweep may see that.
   */
  const AFTER_RETURN_TURNS = 5

  it.live("a new session is closed unless it was handed over", () =>
    Effect.gen(function*() {
      const outcomes = yield* sweep(
        () => Effect.void,
        (agent) => agent.newSession(NEW),
        ({ scopes }, exit, where) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) assert.strictEqual(scopes.live, 1, where.text)
            else if (where.turnsBeforeEnd > AFTER_RETURN_TURNS) assert.strictEqual(scopes.live, 0, where.text)
            else assert.include([0, 1], scopes.live, where.text)
            return Exit.isSuccess(exit)
          })
      )
      assert.sameMembers([...new Set(outcomes)], [true, false])
    }), 60_000)

  it.live("an open leaves no session, or one that a retry reuses", () =>
    Effect.gen(function*() {
      const outcomes = yield* sweep(
        () => Effect.void,
        (agent) => agent.loadSession(LOAD),
        ({ agent, scopes }, _exit, where) =>
          Effect.gen(function*() {
            const live = scopes.live
            assert.include([0, 1], live, where.text)
            const opened = scopes.opened
            yield* orDie(agent.loadSession(LOAD))
            assert.strictEqual(scopes.live, 1, where.text)
            assert.strictEqual(scopes.opened, live === 1 ? opened : opened + 1, where.text)
            return live
          })
      )
      assert.sameMembers([...new Set(outcomes)], [0, 1])
    }), 60_000)

  it.live(
    "a close leaves the session open, to close again, or gone with its scope closed",
    () =>
      Effect.gen(function*() {
        const outcomes = yield* sweep(
          (agent) => orDie(agent.loadSession(LOAD)),
          (agent) => agent.closeSession("conv-old"),
          ({ agent, scopes }, _exit, where) =>
            Effect.gen(function*() {
              const live = scopes.live
              yield* agent.closeSession("conv-old")
              assert.strictEqual(scopes.live, 0, `a scope outlived its session: ${where.text}`)
              return live
            })
        )
        assert.sameMembers([...new Set(outcomes)], [0, 1])
      }),
    60_000
  )
})
