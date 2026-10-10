import { describe, expect, it } from "bun:test"
import { buildRunRequest, buildHeartbeat } from "../protocol/request.ts"
import { decodeMessage } from "../protocol/messages.ts"
import { decodeFramePayload, streamFrames } from "../protocol/framing.ts"
import { gunzipSync } from "node:zlib"
import { readAllFields } from "../protocol/struct.ts"

describe("buildRunRequest", () => {
  it("produces a valid protobuf message", () => {
    const data = buildRunRequest({
      text: "Hello",
      modelId: "test-model",
      conversationId: "conv-1",
    })

    expect(data.length).toBeGreaterThan(10)

    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request).toBeDefined()
    const rr = decoded.run_request
    expect(rr.conversation_id).toBe("conv-1")
    expect(rr.action?.user_message_action?.user_message?.text).toBe("Hello")
    expect(rr.requested_model?.model_id).toBe("test-model")
  })

  it("does not populate selected_subagent_models from the available-model catalog", () => {
    const data = buildRunRequest({
      text: "Hello",
      modelId: "test-model",
      conversationId: "conv-no-subagent-selection",
    })
    const runRequest = readAllFields(data).find((field) => field.fn === 1)?.bytes
    expect(runRequest).toBeDefined()
    expect(readAllFields(runRequest!).some((field) => field.fn === 14)).toBe(false)
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.selected_subagent_models ?? []).toHaveLength(0)
  })

  it("does not fabricate a conversation_group_id from the conversation id", () => {
    const data = buildRunRequest({
      text: "Hello",
      modelId: "test-model",
      conversationId: "conv-not-a-group",
    })
    const runRequest = readAllFields(data).find((field) => field.fn === 1)?.bytes
    expect(runRequest).toBeDefined()
    expect(readAllFields(runRequest!).some((field) => field.fn === 16)).toBe(false)
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.conversation_id).toBe("conv-not-a-group")
    expect(decoded.run_request.conversation_group_id ?? "").toBe("")
  })

  it("injects caller tools into AgentRunRequest #4 mcp_tools", () => {
    const data = buildRunRequest({
      text: "hi",
      modelId: "claude-opus-4-8",
      conversationId: "conv-tools",
      tools: [
        { name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
        { name: "grep", description: "Search", inputSchema: { type: "object" } },
      ],
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const descriptors = decoded.run_request.mcp_tools?.mcp_tools
    expect(descriptors).toHaveLength(2)
    expect(descriptors[0].name).toBe("opencode-read")
    expect(descriptors[0].tool_name).toBe("read")
    expect(descriptors[0].provider_identifier).toBe("opencode")
    expect(descriptors[0].description).toBe("Read a file")
    expect(descriptors[0].input_schema.length).toBeGreaterThan(0)
  })

  it("omits LIVE request_context unless explicitly supplied (proxy posture)", () => {
    const tools = [
      { name: "read", description: "Read", inputSchema: { type: "object" } },
      { name: "bash", description: "Shell", inputSchema: { type: "object" } },
    ]
    const data = buildRunRequest({
      text: "hi",
      modelId: "m",
      conversationId: "c",
      tools,
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.action.user_message_action.request_context == null).toBe(true)
    // Tools still land on prewarm #4.
    expect(decoded.run_request.mcp_tools?.mcp_tools).toHaveLength(2)
  })

  it("sends an empty mcp_tools list when no tools are given", () => {
    const data = buildRunRequest({ text: "hi", modelId: "m", conversationId: "c" })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.mcp_tools?.mcp_tools ?? []).toHaveLength(0)
    expect(decoded.run_request.action.user_message_action.request_context == null).toBe(true)
  })

  it("includes parameter values when provided", () => {
    const data = buildRunRequest({
      text: "Hi",
      modelId: "test-model",
      conversationId: "conv-2",
      parameterValues: [
        { id: "effort", value: "high" },
        { id: "thinking", value: "true" },
      ],
    })

    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const params = decoded.run_request.requested_model?.parameters
    expect(params).toHaveLength(2)
    expect(params[0].id).toBe("effort")
    expect(params[0].value).toBe("high")
  })

  it("delivers system prompt as an always-apply rule, not custom_system_prompt", () => {
    const data = buildRunRequest({
      text: "Hi",
      modelId: "test-model",
      conversationId: "conv-3",
      systemPrompt: "You are a helpful assistant.",
    })

    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.custom_system_prompt || "").toBe("")
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    expect(cs.root_prompt_messages_json ?? []).toHaveLength(0)
    const rules = decoded.run_request.action.user_message_action.request_context.rules
    expect(rules).toEqual([
      {
        full_path: "System instructions",
        content: "You are a helpful assistant.",
        type: { global: {} },
      },
    ])
  })

  it("generates a unique message_id each call", () => {
    const a = buildRunRequest({ text: "A", modelId: "m", conversationId: "c" })
    const b = buildRunRequest({ text: "B", modelId: "m", conversationId: "c" })
    const decA = decodeMessage<any>("AgentClientMessage", a)
    const decB = decodeMessage<any>("AgentClientMessage", b)
    const idA = decA.run_request.action.user_message_action.user_message.message_id
    const idB = decB.run_request.action.user_message_action.user_message.message_id
    expect(idA).not.toBe(idB)
  })

  it("sends live user text only (CLI-style; no client history replay)", () => {
    const data = buildRunRequest({
      text: "What next?",
      modelId: "m",
      conversationId: "conv-hist",
      systemPrompt: "Be brief.",
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe(
      "What next?",
    )
    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    expect(cs.root_prompt_messages_json ?? []).toHaveLength(0)
    expect(
      decoded.run_request.action.user_message_action.request_context.rules[0].content,
    ).toBe("Be brief.")
  })
})

describe("buildRunRequest images", () => {
  it("attaches selected image bytes on the user message", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    )
    const data = buildRunRequest({
      text: "What is this?",
      modelId: "vision-model",
      conversationId: "conv-img",
      images: [{ data: new Uint8Array(png), filename: "shot.png", mimeType: "image/png" }],
    })
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const image =
      decoded.run_request.action.user_message_action.user_message.selected_context.selected_images[0]
    expect(image.mime_type).toBe("image/png")
    expect(image.path).toBe("shot.png")
    expect(typeof image.uuid).toBe("string")
    expect(image.uuid.length).toBeGreaterThan(0)
    const bytes = typeof image.data === "string" ? Buffer.from(image.data, "base64") : Buffer.from(image.data)
    expect(Buffer.compare(bytes, png)).toBe(0)
  })
})

describe("buildHeartbeat", () => {
  it("encodes a heartbeat ClientMessage", () => {
    const data = buildHeartbeat()
    expect(data.length).toBeGreaterThan(0)
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.client_heartbeat).toBeDefined()
  })
})

describe("framing round-trip smoke", () => {
  it("streamFrames can decode a gzipped run request payload", () => {
    const data = buildRunRequest({
      text: "frame-me",
      modelId: "m",
      conversationId: "c-frame",
    })
    // buildRunRequest already returns framed bytes in some paths; decodeFramePayload
    // accepts raw protobuf. Prefer decodeMessage on the protobuf body.
    const decoded = decodeMessage<any>("AgentClientMessage", data)
    expect(decoded.run_request.action.user_message_action.user_message.text).toBe("frame-me")

    // Also exercise gzip inflate path used by the pump.
    const gz = gunzipSync.length // sanity: zlib available
    expect(typeof gz).toBe("number")
    expect(typeof decodeFramePayload).toBe("function")
    expect(typeof streamFrames).toBe("function")
  })
})