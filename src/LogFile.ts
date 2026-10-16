/**
 * The optional log file (`--log-file` / `LACP_LOG_FILE`), written alongside
 * stderr. Some ACP clients keep little of an agent's stderr: T3 Code holds only
 * a short tail in memory and writes none of it to disk.
 */
import { Effect, FileSystem, Layer, Logger, Option, Path } from "effect"
import { Host } from "./Host.ts"

/** Resolves `~/…` against the home directory and a relative path against the working directory. */
const resolvePath = Effect.fnUntraced(function*(file: string) {
  const host = yield* Host
  const path = yield* Path.Path
  return path.resolve(host.cwd, file === "~" || file.startsWith("~/") ? path.join(host.home, file.slice(1)) : file)
})

/** Appends logfmt lines to the file; a file that cannot be opened is reported on stderr and skipped. */
const fileLogger = Effect.fnUntraced(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = yield* resolvePath(file)
  yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.ignore)
  return yield* Logger.toFile(Logger.formatLogFmt, target, { flag: "a" }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Not writing the log to ${target}: ${error.message}`).pipe(
        Effect.as(Logger.make<unknown, void>(() => undefined))
      )
    )
  )
})

/** Adds the file to the current loggers, or nothing without a file. */
export const layer = (file: Option.Option<string>) =>
  Option.match(file, {
    onNone: () => Layer.empty,
    onSome: (file) => Logger.layer([fileLogger(file)], { mergeWithExisting: true })
  })
