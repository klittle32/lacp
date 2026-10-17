import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { VERSION } from "../src/Version.ts"

describe("VERSION", () => {
  it.effect("matches package.json", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const text = yield* fs.readFileString(new URL("../package.json", import.meta.url).pathname)
      const pkg = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(text)
      assert.strictEqual(VERSION, pkg.version)
    }).pipe(Effect.provide(NodeServices.layer)))
})
