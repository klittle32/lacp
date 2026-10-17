/**
 * A prompt's turn, from the input lacp sends Letta to the end the client is
 * told about. Letta reports a turn's start and end separately from its
 * acknowledgement of the input, and may run turns of its own in between
 * (earlier background work), so where a turn is decides which of Letta's
 * reports are its own.
 */
import { Data, type Deferred, type Option } from "effect"
import type { ErrorInfo, StopReason } from "../domain/Events.ts"
import type { TurnFinished } from "../letta/Protocol.ts"

export interface TurnResult {
  readonly stopReason: StopReason
  readonly error: Option.Option<ErrorInfo>
}

export type Phase = Data.TaggedEnum<{
  /**
   * Letta has not acknowledged the input yet. It may already have started the
   * turn, and a `turn_finished` that arrives meanwhile is kept (`early`):
   * once the input is acknowledged, it is the turn's if the turn had started.
   */
  Submitted: { readonly started: boolean; readonly early: Option.Option<TurnFinished> }
  /** Acknowledged, but Letta is still on earlier work, whose end is not the turn's. */
  Queued: {}
  Running: {}
  /**
   * Letta ended the turn, but background work it started is outstanding. Its
   * report comes in a follow-up turn that Letta runs on its own, which the
   * client only shows while this turn is open; `result` stands once that is
   * done. `followUp` once the follow-up streams in.
   */
  Held: { readonly result: TurnResult; readonly followUp: boolean }
}>
export const Phase = Data.taggedEnum<Phase>()

export interface Turn {
  readonly clientMessageId: string
  readonly done: Deferred.Deferred<TurnResult>
  /** Letta runs seen in the turn's stream, so a turn ended locally can disown them. */
  readonly runs: Set<string>
  /** Background subagents already running when the turn began; the turn does not wait for them. */
  readonly preexisting: ReadonlySet<string>
  phase: Phase
  /** An error Letta reported in the turn's stream, for its end. */
  error: Option.Option<string>
}

/** Whether Letta has started the turn, so that its end is the turn's end. */
export const started = (turn: Turn): boolean =>
  Phase.$match(turn.phase, {
    Submitted: (phase) => phase.started,
    Queued: () => false,
    Running: () => true,
    Held: () => true
  })

/** Letta started the turn: it dequeued or echoed the input. */
export const start = (turn: Turn): void => {
  if (turn.phase._tag === "Submitted") turn.phase = Phase.Submitted({ ...turn.phase, started: true })
  else if (turn.phase._tag === "Queued") turn.phase = Phase.Running()
}

/** Letta acknowledged the input, queued behind earlier work or not. */
export const accept = (turn: Turn, queued: boolean): void => {
  if (turn.phase._tag !== "Submitted") return
  turn.phase = turn.phase.started || !queued ? Phase.Running() : Phase.Queued()
}

/** Waiting for the turn's background work only: Letta ended it and no follow-up has started. */
export const waitingForBackground = (turn: Turn): turn is Turn & { phase: Extract<Phase, { _tag: "Held" }> } =>
  turn.phase._tag === "Held" && !turn.phase.followUp
