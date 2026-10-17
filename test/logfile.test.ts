import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Logger, Option, Path } from "effect"
import { Host } from "../src/Host.ts"
import * as LogFile from "../src/LogFile.ts"

/** Logs one line with the log file layer for `file`, then closes it (which flushes the file). */
const logWith = (file: string, home: string) =>
  Effect.gen(function*() {
    const loggers = yield* Effect.service(Logger.CurrentLoggers)
    yield* Effect.logInfo("Started session conv-1")
    return loggers.size
  }).pipe(
    Effect.provide(
      LogFile.layer(Option.some(file)).pipe(
        Layer.provide(Host.layerTest({ home, cwd: home })),
        Layer.provide(NodeServices.layer)
      )
    )
  )

describe("log file", () => {
  it.live("appends the log to the file, next to the existing loggers", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const before = (yield* Effect.service(Logger.CurrentLoggers)).size
      const during = yield* logWith("~/logs/lacp.log", home)
      assert.strictEqual(during, before + 1)
      yield* logWith("~/logs/lacp.log", home)
      const lines = (yield* fs.readFileString(path.join(home, "logs", "lacp.log"))).trim().split("\n")
      assert.strictEqual(lines.length, 2)
      assert.match(lines[0] ?? "", /level=INFO .*message="Started session conv-1"/)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("keeps running without the file when it cannot be opened", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const blocker = path.join(home, "not-a-directory")
      yield* fs.writeFileString(blocker, "")
      yield* logWith(path.join(blocker, "lacp.log"), home)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
