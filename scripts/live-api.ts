#!/usr/bin/env bun
/**
 * Live checks against a running cursor-openai proxy. These call Cursor.
 * They are not part of `bun test`.
 *
 *   bun run live
 *   API_KEY=abc123 BASE_URL=http://localhost:8787 MODEL=composer-2.5 bun run live
 *
 * The script talks to whatever is listening. It does not know which git
 * revision that process loaded.
 */

const base = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "")
const apiKey = process.env.API_KEY ?? process.env.PROXY_KEY ?? "abc123"
const modelOverride = process.env.MODEL?.trim() || undefined
const timeoutMs = Number(process.env.LIVE_TIMEOUT_MS ?? 180_000)

type ToolCall = { id: string; name: string; arguments: string }
type ChatMessage = Record<string, unknown>

type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
  console.log(`      ${detail}`)
}

async function request(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.auth !== false) headers.set("authorization", `Bearer ${apiKey}`)
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  return fetch(`${base}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
}

async function readError(res: Response): Promise<string> {
  const text = await res.text()
  return text.slice(0, 500) || res.statusText
}

type Completion = {
  content: string
  toolCalls: ToolCall[]
  finish: string | null
  raw: unknown
}

function assistantMessage(completion: Completion): ChatMessage {
  return {
    role: "assistant",
    content: completion.content || null,
    ...(completion.toolCalls.length > 0
      ? {
          tool_calls: completion.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  }
}

async function complete(args: {
  model: string
  messages: ChatMessage[]
  tools?: unknown[]
  toolChoice?: unknown
  sessionId?: string
  stream?: boolean
}): Promise<Completion> {
  const headers = new Headers()
  if (args.sessionId) headers.set("x-session-id", args.sessionId)
  const res = await request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      ...(args.tools ? { tools: args.tools } : {}),
      ...(args.toolChoice !== undefined ? { tool_choice: args.toolChoice } : {}),
      ...(args.stream ? { stream: true } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await readError(res)}`)
  }
  if (!args.stream) {
    const raw = await res.json() as {
      choices?: Array<{
        finish_reason?: string | null
        message?: {
          content?: string | null
          tool_calls?: Array<{
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
    }
    const choice = raw.choices?.[0]
    const message = choice?.message
    return {
      content: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id ?? "",
        name: call.function?.name ?? "",
        arguments: call.function?.arguments ?? "",
      })),
      finish: choice?.finish_reason ?? null,
      raw,
    }
  }

  const rawText = await res.text()
  const byIndex = new Map<number, ToolCall>()
  let content = ""
  let finish: string | null = null
  for (const line of rawText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    const data = trimmed.slice(5).trim()
    if (data === "[DONE]") continue
    let json: {
      choices?: Array<{
        finish_reason?: string | null
        delta?: {
          content?: string
          tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
    }
    try {
      json = JSON.parse(data)
    } catch {
      continue
    }
    const choice = json.choices?.[0]
    if (choice?.finish_reason) finish = choice.finish_reason
    const delta = choice?.delta
    if (typeof delta?.content === "string") content += delta.content
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0
      const prev = byIndex.get(index) ?? { id: "", name: "", arguments: "" }
      byIndex.set(index, {
        id: call.id || prev.id,
        name: call.function?.name || prev.name,
        arguments: prev.arguments + (call.function?.arguments ?? ""),
      })
    }
  }
  return { content, toolCalls: [...byIndex.values()], finish, raw: rawText }
}

const vaultTool = {
  type: "function",
  function: {
    name: "vault_lookup",
    description: "Look up a vault entry by id. The value is not known until this tool returns.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
}

const webFetchTool = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "Fetch a URL and return the page text.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
}

const SECRET = "vault-value-8831"
const SYSTEM_TOKEN = "OK-441"
const PASSPHRASE = "kite-moon"

async function main() {
  console.log(`live api  ${base}`)
  console.log(`timeout   ${timeoutMs}ms`)

  const health = await request("/health", { auth: false })
  const healthBody = await health.text()
  record("health", health.ok && healthBody.includes("ok"), `HTTP ${health.status} ${healthBody.trim()}`)
  if (!health.ok) return finish()

  const denied = await request("/v1/models", { auth: false })
  record("models reject missing key", denied.status === 401, `HTTP ${denied.status}`)

  const modelsRes = await request("/v1/models")
  if (!modelsRes.ok) {
    record("models", false, `HTTP ${modelsRes.status}: ${await readError(modelsRes)}`)
    return finish()
  }
  const modelsBody = await modelsRes.json() as { data?: Array<{ id?: string }> }
  const ids = (modelsBody.data ?? []).map((model) => model.id).filter((id): id is string => !!id)
  const model = modelOverride ?? (ids.includes("composer-2.5") ? "composer-2.5" : ids[0])
  record("models", ids.length > 0 && !!model, model ? `${ids.length} models, using ${model}` : "empty model list")
  if (!model) return finish()

  try {
    const plain = await complete({
      model,
      sessionId: `live-plain-${crypto.randomUUID()}`,
      messages: [{ role: "user", content: "Reply with exactly the word pong and no other words." }],
    })
    const text = plain.content.trim()
    record("plain completion", /pong/i.test(text), JSON.stringify(text).slice(0, 240))
  } catch (error) {
    record("plain completion", false, (error as Error).message)
  }

  try {
    const streamed = await complete({
      model,
      stream: true,
      sessionId: `live-stream-${crypto.randomUUID()}`,
      messages: [{ role: "user", content: "Reply with exactly the word pong and no other words." }],
    })
    const text = streamed.content.trim()
    record(
      "streaming completion",
      /pong/i.test(text) && streamed.finish !== null,
      `finish=${streamed.finish} text=${JSON.stringify(text).slice(0, 240)}`,
    )
  } catch (error) {
    record("streaming completion", false, (error as Error).message)
  }

  try {
    const guided = await complete({
      model,
      sessionId: `live-system-${crypto.randomUUID()}`,
      messages: [
        {
          role: "system",
          content: `The only allowed reply is ${SYSTEM_TOKEN}. Do not answer the question. Do not add words.`,
        },
        { role: "user", content: "What is the capital of France?" },
      ],
    })
    const text = guided.content.trim()
    const obeyed = text.includes(SYSTEM_TOKEN) && !/paris/i.test(text)
    record(
      "system prompt is followed",
      obeyed,
      JSON.stringify(text).slice(0, 300),
    )
  } catch (error) {
    record("system prompt is followed", false, (error as Error).message)
  }

  const toolSession = `live-tool-${crypto.randomUUID()}`
  const toolMessages: ChatMessage[] = [
    {
      role: "user",
      content: "Look up vault id 7 with vault_lookup. Do not call web_fetch. Do not guess the value.",
    },
  ]
  try {
    const first = await complete({
      model,
      sessionId: toolSession,
      messages: toolMessages,
      tools: [vaultTool, webFetchTool],
      toolChoice: { type: "function", function: { name: "vault_lookup" } },
    })
    const call = first.toolCalls[0]
    const args = call?.arguments ?? ""
    const namedRight = call?.name === "vault_lookup" && args.includes("7")
    record(
      "tool call uses the offered function",
      namedRight,
      call
        ? `${call.name}(${args}) id=${call.id} finish=${first.finish}`
        : `no tool call, finish=${first.finish} text=${JSON.stringify(first.content).slice(0, 200)}`,
    )
    if (call) {
      toolMessages.push(assistantMessage(first))
      toolMessages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content: SECRET,
      })
      const second = await complete({
        model,
        sessionId: toolSession,
        messages: toolMessages,
        tools: [vaultTool, webFetchTool],
      })
      const answer = second.content
      record(
        "tool result is delivered back to the model",
        answer.includes(SECRET),
        JSON.stringify(answer).slice(0, 300) || `finish=${second.finish} tools=${second.toolCalls.length}`,
      )
    }
  } catch (error) {
    record("tool loop", false, (error as Error).message)
  }

  const memorySession = `live-memory-${crypto.randomUUID()}`
  const memory: ChatMessage[] = [
    { role: "user", content: `The passphrase is ${PASSPHRASE}. Reply with the single word stored.` },
  ]
  try {
    const first = await complete({ model, sessionId: memorySession, messages: memory })
    memory.push({ role: "assistant", content: first.content })
    memory.push({ role: "user", content: "What passphrase did I just give you? Reply with only that passphrase." })
    const second = await complete({ model, sessionId: memorySession, messages: memory })
    record(
      "follow-up sees the prior turn",
      second.content.includes(PASSPHRASE),
      JSON.stringify(second.content).slice(0, 240),
    )
  } catch (error) {
    record("follow-up sees the prior turn", false, (error as Error).message)
  }

  return finish()
}

function finish(): never {
  const failed = checks.filter((check) => !check.ok)
  console.log("")
  console.log(`${checks.length - failed.length}/${checks.length} passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
