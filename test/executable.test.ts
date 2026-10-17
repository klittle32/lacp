import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path, Result } from "effect"
import { LacpConfig } from "../src/Config.ts"
import { Host, type HostShape } from "../src/Host.ts"
import { chooseRuntime, compareVersions, LettaExecutable, parseVersion } from "../src/letta/Executable.ts"
import * as Login from "../src/letta/Login.ts"

describe("version helpers", () => {
  it("parses `letta --version` output", () => {
    assert.deepStrictEqual(parseVersion("0.34.15 (Letta Code)"), Option.some("0.34.15"))
    assert.deepStrictEqual(parseVersion("noise\n0.35.0-next.2 (Letta Code)\n"), Option.some("0.35.0-next.2"))
    assert.deepStrictEqual(parseVersion("v22.22.0"), Option.none())
  })

  it("compares versions numerically", () => {
    assert.isTrue(compareVersions("0.34.15", "0.30.0") > 0)
    assert.isTrue(compareVersions("0.9.0", "0.30.0") < 0)
    assert.strictEqual(compareVersions("1.2.3", "1.2.3"), 0)
  })
})

/** Writes a fake `letta` that prints `version` and returns its directory. */
const fakeLetta = (version: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped()
    const bin = path.join(dir, "letta")
    yield* fs.writeFileString(bin, `#!/bin/sh\necho "${version} (Letta Code)"\n`)
    yield* fs.chmod(bin, 0o755)
    return { dir, bin }
  })

const resolveWith = (
  env: Record<string, string>,
  config: Parameters<typeof LacpConfig.layerTest>[0] = {},
  host: Partial<HostShape> = {}
) =>
  Effect.gen(function*() {
    const executable = yield* LettaExecutable
    return yield* executable.resolve
  }).pipe(
    Effect.provide(LettaExecutable.layer.pipe(
      Layer.provide(LacpConfig.layerTest(config)),
      Layer.provide(Host.layerTest({ env, home: "/nonexistent-home", ...host }))
    ))
  )

describe("LettaExecutable", () => {
  it.live("finds the host's letta on PATH and reads its version", () =>
    Effect.gen(function*() {
      const { bin, dir } = yield* fakeLetta("0.34.15")
      const install = yield* resolveWith({ PATH: `/nonexistent:${dir}` })
      assert.strictEqual(install.path, bin)
      assert.strictEqual(install.command, bin)
      assert.strictEqual(install.version, "0.34.15")
      assert.strictEqual(install.source, "PATH")
      assert.strictEqual(install.runtime, "launcher")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("prefers an explicit path", () =>
    Effect.gen(function*() {
      const onPath = yield* fakeLetta("0.34.15")
      const explicit = yield* fakeLetta("0.33.0")
      const install = yield* resolveWith({ PATH: onPath.dir }, { lettaPath: Option.some(explicit.bin) })
      assert.strictEqual(install.path, explicit.bin)
      assert.strictEqual(install.source, "--letta-path")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("rejects installs that are too old", () =>
    Effect.gen(function*() {
      const { dir } = yield* fakeLetta("0.26.0")
      const error = yield* resolveWith({ PATH: dir }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "LettaUnsupported")
      assert.include(error.message, "older than 0.30.0")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("explains how to install when nothing is found", () =>
    Effect.gen(function*() {
      const error = yield* resolveWith({ PATH: "/nonexistent" }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "LettaNotFound")
      assert.include(error.message, "npm install -g @letta-ai/letta-code")
    }).pipe(Effect.provide(NodeServices.layer)))
})

describe("LettaExecutable caching", () => {
  it.live("looks again after a failed discovery, and keeps a found install", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const bin = path.join(dir, "letta")
      yield* Effect.gen(function*() {
        const executable = yield* LettaExecutable
        assert.strictEqual((yield* executable.resolve.pipe(Effect.flip))._tag, "LettaNotFound")
        yield* fs.writeFileString(bin, `#!/bin/sh\necho "0.34.15 (Letta Code)"\n`)
        yield* fs.chmod(bin, 0o755)
        assert.strictEqual((yield* executable.resolve).path, bin)
        // Once found, the install is not looked up again.
        yield* fs.remove(bin)
        assert.strictEqual((yield* executable.resolve).path, bin)
      }).pipe(
        Effect.provide(LettaExecutable.layer.pipe(
          Layer.provide(LacpConfig.layerTest({})),
          Layer.provide(Host.layerTest({ env: { PATH: dir }, home: "/nonexistent-home" }))
        ))
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("LettaExecutable with a bare command name", () => {
  it.live("looks the configured name up on PATH", () =>
    Effect.gen(function*() {
      const { bin, dir } = yield* fakeLetta("0.34.15")
      const install = yield* resolveWith({ PATH: dir }, { lettaPath: Option.some("letta") })
      assert.strictEqual(install.path, bin)
      assert.strictEqual(install.source, "--letta-path")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("finds other names on PATH too", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { bin, dir } = yield* fakeLetta("0.34.15")
      const nightly = `${dir}/letta-nightly`
      yield* fs.rename(bin, nightly)
      const install = yield* resolveWith({ PATH: dir }, { lettaPath: Option.some("letta-nightly") })
      assert.strictEqual(install.path, nightly)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("fails instead of using another letta when the name is not found", () =>
    Effect.gen(function*() {
      const { dir } = yield* fakeLetta("0.34.15")
      const error = yield* resolveWith({ PATH: dir }, { lettaPath: Option.some("letta-nightly") }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "LettaUnsupported")
      assert.include(error.message, "letta-nightly")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("chooseRuntime", () => {
  const node = Option.some("/usr/bin/node")
  const bun = Option.some("/home/me/.bun/bin/bun")
  const choose = (input: Partial<Parameters<typeof chooseRuntime>[0]>) =>
    chooseRuntime({ requested: "auto", platform: "darwin", loginInSettings: false, node, bun, ...input })
  const runtimeOf = (result: ReturnType<typeof chooseRuntime>) =>
    Result.match(result, { onSuccess: (choice) => choice.runtime, onFailure: (error) => `error: ${error}` })

  it("keeps Node while the settings file holds the login", () => {
    assert.strictEqual(runtimeOf(choose({ loginInSettings: true })), "node")
  })

  it("uses Bun when the login is not in the settings file", () => {
    assert.strictEqual(runtimeOf(choose({})), "bun")
    assert.strictEqual(runtimeOf(choose({ bun: Option.none() })), "node")
  })

  it("prefers Node on Windows", () => {
    assert.strictEqual(runtimeOf(choose({ platform: "win32" })), "node")
    assert.strictEqual(runtimeOf(choose({ platform: "win32", node: Option.none() })), "bun")
  })

  it("falls back to Bun when Node is missing", () => {
    const result = choose({ loginInSettings: true, node: Option.none() })
    assert.strictEqual(runtimeOf(result), "bun")
    assert.include(Result.getOrThrow(result).reason, "Node.js was not found")
  })

  it("honours an explicit choice, and fails when it is not installed", () => {
    assert.strictEqual(runtimeOf(choose({ requested: "node" })), "node")
    assert.strictEqual(runtimeOf(choose({ requested: "bun", loginInSettings: true })), "bun")
    assert.strictEqual(
      runtimeOf(choose({ requested: "bun", bun: Option.none() })),
      "error: LACP_LETTA_RUNTIME is bun, but Bun was not found"
    )
  })
})

/** A `letta.js` (as npm and Bun install it) behind a `letta` symlink, plus a fake `bun` that runs Node. */
const scriptInstall = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped()
  const pkg = path.join(dir, "lib", "node_modules", "@letta-ai", "letta-code")
  yield* fs.makeDirectory(pkg, { recursive: true })
  const script = path.join(pkg, "letta.js")
  yield* fs.writeFileString(script, `#!/usr/bin/env node\nconsole.log("0.34.15 (Letta Code)")\n`)
  const bin = path.join(dir, "bin")
  yield* fs.makeDirectory(bin)
  yield* fs.symlink(script, path.join(bin, "letta"))
  const bun = path.join(bin, "bun")
  yield* fs.writeFileString(bun, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)
  yield* fs.chmod(bun, 0o755)
  const home = path.join(dir, "home")
  yield* fs.makeDirectory(path.join(home, ".letta"), { recursive: true })
  return { bin, bun, home, script: yield* fs.realPath(script) }
})

describe("LettaExecutable runtimes", () => {
  const host = (home: string) => ({ home, execPath: process.execPath, runtime: "node" as const })

  it.live("runs letta.js with Bun when the settings file has no login", () =>
    Effect.gen(function*() {
      const { bin, bun, home, script } = yield* scriptInstall
      const install = yield* resolveWith({ PATH: bin, HOME: home }, {}, host(home))
      assert.strictEqual(install.runtime, "bun")
      assert.strictEqual(install.command, bun)
      assert.deepStrictEqual(install.prefixArgs, [script])
      assert.strictEqual(install.version, "0.34.15")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("keeps Node while ~/.letta/settings.json holds the login", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { bin, home, script } = yield* scriptInstall
      yield* fs.writeFileString(`${home}/.letta/settings.json`, JSON.stringify({ refreshToken: "rt" }))
      const install = yield* resolveWith({ PATH: bin, HOME: home }, {}, host(home))
      assert.strictEqual(install.runtime, "node")
      assert.strictEqual(install.command, process.execPath)
      assert.deepStrictEqual(install.prefixArgs, [script])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("honours LACP_LETTA_RUNTIME=node", () =>
    Effect.gen(function*() {
      const { bin, home } = yield* scriptInstall
      const install = yield* resolveWith({ PATH: bin, HOME: home }, { lettaRuntime: "node" }, host(home))
      assert.strictEqual(install.runtime, "node")
      assert.strictEqual(install.runtimeReason, "LACP_LETTA_RUNTIME=node")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("Login.inSettingsFile", () => {
  it.live("finds a refresh token or an API key, and nothing else", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${home}/.letta`)
      const withSettings = (text: string) =>
        fs.writeFileString(`${home}/.letta/settings.json`, text).pipe(Effect.andThen(Login.inSettingsFile(home)))
      assert.isTrue(yield* withSettings(JSON.stringify({ refreshToken: "rt", lastAgent: "agent-1" })))
      assert.isTrue(yield* withSettings(JSON.stringify({ env: { LETTA_API_KEY: "sk-let" } })))
      assert.isFalse(yield* withSettings(JSON.stringify({ refreshToken: "", env: { OTHER: "x" } })))
      assert.isFalse(yield* withSettings("not json"))
      assert.isFalse(yield* Login.inSettingsFile("/nonexistent-home"))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("Login.environmentKeyNote", () => {
  it("explains when LETTA_API_KEY decides which credential Letta Code uses", () => {
    const env = { LETTA_API_KEY: "sk-let-1" }
    assert.include(Option.getOrThrow(Login.environmentKeyNote("host", env)), "ahead of your Letta login")
    assert.include(Option.getOrThrow(Login.environmentKeyNote("cloud-oauth", env)), "your Letta login is used")
    assert.isTrue(Option.isNone(Login.environmentKeyNote("api-key", env)))
    assert.isTrue(Option.isNone(Login.environmentKeyNote("host", { LETTA_API_KEY: "" })))
  })
})
