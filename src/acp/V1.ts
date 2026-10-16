/**
 * ACP protocol version 1 (stable, schema 1.26.0): the subset of the wire
 * surface this agent implements or calls.
 *
 * Inputs are decoded leniently (unknown keys are dropped); outputs only carry
 * fields defined by the spec.
 */
import { Schema } from "effect"
import { notification, request } from "../jsonrpc/Method.ts"
import {
  AvailableCommandInput,
  ContentBlock,
  EmptyResponse,
  Implementation,
  ListSessionsRequest,
  ListSessionsResponse,
  Meta,
  optNull,
  PermissionOption,
  PlanEntryPriority,
  RequestPermissionResponse,
  SessionIdParams,
  StopReasonV1,
  ToolCallLocation,
  ToolKind,
  UsageCost
} from "./Content.ts"

export const PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

const Marker = optNull(Schema.Struct({}))

export const ClientCapabilities = Schema.Struct({
  fs: Schema.optionalKey(Schema.Struct({
    readTextFile: Schema.optionalKey(Schema.Boolean),
    writeTextFile: Schema.optionalKey(Schema.Boolean)
  })),
  terminal: Schema.optionalKey(Schema.Boolean),
  session: optNull(Schema.Struct({
    configOptions: optNull(Schema.Struct({ boolean: Marker })),
    notices: Marker,
    compaction: Marker
  })),
  auth: Schema.optionalKey(Schema.Struct({ terminal: Schema.optionalKey(Schema.Boolean) })),
  elicitation: optNull(Schema.Struct({ form: Marker, url: Marker })),
  _meta: Meta
})
export type ClientCapabilities = typeof ClientCapabilities.Type

export const InitializeRequest = Schema.Struct({
  protocolVersion: Schema.Int,
  clientCapabilities: Schema.optionalKey(ClientCapabilities),
  clientInfo: optNull(Implementation),
  _meta: Meta
})
export type InitializeRequest = typeof InitializeRequest.Type

export const AgentCapabilities = Schema.Struct({
  loadSession: Schema.optionalKey(Schema.Boolean),
  promptCapabilities: Schema.optionalKey(Schema.Struct({
    image: Schema.optionalKey(Schema.Boolean),
    audio: Schema.optionalKey(Schema.Boolean),
    embeddedContext: Schema.optionalKey(Schema.Boolean)
  })),
  mcpCapabilities: Schema.optionalKey(Schema.Struct({
    http: Schema.optionalKey(Schema.Boolean),
    sse: Schema.optionalKey(Schema.Boolean)
  })),
  sessionCapabilities: Schema.optionalKey(Schema.Struct({
    list: Marker,
    delete: Marker,
    additionalDirectories: Marker,
    resume: Marker,
    close: Marker
  })),
  auth: Schema.optionalKey(Schema.Struct({ logout: Marker })),
  _meta: Meta
})

export const AuthMethod = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("terminal"),
    id: Schema.String,
    name: Schema.String,
    description: optNull(Schema.String),
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    _meta: Meta
  }),
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: optNull(Schema.String),
    _meta: Meta
  })
])

export const InitializeResponse = Schema.Struct({
  protocolVersion: Schema.Int,
  agentCapabilities: AgentCapabilities,
  authMethods: Schema.Array(AuthMethod),
  agentInfo: Implementation,
  _meta: Meta
})

export const Initialize = request("initialize", InitializeRequest, InitializeResponse)

export const Authenticate = request(
  "authenticate",
  Schema.Struct({ methodId: Schema.String, _meta: Meta }),
  EmptyResponse
)

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** MCP server configs are accepted and recorded; their shape is not interpreted here. */
const McpServers = Schema.Array(Schema.Unknown)

export const SessionMode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: optNull(Schema.String),
  _meta: Meta
})

export const SessionModeState = Schema.Struct({
  currentModeId: Schema.String,
  availableModes: Schema.Array(SessionMode),
  _meta: Meta
})

export const SelectOption = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  description: optNull(Schema.String),
  _meta: Meta
})

export const ConfigOptionCategory = Schema.String

export const SessionConfigOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("select"),
    id: Schema.String,
    name: Schema.String,
    description: optNull(Schema.String),
    category: optNull(ConfigOptionCategory),
    currentValue: Schema.String,
    options: Schema.Array(SelectOption),
    _meta: Meta
  }),
  Schema.Struct({
    type: Schema.Literal("boolean"),
    id: Schema.String,
    name: Schema.String,
    description: optNull(Schema.String),
    category: optNull(ConfigOptionCategory),
    currentValue: Schema.Boolean,
    _meta: Meta
  })
])
export type SessionConfigOption = typeof SessionConfigOption.Type

export const NewSessionRequest = Schema.Struct({
  cwd: Schema.String,
  additionalDirectories: Schema.optionalKey(Schema.Array(Schema.String)),
  mcpServers: Schema.optionalKey(McpServers),
  _meta: Meta
})

export const NewSessionResponse = Schema.Struct({
  sessionId: Schema.String,
  modes: optNull(SessionModeState),
  configOptions: optNull(Schema.Array(SessionConfigOption)),
  _meta: Meta
})

export const NewSession = request("session/new", NewSessionRequest, NewSessionResponse)

export const LoadSessionRequest = Schema.Struct({
  sessionId: Schema.String,
  cwd: Schema.String,
  additionalDirectories: Schema.optionalKey(Schema.Array(Schema.String)),
  mcpServers: Schema.optionalKey(McpServers),
  _meta: Meta
})

export const LoadSessionResponse = Schema.Struct({
  modes: optNull(SessionModeState),
  configOptions: optNull(Schema.Array(SessionConfigOption)),
  _meta: Meta
})

export const LoadSession = request("session/load", LoadSessionRequest, LoadSessionResponse)
export const ResumeSession = request("session/resume", LoadSessionRequest, LoadSessionResponse)
export const ListSessions = request("session/list", ListSessionsRequest, ListSessionsResponse)
export const CloseSession = request("session/close", SessionIdParams, EmptyResponse)

export const SetSessionMode = request(
  "session/set_mode",
  Schema.Struct({ sessionId: Schema.String, modeId: Schema.String, _meta: Meta }),
  EmptyResponse
)

export const SetSessionConfigOptionRequest = Schema.Union([
  Schema.Struct({
    sessionId: Schema.String,
    configId: Schema.String,
    type: Schema.Literal("boolean"),
    value: Schema.Boolean,
    _meta: Meta
  }),
  Schema.Struct({
    sessionId: Schema.String,
    configId: Schema.String,
    value: Schema.String,
    _meta: Meta
  })
])

export const SetSessionConfigOption = request(
  "session/set_config_option",
  SetSessionConfigOptionRequest,
  Schema.Struct({ configOptions: Schema.Array(SessionConfigOption), _meta: Meta })
)

export const PromptRequest = Schema.Struct({
  sessionId: Schema.String,
  prompt: Schema.Array(ContentBlock),
  _meta: Meta
})

export const Prompt = request(
  "session/prompt",
  PromptRequest,
  Schema.Struct({ stopReason: StopReasonV1, _meta: Meta })
)

export const Cancel = notification("session/cancel", SessionIdParams)

// ---------------------------------------------------------------------------
// session/update (agent -> client)
// ---------------------------------------------------------------------------

export const ToolCallStatus = Schema.Literals(["pending", "in_progress", "completed", "failed"])
export type ToolCallStatus = typeof ToolCallStatus.Type

export const ToolCallContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("content"), content: ContentBlock, _meta: Meta }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    path: Schema.String,
    oldText: optNull(Schema.String),
    newText: Schema.String,
    _meta: Meta
  }),
  Schema.Struct({ type: Schema.Literal("terminal"), terminalId: Schema.String, _meta: Meta })
])
export type ToolCallContent = typeof ToolCallContent.Type

export const ToolCallUpdateFields = {
  toolCallId: Schema.String,
  title: optNull(Schema.String),
  name: optNull(Schema.String),
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

const chunk = <L extends string>(tag: L) =>
  Schema.Struct({
    sessionUpdate: Schema.Literal(tag),
    content: ContentBlock,
    messageId: optNull(Schema.String),
    _meta: Meta
  })

export const PlanEntry = Schema.Struct({
  content: Schema.String,
  priority: PlanEntryPriority,
  status: Schema.Literals(["pending", "in_progress", "completed"]),
  _meta: Meta
})

export const AvailableCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input: optNull(AvailableCommandInput),
  _meta: Meta
})

export const SessionUpdate = Schema.Union([
  chunk("user_message_chunk"),
  chunk("agent_message_chunk"),
  chunk("agent_thought_chunk"),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call"),
    toolCallId: Schema.String,
    title: Schema.String,
    name: optNull(Schema.String),
    kind: Schema.optionalKey(ToolKind),
    status: Schema.optionalKey(ToolCallStatus),
    content: Schema.optionalKey(Schema.Array(ToolCallContent)),
    locations: Schema.optionalKey(Schema.Array(ToolCallLocation)),
    rawInput: Schema.optionalKey(Schema.Unknown),
    rawOutput: Schema.optionalKey(Schema.Unknown),
    _meta: Meta
  }),
  Schema.Struct({ sessionUpdate: Schema.Literal("tool_call_update"), ...ToolCallUpdateFields }),
  Schema.Struct({ sessionUpdate: Schema.Literal("plan"), entries: Schema.Array(PlanEntry), _meta: Meta }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("available_commands_update"),
    availableCommands: Schema.Array(AvailableCommand),
    _meta: Meta
  }),
  Schema.Struct({ sessionUpdate: Schema.Literal("current_mode_update"), currentModeId: Schema.String, _meta: Meta }),
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

export const SessionNotification = Schema.Struct({
  sessionId: Schema.String,
  update: SessionUpdate,
  _meta: Meta
})

export const Update = notification("session/update", SessionNotification)

export const RequestPermission = request(
  "session/request_permission",
  Schema.Struct({
    sessionId: Schema.String,
    toolCall: ToolCallUpdate,
    options: Schema.Array(PermissionOption),
    _meta: Meta
  }),
  RequestPermissionResponse
)
