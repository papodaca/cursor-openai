import { ApiError } from "../errors.ts"

export type OpenAIChatMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type OpenAIChatCompletionRequest = {
  model: string
  messages: OpenAIChatMessage[]
  stream: boolean
  temperature?: number
  maxOutputTokens?: number
  stopSequences?: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function extractTextContent(content: unknown, role: string): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) {
    throw new ApiError(
      `Message role "${role}" must have string or text-part array content.`,
      400,
    )
  }

  const texts: string[] = []
  for (const part of content) {
    if (!isPlainObject(part)) {
      throw new ApiError(`Invalid content part in role "${role}".`, 400)
    }
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text)
      continue
    }
    throw new ApiError(
      `Unsupported content part type in role "${role}" (MVP is text-only).`,
      400,
      "invalid_request_error",
      "unsupported_content",
    )
  }
  return texts.join("")
}

export function parseChatCompletionRequest(body: unknown): OpenAIChatCompletionRequest {
  if (!isPlainObject(body)) {
    throw new ApiError("Request body must be a JSON object.", 400)
  }

  if ("tools" in body || "functions" in body) {
    throw new ApiError(
      "Tool/function calling is not supported in this MVP. Send text-only chat completions.",
      400,
      "invalid_request_error",
      "tools_not_supported",
    )
  }

  if ("function_call" in body) {
    throw new ApiError(
      "function_call is not supported in this MVP.",
      400,
      "invalid_request_error",
      "tools_not_supported",
    )
  }

  if ("tool_choice" in body && body.tool_choice !== undefined && body.tool_choice !== "none") {
    throw new ApiError(
      "tool_choice is not supported in this MVP (omit it or set to \"none\").",
      400,
      "invalid_request_error",
      "tools_not_supported",
    )
  }

  if (typeof body.model !== "string" || body.model.trim() === "") {
    throw new ApiError("Field \"model\" is required and must be a non-empty string.", 400)
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ApiError("Field \"messages\" is required and must be a non-empty array.", 400)
  }

  const messages: OpenAIChatMessage[] = []
  for (const raw of body.messages) {
    if (!isPlainObject(raw)) {
      throw new ApiError("Each message must be an object.", 400)
    }
    const role = raw.role
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new ApiError(
        `Unsupported message role "${String(role)}" (MVP supports system, user, assistant).`,
        400,
      )
    }
    messages.push({
      role,
      content: extractTextContent(raw.content, role),
    })
  }

  let temperature: number | undefined
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) {
      throw new ApiError("Field \"temperature\" must be a number.", 400)
    }
    temperature = body.temperature
  }

  let maxOutputTokens: number | undefined
  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new ApiError("max_tokens / max_completion_tokens must be a positive integer.", 400)
    }
    maxOutputTokens = maxTokens
  }

  let stopSequences: string[] | undefined
  if (body.stop !== undefined) {
    if (typeof body.stop === "string") {
      stopSequences = [body.stop]
    } else if (Array.isArray(body.stop) && body.stop.every((s) => typeof s === "string")) {
      stopSequences = body.stop as string[]
    } else {
      throw new ApiError("Field \"stop\" must be a string or array of strings.", 400)
    }
  }

  return {
    model: body.model.trim(),
    messages,
    stream: body.stream === true,
    temperature,
    maxOutputTokens,
    stopSequences,
  }
}
