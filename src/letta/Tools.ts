/**
 * How Letta Code tool calls are presented over ACP: title, kind, affected
 * locations, diffs and plan updates, derived from the tool name and its input.
 *
 * Inputs are decoded with Schema per tool; anything that does not match falls
 * back to a generic presentation, so new or custom (mod / MCP) tools still
 * render.
 */
import { Option, type Path, Schema } from "effect"
import type { ToolKind } from "../acp/Content.ts"
import type { DiffHunk, Location, PlanEntry, ToolContent } from "../domain/Events.ts"
import type { DiffPreview } from "./Protocol.ts"

export interface Presentation {
  readonly title: string
  readonly kind: ToolKind
  readonly locations: ReadonlyArray<Location>
  readonly content: ReadonlyArray<ToolContent>
  /** Shell tools are shown as an agent-owned terminal. */
  readonly terminal: Option.Option<{ readonly command: string; readonly cwd: string }>
}

export interface ToolContext {
  readonly cwd: string
  readonly path: Path.Path
}

const opt = Schema.optionalKey
const Read = Schema.Struct({ file_path: Schema.String, offset: opt(Schema.Finite), limit: opt(Schema.Finite) })
const Write = Schema.Struct({ file_path: Schema.String, content: Schema.String })
const Edit = Schema.Struct({ file_path: Schema.String, old_string: Schema.String, new_string: Schema.String })
const ApplyPatch = Schema.Struct({ input: Schema.String })
const Bash = Schema.Struct({ command: Schema.String, description: opt(Schema.String) })
const ExecCommand = Schema.Struct({ cmd: Schema.String, description: opt(Schema.String), workdir: opt(Schema.String) })
const Grep = Schema.Struct({ pattern: Schema.String, path: opt(Schema.String) })
const Glob = Schema.Struct({ pattern: Schema.String, path: opt(Schema.String) })
const PathArg = Schema.Struct({ path: Schema.String })
const Task = Schema.Struct({ description: Schema.String, subagent_type: opt(Schema.String) })
const WebSearch = Schema.Struct({ query: Schema.String })
const FetchUrl = Schema.Struct({ url: Schema.String })
const SkillArg = Schema.Struct({ skill: Schema.String })
const Description = Schema.Struct({ description: Schema.String })

const PlanStatus = Schema.Literals(["pending", "in_progress", "completed"])
const UpdatePlan = Schema.Struct({ plan: Schema.Array(Schema.Struct({ step: Schema.String, status: PlanStatus })) })
const TodoWrite = Schema.Struct({
  todos: Schema.Array(Schema.Struct({
    content: Schema.String,
    status: PlanStatus,
    priority: opt(Schema.Literals(["high", "medium", "low"]))
  }))
})
const TaskCreate = Schema.Struct({ subject: Schema.String })
const TaskUpdate = Schema.Struct({
  taskId: Schema.Union([Schema.String, Schema.Finite]),
  status: opt(Schema.Literals(["pending", "in_progress", "completed", "deleted"])),
  subject: opt(Schema.String)
})

const decoder = <S extends Schema.Codec<unknown, unknown>>(schema: S) => Schema.decodeUnknownOption(schema)
const decodeRead = decoder(Read)
const decodeWrite = decoder(Write)
const decodeEdit = decoder(Edit)
const decodeApplyPatch = decoder(ApplyPatch)
const decodeBash = decoder(Bash)
const decodeExec = decoder(ExecCommand)
const decodeGrep = decoder(Grep)
const decodeGlob = decoder(Glob)
const decodePath = decoder(PathArg)
const decodeTask = decoder(Task)
const decodeWebSearch = decoder(WebSearch)
const decodeFetch = decoder(FetchUrl)
const decodeSkill = decoder(SkillArg)
const decodeDescription = decoder(Description)
const decodeUpdatePlan = decoder(UpdatePlan)
const decodeTodoWrite = decoder(TodoWrite)
export const decodeTaskCreate = decoder(TaskCreate)
export const decodeTaskUpdate = decoder(TaskUpdate)

const truncate = (text: string, max = 80) => {
  const line = text.split("\n")[0] ?? ""
  return line.length > max || text.includes("\n") ? `${line.slice(0, max - 1)}…` : line
}

const generic = (title: string, kind: ToolKind): Presentation => ({
  title,
  kind,
  locations: [],
  content: [],
  terminal: Option.none()
})

/** Parses `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` headers of an ApplyPatch envelope. */
export const patchFiles = (input: string) => {
  const files: Array<
    { readonly operation: "add" | "update" | "delete"; readonly path: string; readonly moveTo?: string }
  > = []
  for (const line of input.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line.trim())
    if (header?.[1] !== undefined && header[2] !== undefined) {
      const operation = header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "update"
      files.push({ operation, path: header[2].trim() })
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line.trim())
    const last = files.at(-1)
    if (move?.[1] !== undefined && last !== undefined) files[files.length - 1] = { ...last, moveTo: move[1].trim() }
  }
  return files
}

/** Converts Letta's diff previews (from `can_use_tool`) to hunks keyed by file name. */
export const hunksByFile = (diffs: ReadonlyArray<DiffPreview> | undefined) => {
  const map = new Map<string, ReadonlyArray<DiffHunk>>()
  for (const diff of diffs ?? []) {
    if (diff.mode === "advanced" && "hunks" in diff) map.set(diff.fileName, diff.hunks)
  }
  return map
}

/** Presents a tool call. `hunks` come from the approval request, when Letta computed them. */
export const present = (
  name: string,
  input: unknown,
  context: ToolContext,
  hunks: ReadonlyMap<string, ReadonlyArray<DiffHunk>> = new Map()
): Presentation => {
  const { cwd, path } = context
  const absolute = (p: string) => (path.isAbsolute(p) ? p : path.resolve(cwd, p))
  const display = (p: string) => {
    const abs = absolute(p)
    const rel = path.relative(cwd, abs)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs
  }
  const hunksFor = (file: string) => hunks.get(file) ?? hunks.get(absolute(file)) ?? hunks.get(display(file))

  switch (name) {
    case "Read":
    case "ReadLSP":
      return Option.match(decodeRead(input), {
        onNone: () => generic("Read file", "read"),
        onSome: ({ file_path, limit, offset }) => {
          const range = offset === undefined
            ? ""
            : limit === undefined
            ? ` (from line ${offset})`
            : ` (lines ${offset}-${offset + limit - 1})`
          return {
            ...generic(`Read ${display(file_path)}${range}`, "read"),
            locations: [{ path: absolute(file_path), ...(offset === undefined ? {} : { line: Math.max(1, offset) }) }]
          }
        }
      })
    case "ViewImage":
      return Option.match(decodePath(input), {
        onNone: () => generic("View image", "read"),
        onSome: ({ path: p }) => ({ ...generic(`View ${display(p)}`, "read"), locations: [{ path: absolute(p) }] })
      })
    case "Write":
    case "WriteArtifactFile":
      return Option.match(decodeWrite(input), {
        onNone: () => generic("Write file", "edit"),
        onSome: ({ content, file_path }) => {
          const fileHunks = hunksFor(file_path)
          return {
            ...generic(`Write ${display(file_path)}`, "edit"),
            locations: [{ path: absolute(file_path) }],
            content: [{
              _tag: "Diff",
              path: absolute(file_path),
              oldText: null,
              newText: content,
              ...(fileHunks === undefined ? {} : { hunks: fileHunks })
            }]
          }
        }
      })
    case "Edit":
    case "MultiEdit":
      return Option.match(decodeEdit(input), {
        onNone: () => generic("Edit file", "edit"),
        onSome: ({ file_path, new_string, old_string }) => {
          const fileHunks = hunksFor(file_path)
          return {
            ...generic(`Edit ${display(file_path)}`, "edit"),
            locations: [{ path: absolute(file_path) }],
            content: [{
              _tag: "Diff",
              path: absolute(file_path),
              oldText: old_string,
              newText: new_string,
              ...(fileHunks === undefined ? {} : { hunks: fileHunks })
            }]
          }
        }
      })
    case "ApplyPatch":
      return Option.match(decodeApplyPatch(input), {
        onNone: () => generic("Apply patch", "edit"),
        onSome: ({ input: patch }) => {
          const files = patchFiles(patch)
          const kind: ToolKind = files.length > 0 && files.every((f) => f.operation === "delete")
            ? "delete"
            : files.length > 0 && files.every((f) => f.moveTo !== undefined)
            ? "move"
            : "edit"
          const content: Array<ToolContent> = []
          for (const file of files) {
            const fileHunks = hunksFor(file.path)
            if (fileHunks === undefined) continue
            content.push({
              _tag: "Diff",
              path: absolute(file.moveTo ?? file.path),
              oldText: file.operation === "add" ? null : hunkSide(fileHunks, "old"),
              newText: file.operation === "delete" ? "" : hunkSide(fileHunks, "new"),
              hunks: fileHunks
            })
          }
          const names = files.map((f) => display(f.moveTo ?? f.path))
          return {
            ...generic(names.length === 0 ? "Apply patch" : `Apply patch to ${names.join(", ")}`, kind),
            locations: files.map((f) => ({ path: absolute(f.moveTo ?? f.path) })),
            content
          }
        }
      })
    case "Bash":
    case "Shell":
    case "shell":
    case "run_shell_command":
      return Option.match(decodeBash(input), {
        onNone: () => generic("Run command", "execute"),
        onSome: ({ command }) => ({
          ...generic(`\`${truncate(command)}\``, "execute"),
          terminal: Option.some({ command, cwd })
        })
      })
    case "exec_command":
      return Option.match(decodeExec(input), {
        onNone: () => generic("Run command", "execute"),
        onSome: ({ cmd, workdir }) => ({
          ...generic(`\`${truncate(cmd)}\``, "execute"),
          terminal: Option.some({ command: cmd, cwd: workdir === undefined ? cwd : absolute(workdir) })
        })
      })
    case "write_stdin":
      return generic("Write to running command", "execute")
    case "Monitor":
      return generic(
        Option.match(decodeDescription(input), { onNone: () => "Monitor", onSome: (d) => d.description }),
        "execute"
      )
    case "Grep":
      return Option.match(decodeGrep(input), {
        onNone: () => generic("Search files", "search"),
        onSome: ({ path: p, pattern }) => ({
          ...generic(`grep ${JSON_quote(pattern)}${p === undefined ? "" : ` ${display(p)}`}`, "search"),
          locations: p === undefined ? [] : [{ path: absolute(p) }]
        })
      })
    case "Glob":
      return Option.match(decodeGlob(input), {
        onNone: () => generic("Find files", "search"),
        onSome: ({ path: p, pattern }) => ({
          ...generic(`Find ${pattern}${p === undefined ? "" : ` in ${display(p)}`}`, "search"),
          locations: p === undefined ? [] : [{ path: absolute(p) }]
        })
      })
    case "LS":
      return Option.match(decodePath(input), {
        onNone: () => generic("List directory", "search"),
        onSome: ({ path: p }) => ({ ...generic(`List ${display(p)}`, "search"), locations: [{ path: absolute(p) }] })
      })
    case "web_search":
    case "WebSearch":
      return Option.match(decodeWebSearch(input), {
        onNone: () => generic("Web search", "fetch"),
        onSome: ({ query }) => generic(`Search the web: ${truncate(query)}`, "fetch")
      })
    case "fetch_webpage":
    case "WebFetch":
    case "WatchPR":
      return Option.match(decodeFetch(input), {
        onNone: () => generic("Fetch", "fetch"),
        onSome: ({ url }) => generic(`Fetch ${url}`, "fetch")
      })
    case "Task":
    case "Agent":
      return Option.match(decodeTask(input), {
        onNone: () => generic("Run subagent", "think"),
        onSome: ({ description, subagent_type }) =>
          generic(`${subagent_type === undefined ? "Subagent" : subagent_type}: ${description}`, "think")
      })
    case "Skill":
      return Option.match(decodeSkill(input), {
        onNone: () => generic("Load skill", "read"),
        onSome: ({ skill }) => generic(`Load skill ${skill}`, "read")
      })
    case "UpdatePlan":
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
      return generic("Update plan", "think")
    case "SetWorkingDirectory":
      return Option.match(decodePath(input), {
        onNone: () => generic("Change directory", "other"),
        onSome: ({ path: p }) => generic(`Change directory to ${display(p)}`, "other")
      })
    case "AskUserQuestion":
      return generic("Ask a question", "other")
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      if (mcp?.[1] !== undefined && mcp[2] !== undefined) return generic(`${mcp[1]}: ${mcp[2]}`, "other")
      return generic(name, /memory/i.test(name) ? "think" : "other")
    }
  }
}

const JSON_quote = (text: string) => `"${truncate(text, 60).replaceAll("\"", "\\\"")}"`

/** Reconstructs the old or new side of a set of hunks (context lines included). */
export const hunkSide = (hunks: ReadonlyArray<DiffHunk>, side: "old" | "new") =>
  hunks
    .map((hunk) =>
      hunk.lines
        .filter((line) => line.type === "context" || line.type === (side === "old" ? "remove" : "add"))
        .map((line) => line.content)
        .join("\n")
    )
    .join("\n…\n")

/** A plan from `UpdatePlan` (Codex toolset) or legacy `TodoWrite` input. */
export const planFromInput = (name: string, input: unknown): Option.Option<ReadonlyArray<PlanEntry>> => {
  if (name === "UpdatePlan") {
    return Option.map(
      decodeUpdatePlan(input),
      ({ plan }) => plan.map((step): PlanEntry => ({ content: step.step, status: step.status, priority: "medium" }))
    )
  }
  if (name === "TodoWrite") {
    return Option.map(
      decodeTodoWrite(input),
      ({ todos }) =>
        todos.map((todo): PlanEntry => ({
          content: todo.content,
          status: todo.status,
          priority: todo.priority ?? "medium"
        }))
    )
  }
  return Option.none()
}

/** Extracts a task id from a `TaskCreate` result such as `Task #3 created successfully: ...`. */
export const createdTaskId = (output: string): Option.Option<string> =>
  Option.fromNullishOr(/task\s*#?\s*([\w-]+)\s+created/i.exec(output)?.[1])

/** Extracts the exit code from shell tool output such as `Exit code: 1`. */
export const exitCodeOf = (output: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(/exit code:?\s*(-?\d+)/i.exec(output)?.[1]), (code) => Number.parseInt(code, 10))
