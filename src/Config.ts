/**
 * Runtime configuration for the agent server.
 *
 * Values come from CLI flags, falling back to environment variables, so an
 * editor can configure the server either way (see `Cli.ts`).
 */
import { Context, Duration, Layer, Option, type Redacted, Schema } from "effect"
import type { PermissionMode } from "./letta/Protocol.ts"

/**
 * How the spawned Letta Code App Server authenticates.
 *
 * - `host`: whatever the host's Letta Code install is configured to use (default).
 * - `cloud-oauth`: Letta Cloud with the OAuth login stored by `letta setup`.
 * - `api-key`: Letta Cloud (or a self-hosted server) with `LETTA_API_KEY`.
 * - `local`: Letta Code's on-device backend.
 */
export const AuthMode = Schema.Literals(["host", "cloud-oauth", "api-key", "local"])
export type AuthMode = typeof AuthMode.Type

/**
 * Which JavaScript runtime runs Letta Code.
 *
 * It matters because Letta Code keeps its Letta Cloud login in the system
 * keychain only when it runs under Bun (`Bun.secrets`); under Node it uses
 * `~/.letta/settings.json`. Bun also moves a login it finds in that file into
 * the keychain. `auto` therefore follows the login: Node while the settings
 * file holds it, otherwise Bun when it is installed.
 */
export const LettaRuntime = Schema.Literals(["auto", "node", "bun"])
export type LettaRuntime = typeof LettaRuntime.Type

/** The highest ACP protocol version this server will negotiate. */
export const AcpVersion = Schema.Literals(["1", "2"])
export type AcpVersion = typeof AcpVersion.Type

export interface LacpConfigShape {
  readonly auth: AuthMode
  readonly apiKey: Option.Option<Redacted.Redacted>
  /** Letta agent to talk to; when absent the host's last-used agent is reused. */
  readonly agentId: Option.Option<string>
  /** Model handle applied to new sessions, e.g. `anthropic/claude-sonnet-4-5`. */
  readonly model: Option.Option<string>
  /** Initial permission mode; when absent the host's configured mode is used. */
  readonly permissionMode: Option.Option<PermissionMode>
  /** Explicit `letta` executable, bypassing discovery. */
  readonly lettaPath: Option.Option<string>
  /** The runtime for Letta Code's `letta.js`. */
  readonly lettaRuntime: LettaRuntime
  /** Connect to an already-running App Server instead of spawning one. */
  readonly appServerUrl: Option.Option<string>
  readonly maxAcpVersion: 1 | 2
  /** How long a cancelled turn waits for Letta to report its end before lacp ends it. */
  readonly cancelGrace: Duration.Duration
  /**
   * Keep a turn open while background subagents it started are still running,
   * so their results, which Letta delivers in a follow-up turn, appear in it.
   * Clients such as T3 Code do not show a turn the agent starts on its own.
   */
  readonly waitForBackground: boolean
  /** How long a turn whose background work finished waits for the follow-up turn to start. */
  readonly backgroundGrace: Duration.Duration
  /**
   * ACP v2: send each prompt back to the client as a `user_message`. Off by
   * default: T3 Code renders the echo as a second message, including the
   * instructions it adds to prompts.
   */
  readonly echoPrompts: boolean
  readonly startupTimeout: Duration.Duration
}

export class LacpConfig extends Context.Service<LacpConfig, LacpConfigShape>()("lacp/Config") {
  static readonly defaults: LacpConfigShape = {
    auth: "host",
    apiKey: Option.none(),
    agentId: Option.none(),
    model: Option.none(),
    permissionMode: Option.none(),
    lettaPath: Option.none(),
    lettaRuntime: "auto",
    appServerUrl: Option.none(),
    maxAcpVersion: 2,
    cancelGrace: Duration.seconds(15),
    waitForBackground: true,
    backgroundGrace: Duration.seconds(20),
    echoPrompts: false,
    startupTimeout: Duration.seconds(60)
  }

  static readonly layerTest = (overrides: Partial<LacpConfigShape> = {}) =>
    Layer.succeed(LacpConfig, LacpConfig.of({ ...LacpConfig.defaults, ...overrides }))
}
