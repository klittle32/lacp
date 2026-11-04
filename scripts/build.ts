// Cross-platform build: clean dist, compile, mark the CLI entry executable.
// Replaces `rm -rf dist && tsc && chmod +x`, which fail under npm's cmd.exe shell on Windows.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const script = yield* path.fromFileUrl(new URL(import.meta.url))
  const root = path.dirname(path.dirname(script))

  yield* fs.remove(path.join(root, "dist"), { recursive: true, force: true })

  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc")
  const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  }))
  const code = yield* handle.exitCode
  if (code !== 0) return yield* Effect.die(`tsc exited with ${code}`)

  // Windows does not use the executable bit.
  if (process.platform !== "win32") yield* fs.chmod(path.join(root, "dist", "main.js"), 0o755)
  return undefined
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

NodeRuntime.runMain(program)
