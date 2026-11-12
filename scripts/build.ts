// Bundles the CLI into one file, dist/main.js, then proves the bundle starts.
//
// A single bundled file starts about 5x faster than tsc's loose output, because Node no longer resolves and
// loads hundreds of modules from node_modules/effect on every launch. Effect ships `@__PURE__` annotations and
// `sideEffects` metadata, so Rolldown tree-shakes it down to what lacp uses. The bundle has no runtime
// dependencies, which is why effect and @effect/platform-node are devDependencies.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { build } from "rolldown"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const script = yield* path.fromFileUrl(new URL(import.meta.url))
  const root = path.dirname(path.dirname(script))
  const entry = path.join(root, "dist", "main.js")

  yield* fs.remove(path.join(root, "dist"), { recursive: true, force: true })

  // A failed bundle is a defect: the build stops with Rolldown's own report.
  yield* Effect.promise(() =>
    build({
      cwd: root,
      input: path.join(root, "src", "main.ts"),
      platform: "node",
      // Matches `engines.node`, so the bundle keeps syntax every supported Node runs.
      transform: { target: "node22" },
      logLevel: "warn",
      output: {
        file: entry,
        format: "esm",
        sourcemap: true,
        // Stack traces only need file and line; embedding Effect's sources would make the map 5 MB.
        sourcemapExcludeSources: true,
        minify: true,
        // Minifying renames classes and functions; keep their `name` so logs and defects stay readable.
        keepNames: true
      }
    })
  )

  // Windows does not use the executable bit.
  if (process.platform !== "win32") yield* fs.chmod(entry, 0o755)

  // Tests run from src, so this is the one check that the bundle itself loads and runs.
  const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [entry, "--version"], {
    cwd: root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit"
  }))
  const code = yield* handle.exitCode
  if (code !== 0) return yield* Effect.die(`the bundle exited with ${code} on --version`)
  return undefined
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

NodeRuntime.runMain(program)
