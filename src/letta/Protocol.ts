/**
 * Schemas for the Letta Code App Server WebSocket protocol
 * (`letta server --listen`, app-server protocol version 1).
 *
 * Only the frames this bridge sends or reads are modelled. Decoding is lenient
 * (unknown keys are ignored) because Letta Code ships very frequently and the
 * protocol describes itself as alpha.
 */
import { Schema } from "effect"

export const SUPPORTED_PROTOCOL_VERSION = 1

const opt = Schema.optionalKey
const optNull = <S extends Schema.Constraint>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

export const PermissionMode = Schema.Literals(["standard", "acceptEdits", "unrestricted", "strict"])
export type PermissionMode = typeof PermissionMode.Type

export const RuntimeScope = Schema.Struct({
  agent_id: Schema.NullOr(Schema.String),
  conversation_id: Schema.String
})
export type RuntimeScope = typeof RuntimeScope.Type

// ---------------------------------------------------------------------------
// Commands (bridge -> App Server)
// ---------------------------------------------------------------------------

export const MessageContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image"),
    source: Schema.Struct({
      type: Schema.Literal("base64"),
      media_type: Schema.String,
      data: Schema.String
    })
  })
])
export type MessageContentPart = typeof MessageContentPart.Type

/** A controller-owned tool, executed by this bridge when Letta calls it (Letta allows 1s–300s timeouts). */
export const ExternalToolDefinition = Schema.Struct({
  name: Schema.String,
  label: opt(Schema.String),
  description: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  timeout_ms: opt(Schema.Int),
  auto_background: opt(Schema.Boolean)
})
export type ExternalToolDefinition = typeof ExternalToolDefinition.Type

export const ExternalToolsGroup = Schema.Struct({
  scope_id: opt(Schema.String),
  tools: Schema.Array(ExternalToolDefinition)
})

/** Letta accepts `text` and base64 `image` parts. */
export const ExternalToolResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({
    type: Schema.String,
    text: opt(Schema.String),
    data: opt(Schema.String),
    mimeType: opt(Schema.String)
  })),
  is_error: opt(Schema.Boolean)
})
export type ExternalToolResult = typeof ExternalToolResult.Type

export const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("app_server_info"), request_id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("runtime_start"),
    request_id: Schema.String,
    agent_id: Schema.String,
    conversation_id: opt(Schema.String),
    create_conversation: opt(Schema.Struct({ body: opt(Schema.Record(Schema.String, Schema.Unknown)) })),
    cwd: opt(Schema.String),
    mode: opt(PermissionMode),
    client_info: opt(Schema.Struct({ name: Schema.String, title: opt(Schema.String), version: opt(Schema.String) })),
    recover_approvals: opt(Schema.Boolean),
    force_device_status: opt(Schema.Boolean),
    wait_for_replay: opt(Schema.Boolean),
    external_tools: opt(Schema.Array(ExternalToolsGroup))
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_external_tools_update"),
    request_id: Schema.String,
    updates: Schema.Array(Schema.Struct({
      runtimes: Schema.Array(RuntimeScope),
      external_tools: Schema.Array(ExternalToolsGroup)
    }))
  }),
  Schema.Struct({
    type: Schema.Literal("external_tool_call_response"),
    request_id: Schema.String,
    result: opt(ExternalToolResult),
    error: opt(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal("input"),
    request_id: Schema.String,
    runtime: RuntimeScope,
    payload: Schema.Struct({
      kind: Schema.Literal("create_message"),
      messages: Schema.Array(Schema.Struct({
        role: Schema.Literal("user"),
        content: Schema.Union([Schema.String, Schema.Array(MessageContentPart)]),
        client_message_id: Schema.String
      })),
      exclude_interactive_tools: opt(Schema.Boolean)
    })
  }),
  Schema.Struct({
    type: Schema.Literal("input"),
    runtime: RuntimeScope,
    payload: Schema.Struct({
      kind: Schema.Literal("approval_response"),
      request_id: Schema.String,
      decision: Schema.Union([
        Schema.Struct({
          behavior: Schema.Literal("allow"),
          message: opt(Schema.String),
          selected_permission_suggestion_ids: opt(Schema.Array(Schema.String))
        }),
        Schema.Struct({ behavior: Schema.Literal("deny"), message: Schema.String })
      ])
    })
  }),
  Schema.Struct({ type: Schema.Literal("abort_message"), request_id: Schema.String, runtime: RuntimeScope }),
  Schema.Struct({
    type: Schema.Literal("change_device_state"),
    runtime: RuntimeScope,
    payload: Schema.Struct({ mode: opt(PermissionMode), cwd: opt(Schema.String) })
  }),
  Schema.Struct({ type: Schema.Literal("list_models"), request_id: Schema.String, force: opt(Schema.Boolean) }),
  Schema.Struct({
    type: Schema.Literal("update_model"),
    request_id: Schema.String,
    runtime: RuntimeScope,
    payload: Schema.Struct({
      model_handle: opt(Schema.String),
      model_id: opt(Schema.String),
      reasoning_effort: opt(Schema.String)
    })
  }),
  Schema.Struct({
    type: Schema.Literal("conversation_list"),
    request_id: Schema.String,
    query: opt(Schema.Record(Schema.String, Schema.Unknown))
  }),
  Schema.Struct({
    type: Schema.Literal("conversation_retrieve"),
    request_id: Schema.String,
    conversation_id: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("conversation_messages_list"),
    request_id: Schema.String,
    conversation_id: Schema.String,
    query: opt(Schema.Record(Schema.String, Schema.Unknown))
  }),
  Schema.Struct({ type: Schema.Literal("agent_retrieve"), request_id: Schema.String, agent_id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("create_agent"),
    request_id: Schema.String,
    personality: Schema.Literals(["memo", "tutorial", "blank", "linus", "kawaii"]),
    model: opt(Schema.String),
    pin_global: opt(Schema.Boolean)
  }),
  Schema.Struct({
    type: Schema.Literal("execute_command"),
    request_id: Schema.String,
    command_id: Schema.String,
    runtime: RuntimeScope,
    args: opt(Schema.String)
  }),
  Schema.Struct({ type: Schema.Literal("get_cwd_map"), request_id: Schema.String })
])
export type Command = typeof Command.Type

export const CommandJson = Schema.fromJsonString(Command)

// ---------------------------------------------------------------------------
// Frames (App Server -> bridge)
// ---------------------------------------------------------------------------

/** The routing header every frame is first decoded with. */
export const FrameHeader = Schema.Struct({
  type: Schema.String,
  request_id: opt(Schema.String),
  runtime: opt(RuntimeScope)
})
export type FrameHeader = typeof FrameHeader.Type

export const FrameJson = Schema.fromJsonString(Schema.Unknown)

/** Fields common to `<command>_response` frames. */
const response = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct({ success: opt(Schema.Boolean), error: optNull(Schema.String), ...fields })

export const AppServerInfo = response({
  backend: Schema.String,
  letta_code_version: Schema.String,
  protocol_version: Schema.Int,
  capabilities: opt(Schema.Record(Schema.String, Schema.Unknown))
})
export type AppServerInfo = typeof AppServerInfo.Type

/**
 * The model settings of an agent or conversation. Effort lives in a
 * provider-specific place: `reasoning_effort` (also under `reasoning`) for
 * OpenAI-style providers, `effort` for Anthropic.
 */
export const ModelSettings = Schema.Struct({
  provider_type: optNull(Schema.String),
  context_window_limit: optNull(Schema.Int),
  reasoning_effort: optNull(Schema.String),
  reasoning: optNull(Schema.Struct({ reasoning_effort: optNull(Schema.String) })),
  effort: optNull(Schema.String)
})
export type ModelSettings = typeof ModelSettings.Type

export const AgentState = Schema.Struct({
  id: Schema.String,
  name: optNull(Schema.String),
  model: optNull(Schema.String),
  llm_config: optNull(Schema.Struct({
    model: optNull(Schema.String),
    context_window: optNull(Schema.Int)
  })),
  model_settings: optNull(ModelSettings)
})
export type AgentState = typeof AgentState.Type

export const Conversation = Schema.Struct({
  id: Schema.String,
  agent_id: optNull(Schema.String),
  summary: optNull(Schema.String),
  description: optNull(Schema.String),
  model: optNull(Schema.String),
  model_settings: optNull(ModelSettings),
  created_at: optNull(Schema.String),
  updated_at: optNull(Schema.String),
  last_message_at: optNull(Schema.String),
  archived: optNull(Schema.Boolean)
})
export type Conversation = typeof Conversation.Type

export const RuntimeStartResponse = response({
  runtime: Schema.NullOr(RuntimeScope),
  agent: optNull(AgentState),
  conversation: optNull(Conversation),
  created: opt(Schema.Struct({ agent: Schema.Boolean, conversation: Schema.Boolean }))
})
export type RuntimeStartResponse = typeof RuntimeStartResponse.Type

export const InputAccepted = response({
  accepted: Schema.Boolean,
  disposition: opt(Schema.Literals(["started", "queued"]))
})

export const ModelEntry = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  label: Schema.String,
  description: optNull(Schema.String),
  isDefault: optNull(Schema.Boolean),
  isFeatured: optNull(Schema.Boolean),
  /** What selecting the entry applies, e.g. `reasoning_effort` and `context_window` for catalog presets. */
  updateArgs: optNull(Schema.Record(Schema.String, Schema.Unknown))
})
export type ModelEntry = typeof ModelEntry.Type

export const ListModelsResponse = response({ entries: Schema.Array(ModelEntry) })

export const UpdateModelResponse = response({
  model_id: optNull(Schema.String),
  model_handle: optNull(Schema.String),
  applied_to: optNull(Schema.String),
  model_settings: optNull(ModelSettings)
})

export const ConversationListResponse = response({ conversations: Schema.Array(Conversation) })
export const ConversationRetrieveResponse = response({ conversation: Schema.NullOr(Conversation) })

export const ConversationMessagesListResponse = response({
  messages: Schema.Array(Schema.Unknown),
  next_before: optNull(Schema.String),
  has_more: opt(Schema.Boolean)
})

export const AgentRetrieveResponse = response({ agent: Schema.NullOr(AgentState) })

export const CreateAgentResponse = response({
  agent_id: optNull(Schema.String),
  name: optNull(Schema.String),
  model: optNull(Schema.String)
})

export const ExecuteCommandResponse = response({ output: opt(Schema.String) })

export const RuntimeExternalToolsUpdateResponse = response({})

export const AbortMessageResponse = response({ aborted: opt(Schema.Boolean) })

export const GetCwdMapResponse = response({
  cwd_map: opt(Schema.Record(Schema.String, Schema.String)),
  boot_working_directory: optNull(Schema.String)
})

// --- runtime-scoped events ---

export const LettaUsage = Schema.Struct({
  prompt_tokens: optNull(Schema.Int),
  completion_tokens: optNull(Schema.Int),
  total_tokens: optNull(Schema.Int),
  context_tokens: optNull(Schema.Int)
})
export type LettaUsage = typeof LettaUsage.Type

export const TurnFinished = Schema.Struct({
  type: Schema.Literal("turn_finished"),
  runtime: RuntimeScope,
  turn_id: opt(Schema.String),
  stop_reason: Schema.String,
  run_id: optNull(Schema.String),
  error: optNull(Schema.String),
  usage: optNull(LettaUsage)
})
export type TurnFinished = typeof TurnFinished.Type

export const DiffPreview = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("advanced"),
    fileName: Schema.String,
    hunks: Schema.Array(Schema.Struct({
      oldStart: Schema.Int,
      oldLines: Schema.Int,
      newStart: Schema.Int,
      newLines: Schema.Int,
      lines: Schema.Array(Schema.Struct({
        type: Schema.Literals(["context", "add", "remove"]),
        content: Schema.String
      }))
    }))
  }),
  Schema.Struct({ mode: Schema.String, fileName: Schema.String, reason: opt(Schema.String) })
])
export type DiffPreview = typeof DiffPreview.Type

export const ControlRequest = Schema.Struct({
  type: Schema.Literal("control_request"),
  request_id: Schema.String,
  runtime: opt(RuntimeScope),
  conversation_id: opt(Schema.String),
  request: Schema.Struct({
    subtype: Schema.Literal("can_use_tool"),
    tool_name: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
    tool_call_id: Schema.String,
    permission_suggestions: opt(Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String }))),
    blocked_path: optNull(Schema.String),
    diffs: opt(Schema.Array(DiffPreview))
  })
})
export type ControlRequest = typeof ControlRequest.Type

export const LoopStatus = Schema.Struct({
  type: Schema.Literal("update_loop_status"),
  runtime: RuntimeScope,
  loop_status: Schema.Struct({
    status: Schema.String,
    active_run_ids: opt(Schema.Array(Schema.String))
  })
})
export type LoopStatus = typeof LoopStatus.Type

export const DeviceStatus = Schema.Struct({
  type: Schema.Literal("update_device_status"),
  runtime: RuntimeScope,
  device_status: Schema.Struct({
    current_permission_mode: opt(Schema.String),
    current_working_directory: optNull(Schema.String),
    supported_commands: opt(Schema.Array(Schema.String)),
    mod_commands: opt(Schema.Array(Schema.Struct({
      id: Schema.String,
      description: Schema.String,
      args: optNull(Schema.String)
    }))),
    current_available_skills: opt(Schema.Array(Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.String
    })))
  })
})
export type DeviceStatus = typeof DeviceStatus.Type

export const QueueUpdate = Schema.Struct({
  type: Schema.Literal("update_queue"),
  runtime: RuntimeScope,
  /** What is waiting to run; a finished background task reports back as a `task_notification` item. */
  queue: opt(Schema.Array(Schema.Struct({ kind: Schema.String }))),
  removed: opt(Schema.Array(Schema.Struct({
    client_message_id: Schema.String,
    disposition: Schema.String
  })))
})
export type QueueUpdate = typeof QueueUpdate.Type

/** The conversation's subagents (a full snapshot), sent whenever one changes state. */
export const SubagentState = Schema.Struct({
  type: Schema.Literal("update_subagent_state"),
  subagents: Schema.Array(Schema.Struct({
    subagent_id: Schema.String,
    status: Schema.String,
    is_background: optNull(Schema.Boolean),
    /** Silent subagents (Letta's own reflection and memory work) never report back. */
    silent: optNull(Schema.Boolean)
  }))
})
export type SubagentState = typeof SubagentState.Type

export const ExternalToolCallRequest = Schema.Struct({
  type: Schema.Literal("external_tool_call_request"),
  request_id: Schema.String,
  runtime: opt(RuntimeScope),
  scope_id: optNull(Schema.String),
  tool_call_id: Schema.String,
  tool_name: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown)
})
export type ExternalToolCallRequest = typeof ExternalToolCallRequest.Type

export const StreamDelta = Schema.Struct({
  type: Schema.Literal("stream_delta"),
  runtime: RuntimeScope,
  delta: Schema.Unknown,
  subagent_id: optNull(Schema.String)
})
export type StreamDelta = typeof StreamDelta.Type

// --- stream_delta payloads (`delta.message_type`) ---

export const DeltaHeader = Schema.Struct({ message_type: Schema.String })

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
export const MessageContent = Schema.Union([Schema.String, Schema.Array(Schema.Union([TextPart, Schema.Unknown]))])

export const AssistantDelta = Schema.Struct({
  message_type: Schema.Literal("assistant_message"),
  id: Schema.String,
  otid: optNull(Schema.String),
  run_id: optNull(Schema.String),
  seq_id: optNull(Schema.Int),
  content: MessageContent
})

export const ReasoningDelta = Schema.Struct({
  message_type: Schema.Literal("reasoning_message"),
  id: Schema.String,
  otid: optNull(Schema.String),
  run_id: optNull(Schema.String),
  seq_id: optNull(Schema.Int),
  reasoning: Schema.String
})

export const UserDelta = Schema.Struct({
  message_type: Schema.Literal("user_message"),
  id: Schema.String,
  otid: optNull(Schema.String),
  content: MessageContent
})

export const ToolCallFragment = Schema.Struct({
  tool_call_id: optNull(Schema.String),
  name: optNull(Schema.String),
  arguments: optNull(Schema.String)
})

export const ToolCallDelta = Schema.Struct({
  message_type: Schema.Literals(["tool_call_message", "approval_request_message"]),
  id: Schema.String,
  tool_call: optNull(ToolCallFragment),
  tool_calls: optNull(Schema.Union([Schema.Array(ToolCallFragment), ToolCallFragment]))
})

export const ToolReturnDelta = Schema.Struct({
  message_type: Schema.Literal("tool_return_message"),
  id: Schema.String,
  tool_call_id: Schema.String,
  status: Schema.String,
  tool_return: Schema.String,
  stdout: optNull(Schema.Array(Schema.String)),
  stderr: optNull(Schema.Array(Schema.String))
})

export const ClientToolStart = Schema.Struct({
  message_type: Schema.Literal("client_tool_start"),
  tool_call_id: Schema.String,
  tool_name: optNull(Schema.String),
  tool_args: optNull(Schema.String)
})

export const ClientToolEnd = Schema.Struct({
  message_type: Schema.Literal("client_tool_end"),
  tool_call_id: Schema.String,
  status: Schema.String
})

export const CommandEnd = Schema.Struct({
  message_type: Schema.Literals(["slash_command_end", "command_end"]),
  command_id: Schema.String,
  input: opt(Schema.String),
  output: opt(Schema.String),
  success: opt(Schema.Boolean)
})

export const StatusDelta = Schema.Struct({
  message_type: Schema.Literal("status"),
  message: Schema.String,
  level: opt(Schema.String)
})

export const RetryDelta = Schema.Struct({
  message_type: Schema.Literal("retry"),
  message: Schema.String,
  attempt: opt(Schema.Int),
  max_attempts: opt(Schema.Int)
})

export const LoopErrorDelta = Schema.Struct({
  message_type: Schema.Literal("loop_error"),
  message: Schema.String,
  stop_reason: optNull(Schema.String),
  is_terminal: opt(Schema.Boolean),
  client_message_ids: optNull(Schema.Array(Schema.String))
})

export const ErrorDelta = Schema.Struct({
  message_type: Schema.Literal("error_message"),
  message: Schema.String,
  detail: optNull(Schema.String)
})

export const UsageDelta = Schema.Struct({
  message_type: Schema.Literal("usage_statistics"),
  ...LettaUsage.fields
})
