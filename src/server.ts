import type { AppConfig } from "./config.ts"
import { requireProxyApiKey } from "./auth.ts"
import type { AuthSession } from "./auth-session.ts"
import { handleChatCompletion, sessionHeadersFromRequest } from "./bridge.ts"
import { getLanguageModel } from "./cursor.ts"
import { ApiError, corsHeaders, errorResponse } from "./errors.ts"
import { listModels } from "./models.ts"
import { parseChatCompletionRequest } from "./openai/request.ts"

export type AuthTokenSource = Pick<AuthSession, "getAccessToken">

export function createHandler(config: AppConfig, auth: AuthTokenSource) {
  return async function handler(req: Request): Promise<Response> {
    try {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() })
      }

      const url = new URL(req.url)

      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true }, { headers: corsHeaders() })
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        requireProxyApiKey(req, config)
        const body = await listModels(config)
        return Response.json(body, { headers: corsHeaders() })
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        requireProxyApiKey(req, config)

        let json: unknown
        try {
          json = await req.json()
        } catch {
          throw new ApiError("Request body must be valid JSON.", 400)
        }

        const parsed = parseChatCompletionRequest(json)
        const accessToken = await auth.getAccessToken()
        const model = getLanguageModel(parsed.model, accessToken, config)
        return await handleChatCompletion({
          model,
          request: parsed,
          abortSignal: req.signal,
          headers: sessionHeadersFromRequest(req.headers),
        })
      }

      throw new ApiError(`Unknown route: ${req.method} ${url.pathname}`, 404, "invalid_request_error", "not_found")
    } catch (err) {
      return errorResponse(err)
    }
  }
}

export function startServer(config: AppConfig, auth: AuthTokenSource) {
  const fetch = createHandler(config, auth)
  const server = Bun.serve({
    port: config.port,
    fetch,
  })
  console.log(`cursor-openai listening on http://localhost:${server.port}`)
  console.log(`  GET  /health`)
  console.log(`  GET  /v1/models`)
  console.log(`  POST /v1/chat/completions`)
  return server
}
