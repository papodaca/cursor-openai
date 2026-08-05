import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3ToolChoice,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIFunctionTool,
  OpenAIToolCall,
  OpenAIToolChoice,
} from "./openai/request.ts"
import {
  chatCompletionChunk,
  chatCompletionResponse,
  completionId,
  mapFinishReason,
  mapUsage,
  sseData,
} from "./openai/response.ts"
import { corsHeaders } from "./errors.ts"

function parseToolArguments(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "") return {}
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return { raw }
  }
}

function toolNameByCallId(messages: OpenAIChatMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue
    for (const call of message.tool_calls) {
      map.set(call.id, call.function.name)
    }
  }
  return map
}

function toV3Tools(tools: OpenAIFunctionTool[] | undefined): LanguageModelV3FunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: (tool.function.parameters ?? {
      type: "object",
      properties: {},
    }) as LanguageModelV3FunctionTool["inputSchema"],
    ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
  }))
}

function toV3ToolChoice(choice: OpenAIToolChoice | undefined): LanguageModelV3ToolChoice | undefined {
  if (choice === undefined) return undefined
  if (choice === "none") return { type: "none" }
  if (choice === "auto") return { type: "auto" }
  if (choice === "required") return { type: "required" }
  return { type: "tool", toolName: choice.function.name }
}

function toPrompt(req: OpenAIChatCompletionRequest): LanguageModelV3Prompt {
  const names = toolNameByCallId(req.messages)

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
    if (message.role === "assistant") {
      const content: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = []
      if (message.content) {
        content.push({ type: "text", text: message.content })
      }
      if (message.tool_calls) {
        for (const call of message.tool_calls) {
          content.push({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.function.name,
            input: parseToolArguments(call.function.arguments),
          })
        }
      }
      if (content.length === 0) {
        content.push({ type: "text", text: "" })
      }
      return { role: "assistant" as const, content }
    }

    // role === "tool"
    const toolName = message.name ?? names.get(message.tool_call_id) ?? "unknown"
    return {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: message.tool_call_id,
          toolName,
          output: { type: "text" as const, value: message.content },
        },
      ],
    }
  })
}

export function toCallOptions(
  req: OpenAIChatCompletionRequest,
  abortSignal?: AbortSignal,
  headers?: Record<string, string | undefined>,
): LanguageModelV3CallOptions {
  const tools = toV3Tools(req.tools)
  const toolChoice = toV3ToolChoice(req.toolChoice)
  return {
    prompt: toPrompt(req),
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
    stopSequences: req.stopSequences,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    abortSignal,
    ...(headers ? { headers } : {}),
  }
}

function toolCallsFromGenerateContent(
  content: Awaited<ReturnType<LanguageModelV3["doGenerate"]>>["content"],
): { text: string; toolCalls: OpenAIToolCall[] } {
  const textParts: string[] = []
  const toolCalls: OpenAIToolCall[] = []
  for (const part of content) {
    if (part.type === "text") {
      textParts.push(part.text)
      continue
    }
    if (part.type === "tool-call") {
      toolCalls.push({
        id: part.toolCallId,
        type: "function",
        function: {
          name: part.toolName,
          arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
        },
      })
    }
  }
  return { text: textParts.join(""), toolCalls }
}

/** Extract optional session id from inbound HTTP headers for sticky Cursor Runs. */
export function sessionHeadersFromRequest(reqHeaders: Headers): Record<string, string | undefined> | undefined {
  const sessionId =
    reqHeaders.get("x-session-id") ??
    reqHeaders.get("x-opencode-session") ??
    reqHeaders.get("x-conversation-id")
  if (!sessionId || sessionId.trim() === "") return undefined
  return {
    "x-opencode-session": sessionId.trim(),
  }
}

export async function handleChatCompletion(args: {
  model: LanguageModelV3
  request: OpenAIChatCompletionRequest
  abortSignal?: AbortSignal
  headers?: Record<string, string | undefined>
}): Promise<Response> {
  const { model, request, abortSignal, headers } = args
  const options = toCallOptions(request, abortSignal, headers)
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)

  if (!request.stream) {
    const result = await model.doGenerate(options)
    const { text, toolCalls } = toolCallsFromGenerateContent(result.content)
    const finishReason = mapFinishReason(result.finishReason)
    const body = chatCompletionResponse({
      id,
      model: request.model,
      created,
      content: toolCalls.length > 0 && text === "" ? null : text,
      toolCalls,
      finishReason: toolCalls.length > 0 && (finishReason === "stop" || finishReason == null)
        ? "tool_calls"
        : finishReason,
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
      const toolIndexById = new Map<string, number>()
      let nextToolIndex = 0
      let emittedToolCalls = false

      const ensureToolIndex = (toolCallId: string): number => {
        const existing = toolIndexById.get(toolCallId)
        if (existing !== undefined) return existing
        const index = nextToolIndex++
        toolIndexById.set(toolCallId, index)
        return index
      }

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
          } else if (part.type === "tool-input-start") {
            emittedToolCalls = true
            const index = ensureToolIndex(part.id)
            enqueue(
              chatCompletionChunk({
                id,
                model: request.model,
                created,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: part.id,
                      type: "function",
                      function: { name: part.toolName, arguments: "" },
                    },
                  ],
                },
              }),
            )
          } else if (part.type === "tool-input-delta") {
            emittedToolCalls = true
            const index = ensureToolIndex(part.id)
            enqueue(
              chatCompletionChunk({
                id,
                model: request.model,
                created,
                delta: {
                  tool_calls: [
                    {
                      index,
                      function: { arguments: part.delta },
                    },
                  ],
                },
              }),
            )
          } else if (part.type === "tool-call") {
            // Full tool-call part: if streaming input was already emitted for this
            // id, skip; otherwise emit a one-shot tool_calls delta (non-delta providers).
            emittedToolCalls = true
            if (toolIndexById.has(part.toolCallId)) continue
            const index = ensureToolIndex(part.toolCallId)
            const args =
              typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {})
            enqueue(
              chatCompletionChunk({
                id,
                model: request.model,
                created,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: part.toolCallId,
                      type: "function",
                      function: { name: part.toolName, arguments: args },
                    },
                  ],
                },
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

        let mapped = mapFinishReason(finishReason)
        if (emittedToolCalls && (mapped === "stop" || mapped == null)) {
          mapped = "tool_calls"
        }

        enqueue(
          chatCompletionChunk({
            id,
            model: request.model,
            created,
            delta: {},
            finishReason: mapped ?? "stop",
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
      // Note: provider keeps Cursor Runs open across tool_calls even if this HTTP
      // response ends normally — do not treat normal completion as cancel.
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