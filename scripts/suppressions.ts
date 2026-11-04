/**
 * Suppression comments must say why they exist. Inline comments also may not
 * silence the Effect-native rules: those boundaries belong in `.oxlintrc.json`.
 */

// A directive counts only at the start of a comment line, so mentioning one in prose is fine.
const DIRECTIVE =
  /(?:^|\n)\s*(?:\*\s*)?(oxlint-disable(?:-next-line|-line)?|eslint-disable(?:-next-line|-line)?|@effect-diagnostics(?:-next-line)?|@ts-expect-error|@ts-ignore|@ts-nocheck)/g

/** Oxlint rule ids that must be scoped in `.oxlintrc.json`, not silenced inline. */
const GUARDED_RULES = [
  "effecttsgo/async-function",
  "effecttsgo/crypto-random-uuid-in-effect",
  "effecttsgo/crypto-random-uuid",
  "effecttsgo/extends-native-error",
  "effecttsgo/global-console-in-effect",
  "effecttsgo/global-console",
  "effecttsgo/global-date-in-effect",
  "effecttsgo/global-date",
  "effecttsgo/global-fetch-in-effect",
  "effecttsgo/global-fetch",
  "effecttsgo/global-json-in-effect",
  "effecttsgo/global-json",
  "effecttsgo/global-random-in-effect",
  "effecttsgo/global-random",
  "effecttsgo/global-timers-in-effect",
  "effecttsgo/global-timers",
  "effecttsgo/new-promise",
  "effecttsgo/node-builtin-import",
  "effecttsgo/process-env-in-effect",
  "effecttsgo/process-env",
  "effecttsgo/try-catch-in-effect-gen"
]

/** Language-service diagnostic names for the same rules. */
const GUARDED_DIAGNOSTICS = [
  "asyncFunction",
  "cryptoRandomUUIDInEffect",
  "cryptoRandomUUID",
  "extendsNativeError",
  "globalConsoleInEffect",
  "globalConsole",
  "globalDateInEffect",
  "globalDate",
  "globalFetchInEffect",
  "globalFetch",
  "globalJsonInEffect",
  "globalJson",
  "globalRandomInEffect",
  "globalRandom",
  "globalTimersInEffect",
  "globalTimers",
  "newPromise",
  "nodeBuiltinImport",
  "processEnvInEffect",
  "processEnv",
  "tryCatchInEffectGen"
]

export interface SuppressionProblem {
  readonly line: number
  readonly message: string
}

interface CommentSpan {
  readonly line: number
  readonly text: string
}

/** Comment texts, with strings and template literals left alone. */
export const commentSpans = (source: string): Array<CommentSpan> => {
  const found: Array<CommentSpan> = []
  let line = 1
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code"
  let buffer = ""
  let bufferLine = 1
  let i = 0

  const push = () => {
    found.push({ line: bufferLine, text: buffer })
    buffer = ""
  }

  while (i < source.length) {
    const char = source[i]!
    const next = source[i + 1]
    if (char === "\n") line++

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line"
        buffer = ""
        bufferLine = line
        i += 2
        continue
      }
      if (char === "/" && next === "*") {
        state = "block"
        buffer = ""
        bufferLine = line
        i += 2
        continue
      }
      if (char === "'") state = "single"
      else if (char === "\"") state = "double"
      else if (char === "`") state = "template"
      i++
      continue
    }

    if (state === "line") {
      if (char === "\n") {
        push()
        state = "code"
      } else buffer += char
      i++
      continue
    }

    if (state === "block") {
      if (char === "*" && next === "/") {
        push()
        state = "code"
        i += 2
        continue
      }
      buffer += char
      i++
      continue
    }

    if (char === "\\") {
      i += 2
      continue
    }
    if (
      (state === "single" && char === "'") || (state === "double" && char === "\"") ||
      (state === "template" && char === "`")
    ) state = "code"
    i++
  }

  if (state === "line" && buffer !== "") push()
  return found
}

const hasReason = (text: string) => /[A-Za-z]{3,}/.test(text)

const mentionsGuarded = (rules: string) =>
  GUARDED_RULES.some((rule) => rules.includes(rule)) ||
  GUARDED_DIAGNOSTICS.some((name) => new RegExp(`\\b${name}\\b`).test(rules))

/** Problems in `source`, using 1-based line numbers. */
export const suppressionProblems = (source: string): Array<SuppressionProblem> => {
  const problems: Array<SuppressionProblem> = []
  for (const comment of commentSpans(source)) {
    for (const match of comment.text.matchAll(DIRECTIVE)) {
      const directive = match[1] ?? ""
      const body = comment.text.slice((match.index ?? 0) + match[0].length)
      const typescriptDirective = directive.startsWith("@ts-")
      const dash = typescriptDirective ? -1 : body.indexOf("--")
      const rules = dash === -1 ? body : body.slice(0, dash)
      const reason = typescriptDirective ? body.replace(/^[\s:]+/, "") : dash === -1 ? "" : body.slice(dash + 2)

      if (!typescriptDirective && mentionsGuarded(rules)) {
        problems.push({
          line: comment.line,
          message:
            `${directive} silences an Effect-native rule. State the boundary in a scoped .oxlintrc.json override instead`
        })
        continue
      }
      if (!hasReason(reason)) {
        problems.push({
          line: comment.line,
          message: typescriptDirective
            ? `${directive} needs a reason after the directive`
            : `${directive} needs a reason after --`
        })
      }
    }
  }
  return problems
}
