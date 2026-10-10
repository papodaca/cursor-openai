import { ApiError } from "../errors.ts"

export type OpenAIToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type OpenAIUserImage = {
  /** data:image/...;base64,... or an http(s) URL. */
  url: string
  mediaType: string
}

export type OpenAIChatMessage =
  | {
      role: "system"
      content: string
    }
  | {
      role: "user"
      content: string
      images?: OpenAIUserImage[]
    }
  | {
      role: "assistant"
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
  | {
      role: "tool"
      content: string
      tool_call_id: string
      name?: string
    }

export type OpenAIFunctionTool = {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean
  }
}

export type OpenAIToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } }

export type OpenAIChatCompletionRequest = {
  model: string
  messages: OpenAIChatMessage[]
  stream: boolean
  temperature?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  tools?: OpenAIFunctionTool[]
  toolChoice?: OpenAIToolChoice
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
    const type = typeof part.type === "string" ? part.type : "unknown"
    throw new ApiError(
      `Unsupported content part type "${type}" in role "${role}". User messages accept text and image_url.`,
      400,
      "invalid_request_error",
      "unsupported_content",
    )
  }
  return texts.join("")
}

function parseImageUrl(part: Record<string, unknown>): OpenAIUserImage {
  const imageUrl = part.image_url
  const url =
    typeof imageUrl === "string"
      ? imageUrl
      : isPlainObject(imageUrl) && typeof imageUrl.url === "string"
        ? imageUrl.url
        : undefined
  if (typeof url !== "string" || url.trim() === "") {
    throw new ApiError(
      "image_url.url is required.",
      400,
      "invalid_request_error",
      "unsupported_content",
    )
  }
  const trimmed = url.trim()
  if (trimmed.startsWith("data:")) {
    const comma = trimmed.indexOf(",")
    const meta = comma >= 0 ? trimmed.slice(5, comma) : ""
    const pieces = meta.split(";")
    const mime = pieces[0]?.toLowerCase() ?? ""
    if (!mime.startsWith("image/") || !pieces.includes("base64") || comma < 0) {
      throw new ApiError(
        "image_url data URLs must be base64-encoded image/* payloads.",
        400,
        "invalid_request_error",
        "unsupported_content",
      )
    }
    return { url: trimmed, mediaType: mime }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ApiError(
      "image_url.url must be an http(s) URL or a base64 image data URL.",
      400,
      "invalid_request_error",
      "unsupported_content",
    )
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(
      "image_url.url must be an http(s) URL or a base64 image data URL.",
      400,
      "invalid_request_error",
      "unsupported_content",
    )
  }
  return { url: trimmed, mediaType: "image/*" }
}

function extractUserMessage(content: unknown): { content: string; images?: OpenAIUserImage[] } {
  if (typeof content === "string") return { content }
  if (!Array.isArray(content)) {
    throw new ApiError('Message role "user" must have string or array content.', 400)
  }

  const texts: string[] = []
  const images: OpenAIUserImage[] = []
  for (const part of content) {
    if (!isPlainObject(part)) {
      throw new ApiError('Invalid content part in role "user".', 400)
    }
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text)
      continue
    }
    if (part.type === "image_url") {
      images.push(parseImageUrl(part))
      continue
    }
    const type = typeof part.type === "string" ? part.type : "unknown"
    throw new ApiError(
      `Unsupported content part type "${type}" in role "user". User messages accept text and image_url.`,
      400,
      "invalid_request_error",
      "unsupported_content",
    )
  }
  return {
    content: texts.join(""),
    ...(images.length > 0 ? { images } : {}),
  }
}

function parseToolCall(raw: unknown): OpenAIToolCall {
  if (!isPlainObject(raw)) {
    throw new ApiError("Each tool_call must be an object.", 400)
  }
  if (raw.type !== undefined && raw.type !== "function") {
    throw new ApiError('tool_calls[].type must be "function".', 400)
  }
  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    throw new ApiError("tool_calls[].id is required.", 400)
  }
  if (!isPlainObject(raw.function)) {
    throw new ApiError("tool_calls[].function is required.", 400)
  }
  const name = raw.function.name
  if (typeof name !== "string" || name.trim() === "") {
    throw new ApiError("tool_calls[].function.name is required.", 400)
  }
  const args = raw.function.arguments
  if (args !== undefined && typeof args !== "string") {
    throw new ApiError("tool_calls[].function.arguments must be a string.", 400)
  }
  return {
    id: raw.id,
    type: "function",
    function: {
      name: name.trim(),
      arguments: typeof args === "string" ? args : "{}",
    },
  }
}

function parseTools(raw: unknown): OpenAIFunctionTool[] {
  if (!Array.isArray(raw)) {
    throw new ApiError("Field \"tools\" must be an array.", 400)
  }
  const tools: OpenAIFunctionTool[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) {
      throw new ApiError("Each tool must be an object.", 400)
    }
    if (item.type !== "function") {
      throw new ApiError('tools[].type must be "function".', 400)
    }
    if (!isPlainObject(item.function)) {
      throw new ApiError("tools[].function is required.", 400)
    }
    const name = item.function.name
    if (typeof name !== "string" || name.trim() === "") {
      throw new ApiError("tools[].function.name is required.", 400)
    }
    const description =
      item.function.description === undefined
        ? undefined
        : typeof item.function.description === "string"
          ? item.function.description
          : (() => {
              throw new ApiError("tools[].function.description must be a string.", 400)
            })()
    let parameters: Record<string, unknown> | undefined
    if (item.function.parameters !== undefined) {
      if (!isPlainObject(item.function.parameters)) {
        throw new ApiError("tools[].function.parameters must be a JSON object (JSON Schema).", 400)
      }
      parameters = item.function.parameters
    }
    let strict: boolean | undefined
    if (item.function.strict !== undefined) {
      if (typeof item.function.strict !== "boolean") {
        throw new ApiError("tools[].function.strict must be a boolean.", 400)
      }
      strict = item.function.strict
    }
    tools.push({
      type: "function",
      function: {
        name: name.trim(),
        description,
        parameters,
        strict,
      },
    })
  }
  return tools
}

function parseToolChoice(raw: unknown): OpenAIToolChoice {
  if (raw === "none" || raw === "auto" || raw === "required") return raw
  if (!isPlainObject(raw)) {
    throw new ApiError(
      'tool_choice must be "none", "auto", "required", or { type: "function", function: { name } }.',
      400,
    )
  }
  if (raw.type !== "function" || !isPlainObject(raw.function)) {
    throw new ApiError(
      'tool_choice object must be { type: "function", function: { name } }.',
      400,
    )
  }
  const name = raw.function.name
  if (typeof name !== "string" || name.trim() === "") {
    throw new ApiError("tool_choice.function.name is required.", 400)
  }
  return { type: "function", function: { name: name.trim() } }
}

export function parseChatCompletionRequest(body: unknown): OpenAIChatCompletionRequest {
  if (!isPlainObject(body)) {
    throw new ApiError("Request body must be a JSON object.", 400)
  }

  if ("functions" in body) {
    throw new ApiError(
      'Legacy "functions" is not supported. Use "tools" instead.',
      400,
      "invalid_request_error",
      "tools_not_supported",
    )
  }

  if ("function_call" in body) {
    throw new ApiError(
      'Legacy "function_call" is not supported. Use "tool_choice" instead.',
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

    if (role === "system") {
      messages.push({
        role,
        content: extractTextContent(raw.content, role),
      })
      continue
    }

    if (role === "user") {
      messages.push({
        role,
        ...extractUserMessage(raw.content),
      })
      continue
    }

    if (role === "assistant") {
      const toolCallsRaw = raw.tool_calls
      const tool_calls =
        toolCallsRaw === undefined
          ? undefined
          : Array.isArray(toolCallsRaw)
            ? toolCallsRaw.map(parseToolCall)
            : (() => {
                throw new ApiError("assistant.tool_calls must be an array.", 400)
              })()

      let content: string | null = null
      if (raw.content === null || raw.content === undefined) {
        content = null
      } else {
        content = extractTextContent(raw.content, "assistant")
      }

      if ((content === null || content === "") && (!tool_calls || tool_calls.length === 0)) {
        throw new ApiError(
          "assistant messages require non-empty content and/or tool_calls.",
          400,
        )
      }

      messages.push({
        role: "assistant",
        content: content === "" ? null : content,
        ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
      })
      continue
    }

    if (role === "tool") {
      if (typeof raw.tool_call_id !== "string" || raw.tool_call_id.trim() === "") {
        throw new ApiError('tool messages require a non-empty "tool_call_id".', 400)
      }
      const name =
        raw.name === undefined
          ? undefined
          : typeof raw.name === "string"
            ? raw.name
            : (() => {
                throw new ApiError("tool.name must be a string.", 400)
              })()
      messages.push({
        role: "tool",
        content: extractTextContent(raw.content, "tool"),
        tool_call_id: raw.tool_call_id,
        ...(name ? { name } : {}),
      })
      continue
    }

    throw new ApiError(
      `Unsupported message role "${String(role)}" (supported: system, user, assistant, tool).`,
      400,
    )
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

  let tools: OpenAIFunctionTool[] | undefined
  if (body.tools !== undefined) {
    tools = parseTools(body.tools)
    if (tools.length === 0) tools = undefined
  }

  let toolChoice: OpenAIToolChoice | undefined
  if (body.tool_choice !== undefined) {
    toolChoice = parseToolChoice(body.tool_choice)
  }

  if (toolChoice !== undefined && toolChoice !== "none" && !tools) {
    throw new ApiError(
      "tool_choice other than \"none\" requires a non-empty tools array.",
      400,
    )
  }

  return {
    model: body.model.trim(),
    messages,
    stream: body.stream === true,
    temperature,
    maxOutputTokens,
    stopSequences,
    tools,
    toolChoice,
  }
}
