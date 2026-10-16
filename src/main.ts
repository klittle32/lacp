#!/usr/bin/env node
/**
 * Entry point. stdout carries the ACP protocol, so every log line, including
 * the final failure report, goes to stderr.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Config, Effect, Layer, Logger, type LogLevel, Option, References } from "effect"
import { CliError } from "effect/cli"
import { homedir } from "node:os"
import { cli } from "./Cli.ts"
import { Host } from "./Host.ts"

const HostLive = Layer.succeed(
  Host,
  Host.of({
    env: process.env,
    platform: process.platform,
    execPath: process.execPath,
    runtime: process.versions["bun"] === undefined ? "node" : "bun",
    cwd: process.cwd(),
    home: homedir()
  })
)

/** The level names `--log-level` takes; `LACP_LOG_LEVEL` takes them in any case. */
const LOG_LEVELS: ReadonlyMap<string, LogLevel.LogLevel> = new Map([
  ["all", "All"],
  ["trace", "Trace"],
  ["debug", "Debug"],
  ["info", "Info"],
  ["warn", "Warn"],
  ["warning", "Warn"],
  ["error", "Error"],
  ["fatal", "Fatal"],
  ["none", "None"]
])

/** `LACP_LOG_LEVEL` sets the minimum log level when the `--log-level` flag is not used. */
const LogLevelLive = Layer.unwrap(
  Config.option(Config.String("LACP_LOG_LEVEL")).pipe(
    Effect.map(Option.match({
      onNone: () => Layer.empty,
      onSome: (name) => {
        const level = LOG_LEVELS.get(name.trim().toLowerCase())
        return level === undefined
          ? Layer.effectDiscard(
            Effect.logWarning(`Ignoring LACP_LOG_LEVEL=${name}; use one of ${Array.from(LOG_LEVELS.keys()).join(", ")}`)
          )
          : Layer.succeed(References.MinimumLogLevel, level)
      }
    })),
    Effect.orElseSucceed(() => Layer.empty)
  )
)

cli.pipe(
  // effect/cli already rendered CLI errors (help to stdout, errors to stderr).
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) || CliError.isCliError(Cause.squash(cause)) ? Effect.void : Effect.logError(cause)
  ),
  Effect.provide(Layer.mergeAll(NodeServices.layer, HostLive, LogLevelLive)),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
