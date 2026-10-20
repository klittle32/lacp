# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

`lacp` is an Agent Client Protocol (ACP) server for Letta Code, written as a pure **Effect v4** TypeScript
program. It drives the host's own `letta` install as an App Server and serves ACP v1 and v2 over stdio. Read
`README.md` for the user-facing picture and `docs/architecture.md` for the module map.

## Effect

- The authoritative Effect documentation is shipped with the package: read `node_modules/effect/AGENTS.md` and the
  examples in `node_modules/effect/ai-docs/src/`. Prefer them (and the installed `.d.ts` files) over memory or web
  pages — Effect v4 renamed much of v3.
- v4 names: `Context.Service` (not `Context.Tag`/`Effect.Service`), `Layer.effect` (also for scoped layers),
  `Schema.TaggedError<Self, { readonly brand: unique symbol }>()(...)`, `Effect.catch`, `Effect.forkChild`,
  `Result`, modules `effect/cli`, `effect/process`, `effect/socket`, `effect/encoding` (no `effect/unstable/*`).
- Services are classes with `static readonly layer`; build implementations with `Self.of({...})` and methods with
  `Effect.fn("Service.method")`. Provide layers once, at the entry point (`src/Cli.ts`).
- Model and decode every IO boundary with `Schema` (ACP messages, App Server frames, settings files). Use
  `Predicate`/`Match`/`Option`, not hand-written guards.
- **stdout is the ACP channel.** Never write to it except through `Transport`. Use `Effect.log*` (routed to stderr);
  never `console.*`.

## Commands

```sh
npm install        # also patches tsc with the Effect Language Service (effect-tsgo patch)
npm run check      # tsc (TypeScript 7) with Effect diagnostics
npm run lint       # oxlint (Effect presets) + dprint check
npm run lint-fix   # oxlint --fix + dprint fmt
npm test           # vitest
LACP_E2E_LETTA="$(command -v letta)" npm test   # also run end-to-end tests against a real Letta Code
npm run smoke:t3   # drive this checkout in a real T3 Code nightly (Chrome; see scripts/t3-smoke.ts)
```

Run `npm run check && npm run lint && npm test` before committing.

## Conventions

- ACP version-specific code lives only in `src/acp/V1.ts`, `src/acp/V2.ts`, `src/acp/Project*.ts` and the handler
  sets in `src/agent/AcpServer.ts`. The core (`src/agent/Agent.ts`) speaks `src/domain/Events.ts` only.
- Letta App Server protocol knowledge lives in `src/letta/`. Decode leniently: Letta Code ships often.
- Tests use `@effect/vitest` (`it.effect`, `it.live`). Prefer driving behaviour through `test/helpers/FakeLetta.ts`
  and `test/helpers/AcpClient.ts` over mocking internals.
