/**
 * Finds the host's own Letta Code installation.
 *
 * Driving the host's `letta` (rather than a bundled copy) is what makes the
 * user's settings, login, skills, hooks, subagents, MCP servers and mods carry
 * over: they all live under the user's HOME and are loaded by that binary.
 *
 * Editors often launch agent servers without the user's shell PATH (e.g. from
 * the macOS Dock), so discovery falls back to well-known global install
 * directories, a login-shell lookup, and finally `npm prefix -g`.
 *
 * When the install is a JavaScript launcher (npm and Bun link `letta` to
 * `letta.js`), lacp runs that script with the runtime that can see the user's
 * login: see `LettaRuntime` and `Login.ts`.
 */
import { Context, type Duration, Effect, FileSystem, Layer, Option, Path, Result } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { LacpConfig, type LettaRuntime } from "../Config.ts"
import { Host } from "../Host.ts"
import { LettaNotFound, LettaUnsupported } from "./Errors.ts"
import * as Login from "./Login.ts"

/** Oldest Letta Code with the App Server WebSocket protocol (v1) this bridge speaks. */
export const MINIMUM_VERSION = "0.30.0"

export interface LettaInstall {
  /** Executable to spawn. */
  readonly command: string
  /** Arguments placed before Letta's own (e.g. the script when run through Node). */
  readonly prefixArgs: ReadonlyArray<string>
  readonly version: string
  /** The path that was found, for diagnostics. */
  readonly path: string
  /** How it was found. */
  readonly source: string
  /** What runs Letta Code: Node or Bun (with its `letta.js`), or the found executable as it is. */
  readonly runtime: "node" | "bun" | "launcher"
  /** Why, for diagnostics. */
  readonly runtimeReason: string
}

export interface RuntimeChoice {
  readonly runtime: "node" | "bun"
  readonly path: string
  readonly reason: string
}

const runtimeName = (runtime: "node" | "bun") => (runtime === "node" ? "Node.js" : "Bun")

/**
 * Picks what runs Letta Code's `letta.js`. An explicit choice must be
 * installed. `auto` prefers Node on Windows and while `~/.letta/settings.json`
 * holds the login (Bun would move it into the keychain), and Bun otherwise,
 * since Letta Code under Bun keeps the login in the system keychain.
 */
export const chooseRuntime = (input: {
  readonly requested: LettaRuntime
  readonly platform: string
  readonly loginInSettings: boolean
  readonly node: Option.Option<string>
  readonly bun: Option.Option<string>
}): Result.Result<RuntimeChoice, string> => {
  const found = (runtime: "node" | "bun") => runtime === "node" ? input.node : input.bun
  if (input.requested !== "auto") {
    const requested = input.requested
    return Option.match(found(requested), {
      onNone: () => Result.fail(`LACP_LETTA_RUNTIME is ${requested}, but ${runtimeName(requested)} was not found`),
      onSome: (path) => Result.succeed({ runtime: requested, path, reason: `LACP_LETTA_RUNTIME=${requested}` })
    })
  }
  const [preferred, reason]: readonly ["node" | "bun", string] = input.platform === "win32"
    ? ["node", "Node.js is the default on Windows"]
    : input.loginInSettings
    ? ["node", "your Letta login is in ~/.letta/settings.json, where Letta Code under Node keeps it"]
    : ["bun", "no Letta login in ~/.letta/settings.json; Letta Code under Bun keeps it in the system keychain"]
  const fallback = preferred === "node" ? "bun" : "node"
  return Option.match(found(preferred), {
    onSome: (path) => Result.succeed({ runtime: preferred, path, reason }),
    onNone: () =>
      Option.match(found(fallback), {
        onSome: (path) =>
          Result.succeed({ runtime: fallback, path, reason: `${runtimeName(preferred)} was not found` }),
        onNone: () => Result.fail("Neither Node.js nor Bun was found to run Letta Code")
      })
  })
}

interface Candidate {
  readonly path: string
  readonly source: string
}

const VERSION_PATTERN = /(\d+\.\d+\.\d+[^\s()]*)\s*\(Letta Code\)/

/** Parses `letta --version` output, e.g. `0.34.15 (Letta Code)`. */
export const parseVersion = (output: string): Option.Option<string> =>
  Option.fromNullishOr(VERSION_PATTERN.exec(output)?.[1])

/** Compares the numeric `major.minor.patch` prefix of two versions. */
export const compareVersions = (a: string, b: string): number => {
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export class LettaExecutable extends Context.Service<LettaExecutable, {
  /** Resolves (once) the `letta` installation to drive. */
  readonly resolve: Effect.Effect<LettaInstall, LettaNotFound | LettaUnsupported>
}>()("lacp/letta/LettaExecutable") {
  static readonly layer = Layer.effect(
    LettaExecutable,
    Effect.gen(function*() {
      const host = yield* Host
      const config = yield* LacpConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const windows = host.platform === "win32"
      const names = windows ? ["letta.cmd", "letta.exe", "letta"] : ["letta"]

      const isFile = (p: string) =>
        fs.stat(p).pipe(
          Effect.map((info) => info.type === "File" || info.type === "SymbolicLink"),
          Effect.orElseSucceed(() => false)
        )

      const run = (command: string, args: ReadonlyArray<string>, timeout: Duration.Input) =>
        spawner.string(
          ChildProcess.make(command, args, {
            env: { DISABLE_AUTOUPDATER: "1", LETTA_CODE_TELEM: "0" },
            extendEnv: true,
            shell: windows && command.endsWith(".cmd"),
            stdin: "ignore"
          }),
          { includeStderr: true }
        ).pipe(
          Effect.timeoutOption(timeout),
          Effect.map(Option.map((out) => out.trim())),
          Effect.orElseSucceed(() => Option.none<string>())
        )

      const pathDirs = (): Array<string> =>
        (host.env["PATH"] ?? host.env["Path"] ?? "").split(windows ? ";" : ":").filter((d) => d !== "")

      const wellKnownDirs = (): Array<string> => {
        const home = host.home
        const env = host.env
        return [
          env["NVM_BIN"],
          env["PNPM_HOME"],
          env["BUN_INSTALL"] === undefined ? undefined : path.join(env["BUN_INSTALL"], "bin"),
          path.join(home, ".bun", "bin"),
          path.join(home, ".npm-global", "bin"),
          path.join(home, ".local", "bin"),
          path.join(home, ".volta", "bin"),
          path.join(home, "Library", "pnpm"),
          path.join(home, ".local", "share", "pnpm"),
          windows ? path.join(env["APPDATA"] ?? path.join(home, "AppData", "Roaming"), "npm") : undefined,
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin"
        ].filter((d): d is string => d !== undefined && d !== "")
      }

      const pathCandidates = (): Array<Candidate> =>
        pathDirs().flatMap((dir) => names.map((name) => ({ path: path.join(dir, name), source: "PATH" })))

      const wellKnownCandidates = (): Array<Candidate> =>
        wellKnownDirs().flatMap((dir) =>
          names.map((name) => ({ path: path.join(dir, name), source: "global install dir" }))
        )

      /** `command -v <name>` in the user's login shell, which sees PATH changes from shell profiles. */
      const loginShellLookup = (name: string) =>
        Effect.suspend(() => {
          const shell = host.env["SHELL"]
          if (windows || shell === undefined) return Effect.succeed(Option.none<string>())
          return run(shell, ["-lc", `command -v ${name}`], "5 seconds").pipe(
            Effect.map(
              Option.flatMap((out) => Option.fromNullishOr(out.split("\n").findLast((l) => l.startsWith("/"))))
            ),
            Effect.map(Option.map((p) => p.trim()))
          )
        })

      const loginShellCandidate = loginShellLookup("letta").pipe(
        Effect.map(Option.map((p): Candidate => ({ path: p, source: "login shell" })))
      )

      /** Finds Node or Bun: the runtime running lacp itself, then the same places as `letta`. */
      const findRuntime = Effect.fnUntraced(function*(name: "node" | "bun") {
        if (host.runtime === name) return Option.some(host.execPath)
        const file = windows ? `${name}.exe` : name
        for (const dir of [...pathDirs(), ...wellKnownDirs()]) {
          const candidate = path.join(dir, file)
          if (yield* isFile(candidate)) return Option.some(candidate)
        }
        return yield* loginShellLookup(name)
      })

      /** The runtime for `letta.js`, chosen once (only when the install is a script). */
      const runtime = yield* Effect.cached(
        Effect.gen(function*() {
          const [loginInSettings, node, bun] = yield* Effect.all([
            Login.inSettingsFile(host.env["HOME"] ?? host.home).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path)
            ),
            findRuntime("node"),
            findRuntime("bun")
          ], { concurrency: "unbounded" })
          const choice = chooseRuntime({
            requested: config.lettaRuntime,
            platform: host.platform,
            loginInSettings,
            node,
            bun
          })
          if (Result.isFailure(choice)) {
            return yield* new LettaUnsupported({ message: choice.failure, command: config.lettaRuntime })
          }
          return choice.success
        })
      )

      /** The JavaScript file behind a candidate (following symlinks and Node/Bun shebangs), if it is one. */
      const scriptOf = Effect.fnUntraced(function*(candidatePath: string) {
        const real = yield* fs.realPath(candidatePath).pipe(Effect.orElseSucceed(() => candidatePath))
        if (/\.[cm]?js$/i.test(real)) return Option.some(real)
        // Windows launchers (`letta.cmd`) are shims; there only a `letta.js` path selects the runtime.
        if (windows) return Option.none<string>()
        const head = yield* fs.open(real).pipe(
          Effect.flatMap((file) => file.readAlloc(128)),
          Effect.scoped,
          Effect.map(Option.match({ onNone: () => "", onSome: (bytes) => new TextDecoder().decode(bytes) })),
          Effect.orElseSucceed(() => "")
        )
        return /^#![^\n]*\b(?:node|bun)\b/.test(head) ? Option.some(real) : Option.none<string>()
      })

      const toInstall = Effect.fnUntraced(function*(candidate: Candidate) {
        const script = yield* scriptOf(candidate.path)
        if (Option.isNone(script)) {
          const install: LettaInstall = {
            command: candidate.path,
            prefixArgs: [],
            version: "unknown",
            path: candidate.path,
            source: candidate.source,
            runtime: "launcher",
            runtimeReason: config.lettaRuntime === "auto"
              ? "not a JavaScript file, so it runs as it is"
              : `not a JavaScript file, so LACP_LETTA_RUNTIME=${config.lettaRuntime} cannot apply; ` +
                "point LACP_LETTA_PATH at letta.js"
          }
          return install
        }
        const choice = yield* runtime
        const install: LettaInstall = {
          command: choice.path,
          // Bun loads `.env` from the working directory by default, which could add
          // variables (even LETTA_API_KEY) that lacp did not pass. Node never does.
          prefixArgs: choice.runtime === "bun" ? ["--no-env-file", script.value] : [script.value],
          version: "unknown",
          path: candidate.path,
          source: candidate.source,
          runtime: choice.runtime,
          runtimeReason: choice.reason
        }
        return install
      })

      /** Probes a candidate: `Some(install)` if it is a usable Letta Code. */
      const probe = Effect.fnUntraced(function*(candidate: Candidate) {
        if (!(yield* isFile(candidate.path))) return Option.none<ProbeResult>()
        const install = yield* toInstall(candidate)
        const output = yield* run(install.command, [...install.prefixArgs, "--version"], "20 seconds")
        const version = Option.flatMap(output, parseVersion)
        if (Option.isNone(version)) {
          return Option.some<ProbeResult>({
            _tag: "Rejected",
            path: candidate.path,
            reason: "did not report a Letta Code version"
          })
        }
        if (compareVersions(version.value, MINIMUM_VERSION) < 0) {
          return Option.some<ProbeResult>({
            _tag: "Rejected",
            path: candidate.path,
            reason: `version ${version.value} is older than ${MINIMUM_VERSION}`
          })
        }
        return Option.some<ProbeResult>({ _tag: "Found", install: { ...install, version: version.value } })
      })

      const npmGlobalCandidate = run(windows ? "npm.cmd" : "npm", ["prefix", "-g"], "10 seconds").pipe(
        Effect.map(Option.map((prefix): Candidate => ({
          path: windows ? path.join(prefix, "letta.cmd") : path.join(prefix, "bin", "letta"),
          source: "npm prefix -g"
        })))
      )

      const resolve = Effect.gen(function*() {
        const searched: Array<string> = []
        const rejected: Array<string> = []
        const seen = new Set<string>()

        const tryAll = Effect.fnUntraced(function*(candidates: ReadonlyArray<Candidate>) {
          for (const candidate of candidates) {
            if (seen.has(candidate.path)) continue
            seen.add(candidate.path)
            searched.push(candidate.path)
            const result = yield* probe(candidate)
            if (Option.isNone(result)) continue
            if (result.value._tag === "Found") return Option.some(result.value.install)
            rejected.push(`${result.value.path}: ${result.value.reason}`)
          }
          return Option.none<LettaInstall>()
        })

        // A bare name (e.g. `letta`) is looked up on PATH; anything else is a path.
        const configured = Option.toArray(config.lettaPath).flatMap((p): Array<Candidate> =>
          p.includes("/") || p.includes("\\")
            ? [{ path: path.resolve(host.cwd, p), source: "--letta-path" }]
            : pathCandidates().filter((c) => path.basename(c.path) === p).map((c) => ({ ...c, source: "--letta-path" }))
        )
        const explicit: Array<Candidate> = [
          ...configured,
          ...(host.env["LETTA_CLI_PATH"] ? [{ path: host.env["LETTA_CLI_PATH"], source: "LETTA_CLI_PATH" }] : [])
        ]
        if (explicit.length > 0) {
          const found = yield* tryAll(explicit)
          if (Option.isSome(found)) return found.value
          if (Option.isSome(config.lettaPath)) {
            return yield* new LettaUnsupported({
              message: `The configured Letta Code executable is not usable: ${
                rejected.join("; ") || `${config.lettaPath.value} does not exist`
              }`,
              command: config.lettaPath.value
            })
          }
        }

        const found = yield* tryAll([...pathCandidates(), ...wellKnownCandidates()])
        if (Option.isSome(found)) return found.value

        const fallbacks = [...Option.toArray(yield* loginShellCandidate), ...Option.toArray(yield* npmGlobalCandidate)]
        const last = yield* tryAll(fallbacks)
        if (Option.isSome(last)) return last.value

        if (rejected.length > 0) {
          return yield* new LettaUnsupported({
            message: `Found Letta Code, but no usable version (need >= ${MINIMUM_VERSION}): ${rejected.join("; ")}. ` +
              "Upgrade with `npm install -g @letta-ai/letta-code@latest`.",
            command: rejected[0] ?? "letta"
          })
        }
        return yield* new LettaNotFound({
          message: "Letta Code is not installed. Install it with `npm install -g @letta-ai/letta-code`, " +
            "or point LACP_LETTA_PATH at the `letta` executable.",
          searched
        })
      }).pipe(
        Effect.tap((install) =>
          Effect.logInfo(
            `Using Letta Code ${install.version} at ${install.path} (found via ${install.source}), ` +
              (install.runtime === "launcher"
                ? "run as it is"
                : `run with ${install.runtime} (${install.command}): ${install.runtimeReason}`)
          )
        ),
        Effect.withSpan("LettaExecutable.resolve")
      )

      return LettaExecutable.of({ resolve: yield* Effect.cached(resolve) })
    })
  )

  static readonly layerTest = (install: LettaInstall) =>
    Layer.succeed(LettaExecutable, LettaExecutable.of({ resolve: Effect.succeed(install) }))
}

type ProbeResult =
  | { readonly _tag: "Found"; readonly install: LettaInstall }
  | { readonly _tag: "Rejected"; readonly path: string; readonly reason: string }
