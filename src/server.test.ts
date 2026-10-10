import path from "node:path"
import { describe, expect, test } from "bun:test"
import { parseChatCompletionRequest } from "./openai/request.ts"
import { ApiError, mapProviderError } from "./errors.ts"
import { requireProxyApiKey } from "./auth.ts"
import { HelpRequested, loadConfig, parseArgs, resolveAuthPath } from "./config.ts"
import type { AppConfig } from "./config.ts"
import { createHandler } from "./server.ts"
import { listModels, normalizeModelId } from "./models.ts"
import {
  decodeJwtExpiryMs,
  parseAuthFile,
  refreshAccessToken,
} from "./auth-session.ts"

const baseConfig: AppConfig = {
  port: 8787,
  proxyApiKey: "proxy-secret",
  authPath: "/tmp/cursor-openai-auth.json",
  cacheDir: "/tmp/cursor-openai-test-cache",
  apiBaseURL: "https://api2.cursor.sh",
}

const authStub = {
  getAccessToken: async () => "cursor-access-token",
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

  test("parses user image_url parts", () => {
    const req = parseChatCompletionRequest({
      model: "composer-2.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aaaa", detail: "high" },
            },
            { type: "image_url", image_url: "https://example.com/a.jpg" },
          ],
        },
      ],
    })
    expect(req.messages[0]).toMatchObject({
      role: "user",
      content: "What is this?",
      images: [
        { url: "data:image/png;base64,aaaa", mediaType: "image/png" },
        { url: "https://example.com/a.jpg", mediaType: "image/*" },
      ],
    })
  })

  test("rejects non-image content parts and image_url on assistant messages", () => {
    expect(() =>
      parseChatCompletionRequest({
        model: "composer-2.5",
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }],
      }),
    ).toThrow(/image_url/)

    expect(() =>
      parseChatCompletionRequest({
        model: "composer-2.5",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "file:///tmp/x.png" } }],
          },
        ],
      }),
    ).toThrow(/http\(s\)/)

    expect(() =>
      parseChatCompletionRequest({
        model: "composer-2.5",
        messages: [
          {
            role: "assistant",
            content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
          },
        ],
      }),
    ).toThrow(ApiError)
  })

  test("parses tools and tool messages", () => {
    const req = parseChatCompletionRequest({
      model: "composer-2.5",
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    })
    expect(req.tools?.[0]?.function.name).toBe("get_weather")
    expect(req.toolChoice).toBe("auto")
    expect(req.messages[1]).toMatchObject({ role: "assistant" })
    expect(req.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_1" })
  })

  test("rejects legacy functions field", () => {
    expect(() =>
      parseChatCompletionRequest({
        model: "composer-2.5",
        messages: [{ role: "user", content: "Hi" }],
        functions: [{ name: "x" }],
      }),
    ).toThrow(ApiError)
  })
})

describe("CLI / config", () => {
  test("resolveAuthPath strips @ prefix", () => {
    expect(resolveAuthPath("@auth.json")).toBe(path.resolve("auth.json"))
    expect(resolveAuthPath("./auth.json")).toBe(path.resolve("./auth.json"))
  })

  test("parseArgs requires --auth and --api-key", () => {
    expect(() => parseArgs([])).toThrow(/--auth/)
    expect(() => parseArgs(["--auth", "@auth.json"])).toThrow(/--api-key/)
  })

  test("parseArgs accepts flags", () => {
    const cli = parseArgs(["--auth", "@/tmp/a.json", "--api-key", "k", "--port", "9000"])
    expect(cli.authPath).toBe(path.resolve("/tmp/a.json"))
    expect(cli.proxyApiKey).toBe("k")
    expect(cli.port).toBe(9000)
  })

  test("parseArgs --help throws HelpRequested", () => {
    expect(() => parseArgs(["--help"])).toThrow(HelpRequested)
  })

  test("loadConfig merges defaults", () => {
    const cfg = loadConfig(
      {
        authPath: "/tmp/a.json",
        proxyApiKey: "k",
      },
      {},
    )
    expect(cfg.port).toBe(8787)
    expect(cfg.apiBaseURL).toBe("https://api2.cursor.sh")
    expect(cfg.proxyApiKey).toBe("k")
  })
})

describe("requireProxyApiKey", () => {
  test("accepts matching Bearer", () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: "Bearer proxy-secret" },
    })
    expect(() => requireProxyApiKey(req, baseConfig)).not.toThrow()
  })

  test("rejects wrong key", () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: "Bearer wrong" },
    })
    expect(() => requireProxyApiKey(req, baseConfig)).toThrow(ApiError)
  })

  test("401 when missing", () => {
    const req = new Request("http://localhost/v1/chat/completions")
    expect(() => requireProxyApiKey(req, baseConfig)).toThrow(ApiError)
  })
})

describe("auth file helpers", () => {
  const sampleAccess = "a".repeat(40)
  const sampleRefresh = "r".repeat(40)

  test("parseAuthFile validates shape", () => {
    const auth = parseAuthFile({
      type: "oauth",
      refresh: sampleRefresh,
      access: sampleAccess,
      expires: 1,
    })
    expect(auth.refresh).toBe(sampleRefresh)
    expect(auth.access).toBe(sampleAccess)
  })

  test("parseAuthFile accepts OpenCode provider map", () => {
    const auth = parseAuthFile({
      cursor: {
        type: "oauth",
        refresh: sampleRefresh,
        access: sampleAccess,
        expires: 42,
      },
      other: { type: "api", key: "x" },
    })
    expect(auth.expires).toBe(42)
  })

  test("parseAuthFile rejects placeholders", () => {
    expect(() =>
      parseAuthFile({
        type: "oauth",
        refresh: "<snip>",
        access: "<snip>",
        expires: 1,
      }),
    ).toThrow(/placeholder/)
  })

  test("parseAuthFile rejects bad type", () => {
    expect(() => parseAuthFile({ type: "api" })).toThrow(/oauth/)
  })

  test("decodeJwtExpiryMs reads exp", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url")
    const jwt = `x.${payload}.y`
    expect(decodeJwtExpiryMs(jwt)).toBe(1_700_000_000_000)
  })

  test("refreshAccessToken exchanges the refresh token at Cursor's endpoint", async () => {
    let seen: { auth?: string | null; body?: string; path?: string } = {}
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = {
          auth: req.headers.get("authorization"),
          body: await req.text(),
          path: new URL(req.url).pathname,
        }
        return Response.json({ accessToken: "new-access-token-value-xxxx" })
      },
    })
    try {
      const pair = await refreshAccessToken(
        sampleRefresh,
        `http://127.0.0.1:${server.port}`,
      )
      expect(seen.path).toBe("/auth/exchange_user_api_key")
      expect(seen.auth).toBe(`Bearer ${sampleRefresh}`)
      expect(seen.body).toBe("{}")
      expect(pair.accessToken).toBe("new-access-token-value-xxxx")
      expect(pair.refreshToken).toBe(sampleRefresh)
    } finally {
      server.stop(true)
    }
  })
})

describe("normalizeModelId", () => {
  test("strips OpenCode-style cursor/ prefix", () => {
    expect(normalizeModelId("cursor/composer-2.5")).toBe("composer-2.5")
    expect(normalizeModelId("Cursor/composer-2.5")).toBe("composer-2.5")
    expect(normalizeModelId("cursor:composer-2.5")).toBe("composer-2.5")
    expect(normalizeModelId("composer-2.5")).toBe("composer-2.5")
  })

  test("maps auto and provider-prefixed ids", () => {
    expect(normalizeModelId("auto")).toBe("default")
    expect(normalizeModelId("AUTO")).toBe("default")
    expect(normalizeModelId("cursor/auto")).toBe("default")
    expect(normalizeModelId("cursor2/auto")).toBe("default")
    expect(normalizeModelId("cursor2/composer-2.5")).toBe("composer-2.5")
  })
})

describe("mapProviderError", () => {
  test("maps Cursor not_found to model_not_found", () => {
    const err = Object.assign(new Error("Cursor API error (code=not_found)"), {
      name: "CursorServerError",
      code: "not_found",
    })
    const mapped = mapProviderError(err)
    expect(mapped).toBeInstanceOf(ApiError)
    expect(mapped?.status).toBe(404)
    expect(mapped?.code).toBe("model_not_found")
  })

  test("maps image input failures to 400", () => {
    const err = new Error("Cursor model composer-2.5 does not support image input.")
    err.name = "CursorImageInputError"
    const mapped = mapProviderError(err)
    expect(mapped?.status).toBe(400)
    expect(mapped?.code).toBe("unsupported_content")
  })
})

describe("HTTP routes", () => {
  test("GET /health", async () => {
    const handler = createHandler(baseConfig, authStub)
    const res = await handler(new Request("http://localhost/health"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("GET /v1/models requires auth", async () => {
    const handler = createHandler(
      { ...baseConfig, modelsAllowlist: ["composer-2.5"] },
      authStub,
    )
    const unauth = await handler(new Request("http://localhost/v1/models"))
    expect(unauth.status).toBe(401)

    const ok = await handler(
      new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer proxy-secret" },
      }),
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { object: string; data: Array<{ id: string }> }
    expect(body.object).toBe("list")
    expect(body.data.map((m) => m.id)).toEqual(["composer-2.5"])
  })

  test("GET /v1/models fallback via listModels", async () => {
    const data = await listModels({
      ...baseConfig,
      cacheDir: "/tmp/does-not-exist-cursor-openai",
    })
    expect(data.object).toBe("list")
    expect(data.data.some((m) => m.id === "composer-2.5")).toBe(true)
  })

  test("listModels discovers via provider when cache is empty", async () => {
    const data = await listModels(
      {
        ...baseConfig,
        cacheDir: "/tmp/does-not-exist-cursor-openai-discover",
      },
      {
        accessToken: "tok",
        discover: async () => [{ id: "default" }, { id: "grok-4.5" }],
      },
    )
    expect(data.data.map((m) => m.id)).toEqual(["default", "grok-4.5"])
  })

  test("listModels falls back when discover fails", async () => {
    const data = await listModels(
      {
        ...baseConfig,
        cacheDir: "/tmp/does-not-exist-cursor-openai-discover-fail",
      },
      {
        accessToken: "tok",
        discover: async () => {
          throw new Error("network down")
        },
      },
    )
    expect(data.data.map((m) => m.id)).toEqual(["composer-2.5"])
  })

  test("POST rejects legacy functions with 400", async () => {
    const handler = createHandler(baseConfig, authStub)
    const res = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer proxy-secret",
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Hi" }],
          functions: [{ name: "x" }],
        }),
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("tools_not_supported")
  })

  test("POST without credentials returns 401", async () => {
    const handler = createHandler(baseConfig, authStub)
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

  test("POST with wrong API key returns 401", async () => {
    const handler = createHandler(baseConfig, authStub)
    const res = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong",
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Hi" }],
        }),
      }),
    )
    expect(res.status).toBe(401)
  })
})