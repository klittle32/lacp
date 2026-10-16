/**
 * End-to-end: the full server against a real Letta Code install, using Letta's
 * offline deterministic backend (no network, no credentials).
 *
 * Opt-in: set LACP_E2E_LETTA to a `letta` executable (or `letta.js`), e.g.
 *
 *   LACP_E2E_LETTA=$(command -v letta) npm test
 */
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { LettaRuntime } from "../src/Config.ts"
import { layerWebSocket, LettaAppServer } from "../src/letta/AppServer.ts"
import { LettaExecutable } from "../src/letta/Executable.ts"
import { allowOnce, initializeHybrid, initializeV1, startWith } from "./helpers/AcpClient.ts"

const mcpFixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))
const scriptedModel = fileURLToPath(new URL("./fixtures/scripted-model.mjs", import.meta.url))

// oxlint-disable-next-line effecttsgo/process-env -- test-only opt-in switch
const letta = process.env["LACP_E2E_LETTA"]
const hasBun = spawnSync("bun", ["--version"]).status === 0

const realLetta = LettaAppServer.layer.pipe(Layer.provide(LettaExecutable.layer), Layer.provide(layerWebSocket))

// The v2 cases anchor on each prompt's echoed `user_message`, so they turn the echo on.
/** Serves the scripted model (test/fixtures/scripted-model.mjs) and returns its base URL. */
const serveScriptedModel = Effect.acquireRelease(
  Effect.callback<{ readonly url: string; readonly kill: () => void }>((resume) => {
    const child = spawn(process.execPath, [scriptedModel], { stdio: ["ignore", "pipe", "inherit"] })
    child.stdout.once(
      "data",
      (port) => resume(Effect.succeed({ url: `http://127.0.0.1:${String(port).trim()}/v1`, kill: () => child.kill() }))
    )
  }),
  (model) => Effect.sync(model.kill)
).pipe(Effect.map((model) => model.url))

/** Letta's offline deterministic backend, or a model endpoint (an LM Studio base URL) on the local backend. */
type Backend = { readonly _tag: "Deterministic" } | { readonly _tag: "Model"; readonly lmStudioUrl: string }

const startReal = (lettaRuntime: LettaRuntime = "node", backend: Backend = { _tag: "Deterministic" }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "lacp-e2e-home-" })
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "lacp-e2e-project-" })
    const client = yield* startWith(realLetta, {
      config: {
        auth: "local",
        lettaPath: Option.fromUndefinedOr(letta),
        lettaRuntime,
        echoPrompts: true,
        permissionMode: Option.some("standard"),
        ...(backend._tag === "Model" ? { model: Option.some("lmstudio/mock-model") } : {})
      },
      host: {
        cwd,
        home,
        env: {
          // oxlint-disable-next-line effecttsgo/process-env -- the child needs the real PATH
          PATH: process.env["PATH"] ?? "",
          HOME: home,
          DISABLE_AUTOUPDATER: "1",
          LETTA_CODE_TELEM: "0",
          DO_NOT_TRACK: "1",
          LETTA_BASE_URL: "http://127.0.0.1:9",
          ...(backend._tag === "Model"
            ? { LMSTUDIO_BASE_URL: backend.lmStudioUrl }
            : { LETTA_LOCAL_BACKEND_EXECUTOR: "deterministic-reflection" })
        },
        execPath: process.execPath
      }
    })
    return { client, cwd, path }
  })

describe.skipIf(letta === undefined)("end-to-end with Letta Code", () => {
  it.live("ACP v2: prompt, approval, terminal output, list and resume with replay", () =>
    Effect.gen(function*() {
      const { client, cwd } = yield* startReal()
      yield* client.setPermissionPolicy(allowOnce)
      const init = yield* client.request("initialize", initializeHybrid)
      assert.strictEqual(init.result.protocolVersion, 2)

      const created = yield* client.request("session/new", { cwd })
      const sessionId = created.result.sessionId as string
      assert.isString(sessionId)
      assert.strictEqual(
        created.result.configOptions.find((o: any) => o.configId === "mode")?.currentValue,
        "standard"
      )

      const first = yield* client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })
      assert.isString(first.result.messageId)
      yield* client.update((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text === "pong")
      yield* client.update((u) => u.sessionUpdate === "state_update" && u.state === "idle")

      // Letta may still be finishing background work (e.g. reflection) from the first
      // turn, so anchor on the second prompt's own user message.
      const second = yield* client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "please inspect $TRANSCRIPT_PATH" }]
      })
      yield* client.update((u) => u.sessionUpdate === "user_message" && u.messageId === second.result.messageId)
      const from = (yield* client.updates).findIndex((u) => u.messageId === second.result.messageId)
      yield* client.update((u) => u.sessionUpdate === "state_update" && u.state === "idle", from)
      const turn = (yield* client.updates).slice(from)
      assert.isTrue(turn.some((u) => u.sessionUpdate === "state_update" && u.state === "requires_action"))
      assert.isTrue(turn.some((u) => u.sessionUpdate === "terminal_update" && u.command !== undefined))
      assert.isTrue(
        turn.some((u) => u.sessionUpdate === "tool_call_update" && (u.status === "completed" || u.status === "failed"))
      )
      const [permission] = yield* client.agentRequests
      assert.strictEqual(permission?.method, "session/request_permission")

      const listed = yield* client.request("session/list", { cwd })
      assert.include(listed.result.sessions.map((s: any) => s.sessionId), sessionId)

      const resumedFrom = (yield* client.updates).length
      const resumed = yield* client.request("session/resume", { sessionId, cwd, replayFrom: { type: "start" } })
      assert.isDefined(resumed.result.configOptions)
      const replayed = (yield* client.updates).slice(resumedFrom)
      assert.isTrue(replayed.some((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text === "pong"))
      assert.isTrue(replayed.some((u) => u.sessionUpdate === "user_message_chunk" && u.content.text.includes("hello")))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 180_000)

  it.live("ACP v2: the client's MCP servers are registered with Letta as external tools", () =>
    Effect.gen(function*() {
      const { client, cwd } = yield* startReal()
      yield* client.request("initialize", initializeHybrid)
      // Letta validates every tool definition in runtime_start; a rejected one fails session/new.
      const created = yield* client.request("session/new", {
        cwd,
        mcpServers: [{ type: "stdio", name: "fixture", command: process.execPath, args: [mcpFixture], env: [] }]
      })
      assert.isUndefined(created.error)
      const sessionId = created.result.sessionId as string
      const reply = yield* client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })
      yield* client.update((u) => u.sessionUpdate === "user_message" && u.messageId === reply.result.messageId)
      yield* client.update((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text === "pong")
      assert.isFalse((yield* client.updates).some((u) => u.sessionUpdate === "notice"))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 180_000)

  it.live.skipIf(!hasBun)("runs Letta Code under Bun with LACP_LETTA_RUNTIME=bun", () =>
    Effect.gen(function*() {
      const { client, cwd } = yield* startReal("bun")
      yield* client.request("initialize", initializeV1)
      const created = yield* client.request("session/new", { cwd, mcpServers: [] })
      const reply = yield* client.request("session/prompt", {
        sessionId: created.result.sessionId,
        prompt: [{ type: "text", text: "hello" }]
      })
      assert.deepStrictEqual(reply.result, { stopReason: "end_turn" })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 180_000)

  it.live(
    "ACP v2: a turn that starts a background subagent ends after the subagent's report",
    () =>
      Effect.gen(function*() {
        const lmStudioUrl = yield* serveScriptedModel
        const { client, cwd } = yield* startReal("node", { _tag: "Model", lmStudioUrl })
        yield* client.request("initialize", initializeHybrid)
        const sessionId = (yield* client.request("session/new", { cwd })).result.sessionId as string
        yield* client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "SPAWN_WORKER" }] })
        // Letta Code reports the subagent's final state only while the turn that started it runs.
        const ended = yield* client.update((u) => u.sessionUpdate === "state_update" && u.state === "idle").pipe(
          Effect.timeout("60 seconds")
        )
        assert.strictEqual(ended.stopReason, "end_turn")
        const texts = (yield* client.updates).filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) =>
          u.content.text
        )
        assert.deepStrictEqual(texts, ["Started a worker; it will report back.", "Here is the listing: a.txt b.txt"])
        assert.isFalse((yield* client.updates).some((u) => u.sessionUpdate === "user_message_chunk"))
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000
  )

  it.live("ACP v1: session/prompt resolves with end_turn", () =>
    Effect.gen(function*() {
      const { client, cwd } = yield* startReal()
      yield* client.request("initialize", initializeV1)
      const created = yield* client.request("session/new", { cwd, mcpServers: [] })
      const reply = yield* client.request("session/prompt", {
        sessionId: created.result.sessionId,
        prompt: [{ type: "text", text: "hello" }]
      })
      assert.deepStrictEqual(reply.result, { stopReason: "end_turn" })
      assert.isTrue(
        (yield* client.updates).some((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text === "pong")
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 180_000)
})
