import { fileURLToPath } from "node:url"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { AppConfig } from "./config.ts"
import { requireProxyApiKey } from "./auth.ts"
import type { AuthSession } from "./auth-session.ts"
import {
  DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
  handleChatCompletion,
  sessionHeadersFromRequest,
  SSE_HEARTBEAT,
  SSE_RESPONSE_HEADERS,
} from "./bridge.ts"
import { getBackend } from "./cursor.ts"
import { ApiError, corsHeaders, errorResponse } from "./errors.ts"
import { listModels, normalizeModelId } from "./models.ts"
import { parseChatCompletionRequest } from "./openai/request.ts"
import { sseData } from "./openai/response.ts"
import { createStatusLog, type StatusSnapshot } from "./status-log.ts"

function statusAsset(name: string) {
  return Bun.file(fileURLToPath(new URL(`../public/${name}`, import.meta.url)))
}

export const statusRoutes = {
  "/status": statusAsset("status.html"),
  "/status.js": statusAsset("status.js"),
  "/status-snapshot.js": statusAsset("status-snapshot.js"),
  "/status-chart.js": statusAsset("status-chart.js"),
}

export type AuthTokenSource = Pick<AuthSession, "getAccessToken">

export type StatusSink = {
  enqueue(bytes: Uint8Array): void
}

type LiveSink = StatusSink & {
  latest?: Uint8Array
}

export type HandlerDeps = {
  languageModel?: (modelId: string, accessToken: string) => LanguageModelV3
  statusHeartbeatMs?: number
  statusSinks?: Set<StatusSink>
}

function statusAuthError(err: unknown): Response {
  const res = errorResponse(err)
  const headers = new Headers(res.headers)
  for (const name of Object.keys(corsHeaders())) headers.delete(name)
  return new Response(res.body, { status: res.status, headers })
}

function readChatJson(raw: Uint8Array): { requestBytes: number; json?: unknown; invalid: boolean } {
  const requestBytes = raw.byteLength
  try {
    return { requestBytes, json: JSON.parse(new TextDecoder().decode(raw)), invalid: false }
  } catch {
    return { requestBytes, invalid: true }
  }
}

export type ProxyHandler = ((req: Request, clientAddress?: string) => Promise<Response>) & {
  statusSnapshot(): StatusSnapshot
  close(): void
}

export function createHandler(
  config: AppConfig,
  auth: AuthTokenSource,
  deps?: HandlerDeps,
): ProxyHandler {
  const encoder = new TextEncoder()
  const subscribers = deps?.statusSinks ?? new Set<StatusSink>()
  const statusHeartbeatMs = deps?.statusHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_INTERVAL_MS
  const timers = new WeakMap<StatusSink, ReturnType<typeof setTimeout>>()

  function removeSubscriber(sub: StatusSink): void {
    subscribers.delete(sub)
    const timer = timers.get(sub)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(sub)
  }

  function encodeSnapshot(snapshot: StatusSnapshot): Uint8Array {
    return encoder.encode(sseData(snapshot))
  }

  function publish(snapshot: StatusSnapshot): void {
    if (subscribers.size === 0) return
    const bytes = encodeSnapshot(snapshot)
    for (const sub of [...subscribers]) {
      try {
        sub.enqueue(bytes)
      } catch {
        removeSubscriber(sub)
      }
    }
  }

  const log = createStatusLog({ onChange: publish, path: config.statusDb })

  function statusEvents(): Response {
    let sink: LiveSink | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const current: LiveSink = {
          enqueue(bytes) {
            if (controller.desiredSize === null) {
              throw new Error("status subscriber closed")
            }
            if (controller.desiredSize <= 0) {
              current.latest = bytes
              return
            }
            controller.enqueue(bytes)
          },
        }
        sink = current
        subscribers.add(current)
        try {
          current.enqueue(encodeSnapshot(log.snapshot()))
        } catch {
          removeSubscriber(current)
          return
        }
        const beat = () => {
          try {
            controller.enqueue(encoder.encode(SSE_HEARTBEAT))
          } catch {
            removeSubscriber(current)
            return
          }
          const timer = setTimeout(beat, statusHeartbeatMs)
          timer.unref?.()
          timers.set(current, timer)
        }
        const timer = setTimeout(beat, statusHeartbeatMs)
        timer.unref?.()
        timers.set(current, timer)
      },
      pull() {
        const current = sink
        if (!current?.latest) return
        const bytes = current.latest
        current.latest = undefined
        try {
          current.enqueue(bytes)
        } catch {
          removeSubscriber(current)
        }
      },
      cancel() {
        if (sink) removeSubscriber(sink)
      },
    })
    return new Response(stream, {
      headers: SSE_RESPONSE_HEADERS,
    })
  }

  async function responseByteLength(res: Response): Promise<number> {
    return (await res.clone().arrayBuffer()).byteLength
  }

  async function recordFailure(
    address: string,
    model: string,
    requestBytes: number,
    err: unknown,
  ): Promise<Response> {
    const res = errorResponse(err)
    log.record({
      address,
      model,
      requestBytes,
      responseBytes: await responseByteLength(res),
    })
    return res
  }

  async function completeChat(req: Request, clientAddress: string): Promise<Response> {
    const body = readChatJson(new Uint8Array(await req.arrayBuffer()))
    const requestBytes = body.requestBytes
    if (body.invalid) {
      return recordFailure(
        clientAddress,
        "",
        requestBytes,
        new ApiError("Request body must be valid JSON.", 400),
      )
    }
    const json = body.json

    let parsed: ReturnType<typeof parseChatCompletionRequest>
    try {
      parsed = parseChatCompletionRequest(json)
    } catch (err) {
      return recordFailure(clientAddress, "", requestBytes, err)
    }

    const requestedModel = parsed.model
    const modelId = normalizeModelId(requestedModel)
    if (!modelId) {
      return recordFailure(
        clientAddress,
        requestedModel,
        requestBytes,
        new ApiError("model must be a non-empty string", 400),
      )
    }

    let accessToken: string
    try {
      accessToken = await auth.getAccessToken()
    } catch (err) {
      return recordFailure(clientAddress, requestedModel, requestBytes, err)
    }

    const request = { ...parsed, model: modelId }
    const id = log.start({
      address: clientAddress,
      model: requestedModel,
      requestBytes,
    })
    let streamArmed = false
    let streamBytes = 0

    try {
      const model = deps?.languageModel
        ? deps.languageModel(modelId, accessToken)
        : getBackend(accessToken, config).languageModel(modelId)
      const response = await handleChatCompletion({
        model,
        request,
        abortSignal: req.signal,
        headers: sessionHeadersFromRequest(req.headers),
        ...(request.stream
          ? {
              streamObserver: {
                enqueued(byteLength: number) {
                  streamBytes += byteLength
                },
                ready() {
                  streamArmed = true
                },
                settled() {
                  log.finish(id, streamBytes)
                },
              },
            }
          : {}),
      })
      if (!request.stream) {
        log.finish(id, await responseByteLength(response))
      }
      return response
    } catch (err) {
      if (streamArmed) throw err
      const res = errorResponse(err)
      log.finish(id, await responseByteLength(res))
      return res
    }
  }

  async function handler(req: Request, clientAddress = ""): Promise<Response> {
    try {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() })
      }

      const url = new URL(req.url)

      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true }, { headers: corsHeaders() })
      }

      if (req.method === "GET" && url.pathname === "/status/events") {
        try {
          requireProxyApiKey(req, config)
        } catch (err) {
          return statusAuthError(err)
        }
        return statusEvents()
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        requireProxyApiKey(req, config)
        const accessToken = await auth.getAccessToken()
        const backend = getBackend(accessToken, config)
        const body = await listModels(config, { accessToken, backend })
        return Response.json(body, { headers: corsHeaders() })
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        requireProxyApiKey(req, config)
        return await completeChat(req, clientAddress)
      }

      throw new ApiError(`Unknown route: ${req.method} ${url.pathname}`, 404, "invalid_request_error", "not_found")
    } catch (err) {
      return errorResponse(err)
    }
  }

  return Object.assign(handler, {
    statusSnapshot() {
      return log.snapshot()
    },
    close() {
      log.close()
    },
  })
}

export function startServer(config: AppConfig, auth: AuthTokenSource, deps?: HandlerDeps) {
  const handler = createHandler(config, auth, deps)
  const server = Bun.serve({
    port: config.port,
    routes: statusRoutes,
    fetch(req, served) {
      const address = served.requestIP(req)?.address ?? ""
      return handler(req, address)
    },
    // Default 10s kills slow non-stream completions and pre-stream upstream waits
    // mid-response; SSE heartbeats cover silence during streaming itself.
    idleTimeout: 255, // Bun maximum
  })
  console.log(`cursor-openai listening on http://localhost:${server.port}`)
  console.log(`  GET  /health`)
  console.log(`  GET  /status`)
  console.log(`  GET  /status/events`)
  console.log(`  GET  /v1/models`)
  console.log(`  POST /v1/chat/completions`)
  console.log(`  status db ${config.statusDb}`)
  return {
    port: server.port,
    stop(closeActiveConnections?: boolean) {
      handler.close()
      return server.stop(closeActiveConnections)
    },
  }
}
