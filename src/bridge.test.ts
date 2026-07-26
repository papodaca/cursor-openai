import { describe, expect, test } from "bun:test"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { handleChatCompletion } from "./bridge.ts"
import type { OpenAIChatCompletionRequest } from "./openai/request.ts"

function mockModel(parts: LanguageModelV3StreamPart[]): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate(_options: LanguageModelV3CallOptions) {
      let text = ""
      let finish = {
        unified: "stop" as const,
        raw: undefined,
      }
      let usage = {
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
        if (part.type === "finish") {
          finish = part.finishReason
          usage = part.usage
        }
      }
      return {
        content: [{ type: "text" as const, text }],
        finishReason: finish,
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
    const body = await res.json()
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0].message.content).toBe("Hello")
    expect(body.choices[0].finish_reason).toBe("stop")
  })

  test("stream ends with [DONE]", async () => {
    const model = mockModel([
      { type: "text-delta", id: "0", delta: "Hi" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: {
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
        },
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
})
