# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

`lacp` is an Agent Client Protocol (ACP) server for Letta Code, written as a pure **Effect v4** TypeScript
program. It drives the host's own `letta` install as an App Server and serves ACP v1 and v2 over stdio. Read
`README.md` for the user-facing picture and `docs/architecture.md` for the module map.

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md` **completely**, and follow the links
in the file when required.

If you need to learn more about particular Effect APIs and concepts that the guide doesn't cover, search through
the source code in `node_modules/effect/src`. Prefer the installed `.d.ts` files and `node_modules/effect/ai-docs/src/`
over memory or web pages — Effect v4 renamed much of v3.

Project skills installed from `Effect-TS/skills` live in `.agents/skills/` (`effect-ts`, and `effect-v3-to-v4` for a
v3 migration only). Refresh them with `npx skills add Effect-TS/skills -y --skill '*' --copy`.

## Effect

Write Effect. Plain TypeScript side effects are lint errors (`npm run lint` fails on them, including warnings).

| Plain TypeScript                                                         | Effect v4                                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `try` / `catch`                                                          | `Effect.try`, `Effect.tryPromise`, `Effect.catch`, `Effect.catchTag`                                                            |
| `throw`                                                                  | `yield*` a `Schema.TaggedError`, or `Effect.fail`. `Effect.die` is a defect                                                     |
| `async` / `Promise`                                                      | `Effect.gen`, `Effect.fn` / `Effect.fnUntraced`, `Effect.promise`, `Effect.tryPromise`                                          |
| `fetch`                                                                  | `HttpClient` from `effect/http`, provided with `FetchHttpClient.layer`                                                          |
| `console.*`                                                              | `Effect.log`, `Effect.logInfo`, `Effect.logWarning`, `Effect.logError`, `Effect.logDebug`, `Effect.logTrace`, `Effect.logFatal` |
| `process.env`                                                            | `Config.String`, `Config.option`, `Config.all`, `Config.withDefault`                                                            |
| `setTimeout` / `setInterval`                                             | `Effect.sleep`, `Schedule`                                                                                                      |
| `Date.now()` / `new Date()`                                              | `Clock.currentTimeMillis`, `DateTime.now`, `DateTime.nowInCurrentZone`                                                          |
| `Math.random()`                                                          | `Random.next`, `Random.nextInt`, `Random.nextIntBetween`                                                                        |
| `crypto.randomUUID()`                                                    | `SecureRandom` from `effect/crypto` (`uuidV4`)                                                                                  |
| `JSON.parse` / `JSON.stringify`                                          | `Schema.fromJsonString`, `Schema.decodeUnknownEffect` / `Schema.decodeSync`, `Schema.encodeEffect`, `Schema.toCodecJson`        |
| `node:fs`, `node:path`, `node:child_process`, `node:crypto`, `node:http` | `FileSystem`, `Path`, `ChildProcess` / `ChildProcessSpawner` (`effect/process`), `effect/crypto`, `HttpClient`                  |

Oxlint enforces these as errors under the `effecttsgo/` rules `global-fetch`, `global-console`, `global-date`,
`global-random`, `global-timers`, `global-json`, `process-env`, `node-builtin-import`, `async-function`,
`new-promise`, `crypto-random-uuid`, `extends-native-error`, and `try-catch-in-effect-gen`, including each
`*-in-effect` pair. Do not copy the same bans into `tsconfig.json`; `npm run check` already runs the language
service, and `npm run diagnostics` repeats that pass. It does not see these oxlint rules.

Other v4 names: `Context.Service` (not `Context.Tag` / `Effect.Service`), `Layer.effect` (also for scoped layers),
`Schema.TaggedError<Self, { readonly brand: unique symbol }>()(...)`, `Effect.catch`, `Effect.forkChild`,
`Result`, modules `effect/cli`, `effect/process`, `effect/socket`, `effect/encoding` (no `effect/unstable/*`).

Services are classes with `static readonly layer`; build implementations with `Self.of({...})` and methods with
`Effect.fn("Service.method")`. Provide layers once, at the entry point (`src/Cli.ts`).

Model and decode every IO boundary with `Schema` (ACP messages, App Server frames, settings files). Use
`Predicate` / `Match` / `Option`, not hand-written guards.

**stdout is the ACP channel.** Never write to it except through `Transport`. Use `Effect.log*` (routed to stderr);
never `console.*`.

`src/main.ts` captures the `process.env` object once into `Host`. That is the process boundary. Everywhere else,
read configuration with `Config` or the `Host` service.

Two files keep a Node API because the oxlint replacement does not do the job. The overrides are in `.oxlintrc.json`:

- `test/helpers/E2eProcess.ts` spawns the real `letta` binary and the scripted model with `node:child_process`.
- `test/helpers/McpHttpServer.ts` is an in-process HTTP server. The `node:http` rule points at `HttpClient`, which
  does not serve.

Do not widen those overrides. Do not add another one without a reason written next to it in this file.

## Commands

```sh
npm install        # also patches tsc with the Effect Language Service (effect-tsgo patch)
npm run check      # tsc (TypeScript 7) with Effect diagnostics
npm run lint       # oxlint (Effect rules, warnings are errors) + dprint + suppression check
npm run lint-fix   # oxlint --fix + dprint fmt
npm test           # vitest
npm run verify     # check, lint, test, and build
LACP_E2E_LETTA="$(command -v letta)" npm test   # also run end-to-end tests against a real Letta Code
npm run smoke:t3   # drive this checkout in a real T3 Code nightly (Chrome; see scripts/t3-smoke.ts)
```

A task is not done until `npm run verify` passes.

## Suppressions

Do not add `oxlint-disable`, `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, or
`@effect-diagnostics` comments without a reason on that same comment, and never to silence the Effect-native rules
above. A boundary is a scoped `.oxlintrc.json` override, with the reason recorded in this file.

- Oxlint, ESLint, and `@effect-diagnostics` directives need `--` and a reason (`// oxlint-disable-next-line no-console -- scratch log`).
- `@ts-expect-error`, `@ts-ignore`, and `@ts-nocheck` need a reason after the directive (`// @ts-expect-error the fixture is partial`).

`npm run lint` runs `scripts/check-suppressions.ts`, which fails the build when a comment breaks these rules.

## Conventions

- ACP version-specific code lives only in `src/acp/V1.ts`, `src/acp/V2.ts`, `src/acp/Project*.ts` and the handler
  sets in `src/agent/AcpServer.ts`. The core (`src/agent/Agent.ts`) speaks `src/domain/Events.ts` only.
- Letta App Server protocol knowledge lives in `src/letta/`. Decode leniently: Letta Code ships often.
- Tests use `@effect/vitest` (`it.effect`, `it.live`). Prefer driving behaviour through `test/helpers/FakeLetta.ts`
  and `test/helpers/AcpClient.ts` over mocking internals.
