#!/usr/bin/env bun
/**
 * Tool-calling checks against a running cursor-openai proxy.
 *
 * The schema check is the success measure for names-only advertisement.
 * `place_order` argument names exist only in the JSON schema. The prompt says
 * "stock" and "count", not `sku` and `qty`. A pass means Cursor received the
 * schema and called that tool. A call to Read, Grep, or Shell is a fail.
 *
 *   bun run live:tools
 *   API_KEY=abc123 BASE_URL=http://localhost:8787 MODEL=composer-2.5 bun run live:tools
 */

const base = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "")
const apiKey = process.env.API_KEY ?? process.env.PROXY_KEY ?? "abc123"
const modelOverride = process.env.MODEL?.trim() || undefined
const timeoutMs = Number(process.env.LIVE_TIMEOUT_MS ?? 180_000)

const VAULT_SECRET = "vault-value-8831"
const PAGE_BODY = "page-body-5520"

type ToolCall = { id: string; name: string; arguments: string }
type ChatMessage = Record<string, unknown>
type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
  console.log(`      ${detail}`)
}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  }
}

const vaultTool = fn(
  "vault_lookup",
  "Look up a vault entry by id. The value is not known until this tool returns.",
  { id: { type: "string" } },
  ["id"],
)

const placeOrderTool = fn(
  "place_order",
  "Submit one warehouse order. Argument names are defined only by the schema.",
  {
    sku: { type: "string" },
    qty: { type: "integer" },
  },
  ["sku", "qty"],
)

const webFetchTool = fn(
  "web_fetch",
  "Fetch a URL and return the page text. The page body is not known until this tool returns.",
  { url: { type: "string" } },
  ["url"],
)

async function complete(args: {
  model: string
  messages: ChatMessage[]
  tools?: unknown[]
  toolChoice?: unknown
  sessionId: string
}): Promise<{ content: string; toolCalls: ToolCall[]; finish: string | null }> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-session-id": args.sessionId,
    },
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      ...(args.tools ? { tools: args.tools } : {}),
      ...(args.toolChoice !== undefined ? { tool_choice: args.toolChoice } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
  const raw = JSON.parse(text) as {
    choices?: Array<{
      finish_reason?: string | null
      message?: {
        content?: string | null
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
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
  }
}

function parsedArgs(call: ToolCall | undefined): Record<string, unknown> {
  if (!call) return {}
  try {
    const value = JSON.parse(call.arguments) as unknown
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function describeCalls(calls: ToolCall[], finish: string | null, content: string): string {
  if (calls.length === 0) {
    return `no tool call, finish=${finish} text=${JSON.stringify(content).slice(0, 200)}`
  }
  return calls.map((call) => `${call.name}(${call.arguments})`).join("; ") + ` finish=${finish}`
}

function assistantMessage(content: string, calls: ToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: content || null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  }
}

async function main() {
  console.log(`live tools  ${base}`)
  const modelsRes = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!modelsRes.ok) {
    record("models", false, `HTTP ${modelsRes.status}`)
    return finish()
  }
  const modelsBody = await modelsRes.json() as { data?: Array<{ id?: string }> }
  const ids = (modelsBody.data ?? []).map((model) => model.id).filter((id): id is string => !!id)
  const model = modelOverride ?? (ids.includes("composer-2.5") ? "composer-2.5" : ids[0])
  if (!model) {
    record("models", false, "empty model list")
    return finish()
  }
  console.log(`model       ${model}`)

  const orderSession = `live-tools-order-${crypto.randomUUID()}`
  const orderMessages: ChatMessage[] = [
    {
      role: "user",
      content: "Use place_order for stock HAMMER-9, count 3. Do not guess a confirmation number.",
    },
  ]
  try {
    const ordered = await complete({
      model,
      sessionId: orderSession,
      messages: orderMessages,
      tools: [placeOrderTool],
      toolChoice: "auto",
    })
    const call = ordered.toolCalls[0]
    const args = parsedArgs(call)
    const qty = args.qty
    const schemaHit = ordered.toolCalls.length === 1
      && call?.name === "place_order"
      && args.sku === "HAMMER-9"
      && (qty === 3 || qty === "3")
    record(
      "schema-only argument names are used",
      schemaHit,
      describeCalls(ordered.toolCalls, ordered.finish, ordered.content),
    )
    if (schemaHit && call) {
      orderMessages.push(assistantMessage(ordered.content, ordered.toolCalls))
      orderMessages.push({
        role: "tool",
        tool_call_id: call.id,
        name: "place_order",
        content: "order-id-4401",
      })
      const confirmed = await complete({
        model,
        sessionId: orderSession,
        messages: orderMessages,
        tools: [placeOrderTool],
        toolChoice: "auto",
      })
      record(
        "model repeats the place_order result",
        confirmed.toolCalls.length === 0 && confirmed.content.includes("order-id-4401"),
        confirmed.toolCalls.length > 0
          ? describeCalls(confirmed.toolCalls, confirmed.finish, confirmed.content)
          : JSON.stringify(confirmed.content).slice(0, 300),
      )
    }
  } catch (error) {
    record("schema-only argument names are used", false, (error as Error).message)
  }

  const offered = [vaultTool, webFetchTool]
  const sessionId = `live-tools-${crypto.randomUUID()}`
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "Look up vault id 7. Use vault_lookup. Do not guess, and do not fetch a page.",
    },
  ]

  try {
    const first = await complete({
      model,
      sessionId,
      messages,
      tools: offered,
      toolChoice: "auto",
    })
    const names = first.toolCalls.map((call) => call.name)
    const onlyVault = names.length === 1 && names[0] === "vault_lookup" && first.toolCalls[0]!.arguments.includes("7")
    record(
      "auto tool_choice calls vault_lookup",
      onlyVault,
      describeCalls(first.toolCalls, first.finish, first.content),
    )
    if (!onlyVault) return finish()

    messages.push(assistantMessage(first.content, first.toolCalls))
    messages.push({
      role: "tool",
      tool_call_id: first.toolCalls[0]!.id,
      name: "vault_lookup",
      content: VAULT_SECRET,
    })
    const second = await complete({ model, sessionId, messages, tools: offered, toolChoice: "auto" })
    record(
      "model repeats the vault tool result",
      second.toolCalls.length === 0 && second.content.includes(VAULT_SECRET),
      second.toolCalls.length > 0
        ? describeCalls(second.toolCalls, second.finish, second.content)
        : JSON.stringify(second.content).slice(0, 300),
    )
  } catch (error) {
    record("vault tool loop", false, (error as Error).message)
  }

  const fetchSession = `live-tools-fetch-${crypto.randomUUID()}`
  try {
    const fetched = await complete({
      model,
      sessionId: fetchSession,
      tools: offered,
      toolChoice: "auto",
      messages: [
        {
          role: "user",
          content: "Fetch https://example.test/note with web_fetch and do not call vault_lookup. Do not guess the page body.",
        },
      ],
    })
    const call = fetched.toolCalls[0]
    const right = fetched.toolCalls.length === 1
      && call?.name === "web_fetch"
      && call.arguments.includes("example.test/note")
    record(
      "auto tool_choice calls web_fetch",
      right,
      describeCalls(fetched.toolCalls, fetched.finish, fetched.content),
    )
    if (right && call) {
      const follow = await complete({
        model,
        sessionId: fetchSession,
        tools: offered,
        toolChoice: "auto",
        messages: [
          {
            role: "user",
            content: "Fetch https://example.test/note with web_fetch and do not call vault_lookup. Do not guess the page body.",
          },
          assistantMessage(fetched.content, fetched.toolCalls),
          { role: "tool", tool_call_id: call.id, name: "web_fetch", content: PAGE_BODY },
        ],
      })
      record(
        "model repeats the web_fetch result",
        follow.toolCalls.length === 0 && follow.content.includes(PAGE_BODY),
        follow.toolCalls.length > 0
          ? describeCalls(follow.toolCalls, follow.finish, follow.content)
          : JSON.stringify(follow.content).slice(0, 300),
      )
    }
  } catch (error) {
    record("web_fetch tool loop", false, (error as Error).message)
  }

  try {
    const quiet = await complete({
      model,
      sessionId: `live-tools-none-${crypto.randomUUID()}`,
      tools: offered,
      toolChoice: "none",
      messages: [{ role: "user", content: "Reply with exactly the word pong and no other words." }],
    })
    record(
      "tool_choice none does not call a tool",
      quiet.toolCalls.length === 0 && /pong/i.test(quiet.content),
      describeCalls(quiet.toolCalls, quiet.finish, quiet.content),
    )
  } catch (error) {
    record("tool_choice none does not call a tool", false, (error as Error).message)
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
