const COMMENT_LINE_DIRECTIVE =
  /(?:^|\n)\s*(?:\*\s*)?(oxlint-disable(?:-next-line|-line)?|eslint-disable(?:-next-line|-line)?|@effect-diagnostics(?:-next-line)?|@ts-expect-error|@ts-ignore|@ts-nocheck)/g

const RULES_FORBIDDEN_INLINE = [
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

const DIAGNOSTICS_FORBIDDEN_INLINE = [
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

const REGEX_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "void",
  "typeof",
  "delete",
  "await",
  "yield",
  "else",
  "do",
  "in",
  "of",
  "instanceof"
])

export const commentSpans = (source: string): Array<CommentSpan> => {
  const found: Array<CommentSpan> = []
  let index = 0
  let line = 1
  let canRegex = true

  const scanCode = (stopOnBrace: boolean) => {
    let depth = 0
    while (index < source.length) {
      const char = source[index]!
      const next = source[index + 1]
      if (stopOnBrace && char === "}" && depth === 0) {
        index++
        return
      }
      if (char === "{") {
        depth++
        canRegex = true
        index++
        continue
      }
      if (char === "}") {
        depth = Math.max(0, depth - 1)
        canRegex = false
        index++
        continue
      }
      if (char === "\n") {
        line++
        canRegex = true
        index++
        continue
      }
      if (char === " " || char === "\t" || char === "\r") {
        index++
        continue
      }
      if (char === "/" && next === "/") {
        const startLine = line
        index += 2
        let text = ""
        while (index < source.length && source[index] !== "\n") text += source[index++]
        found.push({ line: startLine, text })
        canRegex = true
        continue
      }
      if (char === "/" && next === "*") {
        const startLine = line
        index += 2
        let text = ""
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
          if (source[index] === "\n") line++
          text += source[index++]
        }
        index = Math.min(source.length, index + 2)
        found.push({ line: startLine, text })
        canRegex = true
        continue
      }
      if (canRegex && char === "/") {
        index++
        while (index < source.length && source[index] !== "\n") {
          if (source[index] === "\\") {
            index += 2
            continue
          }
          if (source[index] === "[") {
            index++
            while (index < source.length && source[index] !== "]" && source[index] !== "\n") {
              index += source[index] === "\\" ? 2 : 1
            }
            continue
          }
          if (source[index] === "/") {
            index++
            break
          }
          index++
        }
        while (index < source.length && /[a-z]/i.test(source[index]!)) index++
        canRegex = false
        continue
      }
      if (char === "\"" || char === "'") {
        const quote = char
        index++
        while (index < source.length && source[index] !== quote && source[index] !== "\n") {
          index += source[index] === "\\" ? 2 : 1
        }
        if (source[index] === quote) index++
        canRegex = false
        continue
      }
      if (char === "`") {
        index++
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2
            continue
          }
          if (source[index] === "`") {
            index++
            break
          }
          if (source[index] === "$" && source[index + 1] === "{") {
            index += 2
            scanCode(true)
            continue
          }
          if (source[index] === "\n") line++
          index++
        }
        canRegex = false
        continue
      }
      if (/[A-Za-z_$]/.test(char)) {
        let word = ""
        while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) word += source[index++]
        canRegex = REGEX_KEYWORDS.has(word)
        continue
      }
      if (/[0-9]/.test(char)) {
        while (index < source.length && /[0-9A-Za-z_.]/.test(source[index]!)) index++
        canRegex = false
        continue
      }
      canRegex = "([{:;,=!?+-~*%&|^<>".includes(char)
      index++
    }
  }

  scanCode(false)
  return found
}

const hasReason = (text: string) => /[A-Za-z]{3,}/.test(text)

const namesForbiddenInlineRule = (rules: string) =>
  RULES_FORBIDDEN_INLINE.some((rule) => rules.includes(rule)) ||
  DIAGNOSTICS_FORBIDDEN_INLINE.some((name) => new RegExp(`\\b${name}\\b`).test(rules))

export const suppressionProblems = (source: string): Array<SuppressionProblem> => {
  const problems: Array<SuppressionProblem> = []
  for (const comment of commentSpans(source)) {
    for (const match of comment.text.matchAll(COMMENT_LINE_DIRECTIVE)) {
      const directive = match[1] ?? ""
      const body = comment.text.slice((match.index ?? 0) + match[0].length)
      const typescriptDirective = directive.startsWith("@ts-")
      const dash = typescriptDirective ? -1 : body.indexOf("--")
      const rules = dash === -1 ? body : body.slice(0, dash)
      const reason = typescriptDirective ? body.replace(/^[\s:]+/, "") : dash === -1 ? "" : body.slice(dash + 2)
      const namedRules = rules.trim()
      const blanket = namedRules === "" || namedRules === "*" || /(^|[\s,])\*(?::[A-Za-z]+)?\b/.test(namedRules)

      if (!typescriptDirective && (blanket || namesForbiddenInlineRule(rules))) {
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
