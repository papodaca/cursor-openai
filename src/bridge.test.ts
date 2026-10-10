import { describe, expect, test } from "bun:test"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { handleChatCompletion, toCallOptions } from "./bridge.ts"
import type { OpenAIChatCompletionRequest } from "./openai/request.ts"

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: undefined,
      text: undefined,
      reasoning: undefined,
    },
  }
}

function mockModel(parts: LanguageModelV3StreamPart[]): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate(_options: LanguageModelV3CallOptions) {
      let text = ""
      const toolCalls: Array<{
        type: "tool-call"
        toolCallId: string
        toolName: string
        input: string
      }> = []
      let finishReason: LanguageModelV3FinishReason = {
        unified: "stop",
        raw: undefined,
      }
      let usage: LanguageModelV3Usage = {
        inputTokens: {
          total: 3,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: 2,
          text: undefined,
          reasoning: undefined,
        },
      }
      for (const part of parts) {
        if (part.type === "text-delta") text += part.delta
        if (part.type === "tool-call") {
          toolCalls.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
        }
        if (part.type === "finish") {
          finishReason = part.finishReason
          usage = part.usage
        }
      }
      return {
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...toolCalls,
        ],
        finishReason,
        usage,
        warnings: [],
      }
    },
    async doStream(_options: LanguageModelV3CallOptions) {
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }
    },
  }
}

/** Model whose stream pauses between parts, mimicking upstream "thinking" silence. */
function delayedModel(
  entries: Array<{ afterMs: number; part: LanguageModelV3StreamPart }>,
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate(_options: LanguageModelV3CallOptions) {
      throw new Error("not implemented")
    },
    async doStream(_options: LanguageModelV3CallOptions) {
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async start(controller) {
            for (const entry of entries) {
              await new Promise((r) => setTimeout(r, entry.afterMs))
              controller.enqueue(entry.part)
            }
            controller.close()
          },
        }),
      }
    },
  }
}

const baseRequest: OpenAIChatCompletionRequest = {
  model: "composer-2.5",
  messages: [{ role: "user", content: "Hi" }],
  stream: false,
}

describe("handleChatCompletion", () => {
  test("non-stream returns chat.completion", async () => {
    const model = mockModel([
      { type: "text-delta", id: "0", delta: "Hello" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 1,
            text: undefined,
            reasoning: undefined,
          },
        },
      },
    ])
    const res = await handleChatCompletion({ model, request: baseRequest })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      choices: Array<{ message: { content: string }; finish_reason: string }>
    }
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0]?.message.content).toBe("Hello")
    expect(body.choices[0]?.finish_reason).toBe("stop")
  })

  test("stream ends with [DONE]", async () => {
    const model = mockModel([
      { type: "text-delta", id: "0", delta: "Hi" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: emptyUsage(),
      },
    ])
    const res = await handleChatCompletion({
      model,
      request: { ...baseRequest, stream: true },
    })
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("data: ")
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
    expect(text).toContain('"content":"Hi"')
  })

  test("non-stream maps tool_calls", async () => {
    const model = mockModel([
      {
        type: "tool-call",
        toolCallId: "cursor_sess_1",
        toolName: "get_weather",
        input: JSON.stringify({ city: "SF" }),
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: emptyUsage(),
      },
    ])
    const res = await handleChatCompletion({
      model,
      request: {
        ...baseRequest,
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      },
    })
    const body = (await res.json()) as {
      choices: Array<{
        finish_reason: string
        message: {
          content: string | null
          tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>
        }
      }>
    }
    expect(body.choices[0]?.finish_reason).toBe("tool_calls")
    expect(body.choices[0]?.message.content).toBeNull()
    expect(body.choices[0]?.message.tool_calls[0]?.function.name).toBe("get_weather")
    expect(body.choices[0]?.message.tool_calls[0]?.function.arguments).toContain("SF")
  })

  test("stream emits SSE heartbeat comments during upstream silence", async () => {
    // Regression: Bun.serve kills connections idle >10s mid-stream; clients then
    // see truncated chunked responses. Heartbeats must keep the wire busy.
    const model = delayedModel([
      { afterMs: 90, part: { type: "text-delta", id: "0", delta: "late" } },
      {
        afterMs: 5,
        part: {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: emptyUsage(),
        },
      },
    ])
    const res = await handleChatCompletion({
      model,
      request: { ...baseRequest, stream: true },
      heartbeatIntervalMs: 20,
    })
    const text = await res.text()
    const heartbeatAt = text.indexOf(": keep-alive")
    const deltaAt = text.indexOf('"content":"late"')
    expect(heartbeatAt).toBeGreaterThanOrEqual(0)
    expect(deltaAt).toBeGreaterThan(heartbeatAt)
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
  })

  test("stream without upstream silence has no heartbeat comments", async () => {
    const model = mockModel([
      { type: "text-delta", id: "0", delta: "Hi" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: emptyUsage(),
      },
    ])
    const res = await handleChatCompletion({
      model,
      request: { ...baseRequest, stream: true },
      heartbeatIntervalMs: 20,
    })
    const text = await res.text()
    expect(text).not.toContain(": keep-alive")
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
  })

  test("stream emits tool_calls argument deltas", async () => {
    const model = mockModel([
      {
        type: "tool-input-start",
        id: "cursor_sess_1",
        toolName: "get_weather",
      },
      {
        type: "tool-input-delta",
        id: "cursor_sess_1",
        delta: '{"city":',
      },
      {
        type: "tool-input-delta",
        id: "cursor_sess_1",
        delta: '"SF"}',
      },
      {
        type: "tool-input-end",
        id: "cursor_sess_1",
      },
      {
        type: "tool-call",
        toolCallId: "cursor_sess_1",
        toolName: "get_weather",
        input: '{"city":"SF"}',
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: emptyUsage(),
      },
    ])
    const res = await handleChatCompletion({
      model,
      request: { ...baseRequest, stream: true },
    })
    const text = await res.text()
    expect(text).toContain('"tool_calls"')
    expect(text).toContain('"name":"get_weather"')
    expect(text).toContain('\\"city\\"')
    expect(text).toContain('\\"SF\\"')
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
  })
})

describe("toCallOptions", () => {
  test("maps tools and tool results into V3 prompt", () => {
    const options = toCallOptions(
      {
        model: "composer-2.5",
        stream: false,
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Weather lookup",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
        toolChoice: "auto",
        messages: [
          { role: "user", content: "Weather in SF?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "cursor_sess_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"SF"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "cursor_sess_1",
            content: "68F and sunny",
          },
        ],
      },
      undefined,
      { "x-opencode-session": "conv-1" },
    )

    expect(options.tools?.[0]?.name).toBe("get_weather")
    expect(options.toolChoice).toEqual({ type: "auto" })
    expect(options.headers?.["x-opencode-session"]).toBe("conv-1")

    const assistant = options.prompt.find((m) => m.role === "assistant")
    expect(assistant?.role).toBe("assistant")
    if (assistant?.role === "assistant") {
      const call = assistant.content.find((p) => p.type === "tool-call")
      expect(call).toMatchObject({
        type: "tool-call",
        toolCallId: "cursor_sess_1",
        toolName: "get_weather",
      })
    }

    const user = options.prompt.find((m) => m.role === "user")
    expect(user?.role).toBe("user")
    if (user?.role === "user") {
      expect(user.content).toEqual([{ type: "text", text: "Weather in SF?" }])
    }

    const tool = options.prompt.find((m) => m.role === "tool")
    expect(tool?.role).toBe("tool")
    if (tool?.role === "tool") {
      expect(tool.content[0]).toMatchObject({
        type: "tool-result",
        toolCallId: "cursor_sess_1",
        toolName: "get_weather",
        output: { type: "text", value: "68F and sunny" },
      })
    }
  })

  test("maps image_url parts onto file parts", () => {
    const options = toCallOptions({
      model: "composer-2.5",
      stream: false,
      messages: [
        {
          role: "user",
          content: "",
          images: [
            { url: "data:image/png;base64,aaaa", mediaType: "image/png" },
            { url: "https://example.com/cat.png", mediaType: "image/*" },
          ],
        },
      ],
    })
    const user = options.prompt[0]
    expect(user?.role).toBe("user")
    if (user?.role !== "user") return
    expect(user.content[0]).toEqual({
      type: "file",
      mediaType: "image/png",
      data: "data:image/png;base64,aaaa",
    })
    expect(user.content[1]).toMatchObject({ type: "file", mediaType: "image/*" })
    if (user.content[1]?.type === "file") {
      expect(user.content[1].data).toBeInstanceOf(URL)
      expect(String(user.content[1].data)).toBe("https://example.com/cat.png")
    }
  })
})
