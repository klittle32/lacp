/**
 * The ACP client, as seen by the agent core.
 *
 * The core emits version-neutral events and asks for permission; this service
 * projects both onto whichever protocol version `initialize` negotiated.
 */
import { Context, Effect, Layer, Option, Ref } from "effect"
import * as ProjectV1 from "../acp/ProjectV1.ts"
import * as ProjectV2 from "../acp/ProjectV2.ts"
import * as V1 from "../acp/V1.ts"
import * as V2 from "../acp/V2.ts"
import type { PermissionDecision, PermissionRequest, SessionEvent } from "../domain/Events.ts"
import { JsonRpcPeer } from "../jsonrpc/Peer.ts"

export type Surface =
  | { readonly version: 1; readonly capabilities: V1.ClientCapabilities }
  | { readonly version: 2; readonly capabilities: V2.ClientCapabilities }

type Selected =
  | { readonly version: 1; readonly projector: ProjectV1.ProjectorV1 }
  | { readonly version: 2 }

export class AcpClient extends Context.Service<AcpClient, {
  /** Fixes the protocol surface after `initialize`. */
  select(surface: Surface): Effect.Effect<void>
  /** The negotiated version, if `initialize` has completed. */
  readonly version: Effect.Effect<Option.Option<1 | 2>>
  emit(sessionId: string, event: SessionEvent): Effect.Effect<void>
  requestPermission(sessionId: string, request: PermissionRequest): Effect.Effect<PermissionDecision>
}>()("lacp/agent/AcpClient") {
  static readonly layer = Layer.effect(
    AcpClient,
    Effect.gen(function*() {
      const peer = yield* JsonRpcPeer
      const selected = yield* Ref.make(Option.none<Selected>())

      const decision = (outcome: { readonly outcome: string; readonly optionId?: string }): PermissionDecision =>
        outcome.outcome === "selected" && outcome.optionId !== undefined
          ? { _tag: "Selected", optionId: outcome.optionId }
          : { _tag: "Cancelled" }

      return AcpClient.of({
        select: (surface) =>
          Ref.set(
            selected,
            Option.some<Selected>(
              surface.version === 1
                ? {
                  version: 1,
                  projector: ProjectV1.makeProjector({ notices: surface.capabilities.session?.notices != null })
                }
                : { version: 2 }
            )
          ),
        version: Ref.get(selected).pipe(Effect.map(Option.map((s) => s.version))),
        emit: Effect.fnUntraced(function*(sessionId, event) {
          const surface = yield* Ref.get(selected)
          if (Option.isNone(surface)) return
          if (surface.value.version === 1) {
            for (const update of surface.value.projector.project(sessionId, event)) {
              yield* peer.notify(V1.Update, { sessionId, update })
            }
          } else {
            for (const update of ProjectV2.project(event)) {
              yield* peer.notify(V2.Update, { sessionId, update })
            }
          }
        }),
        requestPermission: Effect.fnUntraced(function*(sessionId, request) {
          const surface = yield* Ref.get(selected)
          if (Option.isNone(surface)) return { _tag: "Cancelled" } as const
          const response = surface.value.version === 1
            ? yield* peer.request(
              V1.RequestPermission,
              ProjectV1.permissionParams(surface.value.projector, sessionId, request)
            )
            : yield* peer.request(V2.RequestPermission, ProjectV2.permissionParams(sessionId, request))
          return decision(response.outcome)
        }, (effect) =>
          effect.pipe(
            Effect.catch((error) =>
              Effect.logWarning(`session/request_permission failed: ${error.message}`).pipe(
                Effect.as<PermissionDecision>({ _tag: "Cancelled" })
              )
            )
          ))
      })
    })
  )
}
