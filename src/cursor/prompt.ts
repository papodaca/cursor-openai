import type { LanguageModelV3CallOptions, LanguageModelV3FinishReason, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import { parseExecIdFromToolCallId, type OpencodeToolDef } from "./protocol/tools.js"
import type { SeedHistoryMessage } from "./protocol/request.js"
import { turnEndedCounter } from "./usage.js"
import { trace } from "./debug.js"

export type ExtractedToolResult = {
  toolCallId: string
  sessionId: string
  execId: number
  toolName: string
  output: string
  error?: string
}

export type V3Part = LanguageModelV3StreamPart

function toolResultOutputToText(output: unknown): { text: string; isError: boolean } {
  if (output == null) return { text: "", isError: false }
  if (typeof output === "string") return { text: output, isError: false }
  const o = output as Record<string, unknown>
  const isError = typeof o.type === "string" && (o.type as string).startsWith("error")
  if (o.type === "text" || o.type === "error-text") {
    return { text: String(o.value ?? ""), isError }
  }
  if (o.type === "json" || o.type === "error-json") {
    return { text: JSON.stringify(o.value ?? null), isError }
  }
  if (o.type === "content" && Array.isArray(o.value)) {
    const text = o.value
      .map((c) => {
        const cp = c as Record<string, unknown>
        return cp.type === "text" ? String(cp.text ?? "") : ""
      })
      .join("")
    return { text, isError }
  }
  return { text: JSON.stringify(output), isError }
}

export function extractToolResults(prompt: LanguageModelV3CallOptions["prompt"]): ExtractedToolResult[] {
  const out: ExtractedToolResult[] = []
  for (const msg of prompt) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      const p = part as unknown as Record<string, unknown>
      if (p.type !== "tool-result") continue
      const toolCallId = (p.toolCallId as string) ?? ""
      const parsed = parseExecIdFromToolCallId(toolCallId)
      if (!parsed) continue
      const { text, isError } = toolResultOutputToText(p.output)
      out.push({
        toolCallId,
        sessionId: parsed.sessionId,
        execId: parsed.execId,
        toolName: (p.toolName as string) ?? "mcp",
        output: text,
        error: isError ? text : undefined,
      })
    }
  }
  return out
}

/**
 * Tool results that form a live continuation: only the trailing run of `tool`
 * messages after the last non-tool message.
 */
export function extractTrailingToolResults(
  prompt: LanguageModelV3CallOptions["prompt"],
): ExtractedToolResult[] {
  if (prompt.length === 0) return []
  let i = prompt.length - 1
  while (i >= 0 && prompt[i]!.role === "tool") i--
  if (i === prompt.length - 1) return []
  return extractToolResults(prompt.slice(i + 1))
}

export function extractSystemPrompt(prompt: LanguageModelV3CallOptions["prompt"]): string | undefined {
  const parts: string[] = []
  for (const m of prompt) {
    if (m.role === "system" && typeof m.content === "string") parts.push(m.content)
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined
}

/** Rough char→token estimate for mid-turn usage before TurnEnded arrives. */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.ceil(chars / 4)
}

/** Estimate current-request prompt tokens from the complete serialized V3 prompt. */
export function estimatePromptTokens(prompt: LanguageModelV3CallOptions["prompt"]): number {
  const serializedContent = prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (JSON.stringify(message.content) ?? ""),
    )
    .join("\n")
  return estimateTokens(serializedContent.length)
}

/** Preserve exact Cursor counters as diagnostics when they are cumulative across a multi-step Run. */
export function cursorTurnEndedProviderMetadata(te: Record<string, unknown>): {
  cursor: {
    usageVersion: number
    inputTokensRaw: number
    outputTokensRaw: number
    cacheReadRaw: number
    cacheWriteRaw: number
    reasoningTokensRaw: number
  }
} {
  return {
    cursor: {
      usageVersion: 2,
      inputTokensRaw: turnEndedCounter(te, "input_tokens"),
      outputTokensRaw: turnEndedCounter(te, "output_tokens"),
      cacheReadRaw: turnEndedCounter(te, "cache_read"),
      cacheWriteRaw: turnEndedCounter(te, "cache_write"),
      reasoningTokensRaw: turnEndedCounter(te, "reasoning_tokens"),
    },
  }
}

function formatSeedToolObservation(input: {
  toolName: string
  toolCallId: string
  output: string
  isError: boolean
}): string {
  const status = input.isError ? "error" : "ok"
  return `Tool result (tool=${input.toolName} callId=${input.toolCallId} status=${status}):\n${input.output}`
}

function extractAssistantHistoryText(msg: Record<string, unknown>): string {
  const content = msg.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const texts: string[] = []
  for (const part of content) {
    const p = part as Record<string, unknown>
    if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
      texts.push(p.text)
    }
  }
  return texts.join("\n")
}

function appendSeedHistory(
  out: SeedHistoryMessage[],
  role: SeedHistoryMessage["role"],
  content: string,
): void {
  if (!content) return
  const last = out[out.length - 1]
  if (last?.role === role) {
    last.content += `\n\n${content}`
    return
  }
  out.push({ role, content })
}

export function extractUserText(lastUser: Record<string, unknown> | undefined): string {
  if (!lastUser) return "."
  const content = lastUser.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      const p = part as Record<string, unknown>
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text)
    }
    if (texts.length > 0) return texts.join("\n")
  }
  return "."
}

/**
 * Prior prompt turns for a seed ConversationStateStructure.
 * Interrupted continuations retain only the trailing live result suffix as
 * neutral tool observations (not OpenCode host wording).
 */
export function extractPromptHistory(
  prompt: LanguageModelV3CallOptions["prompt"],
  options?: {
    preserveTrailingUser?: boolean
    toolResults?: "omit" | "trailing"
  },
): SeedHistoryMessage[] {
  const out: SeedHistoryMessage[] = []
  const toolResults = options?.toolResults ?? "omit"
  let trailingToolStart = prompt.length
  if (toolResults === "trailing") {
    while (trailingToolStart > 0 && prompt[trailingToolStart - 1]?.role === "tool") {
      trailingToolStart--
    }
  }
  for (let messageIndex = 0; messageIndex < prompt.length; messageIndex++) {
    const m = prompt[messageIndex]!
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content.length > 0) {
        out.push({ role: "system", content: m.content })
      }
      continue
    }
    if (m.role === "user") {
      const text = extractUserText(m as unknown as Record<string, unknown>)
      if (text && text !== ".") out.push({ role: "user", content: text })
      continue
    }
    if (m.role === "assistant") {
      const text = extractAssistantHistoryText(m as unknown as Record<string, unknown>)
      if (text) appendSeedHistory(out, "assistant", text)
      continue
    }
    if (m.role === "tool" && Array.isArray(m.content)) {
      if (
        toolResults === "omit" ||
        (toolResults === "trailing" && messageIndex < trailingToolStart)
      ) continue
      const results: string[] = []
      for (const part of m.content) {
        const p = part as unknown as Record<string, unknown>
        if (p.type !== "tool-result") continue
        const toolName = typeof p.toolName === "string" && p.toolName ? p.toolName : "tool"
        const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : ""
        const result = toolResultOutputToText(p.output)
        results.push(formatSeedToolObservation({
          toolName,
          toolCallId,
          output: result.text,
          isError: result.isError,
        }))
      }
      if (results.length > 0) appendSeedHistory(out, "user", results.join("\n\n"))
    }
  }
  if (!options?.preserveTrailingUser && out.length > 0 && out[out.length - 1]!.role === "user") {
    out.pop()
  }
  return out
}

/** Session affinity header used to bind Cursor conversation_id across turns. */
export function sessionKeyFromHeaders(callOptions: LanguageModelV3CallOptions): string | undefined {
  const h = callOptions.headers ?? {}
  const raw =
    h["x-session-id"] ??
    h["X-Session-Id"] ??
    h["x-session-affinity"] ??
    h["x-opencode-session"]
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim()
  return undefined
}

export function extractTools(callOptions: LanguageModelV3CallOptions): OpencodeToolDef[] {
  const tools = callOptions.tools
  if (!tools || tools.length === 0) {
    trace("extractTools: callOptions.tools empty/missing")
    return []
  }
  const out: OpencodeToolDef[] = []
  for (const t of tools) {
    const any = t as { type?: string; name?: string; description?: string; inputSchema?: unknown }
    if (any.type === "function" || (any.name && any.inputSchema !== undefined)) {
      if (!any.name) continue
      out.push({ name: any.name, description: any.description, inputSchema: any.inputSchema })
    }
  }
  trace(`extractTools: ${tools.length} incoming → ${out.length} advertised [${out.map((t) => t.name).join(",")}]`)
  return out
}

/** AI SDK V3 span ends that must precede finish / tool-call. */
export function spanEndParts(opts: {
  textStarted: boolean
  reasoningStarted: boolean
  textId: string
  reasoningId: string
}): Array<{ type: "text-end" | "reasoning-end"; id: string }> {
  const out: Array<{ type: "text-end" | "reasoning-end"; id: string }> = []
  if (opts.reasoningStarted) out.push({ type: "reasoning-end", id: opts.reasoningId })
  if (opts.textStarted) out.push({ type: "text-end", id: opts.textId })
  return out
}

/** False when the caller omitted tools or set toolChoice "none". */
export function computeAllowTools(
  toolCount: number,
  toolChoice: LanguageModelV3CallOptions["toolChoice"] | undefined,
): boolean {
  return toolCount > 0 && toolChoice?.type !== "none"
}

export function foldStreamParts(parts: V3Part[]): LanguageModelV3GenerateResult {
  let text = ""
  let reasoning = ""
  const content: LanguageModelV3GenerateResult["content"] = []
  let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined }
  let usage: LanguageModelV3Usage = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }

  for (const part of parts) {
    if (part.type === "text-delta") text += part.delta
    else if (part.type === "reasoning-delta") reasoning += part.delta
    else if (part.type === "tool-call") {
      content.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      })
    } else if (part.type === "finish") {
      finishReason = part.finishReason
      usage = part.usage
    }
  }

  if (reasoning) content.unshift({ type: "reasoning", text: reasoning })
  if (text) content.unshift({ type: "text", text })

  return { content, finishReason, usage, warnings: [] }
}