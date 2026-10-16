/**
 * The host process environment, as a service.
 *
 * Captured once at the entry point so the rest of the program never touches
 * `process` globals directly, and so tests can describe any host they like.
 */
import { Context, Layer } from "effect"

export interface HostShape {
  /** The full environment the agent server was launched with. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: string
  /** The executable running this program (Node or Bun). */
  readonly execPath: string
  /** Which runtime `execPath` is. */
  readonly runtime: "node" | "bun"
  readonly cwd: string
  readonly home: string
}

export class Host extends Context.Service<Host, HostShape>()("lacp/Host") {
  static readonly layerTest = (overrides: Partial<HostShape> = {}) =>
    Layer.succeed(
      Host,
      Host.of({
        env: {},
        platform: "linux",
        execPath: "/usr/bin/node",
        runtime: "node",
        cwd: "/work",
        home: "/home/test",
        ...overrides
      })
    )
}
