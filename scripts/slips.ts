export interface SlipProblem {
  readonly line: number
  readonly message: string
}

type Parts = ReadonlyArray<string>

type Denotation =
  | { readonly _tag: "Path"; readonly parts: Parts }
  | { readonly _tag: "Module"; readonly name: string }
  | { readonly _tag: "RequireFactory" }
  | { readonly _tag: "Requirer" }

interface Value {
  readonly denoted?: Denotation
  readonly directEnv: boolean
  readonly tryLine?: number
  readonly line?: number
}

interface Token {
  readonly kind: "id" | "str" | "num" | "op" | "eof"
  readonly text: string
  readonly line: number
}

interface FunctionInfo {
  tryLine?: number
}

class Scope {
  readonly bindings = new Map<string, Denotation>()
  readonly functions = new Map<string, FunctionInfo>()
  readonly parent: Scope | undefined
  constructor(parent?: Scope) {
    this.parent = parent
  }

  lookup(name: string): Denotation | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name)
  }

  lookupFunction(name: string): FunctionInfo | undefined {
    return this.functions.get(name) ?? this.parent?.lookupFunction(name)
  }
}

const GLOBALS = new Set([
  "JSON",
  "console",
  "Math",
  "Date",
  "process",
  "fetch",
  "crypto",
  "Promise",
  "setTimeout",
  "setInterval",
  "globalThis",
  "Effect"
])

const NATIVE_ERRORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError"
])

const BANNED_NODE = new Set(["fs", "path", "child_process", "crypto", "http", "https", "timers"])

const NODE_ALLOW: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["test/helpers/E2eProcess.ts", new Set(["child_process"])],
  ["test/helpers/McpHttpServer.ts", new Set(["http"])]
])

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

const nodeModule = (specifier: string): string | undefined => {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier
  const top = bare.split("/")[0] ?? ""
  return BANNED_NODE.has(top) ? top : undefined
}

const keyOf = (parts: Parts) => parts.join(".")

const normalize = (parts: Parts): Parts =>
  parts[0] === "globalThis" && parts.length > 1 ? normalize(parts.slice(1)) : parts

const isEnv = (denoted: Denotation | undefined) =>
  denoted?._tag === "Path" && denoted.parts[0] === "process" && denoted.parts[1] === "env"

const empty: Value = { directEnv: false }

const tokenize = (source: string): Array<Token> => {
  const tokens: Array<Token> = []
  let index = 0
  let line = 1
  let canRegex = true
  const push = (kind: Token["kind"], text: string, tokenLine: number) => {
    tokens.push({ kind, text, line: tokenLine })
  }
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
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
      while (index < source.length && source[index] !== "\n") index++
      canRegex = true
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line++
        index++
      }
      index = Math.min(source.length, index + 2)
      canRegex = true
      continue
    }
    if (canRegex && char === "/" && next !== "/" && next !== "*") {
      const start = line
      index++
      let text = ""
      while (index < source.length && source[index] !== "\n") {
        if (source[index] === "\\") {
          text += source[index++] ?? ""
          text += source[index++] ?? ""
          continue
        }
        if (source[index] === "[") {
          while (index < source.length && source[index] !== "]" && source[index] !== "\n") {
            text += source[index++]
            if (source[index - 1] === "\\") text += source[index++] ?? ""
          }
          continue
        }
        if (source[index] === "/") {
          index++
          break
        }
        text += source[index++]
      }
      while (index < source.length && /[a-z]/i.test(source[index]!)) index++
      push("op", `/${text}/`, start)
      canRegex = false
      continue
    }
    if (char === "\"" || char === "'") {
      const quote = char
      const start = line
      index++
      let text = ""
      while (index < source.length && source[index] !== quote && source[index] !== "\n") {
        if (source[index] === "\\") {
          index++
          text += source[index++] ?? ""
          continue
        }
        text += source[index++]
      }
      if (source[index] === quote) index++
      push("str", text, start)
      canRegex = false
      continue
    }
    if (char === "`") {
      const start = line
      index++
      let text = ""
      while (index < source.length && source[index] !== "`") {
        if (source[index] === "\\") {
          index++
          text += source[index++] ?? ""
          continue
        }
        if (source[index] === "$" && source[index + 1] === "{") break
        if (source[index] === "\n") line++
        text += source[index++]
      }
      if (source[index] === "`") index++
      push("str", text, start)
      canRegex = false
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = line
      let text = ""
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) text += source[index++]
      push("id", text, start)
      canRegex = REGEX_KEYWORDS.has(text)
      continue
    }
    if (/[0-9]/.test(char)) {
      const start = line
      let text = ""
      while (index < source.length && /[0-9A-Za-z_.]/.test(source[index]!)) text += source[index++]
      push("num", text, start)
      canRegex = false
      continue
    }
    const start = line
    const two = char + (next ?? "")
    const three = two + (source[index + 2] ?? "")
    const op =
      ["===", "!==", "...", "=>", "??", "?.", "&&", "||", "==", "!=", "<=", ">=", "++", "--", "**"].find((item) =>
        three.startsWith(item)
      ) ?? char
    push("op", op, start)
    index += op.length
    canRegex = "([{:;,=!?+-~*%&|^<>".includes(char)
  }
  tokens.push({ kind: "eof", text: "", line })
  return tokens
}

/** Reports Effect-banned operations, including ones reached through a local alias. */
export const slipProblems = (sourceText: string, file: string): ReadonlyArray<SlipProblem> => {
  const tokens = tokenize(sourceText)
  const problems: Array<SlipProblem> = []
  const seen = new Set<string>()
  let cursor = 0

  const peek = () => tokens[cursor] ?? tokens[tokens.length - 1]!
  const at = (text: string) => peek().text === text && peek().kind !== "eof"
  const eat = (text?: string) => {
    const token = peek()
    if (text === undefined || token.text === text) cursor++
    return token
  }

  const report = (line: number, message: string) => {
    const key = `${line}:${message}`
    if (seen.has(key)) return
    seen.add(key)
    problems.push({ line, message })
  }

  const reportModule = (line: number, specifier: string) => {
    const name = nodeModule(specifier)
    if (name === undefined || NODE_ALLOW.get(file)?.has(name) === true) return
    report(line, `node:${name} is banned. Use the Effect module instead.`)
  }

  const note = (value: Value, line: number, allowDirectEnv: boolean) => {
    if (!isEnv(value.denoted)) return
    if (allowDirectEnv && value.directEnv && file === "src/main.ts") return
    report(line, "process.env is banned. Use Config or the Host service.")
  }

  const extend = (value: Value, name: string): Value => {
    if (value.denoted?._tag === "Path") {
      return { directEnv: false, denoted: { _tag: "Path", parts: normalize([...value.denoted.parts, name]) } }
    }
    if (value.denoted?._tag === "Module") return { directEnv: false, denoted: value.denoted }
    return empty
  }

  const skipType = () => {
    let depth = 0
    while (peek().kind !== "eof") {
      const token = peek()
      if (
        (token.text === ")" || token.text === "," || token.text === "=" || token.text === "{" || token.text === "=>") &&
        depth === 0
      ) return
      if (token.text === "(" || token.text === "<" || token.text === "{" || token.text === "[") depth++
      else if (token.text === ")" || token.text === ">" || token.text === "}" || token.text === "]") {
        depth = Math.max(0, depth - 1)
      }
      cursor++
    }
  }

  const skipBalanced = (open: string, close: string) => {
    if (!at(open)) return
    let depth = 0
    while (peek().kind !== "eof") {
      const token = eat()
      if (token.text === open) depth++
      else if (token.text === close && --depth === 0) return
    }
  }

  const parseExpression = (scope: Scope, allowDirectEnv: boolean): Value => {
    if (at("async")) {
      report(peek().line, "async function is banned. Use Effect.gen or Effect.fn.")
      eat("async")
    }
    if (at("await")) eat("await")
    if (at("new")) {
      const line = eat("new").line
      const constructed = parsePostfix(scope, parsePrimary(scope, allowDirectEnv), allowDirectEnv, true)
      if (at("(")) skipBalanced("(", ")")
      if (constructed.denoted?._tag === "Path" && keyOf(constructed.denoted.parts) === "Promise") {
        report(line, "new Promise is banned. Use Effect.promise or Effect.tryPromise.")
      } else if (constructed.denoted?._tag === "Path" && keyOf(constructed.denoted.parts) === "Date") {
        report(line, "new Date is banned. Use DateTime.")
      }
      return empty
    }
    let value = parsePostfix(scope, parsePrimary(scope, allowDirectEnv), allowDirectEnv)
    while (isContinuation(peek().text)) {
      if (at("as") || at("satisfies")) {
        eat()
        skipType()
        continue
      }
      if (at("?")) {
        eat("?")
        parseExpression(scope, false)
        if (at(":")) {
          eat(":")
          value = parseExpression(scope, allowDirectEnv)
        }
        continue
      }
      const before = cursor
      eat()
      value = parseExpression(scope, false)
      if (cursor === before) break
    }
    return value
  }

  const isContinuation = (text: string) =>
    [
      "+",
      "-",
      "*",
      "/",
      "%",
      "==",
      "===",
      "!=",
      "!==",
      "<",
      ">",
      "<=",
      ">=",
      "&&",
      "||",
      "??",
      "=",
      "+=",
      "as",
      "satisfies",
      "?"
    ].includes(text)

  const parsePrimary = (scope: Scope, allowDirectEnv: boolean): Value => {
    const token = peek()
    if (token.kind === "id" && token.text === "import") {
      eat()
      return { directEnv: false, denoted: { _tag: "Path", parts: ["import"] }, line: token.line }
    }
    if (token.kind === "id" && token.text === "function") return parseFunction(scope, true)
    if (token.kind === "id" && token.text === "class") return parseClass(scope)
    if (at("(")) {
      eat("(")
      if (at(")") || peek().kind === "id") {
        const saved = cursor
        const maybeArrow = lookAheadArrow()
        cursor = saved
        if (maybeArrow) return parseArrow(scope)
      }
      const value = parseExpression(scope, allowDirectEnv)
      if (at(")")) eat(")")
      return value
    }
    if (at("{")) return parseObject(scope)
    if (at("[")) {
      skipBalanced("[", "]")
      return empty
    }
    if (at("...")) {
      eat("...")
      const value = parseExpression(scope, false)
      note(value, token.line, false)
      return empty
    }
    if (token.kind === "id") {
      eat()
      const found = scope.lookup(token.text)
      const tryLine = scope.lookupFunction(token.text)?.tryLine
      if (found !== undefined) {
        return tryLine === undefined
          ? { directEnv: false, denoted: found, line: token.line }
          : { directEnv: false, denoted: found, tryLine, line: token.line }
      }
      if (GLOBALS.has(token.text)) {
        return { directEnv: false, denoted: { _tag: "Path", parts: [token.text] }, line: token.line }
      }
      return tryLine === undefined
        ? { directEnv: false, line: token.line }
        : { directEnv: false, tryLine, line: token.line }
    }
    if (token.kind === "str" || token.kind === "num" || token.kind === "op") eat()
    return empty
  }

  const lookAheadArrow = () => {
    let depth = 0
    let seenParen = false
    for (let index = cursor; index < tokens.length; index++) {
      const token = tokens[index]!
      if (token.text === "(") {
        depth++
        seenParen = true
      } else if (token.text === ")") depth--
      else if (token.text === "=>" && depth === 0 && seenParen) return true
      else if ((token.text === ";" || token.text === "{" || token.text === "=") && depth === 0) return false
      if (depth < 0) return false
    }
    return false
  }

  const parseArrow = (scope: Scope): Value => {
    parseParameters(scope)
    if (at(":")) {
      eat(":")
      skipType()
    }
    if (at("=>")) eat("=>")
    if (at("{")) {
      parseBlock(new Scope(scope), false)
      return empty
    }
    return parseExpression(scope, false)
  }

  const parsePostfix = (scope: Scope, receiver: Value, allowDirectEnv: boolean, stopBeforeCall = false): Value => {
    let value = receiver
    while (peek().kind !== "eof") {
      if (at("(") && !stopBeforeCall) {
        const line = peek().line
        eat("(")
        const args: Array<Value> = []
        while (!at(")") && peek().kind !== "eof") {
          args.push(parseExpression(scope, false))
          if (at(",")) eat(",")
          else break
        }
        if (at(")")) eat(")")
        reportCall(value, args, line)
        const result = callResult(value, line)
        const tryLine = args.find((arg) => arg.tryLine !== undefined)?.tryLine
        value = tryLine === undefined ? result : { ...result, tryLine }
        continue
      }
      if (at(".") || at("?.")) {
        eat()
        const name = peek().kind === "id" ? eat().text : ""
        const directEnv = value.denoted?._tag === "Path" && keyOf(value.denoted.parts) === "process" && name === "env"
        value = { ...extend(value, name), directEnv, line: peek().line }
        continue
      }
      if (at("[")) {
        const line = peek().line
        eat("[")
        const name = peek().kind === "str" ? eat().text : ""
        if (name === "") parseExpression(scope, false)
        if (at("]")) eat("]")
        if (name !== "") value = { ...extend(value, name), directEnv: false, line }
        continue
      }
      if (at("<") && value.denoted?._tag === "Path") {
        eat("<")
        skipType()
        continue
      }
      break
    }
    note(value, value.line ?? peek().line, allowDirectEnv)
    return value
  }

  const callResult = (callee: Value, line: number): Value => {
    if (callee.denoted?._tag === "RequireFactory") return { directEnv: false, denoted: { _tag: "Requirer" }, line }
    if (
      callee.denoted?._tag === "Path" &&
      (keyOf(callee.denoted.parts) === "Effect.fn" || keyOf(callee.denoted.parts) === "Effect.fnUntraced")
    ) {
      return { directEnv: false, denoted: { _tag: "Path", parts: ["Effect", "fn", "call"] }, line }
    }
    if (callee.denoted?._tag === "Path" && keyOf(callee.denoted.parts) === "import") {
      const specifier = lastString(line)
      const name = specifier === undefined ? undefined : nodeModule(specifier)
      return name === undefined ? empty : { directEnv: false, denoted: { _tag: "Module", name }, line }
    }
    return empty
  }

  const reportCall = (callee: Value, args: ReadonlyArray<Value>, line: number) => {
    const denoted = callee.denoted
    if (denoted?._tag === "Path") {
      const called = keyOf(denoted.parts)
      if (called === "JSON.parse" || called === "JSON.stringify") {
        report(line, `${called} is banned. Use Schema.fromJsonString.`)
      } else if (denoted.parts[0] === "console") report(line, "console is banned. Use Effect.log.")
      else if (called === "Math.random") report(line, "Math.random is banned. Use Random.")
      else if (called === "Date.now") report(line, "Date.now is banned. Use Clock or DateTime.")
      else if (called === "setTimeout" || called === "setInterval") {
        report(line, `${called} is banned. Use Effect.sleep or Schedule.`)
      } else if (called === "crypto.randomUUID") report(line, "crypto.randomUUID is banned. Use SecureRandom.")
      else if (called === "fetch") report(line, "fetch is banned. Use HttpClient.")
      else if (called === "import" || called === "process.getBuiltinModule") {
        const specifier = lastString(line)
        if (specifier !== undefined) reportModule(line, specifier)
      }
    }
    if (
      denoted?._tag === "Path" &&
      (keyOf(denoted.parts) === "Effect.gen" || keyOf(denoted.parts) === "Effect.fn" ||
        keyOf(denoted.parts) === "Effect.fnUntraced" || keyOf(denoted.parts) === "Effect.fn.call")
    ) {
      for (const arg of args) {
        if (arg.tryLine !== undefined) {
          report(arg.tryLine, "try/catch inside an Effect generator is banned. Use Effect.try or Effect.catch.")
        }
      }
    }
    if (denoted?._tag === "Requirer") {
      const specifier = lastString(line)
      if (specifier !== undefined) reportModule(line, specifier)
    }
  }

  const lastString = (line: number) => {
    for (let index = cursor - 1; index >= 0; index--) {
      const token = tokens[index]!
      if (token.line < line - 2) return undefined
      if (token.kind === "str") return token.text
    }
    return undefined
  }

  const parseObject = (scope: Scope): Value => {
    eat("{")
    while (!at("}") && peek().kind !== "eof") {
      if (at("...")) {
        eat("...")
        const value = parseExpression(scope, false)
        note(value, peek().line, false)
      } else if (peek().kind === "id" || peek().kind === "str") {
        eat()
        if (at(":")) {
          eat(":")
          parseExpression(scope, file === "src/main.ts")
        }
      } else eat()
      if (at(",")) eat(",")
    }
    if (at("}")) eat("}")
    return empty
  }

  const parseParameters = (scope: Scope) => {
    if (!at("(")) return
    eat("(")
    while (!at(")") && peek().kind !== "eof") {
      if (at("...")) eat("...")
      if (peek().kind === "id") scope.bindings.set(eat().text, { _tag: "Path", parts: ["opaque"] })
      if (at(":")) {
        eat(":")
        skipType()
      }
      if (at("=")) {
        eat("=")
        parseExpression(scope, false)
      }
      if (at(",")) eat(",")
      else break
    }
    if (at(")")) eat(")")
  }

  const parseBlock = (scope: Scope, generator: boolean, info?: FunctionInfo) => {
    if (!at("{")) return
    eat("{")
    const inner = new Scope(scope)
    while (!at("}") && peek().kind !== "eof") {
      if (generator && at("try") && info !== undefined && info.tryLine === undefined) info.tryLine = peek().line
      parseStatement(inner, generator)
    }
    if (at("}")) eat("}")
  }

  const parseFunction = (scope: Scope, expression: boolean): Value => {
    const line = peek().line
    if (at("async")) {
      report(line, "async function is banned. Use Effect.gen or Effect.fn.")
      eat("async")
    }
    if (at("function")) eat("function")
    const generator = at("*")
    if (generator) eat("*")
    let name: string | undefined
    if (!expression && peek().kind === "id") name = eat().text
    else if (expression && peek().kind === "id" && !at("(")) name = eat().text
    const info: FunctionInfo = {}
    if (name !== undefined) scope.functions.set(name, info)
    const inner = new Scope(scope)
    parseParameters(inner)
    if (at(":")) {
      eat(":")
      skipType()
    }
    parseBlock(inner, generator, info)
    return generator && info.tryLine !== undefined
      ? { directEnv: false, tryLine: info.tryLine, line }
      : { directEnv: false, line }
  }

  const parseClass = (scope: Scope): Value => {
    eat("class")
    if (peek().kind === "id") eat()
    if (at("extends")) {
      eat("extends")
      const line = peek().line
      const name = peek().kind === "id" ? eat().text : ""
      const local = scope.lookup(name)
      if (local === undefined && NATIVE_ERRORS.has(name)) {
        report(line, `extends ${name} is banned. Use Schema.TaggedError.`)
      }
    }
    if (at("{")) parseBlock(new Scope(scope), false)
    return empty
  }

  const parseBinding = (scope: Scope, allowDirectEnv: boolean) => {
    if (at("{")) {
      const fields: Array<{ local: string; prop: string }> = []
      eat("{")
      while (!at("}") && peek().kind !== "eof") {
        if (peek().kind === "id") {
          const prop = eat().text
          const local = at(":") ? (eat(":"), peek().kind === "id" ? eat().text : prop) : prop
          fields.push({ local, prop })
        } else eat()
        if (at(",")) eat(",")
      }
      if (at("}")) eat("}")
      if (at("=")) eat("=")
      const init = parseExpression(scope, allowDirectEnv)
      for (const field of fields) {
        if (init.denoted?._tag === "Path") {
          scope.bindings.set(field.local, { _tag: "Path", parts: normalize([...init.denoted.parts, field.prop]) })
        }
      }
      return
    }
    if (peek().kind !== "id") return
    const name = eat().text
    if (at(":")) {
      eat(":")
      skipType()
    }
    if (!at("=")) {
      scope.bindings.set(name, { _tag: "Path", parts: ["opaque"] })
      return
    }
    eat("=")
    const init = parseExpression(scope, allowDirectEnv)
    if (init.denoted !== undefined) scope.bindings.set(name, init.denoted)
    else scope.bindings.set(name, { _tag: "Path", parts: ["opaque"] })
  }

  const parseStatement = (scope: Scope, generator: boolean) => {
    if (at("async") && (tokens[cursor + 1]?.text === "function" || tokens[cursor + 1]?.text === "(")) {
      report(peek().line, "async function is banned. Use Effect.gen or Effect.fn.")
      eat("async")
    }
    if (at("import")) {
      parseImport(scope)
      return
    }
    if (at("export")) {
      eat("export")
      if (at("default")) eat("default")
      if (at("type")) eat("type")
      if (at("*")) {
        while (!at("from") && !at(";") && peek().kind !== "eof") eat()
      }
      if (at("{")) {
        skipBalanced("{", "}")
        if (at("from")) {
          eat("from")
          if (peek().kind === "str") reportModule(peek().line, eat().text)
        }
        if (at(";")) eat(";")
        return
      }
    }
    if (at("function") || (at("async") && tokens[cursor + 1]?.text === "function")) {
      parseFunction(scope, false)
      return
    }
    if (at("class")) {
      parseClass(scope)
      return
    }
    if (at("const") || at("let") || at("var")) {
      eat()
      parseBinding(scope, false)
      if (at(";")) eat(";")
      return
    }
    if (at("try")) {
      if (generator) {
        report(peek().line, "try/catch inside an Effect generator is banned. Use Effect.try or Effect.catch.")
      }
      eat("try")
      parseBlock(scope, false)
      if (at("catch")) {
        eat("catch")
        if (at("(")) skipBalanced("(", ")")
        parseBlock(scope, false)
      }
      if (at("finally")) {
        eat("finally")
        parseBlock(scope, false)
      }
      return
    }
    if (at("if") || at("while") || at("for") || at("switch") || at("catch")) {
      eat()
      if (at("(")) skipBalanced("(", ")")
      if (at("{")) parseBlock(scope, generator)
      else parseStatement(scope, generator)
      if (at("else")) {
        eat("else")
        parseStatement(scope, generator)
      }
      return
    }
    if (at("return") || at("throw") || at("yield")) {
      eat()
      if (at("*")) eat("*")
      if (!at(";") && !at("}")) parseExpression(scope, false)
      if (at(";")) eat(";")
      return
    }
    if (at("{")) {
      parseBlock(scope, generator)
      return
    }
    if (at(";")) {
      eat(";")
      return
    }
    parseExpression(scope, false)
    if (at(";")) eat(";")
  }

  const parseImport = (scope: Scope) => {
    const line = eat("import").line
    if (at("type")) eat("type")
    if (peek().kind === "str") {
      reportModule(line, eat().text)
      if (at(";")) eat(";")
      return
    }
    const names: Array<{ local: string; imported: string }> = []
    if (at("*")) {
      eat("*")
      if (at("as") && tokens[cursor + 1]?.kind === "id") {
        eat("as")
        names.push({ local: eat().text, imported: "*" })
      }
    } else if (at("{")) {
      eat("{")
      while (!at("}") && peek().kind !== "eof") {
        if (at("type")) eat("type")
        if (peek().kind === "id") {
          const imported = eat().text
          const local = at("as") ? (eat("as"), eat().text) : imported
          names.push({ local, imported })
        } else eat()
        if (at(",")) eat(",")
      }
      if (at("}")) eat("}")
    } else if (peek().kind === "id") names.push({ local: eat().text, imported: "default" })
    if (at(",")) {
      eat(",")
      if (at("{")) skipBalanced("{", "}")
      else if (at("*")) {
        eat("*")
        if (at("as")) {
          eat("as")
          eat()
        }
      }
    }
    if (at("from")) eat("from")
    const specifier = peek().kind === "str" ? eat().text : ""
    reportModule(line, specifier)
    for (const binding of names) {
      if ((specifier === "node:module" || specifier === "module") && binding.imported === "createRequire") {
        scope.bindings.set(binding.local, { _tag: "RequireFactory" })
      } else if ((specifier === "node:process" || specifier === "process") && binding.imported === "env") {
        scope.bindings.set(binding.local, { _tag: "Path", parts: ["process", "env"] })
      } else if (specifier === "effect" && (binding.imported === "Effect" || binding.imported === "*")) {
        scope.bindings.set(binding.local, { _tag: "Path", parts: ["Effect"] })
      }
    }
    if (at(";")) eat(";")
  }

  const root = new Scope()
  while (peek().kind !== "eof") parseStatement(root, false)
  return problems
}
