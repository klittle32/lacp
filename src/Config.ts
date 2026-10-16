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
  /** Connect to an already-running App Server instead of spawning one. */
  readonly appServerUrl: Option.Option<string>
  readonly maxAcpVersion: 1 | 2
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
    appServerUrl: Option.none(),
    maxAcpVersion: 2,
    startupTimeout: Duration.seconds(60)
  }

  static readonly layerTest = (overrides: Partial<LacpConfigShape> = {}) =>
    Layer.succeed(LacpConfig, LacpConfig.of({ ...LacpConfig.defaults, ...overrides }))
}
