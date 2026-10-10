import type { CursorImageInput } from "../image-input.js"
import { encodeMessage, getMessageTypes } from "./messages.js"
import { toolsToMcpDescriptors, type OpencodeToolDef } from "./tools.js"

export type SeedHistoryMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type RunRequestInput = {
  text: string
  /** Raster images for UserMessage.selected_context.selected_images. */
  images?: CursorImageInput[]
  modelId: string
  conversationId: string
  systemPrompt?: string
  /**
   * Prior chat turns for a seed ConversationStateStructure (no checkpoint).
   * Tool outputs, when required for compaction/recovery, are represented as
   * user-role OpenCode host observations rather than assistant-authored prose.
   */
  history?: SeedHistoryMessage[]
  /**
   * Opaque ConversationStateStructure bytes from the last
   * conversation_checkpoint_update for this conversation_id. When set, echoed
   * as AgentRunRequest.conversation_state (CLI parity). When absent, a seed
   * state carrying only `history` (or empty) is built for turn 1.
   */
  conversationState?: Uint8Array
  parameterValues?: Array<{ id: string; value: string }>
  maxMode?: boolean
  messageId?: string
  tools?: OpencodeToolDef[]
  /** Pre-resolved descriptors (including config-backed MCP server identity). */
  toolDescriptors?: Array<Record<string, unknown>>
  /** Prebuilt RequestContext (OpenCode-sourced). */
  requestContext?: Record<string, unknown>
  /** Resume the supplied checkpoint instead of submitting another user turn. */
  action?: "user" | "resume"
}

/** Label on the always-apply rule. Not a file path. */
export const SYSTEM_INSTRUCTIONS_RULE_PATH = "System instructions"

/**
 * Cursor ignores a client-authored `system` entry in
 * `root_prompt_messages_json`, and rejects `custom_system_prompt` for normal
 * accounts. The CLI sends host instructions as an always-apply rule
 * (`CursorRuleType.global`).
 */
export function systemInstructionsRule(text: string): Record<string, unknown> {
  return {
    full_path: SYSTEM_INSTRUCTIONS_RULE_PATH,
    content: text,
    type: { global: {} },
  }
}

/**
 * Seed ConversationStateStructure for the first turn (no checkpoint yet).
 *
 * After the first checkpoint arrives we stop inventing state and echo the
 * server's opaque structure instead. Compaction resets also use this seed,
 * with `history` carrying prior turns so Cursor can continue without the old
 * checkpoint.
 *
 * System text is not seeded here. It travels as the always-apply rule from
 * `systemInstructionsRule`.
 */
export function buildSeedConversationState(input?: {
  history?: SeedHistoryMessage[]
}): Uint8Array {
  const root = getMessageTypes()
  const type = root.lookupType("ConversationStateStructure")
  const messages: string[] = []
  for (const entry of input?.history ?? []) {
    if (!entry.content || entry.role === "system") continue
    messages.push(JSON.stringify({ role: entry.role, content: entry.content }))
  }
  const obj: Record<string, unknown> = {}
  if (messages.length > 0) obj.root_prompt_messages_json = messages
  return type.encode(type.fromObject(obj)).finish()
}

/**
 * Request context this proxy is willing to send: the caller's system text as
 * one global rule, and caller tool names. No env, git, or project layout.
 * Undefined when the turn has neither.
 */
export function buildProxyRequestContext(input: {
  systemPrompt?: string
  tools?: OpencodeToolDef[]
  requestContext?: Record<string, unknown>
}): Record<string, unknown> | undefined {
  const systemText = input.systemPrompt?.trim() ? input.systemPrompt : undefined
  const tools = input.tools ?? []
  if (!systemText && tools.length === 0 && !input.requestContext) return undefined
  const context: Record<string, unknown> = { ...input.requestContext }
  if (systemText) context.rules = [systemInstructionsRule(systemText)]
  if (tools.length > 0) {
    const descriptors = toolsToMcpDescriptors(tools, "opencode", [], { namesOnly: true })
    context.mcp_meta_tool_options = {
      enabled: true,
      ...(descriptors.length > 0 ? { mcp_descriptors: descriptors } : {}),
    }
  }
  return context
}

/**
 * Build an AgentClientMessage{run_request} for a conversation turn.
 *
 * Live `user_message.text` is the current prompt only — same as Cursor CLI.
 * Cross-turn history is the last server checkpoint re-sent as conversation_state.
 */
export function buildRunRequest(input: RunRequestInput): Uint8Array {
  const msgId = input.messageId ?? crypto.randomUUID()

  // Field 4 stays empty on a real turn. Tool names ride on request_context.
  // Full schemas are answered later on exec #36 from session.toolDescriptors.
  const requestContext = buildProxyRequestContext(input)

  const userMessage: Record<string, unknown> = {
    text: input.text,
    message_id: msgId,
  }
  if (input.images && input.images.length > 0) {
    userMessage.selected_context = {
      selected_images: input.images.map((image) => ({
        data: image.data,
        uuid: crypto.randomUUID(),
        path: image.filename,
        mime_type: image.mimeType,
      })),
    }
  }
  const userMessageAction: Record<string, unknown> = { user_message: userMessage }
  if (requestContext) userMessageAction.request_context = requestContext
  const action = input.action === "resume"
    ? { resume_action: {} }
    : { user_message_action: userMessageAction }

  const conversationState =
    input.conversationState && input.conversationState.length > 0
      ? input.conversationState
      : buildSeedConversationState({ history: input.history })

  const runRequest: Record<string, unknown> = {
    conversation_id: input.conversationId,
    action,
    requested_model: {
      // The provider always selects a concrete model. Cursor's "default"
      // pseudo-model (Auto) is never used here — we send the real id plus the
      // chosen variant's parameter values.
      model_id: input.modelId,
      max_mode: input.maxMode ?? false,
      parameters: input.parameterValues ?? [],
    },
    conversation_state: conversationState,
    mcp_tools: { mcp_tools: [] },
    unknown_flag: 0,
    field_12: 0,
  }

  return encodeMessage("AgentClientMessage", {
    run_request: runRequest,
  })
}

/**
 * Build a heartbeat message.
 */
export function buildHeartbeat(): Uint8Array {
  return encodeMessage("AgentClientMessage", {
    client_heartbeat: {},
  })
}
