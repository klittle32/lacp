import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import { LacpConfig } from "../src/Config.ts"
import { Host } from "../src/Host.ts"
import { compareVersions, LettaExecutable, parseVersion } from "../src/letta/Executable.ts"

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

const resolveWith = (env: Record<string, string>, config: Parameters<typeof LacpConfig.layerTest>[0] = {}) =>
  Effect.gen(function*() {
    const executable = yield* LettaExecutable
    return yield* executable.resolve
  }).pipe(
    Effect.provide(LettaExecutable.layer.pipe(
      Layer.provide(LacpConfig.layerTest(config)),
      Layer.provide(Host.layerTest({ env, home: "/nonexistent-home" }))
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

describe("LettaExecutable with a bare command name", () => {
  it.live("looks the configured name up on PATH", () =>
    Effect.gen(function*() {
      const { bin, dir } = yield* fakeLetta("0.34.15")
      const install = yield* resolveWith({ PATH: dir }, { lettaPath: Option.some("letta") })
      assert.strictEqual(install.path, bin)
      assert.strictEqual(install.source, "--letta-path")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
