import type { LanguageModelV3FinishReason, LanguageModelV3Usage } from "@ai-sdk/provider"
import type { OpenAIToolCall } from "./request.ts"

export function completionId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`
}

export function mapFinishReason(
  reason: LanguageModelV3FinishReason | undefined,
): "stop" | "length" | "content_filter" | "tool_calls" | null {
  switch (reason?.unified) {
    case "stop":
      return "stop"
    case "length":
      return "length"
    case "content-filter":
      return "content_filter"
    case "tool-calls":
      return "tool_calls"
    case "error":
    case "other":
    default:
      return reason ? "stop" : null
  }
}

export function mapUsage(usage: LanguageModelV3Usage | undefined): {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
} | undefined {
  if (!usage) return undefined
  const prompt = usage.inputTokens.total ?? 0
  const completion = usage.outputTokens.total ?? 0
  if (usage.inputTokens.total == null && usage.outputTokens.total == null) {
    return undefined
  }
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  }
}

export function chatCompletionResponse(args: {
  id: string
  model: string
  created: number
  content: string | null
  toolCalls?: OpenAIToolCall[]
  finishReason: ReturnType<typeof mapFinishReason>
  usage?: ReturnType<typeof mapUsage>
}) {
  const toolCalls = args.toolCalls && args.toolCalls.length > 0 ? args.toolCalls : undefined
  const finishReason =
    args.finishReason ?? (toolCalls ? "tool_calls" : "stop")

  return {
    id: args.id,
    object: "chat.completion" as const,
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: args.content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(args.usage ? { usage: args.usage } : {}),
  }
}

export function chatCompletionChunk(args: {
  id: string
  model: string
  created: number
  delta: Record<string, unknown>
  finishReason?: ReturnType<typeof mapFinishReason>
  usage?: ReturnType<typeof mapUsage>
}) {
  return {
    id: args.id,
    object: "chat.completion.chunk" as const,
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        delta: args.delta,
        finish_reason: args.finishReason ?? null,
      },
    ],
    ...(args.usage ? { usage: args.usage } : {}),
  }
}

export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}
