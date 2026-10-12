import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { parseChatCompletionRequest } from "./openai/request.ts"
import { ApiError, mapProviderError } from "./errors.ts"
import { requireProxyApiKey } from "./auth.ts"
import { HelpRequested, loadConfig, parseArgs, resolveAuthPath } from "./config.ts"
import type { AppConfig } from "./config.ts"
import { createHandler, statusRoutes } from "./server.ts"
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
  statusDb: ":memory:",
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
    expect(cfg.statusDb).toBe(path.resolve("status.sqlite"))
  })

  test("parseArgs and loadConfig accept --status-db", () => {
    const cli = parseArgs([
      "--auth",
      "@/tmp/a.json",
      "--api-key",
      "k",
      "--status-db",
      "var/calls.sqlite",
    ])
    expect(cli.statusDb).toBe("var/calls.sqlite")
    const cfg = loadConfig(cli, {})
    expect(cfg.statusDb).toBe(path.resolve("var/calls.sqlite"))
  })

  test("loadConfig reads CURSOR_STATUS_DB and keeps :memory:", () => {
    const cli = { authPath: "/tmp/a.json", proxyApiKey: "k" }
    expect(loadConfig(cli, { CURSOR_STATUS_DB: "data/status.sqlite" }).statusDb).toBe(
      path.resolve("data/status.sqlite"),
    )
    expect(loadConfig({ ...cli, statusDb: ":memory:" }, {}).statusDb).toBe(":memory:")
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

  test("listModels publishes context length and input modalities", async () => {
    const data = await listModels(
      {
        ...baseConfig,
        cacheDir: "/tmp/does-not-exist-cursor-openai-catalog",
      },
      {
        accessToken: "tok",
        discover: async () => [
          {
            id: "composer-2.5",
            name: "Composer 2.5",
            contextLength: 1_000_000,
            supportsImages: true,
          },
          {
            id: "text-only",
            contextLength: 200_000,
            supportsImages: false,
          },
          { id: "unknown-caps" },
        ],
      },
    )
    expect(data.data[0]).toMatchObject({
      id: "composer-2.5",
      name: "Composer 2.5",
      context_length: 1_000_000,
      max_model_len: 1_000_000,
      top_provider: { context_length: 1_000_000 },
      architecture: {
        modality: "text+image->text",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
    })
    expect(data.data[1]?.architecture).toEqual({
      modality: "text->text",
      input_modalities: ["text"],
      output_modalities: ["text"],
    })
    expect(data.data[2]?.architecture).toBeUndefined()
    expect(data.data[2]?.context_length).toBeUndefined()
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

function emptyUsage() {
  return {
    inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: undefined, reasoning: undefined },
  }
}

function textModel(text: string): LanguageModelV3 {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "text-delta", id: "0", delta: text },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: emptyUsage(),
    },
  ]
  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate(_options: LanguageModelV3CallOptions) {
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      }
    },
    async doStream(_options: LanguageModelV3CallOptions) {
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }
    },
  }
}

function chatBody(model: string, stream = false): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "Hi" }],
    ...(stream ? { stream: true } : {}),
  })
}

function expectStatus(
  actual: { rows: Array<{ at?: unknown }>; inFlight: boolean },
  expected: { rows: unknown[]; inFlight: boolean },
) {
  expect(actual.inFlight).toBe(expected.inFlight)
  expect(actual.rows).toHaveLength(expected.rows.length)
  actual.rows.forEach((row, index) => {
    expect(row).toMatchObject(expected.rows[index] as object)
    expect(row.at).toEqual(expect.any(Number))
  })
}

function chatPost(body: string, key = "proxy-secret"): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body,
  })
}

describe("chat completion log", () => {
  test("non-stream POST stores response bytes and leaves the count at 0", async () => {
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => textModel("Hello"),
    })
    expectStatus(handler.statusSnapshot(), { rows: [], inFlight: false })
    const body = chatBody("composer-2.5")
    const res = await handler(chatPost(body))
    const text = await res.text()
    expect(res.status).toBe(200)
    expectStatus(handler.statusSnapshot(), {
      rows: [
        {
          address: "",
          model: "composer-2.5",
          requestBytes: Buffer.byteLength(body),
          responseBytes: Buffer.byteLength(text),
        },
      ],
      inFlight: false,
    })
  })

  test("stream POST stores the done frame in response bytes", async () => {
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => textModel("Hi"),
    })
    expect(handler.statusSnapshot().rows).toEqual([])
    const res = await handler(chatPost(chatBody("composer-2.5", true)))
    const text = await res.text()
    expect(text).toContain("data: [DONE]\n\n")
    expect(handler.statusSnapshot().rows[0]?.responseBytes).toBe(Buffer.byteLength(text))
    expect(handler.statusSnapshot().inFlight).toBe(false)
  })

  test("stores cursor/auto before model normalization", async () => {
    let seen = ""
    const handler = createHandler(baseConfig, authStub, {
      languageModel: (modelId) => {
        seen = modelId
        return textModel("ok")
      },
    })
    expect(handler.statusSnapshot().rows).toEqual([])
    const res = await handler(chatPost(chatBody("cursor/auto")))
    expect(res.status).toBe(200)
    expect(seen).toBe("default")
    expect(handler.statusSnapshot().rows[0]?.model).toBe("cursor/auto")
  })

  test("invalid JSON stores an empty model and the 400 body length", async () => {
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => textModel("nope"),
    })
    const body = "not-json"
    const res = await handler(chatPost(body))
    const text = await res.text()
    expect(res.status).toBe(400)
    expectStatus(handler.statusSnapshot(), {
      rows: [
        {
          address: "",
          model: "",
          requestBytes: Buffer.byteLength(body),
          responseBytes: Buffer.byteLength(text),
        },
      ],
      inFlight: false,
    })
  })

  test("wrong proxy key stores nothing", async () => {
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => textModel("nope"),
    })
    const res = await handler(chatPost(chatBody("composer-2.5"), "wrong"))
    expect(res.status).toBe(401)
    expectStatus(handler.statusSnapshot(), { rows: [], inFlight: false })
  })

  test("access token failure stores a row and does not change the count", async () => {
    const handler = createHandler(baseConfig, {
      getAccessToken: async () => {
        throw new Error("refresh failed")
      },
    }, {
      languageModel: () => textModel("nope"),
    })
    const res = await handler(chatPost(chatBody("composer-2.5")))
    const text = await res.text()
    expect(res.status).toBe(502)
    expectStatus(handler.statusSnapshot(), {
      rows: [
        {
          address: "",
          model: "composer-2.5",
          requestBytes: Buffer.byteLength(chatBody("composer-2.5")),
          responseBytes: Buffer.byteLength(text),
        },
      ],
      inFlight: false,
    })
  })

  test("doStream throwing before a readable exists returns the count to 0", async () => {
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => ({
        ...textModel("x"),
        async doStream() {
          throw new Error("upstream down")
        },
      }),
    })
    expect(handler.statusSnapshot().inFlight).toBe(false)
    const res = await handler(chatPost(chatBody("composer-2.5", true)))
    const text = await res.text()
    expect(res.status).toBe(502)
    expect(text).toContain("upstream down")
    expect(handler.statusSnapshot().rows).toHaveLength(1)
    expect(handler.statusSnapshot().rows[0]?.responseBytes).toBe(Buffer.byteLength(text))
    expect(handler.statusSnapshot().inFlight).toBe(false)
  })

  test("overlapping streams stay in flight until the last one finishes", async () => {
    let entered = 0
    let markBoth: () => void = () => {}
    const bothEntered = new Promise<void>((resolve) => {
      markBoth = resolve
    })
    const release: Array<() => void> = []
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => {
        let open: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
          open = resolve
        })
        release.push(open)
        const model = textModel("x")
        return {
          ...model,
          async doStream(options: LanguageModelV3CallOptions) {
            entered += 1
            if (entered === 2) markBoth()
            await gate
            return model.doStream(options)
          },
        }
      },
    })
    expect(handler.statusSnapshot().inFlight).toBe(false)

    const pendingA = handler(chatPost(chatBody("composer-2.5", true)))
    const pendingB = handler(chatPost(chatBody("composer-2.5", true)))
    await bothEntered
    expect(handler.statusSnapshot().inFlight).toBe(true)

    release[0]?.()
    const resA = await pendingA
    await resA.text()
    expect(handler.statusSnapshot().inFlight).toBe(true)

    release[1]?.()
    const resB = await pendingB
    await resB.text()
    expect(handler.statusSnapshot().inFlight).toBe(false)
    expect(handler.statusSnapshot().rows).toHaveLength(2)
  })

  test("a listening server records 127.0.0.1 and a direct call stores an empty address", async () => {
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => textModel("Hi"),
    })
    expect(handler.statusSnapshot().rows).toEqual([])
    const direct = await handler(chatPost(chatBody("composer-2.5")))
    expect(direct.status).toBe(200)
    expect(handler.statusSnapshot().rows[0]?.address).toBe("")

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, served) {
        const address = served.requestIP(req)?.address ?? ""
        return handler(req, address)
      },
    })
    try {
      const body = chatBody("composer-2.5")
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer proxy-secret",
        },
        body,
      })
      expect(res.status).toBe(200)
      const rows = handler.statusSnapshot().rows
      expect(rows[0]?.address).toBe("127.0.0.1")
    } finally {
      server.stop(true)
    }
  })

  test("a models failure does not become a chat row", async () => {
    const handler = createHandler(baseConfig, {
      getAccessToken: async () => {
        throw new Error("no token")
      },
    })
    const res = await handler(
      new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer proxy-secret" },
      }),
    )
    expect(res.status).toBe(502)
    expect(handler.statusSnapshot().rows).toEqual([])
  })
})

function eventsRequest(key?: string): Request {
  return new Request("http://localhost/status/events", {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  })
}

async function readStatusText(
  res: Response,
  until?: (text: string) => boolean,
): Promise<{ text: string; closed: boolean }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let closed = false
  const deadline = Date.now() + 1500
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("status stream timed out")), remaining)
        }),
      ])
      if (chunk.done) {
        closed = true
        break
      }
      text += decoder.decode(chunk.value, { stream: true })
      if (!until || until(text)) break
    }
    return { text, closed }
  } finally {
    await reader.cancel()
  }
}

describe("status routes", () => {
  test("GET /status is an empty html shell", async () => {
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => textModel("Hi"),
    })
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: statusRoutes,
      fetch(req) {
        return handler(req)
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const before = await fetch(`${origin}/status`)
      expect(before.status).toBe(200)
      expect(before.headers.get("Content-Type")).toContain("text/html")
      expect(before.headers.get("Access-Control-Allow-Origin")).toBeNull()
      const beforeHtml = await before.text()
      const recorded = await handler(chatPost(chatBody("</script>")))
      expect(recorded.status).toBe(200)
      const afterHtml = await (await fetch(`${origin}/status`)).text()
      const script = await (await fetch(`${origin}/status.js`)).text()
      const parser = await (await fetch(`${origin}/status-snapshot.js`)).text()
      expect(afterHtml).toBe(beforeHtml)
      expect(afterHtml).toContain('id="hourly"')
      expect(afterHtml).toContain('id="grid"')
      expect(afterHtml).toContain("Last 24 hours")
      expect(afterHtml).toContain("Last year")
      expect(afterHtml).toContain("<table")
      expect(afterHtml).toContain("Not connected")
      expect(afterHtml).toContain('class="nav"')
      expect(afterHtml).toContain('data-lamp="busy"')
      expect(afterHtml).toContain("@media (prefers-color-scheme: dark)")
      expect(afterHtml).toContain("color-scheme: dark")
      expect(afterHtml).toContain('type="password"')
      expect(afterHtml).toContain('autocomplete="off"')
      expect(afterHtml).toContain('src="/status.js"')
      expect(afterHtml).toContain("form[hidden]")
      expect(script).toContain('from "./status-snapshot.js"')
      expect(script).toContain('from "./status-chart.js"')
      const chart = await (await fetch(`${origin}/status-chart.js`)).text()
      expect(chart).toContain("export function levels")
      expect(script).toContain("textContent")
      expect(script).toContain('get("api_key")')
      expect(script).toContain("form.hidden")
      expect(parser).toContain("function createSnapshotParser")
      for (const text of [afterHtml, script, parser]) {
        expect(text).not.toContain("proxy-secret")
        expect(text).not.toContain("proxyApiKey")
        expect(text).not.toContain("composer-2.5")
        expect(text).not.toContain("localStorage")
        expect(text).not.toContain("sessionStorage")
      }
    } finally {
      server.stop(true)
    }
  })

  test("GET /status/events starts with an empty snapshot", async () => {
    const handler = createHandler(baseConfig, authStub)
    const res = await handler(eventsRequest("proxy-secret"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
    const { text, closed } = await readStatusText(res)
    expect(closed).toBe(false)
    const payload = JSON.parse(text.slice("data: ".length).trim()) as {
      rows: unknown[]
      inFlight: boolean
      hourly: number[]
      daily: number[]
    }
    expect(payload.rows).toEqual([])
    expect(payload.inFlight).toBe(false)
    expect(payload.hourly).toEqual(Array(24).fill(0))
    expect(payload.daily.length).toBeGreaterThanOrEqual(365)
    expect(payload.daily.length).toBeLessThanOrEqual(371)
    expect(payload.daily.every((count) => count === 0)).toBe(true)
  })

  test("GET /status/events replays a recorded chat", async () => {
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => textModel("Hi"),
    })
    const posted = await handler(chatPost(chatBody("composer-2.5")))
    expect(posted.status).toBe(200)
    const res = await handler(eventsRequest("proxy-secret"))
    const { text } = await readStatusText(res)
    const payload = JSON.parse(text.slice("data: ".length).trim()) as {
      rows: Array<{ model: string }>
      inFlight: boolean
    }
    expect(payload.inFlight).toBe(false)
    expect(payload.rows[0]?.model).toBe("composer-2.5")
    const chart = payload as { hourly?: number[]; daily?: number[] }
    expect(chart.hourly?.reduce((sum, count) => sum + count, 0)).toBe(1)
    expect(chart.daily?.reduce((sum, count) => sum + count, 0)).toBe(1)
  })

  test("GET /status/events without a key is 401 and adds no row", async () => {
    const handler = createHandler(baseConfig, authStub)
    const res = await handler(eventsRequest())
    expect(res.status).toBe(401)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
    expect(await res.json()).toEqual({
      error: {
        message: "Missing Authorization header. Expected Bearer <api-key>.",
        type: "authentication_error",
        code: "missing_credentials",
      },
    })
    expectStatus(handler.statusSnapshot(), { rows: [], inFlight: false })
  })

  test("status events stay open and emit a heartbeat before a later row", async () => {
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => textModel("Hi"),
      statusHeartbeatMs: 20,
    })
    const res = await handler(eventsRequest("proxy-secret"))
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ""
    let posted = false
    const deadline = Date.now() + 1500
    try {
      while (Date.now() < deadline) {
        const chunk = await reader.read()
        expect(chunk.done).toBe(false)
        text += decoder.decode(chunk.value, { stream: true })
        if (!posted && text.includes(": keep-alive\n\n")) {
          const post = await handler(chatPost(chatBody("composer-2.5")))
          expect(post.status).toBe(200)
          posted = true
        }
        if (posted && text.includes("composer-2.5")) break
      }
    } finally {
      await reader.cancel()
    }
    expect(posted).toBe(true)
    expect(text.indexOf(": keep-alive\n\n")).toBeGreaterThanOrEqual(0)
    expect(text.indexOf("composer-2.5")).toBeGreaterThan(text.indexOf(": keep-alive\n\n"))
  })

  test("a throwing subscriber does not fail a later chat post", async () => {
    let calls = 0
    const bad = {
      enqueue() {
        calls += 1
        throw new Error("blocked")
      },
    }
    const sinks = new Set([bad])
    const handler = createHandler(baseConfig, authStub, {
      languageModel: () => textModel("Hi"),
      statusSinks: sinks,
    })
    const res = await handler(chatPost(chatBody("composer-2.5")))
    expect(res.status).toBe(200)
    expect(calls).toBe(1)
    expect(sinks.has(bad)).toBe(false)
    const again = await handler(chatPost(chatBody("composer-2.5")))
    expect(again.status).toBe(200)
    expect(calls).toBe(1)
  })
})