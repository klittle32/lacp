/**
 * Smoke test against a real T3 Code. Installs a T3 Code release (the nightly by
 * default) into a cache, runs it headless with this checkout of lacp as a
 * "Local ACP command" provider, and drives T3's web UI in Chrome:
 *
 * 1. A prompt that starts a background subagent: its report must appear and
 *    the turn must end on its own.
 * 2. The same prompt, stopped while the subagent runs: the turn must end at once.
 * 3. A model request that fails once: Letta's retry must show as a readable row,
 *    not as T3's "Unsupported ACP update".
 *
 * Letta Code runs on its local backend against the scripted model in
 * test/fixtures/scripted-model.mjs, so no Letta account or model provider is
 * needed. Screenshots, lacp's log, T3's output and the T3 home land in the
 * output directory printed at the end.
 *
 *   npm run smoke:t3
 *
 * Environment (all optional):
 * - T3_SMOKE_VERSION: version or npm tag of `t3` (default `nightly`)
 * - T3_SMOKE_BROWSER: a Chrome or Chromium executable (default: the installed Google Chrome)
 * - T3_SMOKE_CACHE: where T3 Code releases are kept (default ~/.cache/lacp/t3-smoke)
 * - T3_SMOKE_OUT: the output directory (default: a new temporary directory)
 * - T3_SMOKE_PORT: T3's port (default 3799)
 * - LACP_LETTA_PATH, LACP_LETTA_RUNTIME: passed on to lacp
 *
 * macOS and Linux.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
  Clock,
  Config,
  Console,
  Deferred,
  type Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
  Stream
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "playwright-core"

class SmokeFailed extends Schema.TaggedError<SmokeFailed, { readonly brand: unique symbol }>()("SmokeFailed", {
  step: Schema.String,
  message: Schema.String
}) {}

const fail = (step: string) => (cause: unknown) => new SmokeFailed({ step, message: String(cause) })

/** The provider's display name in T3. */
const PROVIDER = "lacp smoke"
const SPAWN_WORKER = "SPAWN_WORKER and list the directory"
const FAIL_ONCE = "FAIL_ONCE and say hello"
/** How long the scripted subagent works: long enough to stop it, like a real worker. */
const WORKER_MS = 8000

const repo = fileURLToPath(new URL("..", import.meta.url))
const node = process.execPath

const SmokeConfig = Config.all({
  version: Config.String("T3_SMOKE_VERSION").pipe(Config.withDefault("nightly")),
  browser: Config.option(Config.String("T3_SMOKE_BROWSER")),
  cache: Config.String("T3_SMOKE_CACHE").pipe(Config.withDefault(`${homedir()}/.cache/lacp/t3-smoke`)),
  out: Config.option(Config.String("T3_SMOKE_OUT")),
  port: Config.Port("T3_SMOKE_PORT").pipe(Config.withDefault(3799)),
  lettaPath: Config.option(Config.String("LACP_LETTA_PATH")),
  lettaRuntime: Config.option(Config.String("LACP_LETTA_RUNTIME"))
})
type SmokeConfig = Config.Success<typeof SmokeConfig>

// --- processes ----------------------------------------------------------------

/** Runs a command to completion and returns its output; a non-zero exit fails the step. */
const run = (step: string, command: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, { env, extendEnv: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    )
    const [output, code] = yield* Effect.all([handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], {
      concurrency: 2
    })
    if (code !== 0) {
      return yield* new SmokeFailed({ step, message: `${command} exited with ${code}:\n${output.slice(-2000)}` })
    }
    return output
  }).pipe(Effect.scoped, Effect.catchTag("PlatformError", (error) => Effect.fail(fail(step)(error))))

/**
 * Starts a process for the rest of the scope, copies its output to
 * `<out>/<name>.log`, and returns the first capture of `ready` in its output.
 */
const startService = Effect.fnUntraced(function*(options: {
  readonly name: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Record<string, string>
  readonly cwd: string
  readonly ready: RegExp
  readonly out: string
}) {
  const step = `start ${options.name}`
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const log = yield* fs.open(path.join(options.out, `${options.name}.log`), { flag: "a" })
  const handle = yield* spawner.spawn(
    ChildProcess.make(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: "5 seconds"
    })
  )
  const ready = yield* Deferred.make<string>()
  const encoder = new TextEncoder()
  yield* handle.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      log.writeAll(encoder.encode(`${line}\n`)).pipe(
        Effect.andThen(Option.match(Option.fromNullishOr(options.ready.exec(line)?.[1]), {
          onNone: () => Effect.void,
          onSome: (value) => Deferred.succeed(ready, value)
        }))
      )
    ),
    Effect.ignore,
    Effect.forkScoped
  )
  const exited = handle.exitCode.pipe(
    Effect.flatMap((code) =>
      new SmokeFailed({ step, message: `${options.name} exited with ${code}; see ${options.name}.log` })
    )
  )
  return yield* Deferred.await(ready).pipe(
    Effect.raceFirst(exited),
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () => new SmokeFailed({ step, message: `${options.name} did not start; see ${options.name}.log` })
    })
  )
}, Effect.catchTag("PlatformError", (error) => Effect.fail(fail("start a process")(error))))

// --- T3 Code ------------------------------------------------------------------

/** Installs the T3 Code release once per version, and returns it. */
const installT3 = Effect.fnUntraced(function*(config: SmokeConfig) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const version = /^\d+\.\d+\.\d+/.test(config.version)
    ? config.version
    : (yield* run("resolve the T3 Code version", "npm", ["view", `t3@${config.version}`, "version"])).trim()
  const home = path.join(config.cache, "home")
  const binary = path.join(home, "runtime", "versions", version, "t3")
  if (!(yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false)))) {
    yield* Console.log(`Installing T3 Code ${version} into ${config.cache}…`)
    const prefix = path.join(config.cache, "npm", version)
    yield* run("install T3 Code", "npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", `t3@${version}`])
    yield* run("download T3 Code", node, [path.join(prefix, "node_modules", "t3", "bin", "t3.mjs"), "--version"], {
      T3CODE_HOME: home
    })
  }
  return { version, binary }
})

/** T3's settings: this checkout of lacp as a Local ACP command, on Letta's local backend and the scripted model. */
const t3Settings = (options: {
  readonly config: SmokeConfig
  readonly modelUrl: string
  readonly lettaHome: string
  readonly logFile: string
}) => {
  const passOn = (name: string, value: Option.Option<string>) =>
    Option.match(value, {
      onNone: () => ({}),
      onSome: (value) => ({ [name]: value })
    })
  const environment = {
    LACP_AUTH: "local",
    LACP_MODEL: "lmstudio/mock-model",
    LACP_PERMISSION_MODE: "unrestricted",
    LACP_LOG_FILE: options.logFile,
    LACP_LOG_LEVEL: "trace",
    LMSTUDIO_BASE_URL: options.modelUrl,
    LETTA_BASE_URL: "http://127.0.0.1:9",
    HOME: options.lettaHome,
    DISABLE_AUTOUPDATER: "1",
    LETTA_CODE_TELEM: "0",
    DO_NOT_TRACK: "1",
    ...passOn("LACP_LETTA_PATH", options.config.lettaPath),
    ...passOn("LACP_LETTA_RUNTIME", options.config.lettaRuntime)
  }
  return {
    providerInstances: {
      lacpsmoke: {
        driver: "acpRegistry",
        displayName: PROVIDER,
        enabled: true,
        environment: Object.entries(environment).map(([name, value]) => ({ name, value, sensitive: false })),
        config: {
          source: "local",
          commandPath: node,
          commandArgs: [`${repo}src/main.ts`],
          authMethodId: "",
          customModels: []
        }
      }
    }
  }
}

// --- the browser ----------------------------------------------------------------

/** One step in the browser. */
const ui = <A>(step: string, action: () => Promise<A>) => Effect.tryPromise({ try: action, catch: fail(step) })

const launchBrowser = (executable: Option.Option<string>) =>
  Effect.acquireRelease(
    ui(
      "launch Chrome (set T3_SMOKE_BROWSER to a Chrome or Chromium executable)",
      () =>
        chromium.launch(Option.match(executable, {
          onNone: () => ({ channel: "chrome" }),
          onSome: (executablePath) => ({ executablePath })
        }))
    ),
    (browser) => Effect.promise(() => browser.close())
  )

const screenshot = (page: Page, file: string) => ui(`save ${file}`, () => page.screenshot({ path: file }))

const threadText = (page: Page) => ui("read the thread", () => page.locator("main").innerText())

/** Waits until the thread's text satisfies `done`. */
const waitForThread = (page: Page, step: string, done: (text: string) => boolean, timeout: Duration.Input) =>
  threadText(page).pipe(
    Effect.repeat({ schedule: Schedule.spaced("500 millis"), until: done }),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        threadText(page).pipe(
          Effect.flatMap((text) =>
            new SmokeFailed({ step, message: `timed out; the thread shows: ${text.replace(/\s+/g, " ").slice(-500)}` })
          )
        )
    })
  )

/** Pairs the browser with the server. */
const pair = (page: Page, pairingUrl: string) =>
  ui("pair with T3 Code", async () => {
    await page.goto(pairingUrl)
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 })
  })

/** One step of T3's first-run setup: skip importing projects, or continue. */
const setupStep = (page: Page) =>
  ui("finish T3's first-run setup", async () => {
    const skipImport = page.getByRole("button", { name: "Do not import projects" })
    const next = (await skipImport.isVisible())
      ? skipImport
      : page.getByRole("button", { name: "Continue", exact: true }).first()
    await next.click()
  })

/** Steps through T3's first-run setup until it is done. */
const finishSetup = (page: Page) =>
  Effect.suspend(() =>
    page.url().includes("/welcome")
      ? setupStep(page).pipe(Effect.andThen(Effect.sleep("1500 millis")), Effect.as(true))
      : Effect.succeed(false)
  ).pipe(Effect.repeat({ while: (pending) => pending, times: 10 }))

/** Opens T3; a navigation of T3's own (after its setup, say) can interrupt the first try. */
const openT3 = (page: Page, base: string) =>
  ui("open T3 Code", () => page.goto(base)).pipe(Effect.retry({ times: 3, schedule: Schedule.spaced("1 second") }))

/** Opens a new thread on the lacp provider with the scripted model and sends `prompt`. */
const startThread = (page: Page, base: string, prompt: string) =>
  openT3(page, base).pipe(Effect.andThen(ui("start a thread on lacp with the scripted model", async () => {
    const newThread = page.locator("[aria-label=\"New thread\"]")
    if ((await newThread.count()) > 0) await newThread.first().click()
    await page.locator("[data-chat-provider-model-picker]").first().click()
    await page.locator(`[aria-label^="${PROVIDER}"]`).first().click()
    await page.getByPlaceholder("Search models...").fill("mock-model")
    // lacp starts Letta Code before T3 lists its models.
    await page.locator("[role=option]").filter({ hasText: "mock-model" }).filter({ hasText: PROVIDER }).first()
      .click({ timeout: 120_000 })
    await page.locator("[data-testid=\"composer-editor\"]").first().click()
    await page.keyboard.type(prompt)
    await page.keyboard.press("Enter")
  })))

const seconds = (since: number) => Clock.currentTimeMillis.pipe(Effect.map((now) => (now - since) / 1000))

/** The subagent's report appears, and the turn ends on its own. */
const reportCheck = Effect.fnUntraced(function*(page: Page, base: string, out: string) {
  const path = yield* Path.Path
  yield* startThread(page, base, SPAWN_WORKER)
  const sent = yield* Clock.currentTimeMillis
  const text = yield* waitForThread(
    page,
    "the report appears and the turn ends on its own",
    (text) => /Worked for/.test(text),
    "3 minutes"
  )
  const took = yield* seconds(sent)
  yield* screenshot(page, path.join(out, "1-report.png"))
  if (!text.includes("Here is the listing")) {
    return yield* new SmokeFailed({ step: "the report appears", message: "the turn ended without the report" })
  }
  return `the report was shown and the turn ended on its own, ${took.toFixed(1)} s after the prompt`
})

/** Stopping a turn that waits for its subagent ends it at once. */
const stopCheck = Effect.fnUntraced(function*(page: Page, base: string, out: string) {
  const path = yield* Path.Path
  yield* startThread(page, base, SPAWN_WORKER)
  // The subagent's tool call shows once it has started; the turn then waits for its report.
  yield* waitForThread(page, "the subagent starts", (text) => /List directory|Tool/.test(text), "3 minutes")
  yield* Effect.sleep("2 seconds")
  const stopped = yield* Clock.currentTimeMillis
  yield* ui("press Stop", () => page.locator("button[aria-label=\"Stop generation\"]").first().click())
  yield* waitForThread(page, "Stop ends the turn", (text) => text.includes("Run interrupted"), "5 seconds")
  const took = yield* seconds(stopped)
  yield* screenshot(page, path.join(out, "2-stop.png"))
  return `Stop ended the waiting turn after ${took.toFixed(1)} s`
})

/** A retried model request shows as a row with its own text in the turn's work log. */
const retryCheck = Effect.fnUntraced(function*(page: Page, base: string, out: string) {
  const path = yield* Path.Path
  yield* startThread(page, base, FAIL_ONCE)
  yield* waitForThread(
    page,
    "the retried request answers",
    (text) => /Worked for/.test(text) && text.includes("Recovered after a retry"),
    "3 minutes"
  )
  yield* ui("open the work log", () => page.getByText(/^Worked for/).first().click())
  const text = yield* waitForThread(
    page,
    "the retry shows in the work log",
    (text) => /Retrying/.test(text),
    "5 seconds"
  )
  yield* screenshot(page, path.join(out, "3-retry.png"))
  if (text.includes("Unsupported ACP update")) {
    return yield* new SmokeFailed({ step: "the retry shows", message: "T3 shows an \"Unsupported ACP update\" row" })
  }
  return `the retry showed as "${/Retrying[^\n]*/.exec(text)?.[0].trim()}"`
})

// --- main ------------------------------------------------------------------------

const smoke = Effect.gen(function*() {
  const config = yield* SmokeConfig
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const out = yield* Option.match(config.out, {
    onNone: () => fs.makeTempDirectory({ prefix: "lacp-t3-smoke-" }),
    onSome: (dir) => fs.makeDirectory(dir, { recursive: true }).pipe(Effect.as(dir))
  })
  const t3Home = path.join(out, "t3-home")
  const lettaHome = path.join(out, "letta-home")
  const project = path.join(out, "project")
  for (const dir of [path.join(t3Home, "userdata"), lettaHome, project]) {
    yield* fs.makeDirectory(dir, { recursive: true })
  }
  yield* fs.writeFileString(path.join(project, "README.md"), "A project for the lacp smoke test.\n")

  const t3 = yield* installT3(config)
  yield* Console.log(`T3 Code ${t3.version}, lacp from ${repo}`)
  yield* Console.log(`Output: ${out}`)

  const modelPort = yield* startService({
    name: "model",
    command: node,
    args: [path.join(repo, "test", "fixtures", "scripted-model.mjs")],
    env: { SCRIPTED_MODEL_WORKER_MS: String(WORKER_MS) },
    cwd: out,
    ready: /^(\d+)$/,
    out
  })
  const settings = t3Settings({
    config,
    modelUrl: `http://127.0.0.1:${modelPort}/v1`,
    lettaHome,
    logFile: path.join(out, "lacp.log")
  })
  yield* fs.writeFileString(path.join(t3Home, "userdata", "settings.json"), JSON.stringify(settings, null, 2))

  const t3Env = { T3CODE_HOME: t3Home, T3CODE_TELEMETRY_ENABLED: "false" }
  const pairingUrl = yield* startService({
    name: "t3",
    command: t3.binary,
    args: ["serve", "--port", String(config.port), "--host", "127.0.0.1", project],
    env: t3Env,
    cwd: project,
    ready: /Pairing URL: (\S+)/,
    out
  })
  yield* run("add the project to T3 Code", t3.binary, ["project", "add", "--title", "lacp-smoke", project], t3Env)

  const browser = yield* launchBrowser(config.browser)
  const page = yield* ui("open a page", () => browser.newPage({ viewport: { width: 1400, height: 900 } }))
  const base = `http://127.0.0.1:${config.port}/`
  const results = yield* Effect.gen(function*() {
    yield* pair(page, pairingUrl)
    yield* finishSetup(page)
    return [yield* reportCheck(page, base, out), yield* stopCheck(page, base, out), yield* retryCheck(page, base, out)]
  }).pipe(Effect.tapError(() => screenshot(page, path.join(out, "failure.png")).pipe(Effect.ignore)))
  for (const result of results) yield* Console.log(`✓ ${result}`)
  yield* Console.log(`Screenshots, lacp.log, t3.log and model.log are in ${out}`)
}).pipe(
  Effect.scoped,
  Effect.tapError((error) =>
    Console.error(error._tag === "SmokeFailed" ? `✗ ${error.step}: ${error.message}` : `✗ ${String(error)}`)
  )
)

smoke.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain({ disableErrorReporting: true }))
