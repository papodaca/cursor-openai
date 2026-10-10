#!/usr/bin/env bun
/**
 * Overlapping chats against a running cursor-openai proxy.
 *
 * The second and third Runs start after the first has already produced text,
 * so they reuse the HTTP/2 session while that stream is still open. Each reply
 * must contain its own word. A destroyed shared session drops one of them.
 *
 *   bun run live:parallel
 */

const base = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "")
const apiKey = process.env.API_KEY ?? process.env.PROXY_KEY ?? "abc123"
const modelOverride = process.env.MODEL?.trim() || undefined
const timeoutMs = Number(process.env.LIVE_TIMEOUT_MS ?? 180_000)

type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
  console.log(`      ${detail}`)
}

function streamChat(model: string, word: string): {
  started: Promise<void>
  done: Promise<string>
} {
  let markStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const done = (async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-session-id": `live-parallel-${word}-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{
          role: "user",
          content: `Reply with exactly the word ${word} and no other words.`,
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok || !res.body) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let raw = ""
    let content = ""
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      raw += decoder.decode(step.value, { stream: true })
      if (content.length === 0 && raw.includes(`"content"`)) markStarted()
      content = collectContent(raw)
    }
    markStarted()
    return content
  })()
  return { started, done }
}

function collectContent(raw: string): string {
  let content = ""
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) continue
    const data = trimmed.slice(5).trim()
    if (data === "[DONE]") continue
    try {
      const json = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>
      }
      const delta = json.choices?.[0]?.delta?.content
      if (typeof delta === "string") content += delta
    } catch {
      /* heartbeat comments and partial frames */
    }
  }
  return content
}

async function main() {
  console.log(`live parallel  ${base}`)
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
  console.log(`model          ${model}`)

  const words = ["alpha", "beta", "gamma"] as const
  const first = streamChat(model, words[0])
  try {
    await first.started
  } catch (error) {
    record("overlapping chats", false, (error as Error).message)
    return finish()
  }
  const rest = [streamChat(model, words[1]), streamChat(model, words[2])]
  try {
    const texts = await Promise.all([first.done, ...rest.map((chat) => chat.done)])
    const misses = words.filter((word, index) => !texts[index]?.toLowerCase().includes(word))
    record(
      "overlapping chats each keep their reply",
      misses.length === 0,
      misses.length === 0
        ? texts.map((text) => JSON.stringify(text.trim()).slice(0, 80)).join(" | ")
        : `missing ${misses.join(", ")} in ${texts.map((text) => JSON.stringify(text).slice(0, 80)).join(" | ")}`,
    )
  } catch (error) {
    record("overlapping chats each keep their reply", false, (error as Error).message)
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
