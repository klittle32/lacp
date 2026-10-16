/**
 * ACP protocol version 2 (draft, schema 2.0.0-alpha.9): the subset of the
 * wire surface this agent implements or calls.
 *
 * v2 replaces the turn-scoped `session/prompt` response with an insertion
 * receipt plus `state_update` notifications, makes `tool_call_update` an
 * upsert, and turns capability booleans into `{}` markers.
 */
import { Schema } from "effect"
import { notification, request } from "../jsonrpc/Method.ts"
import {
  AvailableCommandInput,
  ContentBlock,
  EmptyResponse,
  EnvVariable,
  Implementation,
  ListSessionsRequest,
  ListSessionsResponse,
  Meta,
  optNull,
  PermissionOption,
  PlanEntryPriority,
  RequestPermissionResponse,
  SessionIdParams,
  ToolCallLocation,
  ToolKind,
  UsageCost
} from "./Content.ts"

export const PROTOCOL_VERSION = 2

const Marker = optNull(Schema.Struct({ _meta: Meta }))
const present = {} as const

// ---------------------------------------------------------------------------
// initialize / auth
// ---------------------------------------------------------------------------

export const ClientCapabilities = Schema.Struct({
  auth: optNull(Schema.Struct({ terminal: Marker, _meta: Meta })),
  elicitation: optNull(Schema.Struct({ form: Marker, url: Marker, _meta: Meta })),
  _meta: Meta
})
export type ClientCapabilities = typeof ClientCapabilities.Type

export const InitializeRequest = Schema.Struct({
  protocolVersion: Schema.Int,
  info: Implementation,
  capabilities: Schema.optionalKey(ClientCapabilities),
  _meta: Meta
})
export type InitializeRequest = typeof InitializeRequest.Type

export const AgentCapabilities = Schema.Struct({
  session: optNull(Schema.Struct({
    prompt: optNull(Schema.Struct({ image: Marker, audio: Marker, embeddedContext: Marker, _meta: Meta })),
    mcp: optNull(Schema.Struct({ stdio: Marker, http: Marker, _meta: Meta })),
    delete: Marker,
    additionalDirectories: Marker,
    _meta: Meta
  })),
  auth: Marker,
  _meta: Meta
})

export const AuthMethod = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("terminal"),
    methodId: Schema.String,
    name: Schema.String,
    description: optNull(Schema.String),
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Schema.Array(EnvVariable)),
    _meta: Meta
  }),
  Schema.Struct({
    type: Schema.Literal("agent"),
    methodId: Schema.String,
    name: Schema.String,
    description: optNull(Schema.String),
    _meta: Meta
  })
])

export const InitializeResponse = Schema.Struct({
  protocolVersion: Schema.Int,
  info: Implementation,
  capabilities: Schema.optionalKey(AgentCapabilities),
  authMethods: Schema.optionalKey(Schema.Array(AuthMethod)),
  _meta: Meta
})

export const Initialize = request("initialize", InitializeRequest, InitializeResponse)

export const Login = request("auth/login", Schema.Struct({ methodId: Schema.String, _meta: Meta }), EmptyResponse)
export const Logout = request("auth/logout", Schema.Struct({ _meta: Meta }), EmptyResponse)

/** The `{}` marker value for capability fields. */
export const supported = present

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const McpServers = Schema.Array(Schema.Unknown)

export const SelectOption = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  description: optNull(Schema.String),
  _meta: Meta
})

export const SessionConfigOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("select"),
    configId: Schema.String,
    name: Schema.String,
    description: optNull(Schema.String),
    category: optNull(Schema.String),
    currentValue: Schema.String,
    options: Schema.Array(SelectOption),
    _meta: Meta
  }),
  Schema.Struct({
    type: Schema.Literal("boolean"),
    configId: Schema.String,
    name: Schema.String,
    description: optNull(Schema.String),
    category: optNull(Schema.String),
    currentValue: Schema.Boolean,
    _meta: Meta
  })
])
export type SessionConfigOption = typeof SessionConfigOption.Type

export const AvailableCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input: optNull(Schema.Struct({ type: Schema.Literal("text"), ...AvailableCommandInput.fields })),
  _meta: Meta
})

export const NewSessionRequest = Schema.Struct({
  cwd: Schema.String,
  additionalDirectories: Schema.optionalKey(Schema.Array(Schema.String)),
  mcpServers: Schema.optionalKey(McpServers),
  _meta: Meta
})

export const NewSessionResponse = Schema.Struct({
  sessionId: Schema.String,
  configOptions: Schema.optionalKey(Schema.Array(SessionConfigOption)),
  availableCommands: Schema.optionalKey(Schema.Array(AvailableCommand)),
  _meta: Meta
})

export const NewSession = request("session/new", NewSessionRequest, NewSessionResponse)

export const ReplayFrom = Schema.Struct({ type: Schema.String, _meta: Meta })

export const ResumeSessionRequest = Schema.Struct({
  sessionId: Schema.String,
  cwd: Schema.String,
  additionalDirectories: Schema.optionalKey(Schema.Array(Schema.String)),
  mcpServers: Schema.optionalKey(McpServers),
  replayFrom: optNull(ReplayFrom),
  _meta: Meta
})

export const ResumeSessionResponse = Schema.Struct({
  configOptions: Schema.optionalKey(Schema.Array(SessionConfigOption)),
  availableCommands: Schema.optionalKey(Schema.Array(AvailableCommand)),
  _meta: Meta
})

export const ResumeSession = request("session/resume", ResumeSessionRequest, ResumeSessionResponse)
export const ListSessions = request("session/list", ListSessionsRequest, ListSessionsResponse)
export const CloseSession = request("session/close", SessionIdParams, EmptyResponse)

export const SetSessionConfigOption = request(
  "session/set_config_option",
  Schema.Struct({
    sessionId: Schema.String,
    configId: Schema.String,
    type: Schema.String,
    value: Schema.Union([Schema.String, Schema.Boolean]),
    _meta: Meta
  }),
  Schema.Struct({ configOptions: Schema.Array(SessionConfigOption), _meta: Meta })
)

export const Prompt = request(
  "session/prompt",
  Schema.Struct({ sessionId: Schema.String, prompt: Schema.Array(ContentBlock), _meta: Meta }),
  Schema.Struct({ messageId: Schema.String, _meta: Meta })
)

export const Cancel = notification("session/cancel", SessionIdParams)

// ---------------------------------------------------------------------------
// session/update (agent -> client)
// ---------------------------------------------------------------------------

export const ToolCallStatus = Schema.Literals(["pending", "in_progress", "completed", "failed", "cancelled"])
export type ToolCallStatus = typeof ToolCallStatus.Type

export const DiffChange = Schema.Union([
  Schema.Struct({
    operation: Schema.Literals(["add", "delete", "modify"]),
    path: Schema.String,
    fileType: optNull(Schema.String),
    mimeType: optNull(Schema.String),
    _meta: Meta
  }),
  Schema.Struct({
    operation: Schema.Literals(["move", "copy"]),
    oldPath: Schema.String,
    path: Schema.String,
    fileType: optNull(Schema.String),
    mimeType: optNull(Schema.String),
    _meta: Meta
  })
])
export type DiffChange = typeof DiffChange.Type

export const ToolCallContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("content"), content: ContentBlock, _meta: Meta }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    changes: Schema.Array(DiffChange),
    patch: optNull(Schema.Struct({ format: Schema.String, text: Schema.String })),
    _meta: Meta
  }),
  Schema.Struct({ type: Schema.Literal("terminal"), terminalId: Schema.String, _meta: Meta })
])
export type ToolCallContent = typeof ToolCallContent.Type

export const ToolCallUpdateFields = {
  toolCallId: Schema.String,
  name: optNull(Schema.String),
  title: optNull(Schema.String),
  kind: optNull(ToolKind),
  status: optNull(ToolCallStatus),
  content: optNull(Schema.Array(ToolCallContent)),
  locations: optNull(Schema.Array(ToolCallLocation)),
  rawInput: Schema.optionalKey(Schema.Unknown),
  rawOutput: Schema.optionalKey(Schema.Unknown),
  _meta: Meta
}

export const ToolCallUpdate = Schema.Struct(ToolCallUpdateFields)
export type ToolCallUpdate = typeof ToolCallUpdate.Type

export const ErrorDetails = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown)
})

export const StopReason = Schema.Literals([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
  "error"
])
export type StopReason = typeof StopReason.Type

export const PlanEntry = Schema.Struct({
  content: Schema.String,
  priority: PlanEntryPriority,
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
  _meta: Meta
})

const chunk = <L extends string>(tag: L) =>
  Schema.Struct({ sessionUpdate: Schema.Literal(tag), messageId: Schema.String, content: ContentBlock, _meta: Meta })

const upsert = <L extends string>(tag: L) =>
  Schema.Struct({
    sessionUpdate: Schema.Literal(tag),
    messageId: Schema.String,
    content: optNull(Schema.Array(ContentBlock)),
    _meta: Meta
  })

export const SessionUpdate = Schema.Union([
  chunk("user_message_chunk"),
  chunk("agent_message_chunk"),
  chunk("agent_thought_chunk"),
  upsert("user_message"),
  upsert("agent_message"),
  upsert("agent_thought"),
  Schema.Struct({
    sessionUpdate: Schema.Literal("state_update"),
    state: Schema.Literals(["running", "requires_action"]),
    _meta: Meta
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("state_update"),
    state: Schema.Literal("idle"),
    stopReason: optNull(StopReason),
    error: optNull(ErrorDetails),
    _meta: Meta
  }),
  Schema.Struct({ sessionUpdate: Schema.Literal("tool_call_update"), ...ToolCallUpdateFields }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call_content_chunk"),
    toolCallId: Schema.String,
    content: ToolCallContent,
    _meta: Meta
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("terminal_update"),
    terminalId: Schema.String,
    command: optNull(Schema.String),
    cwd: optNull(Schema.String),
    output: optNull(Schema.Struct({ data: Schema.String })),
    exitStatus: optNull(Schema.Struct({ exitCode: optNull(Schema.Int), signal: optNull(Schema.String) })),
    _meta: Meta
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("plan_update"),
    plan: Schema.Struct({
      type: Schema.Literal("items"),
      planId: Schema.String,
      entries: Schema.Array(PlanEntry),
      _meta: Meta
    }),
    _meta: Meta
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("available_commands_update"),
    availableCommands: Schema.Array(AvailableCommand),
    _meta: Meta
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("config_option_update"),
    configOptions: Schema.Array(SessionConfigOption),
    _meta: Meta
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("session_info_update"),
    title: optNull(Schema.String),
    updatedAt: optNull(Schema.String),
    _meta: Meta
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("usage_update"),
    used: Schema.Int,
    size: Schema.Int,
    cost: optNull(UsageCost),
    _meta: Meta
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("notice"),
    severity: Schema.String,
    title: Schema.String,
    description: optNull(Schema.String),
    _meta: Meta
  })
])
export type SessionUpdate = typeof SessionUpdate.Type

export const Update = notification(
  "session/update",
  Schema.Struct({ sessionId: Schema.String, update: SessionUpdate, _meta: Meta })
)

export const RequestPermission = request(
  "session/request_permission",
  Schema.Struct({
    sessionId: Schema.String,
    title: Schema.String,
    description: optNull(Schema.String),
    subject: optNull(Schema.Union([
      Schema.Struct({ type: Schema.Literal("tool_call"), toolCall: ToolCallUpdate, _meta: Meta }),
      Schema.Struct({
        type: Schema.Literal("command"),
        command: Schema.String,
        cwd: Schema.String,
        toolCallId: optNull(Schema.String),
        terminalId: optNull(Schema.String),
        _meta: Meta
      })
    ])),
    options: Schema.Array(PermissionOption),
    _meta: Meta
  }),
  RequestPermissionResponse
)
