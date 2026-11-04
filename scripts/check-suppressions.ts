// Fails when a suppression comment has no reason, or silences an Effect-native rule inline.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { suppressionProblems } from "./suppressions.ts"

class UnreasonedSuppression extends Schema.TaggedError<UnreasonedSuppression, { readonly brand: unique symbol }>()(
  "UnreasonedSuppression",
  { count: Schema.Finite }
) {}

const CODE = /\.(?:[cm]?ts|tsx|[cm]?js)$/

const SKIP = new Set(["node_modules", "dist", ".git", "coverage"])

const walk = (directory: string): Effect.Effect<Array<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found: Array<string> = []
    for (const entry of yield* fs.readDirectoryEntries(directory)) {
      if (SKIP.has(entry.name)) continue
      const full = path.join(directory, entry.name)
      if (entry.type === "Directory") found.push(...yield* walk(full))
      else if (entry.type === "File" && CODE.test(entry.name)) found.push(full)
    }
    return found
  }).pipe(Effect.orDie)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const script = yield* path.fromFileUrl(new URL(import.meta.url))
  const root = path.dirname(path.dirname(script))
  const files = yield* walk(root)
  const problems: Array<string> = []
  for (const file of files) {
    const text = yield* fs.readFileString(file)
    for (const problem of suppressionProblems(text)) {
      problems.push(`${path.relative(root, file)}:${problem.line}: ${problem.message}`)
    }
  }
  if (problems.length > 0) {
    yield* Console.error(problems.join("\n"))
    return yield* new UnreasonedSuppression({ count: problems.length })
  }
  return undefined
}).pipe(Effect.provide(NodeServices.layer))

NodeRuntime.runMain(program)
