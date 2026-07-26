import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3Prompt,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type { OpenAIChatCompletionRequest } from "./openai/request.ts"
import {
  chatCompletionChunk,
  chatCompletionResponse,
  completionId,
  mapFinishReason,
  mapUsage,
  sseData,
} from "./openai/response.ts"
import { corsHeaders } from "./errors.ts"

function toPrompt(req: OpenAIChatCompletionRequest): LanguageModelV3Prompt {
  return req.messages.map((message) => {
    if (message.role === "system") {
      return { role: "system" as const, content: message.content }
    }
    if (message.role === "user") {
      return {
        role: "user" as const,
        content: [{ type: "text" as const, text: message.content }],
      }
    }
    return {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: message.content }],
    }
  })
}

function toCallOptions(
  req: OpenAIChatCompletionRequest,
  abortSignal?: AbortSignal,
): LanguageModelV3CallOptions {
  return {
    prompt: toPrompt(req),
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
    stopSequences: req.stopSequences,
    abortSignal,
  }
}

function textFromGenerateContent(
  content: Awaited<ReturnType<LanguageModelV3["doGenerate"]>>["content"],
): string {
  const parts: string[] = []
  for (const part of content) {
    if (part.type === "text") parts.push(part.text)
  }
  return parts.join("")
}

export async function handleChatCompletion(args: {
  model: LanguageModelV3
  request: OpenAIChatCompletionRequest
  abortSignal?: AbortSignal
}): Promise<Response> {
  const { model, request, abortSignal } = args
  const options = toCallOptions(request, abortSignal)
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)

  if (!request.stream) {
    const result = await model.doGenerate(options)
    const body = chatCompletionResponse({
      id,
      model: request.model,
      created,
      content: textFromGenerateContent(result.content),
      finishReason: mapFinishReason(result.finishReason),
      usage: mapUsage(result.usage),
    })
    return Response.json(body, { headers: corsHeaders() })
  }

  const { stream } = await model.doStream(options)
  const encoder = new TextEncoder()

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (payload: unknown) => {
        controller.enqueue(encoder.encode(sseData(payload)))
      }

      enqueue(
        chatCompletionChunk({
          id,
          model: request.model,
          created,
          delta: { role: "assistant", content: "" },
        }),
      )

      let finishReason: LanguageModelV3FinishReason | undefined
      let usage: LanguageModelV3Usage | undefined

      try {
        for await (const part of stream) {
          if (abortSignal?.aborted) break

          if (part.type === "text-delta") {
            enqueue(
              chatCompletionChunk({
                id,
                model: request.model,
                created,
                delta: { content: part.delta },
              }),
            )
          } else if (part.type === "finish") {
            finishReason = part.finishReason
            usage = part.usage
          } else if (part.type === "error") {
            throw part.error instanceof Error
              ? part.error
              : new Error(String(part.error))
          }
        }

        enqueue(
          chatCompletionChunk({
            id,
            model: request.model,
            created,
            delta: {},
            finishReason: mapFinishReason(finishReason) ?? "stop",
            usage: mapUsage(usage),
          }),
        )
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
    cancel() {
      // Client disconnected; AbortSignal on the request should stop upstream work.
    },
  })

  return new Response(readable, {
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
