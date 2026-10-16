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
  /** The Node executable running this program (used to run a `letta.js` path). */
  readonly execPath: string
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
        cwd: "/work",
        home: "/home/test",
        ...overrides
      })
    )
}
