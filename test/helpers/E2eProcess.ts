/**
 * Process boundary for the Letta end-to-end harness.
 *
 * `node:child_process` stays here on purpose. The suite spawns the real `letta`
 * binary and a one-shot model fixture whose first stdout chunk is its port.
 * `effecttsgo/node-builtin-import` maps the module to `ChildProcess`; that
 * client does not cover this handshake. See the override in `.oxlintrc.json`.
 */
import { assert } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { spawn, spawnSync } from "node:child_process"

const CreatedAgent = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))

export const bunAvailable = spawnSync("bun", ["--version"]).status === 0

/** Letta's offline deterministic backend, or a model endpoint on the local backend. */
export type Backend = { readonly _tag: "Deterministic" } | { readonly _tag: "Model"; readonly lmStudioUrl: string }

/** Serves the scripted model and returns its base URL. */
export const serveScriptedModel = (script: string) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly kill: () => void }>((resume) => {
      const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] })
      child.stdout.once(
        "data",
        (port) =>
          resume(Effect.succeed({ url: `http://127.0.0.1:${String(port).trim()}/v1`, kill: () => child.kill() }))
      )
    }),
    (model) => Effect.sync(model.kill)
  ).pipe(Effect.map((model) => model.url))

/** Makes an agent with `letta` itself, as a user would: lacp never creates them. */
export const createAgent = (letta: string | undefined, env: Record<string, string>, cwd: string, backend: Backend) => {
  const made = spawnSync(letta ?? "letta", [
    "--backend",
    "local",
    "agents",
    "create",
    "--name",
    "lacp-e2e",
    ...(backend._tag === "Model" ? ["--model", "lmstudio/mock-model"] : [])
  ], { cwd, env, encoding: "utf8" })
  assert.strictEqual(made.status, 0, made.stderr)
  return Schema.decodeSync(CreatedAgent)(made.stdout).id
}
