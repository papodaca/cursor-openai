import { describe, expect, test } from "bun:test"
import { parseChatCompletionRequest } from "./openai/request.ts"
import { ApiError } from "./errors.ts"
import { resolveCredential } from "./auth.ts"
import type { AppConfig } from "./config.ts"
import { createHandler } from "./server.ts"
import { listModels } from "./models.ts"

const baseConfig: AppConfig = {
  port: 8787,
  cacheDir: "/tmp/cursor-openai-test-cache",
  apiKey: "sk-test",
}

describe("parseChatCompletionRequest", () => {
  test("parses text-only messages", () => {
    const req = parseChatCompletionRequest({
      model: "composer-2.5",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ],
    })
    expect(req.model).toBe("composer-2.5")
    expect(req.stream).toBe(false)
    expect(req.messages[1]?.content).toBe("Hi")
  })

  test("rejects tools", () => {
    expect(() =>
      parseChatCompletionRequest({
        model: "composer-2.5",
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
      }),
    ).toThrow(ApiError)
  })
})

describe("resolveCredential", () => {
  test("prefers Bearer over env", () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: "Bearer sk-from-header" },
    })
    const cred = resolveCredential(req, {
      ...baseConfig,
      apiKey: "sk-from-env",
    })
    expect(cred).toEqual({ kind: "apiKey", value: "sk-from-header" })
  })

  test("classifies JWT bearer as accessToken", () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: "Bearer eyJhbGciOi.test" },
    })
    const cred = resolveCredential(req, baseConfig)
    expect(cred.kind).toBe("accessToken")
  })

  test("401 when missing", () => {
    const req = new Request("http://localhost/v1/chat/completions")
    expect(() =>
      resolveCredential(req, { port: 8787, cacheDir: "/tmp" }),
    ).toThrow(ApiError)
  })
})

describe("HTTP routes", () => {
  test("GET /health", async () => {
    const handler = createHandler(baseConfig)
    const res = await handler(new Request("http://localhost/health"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("GET /v1/models fallback", async () => {
    const data = await listModels({
      port: 8787,
      cacheDir: "/tmp/does-not-exist-cursor-openai",
    })
    expect(data.object).toBe("list")
    expect(data.data.some((m) => m.id === "composer-2.5")).toBe(true)
  })

  test("POST rejects tools with 400", async () => {
    const handler = createHandler(baseConfig)
    const res = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Hi" }],
          tools: [{ type: "function", function: { name: "x" } }],
        }),
      }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("tools_not_supported")
  })

  test("POST without credentials returns 401", async () => {
    const handler = createHandler({ port: 8787, cacheDir: "/tmp" })
    const res = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Hi" }],
        }),
      }),
    )
    expect(res.status).toBe(401)
  })
})
