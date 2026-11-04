export interface SlipProblem {
  readonly line: number
  readonly message: string
}

/** Stub. The regression tests name the bypasses this must report. */
export const slipProblems = (_source: string, _file: string): ReadonlyArray<SlipProblem> => []
