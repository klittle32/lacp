/**
 * Where the host's Letta Code keeps its Letta Cloud login.
 *
 * Letta Code stores the OAuth refresh token and API key in the system keychain
 * when it runs under Bun (`Bun.secrets`, service `letta-code`), and in
 * `~/.letta/settings.json` when it runs under Node. Under Bun it also moves a
 * login it finds in that file into the keychain, after which Letta Code under
 * Node can no longer see it. So the runtime has to follow the login.
 */
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const KEYCHAIN_SERVICE = "letta-code"
const KEYCHAIN_ACCOUNTS = ["letta-refresh-token", "letta-api-key"]

const Settings = Schema.Struct({
  refreshToken: Schema.optionalKey(Schema.NullOr(Schema.String)),
  env: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)))
})
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(Settings))

const isNonEmptyString = (value: unknown) => Predicate.isString(value) && value !== ""

/** Letta Code's global settings file for a HOME. */
export const settingsPath = (path: Path.Path, home: string) => path.join(home, ".letta", "settings.json")

/** Whether `~/.letta/settings.json` holds a login (an OAuth refresh token or an API key). */
export const inSettingsFile = Effect.fnUntraced(function*(home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const text = yield* fs.readFileString(settingsPath(path, home)).pipe(Effect.option)
  return Option.flatMap(text, decodeSettings).pipe(
    Option.exists((settings) =>
      isNonEmptyString(settings.refreshToken) || isNonEmptyString(settings.env?.["LETTA_API_KEY"])
    )
  )
})

/**
 * Whether the macOS keychain holds Letta Code's login. `None` on other
 * platforms, where this is not checked.
 */
export const inKeychain = Effect.fnUntraced(function*(platform: string) {
  if (platform !== "darwin") return Option.none<boolean>()
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  for (const account of KEYCHAIN_ACCOUNTS) {
    // Without -g or -w, `security` only looks the item up; it never reads the secret.
    const code = yield* spawner.exitCode(
      ChildProcess.make("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore"
      })
    ).pipe(Effect.orElseSucceed(() => -1))
    if (code === 0) return Option.some(true)
  }
  return Option.some(false)
})
