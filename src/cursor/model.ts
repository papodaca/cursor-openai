import fs from "node:fs"
import { createHash } from "node:crypto"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider"
import {
  bidiRunStream,
  normalizeAgentRunOrigin,
  type BidiStream,
} from "./transport/connect.js"
import { trace } from "./debug.js"
import { buildRunRequest, buildHeartbeat } from "./protocol/request.js"
import {
  buildExecClientMessages,
  toolsToDescriptors,
} from "./protocol/tools.js"
import { getCheckpoint } from "./protocol/checkpoint.js"
import { bindConversationId } from "./protocol/conversation-bind.js"
import {
  resolveContinuationPolicy,
  sessionManager,
  type CursorContinuationOptions,
  type CursorSession,
} from "./session.js"
import {
  CursorAuthError,
  CursorProtocolError,
  CursorTransportError,
  toCursorProviderError,
} from "./errors.js"
import {
  readCache,
  cacheFilePath,
  resolveVariantParameters,
  paramsImplyMaxMode,
  extractCursorVariantParameters,
  resolveCursorWireModelId,
  type ModelInfo,
} from "./models.js"
import { resolveAgentUrl } from "./agent-url.js"
import { CURSOR_API_HOST, CURSOR_PROVIDER_ID, defaultCacheDir } from "./shared.js"
import type { CursorRetryOptions } from "./retry.js"
import { resolveRetryPolicy } from "./retry.js"
import {
  computeAllowTools,
  estimatePromptTokens,
  estimateTokens,
  extractPromptHistory,
  extractSystemPrompt,
  extractTools,
  extractTrailingToolResults,
  extractToolResults,
  extractUserText,
  foldStreamParts,
  sessionKeyFromHeaders,
  type ExtractedToolResult,
  type V3Part,
} from "./prompt.js"
import { pumpWithRecovery, type CursorRunRecovery } from "./pump.js"
import { extractPromptImages, promptHasImages, type CursorImageInput, CursorImageInputError } from "./image-input.js"

export type CreateCursorAdapterOptions = {
  /** Plain Cursor access token (oauth refresh is the caller's job). */
  accessToken?: string
  /** API base for auth, model discovery, and GetServerConfig. */
  apiBaseURL?: string
  /** Explicit Cursor agent Run host override. */
  agentBaseURL?: string
  /** Forwarded onto the Run stream handshake (session id headers). */
  headers?: Record<string, string>
  /** Proxy cache root for model/version caches. Defaults to an XDG cache dir. */
  cacheDir?: string
  /** Held-stream policy. Defaults: heartbeat 5s, semantic idle 120s, tool inactivity 10m. */
  continuation?: CursorContinuationOptions
  /** Fresh-turn retry policy. Defaults: 3 attempts, 500ms base, 8000ms cap. */
  retry?: CursorRetryOptions
}

let _availableModels: ModelInfo[] | undefined
let _availableModelsMtimeMs = -1

export function createCursorAdapterModel(
  modelId: string,
  options: CreateCursorAdapterOptions,
  providerId: string = CURSOR_PROVIDER_ID,
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: providerId,
    modelId,
    supportedUrls: {},

    async doStream(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      return doStreamImpl(modelId, options, callOptions)
    },

    async doGenerate(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const result = await doStreamImpl(modelId, options, callOptions)
      const parts: V3Part[] = []
      const reader = result.stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
      }
      return foldStreamParts(parts)
    },
  }
}

async function doStreamImpl(
  modelId: string,
  options: CreateCursorAdapterOptions,
  callOptions: LanguageModelV3CallOptions,
): Promise<LanguageModelV3StreamResult> {
  const token = options.accessToken?.trim()
  if (!token) {
    throw new CursorAuthError("Cursor access token is required")
  }

  const prompt = callOptions.prompt
  const promptTokens = estimatePromptTokens(prompt)
  const retryPolicy = resolveRetryPolicy(options.retry)
  const openSession = (startOptions?: { recovery?: CursorRunRecovery }) =>
    startSession(modelId, token, callOptions, options, startOptions)

  const trailingToolResults = extractTrailingToolResults(prompt)
  let session = findContinuationSession(trailingToolResults)

  if (session) {
    session = deliverContinuationResults(session, trailingToolResults)
  }

  if (!session) {
    if (trailingToolResults.length > 0) {
      const ids = trailingToolResults.map((r) => `${r.sessionId}:${r.execId}`).join(",")
      trace(`continuation: ${trailingToolResults.length} interrupted trailing tool result(s) [${ids}] — rebasing fresh Run`)
      session = await openSession({ recovery: { kind: "rebase" } })
    } else {
      const historical = extractToolResults(prompt).length
      if (historical > 0) {
        trace(`fresh turn: ignoring ${historical} historical tool result(s) (not trailing)`)
      }
      session = await openSession()
    }
  }

  let activeSession = session

  return {
    stream: new ReadableStream<V3Part>({
      async pull(controller) {
        try {
          try {
            controller.enqueue({ type: "stream-start", warnings: [] } as V3Part)
          } catch (e) {
            trace(`pull: stream-start enqueue failed (cancelled) err=${(e as Error).message}`)
            return
          }
          activeSession = await pumpWithRecovery({
            initialSession: activeSession,
            controller,
            abortSignal: callOptions.abortSignal,
            promptTokens,
            retryPolicy,
            recover: (recovery) => openSession({ recovery }),
            onSession: (next) => { activeSession = next },
          })
          try {
            controller.close()
          } catch (e) {
            trace(`pull: close failed (already closed/cancelled) err=${(e as Error).message}`)
          }
        } catch (e) {
          activeSession.pumpActive = false
          trace(`pull: pump threw (cleaning up): ${(e as Error).message}`)
          sessionManager.close(activeSession)
          try {
            controller.error(e instanceof Error ? e : new Error(String(e)))
          } catch {
            /* controller already errored/closed */
          }
        }
      },
      cancel() {
        trace("ReadableStream cancel() → closeUnlessPending")
        sessionManager.closeUnlessPending(activeSession)
      },
    }),
  }
}

async function startSession(
  modelId: string,
  token: string,
  callOptions: LanguageModelV3CallOptions,
  options: CreateCursorAdapterOptions,
  startOptions?: { recovery?: CursorRunRecovery },
): Promise<CursorSession> {
  const continuationPolicy = resolveContinuationPolicy(options.continuation)
  const prompt = callOptions.prompt
  const tools = extractTools(callOptions)
  const sessionKey = sessionKeyFromHeaders(callOptions)
  const providerOptions = callOptions.providerOptions?.cursor as Record<string, unknown> | undefined
  const allowTools = computeAllowTools(tools.length, callOptions.toolChoice)
  const recovery = startOptions?.recovery
  const resuming = recovery?.kind === "resume"
  const bound = resuming
    ? { conversationId: recovery.conversationId, reset: false, previousId: undefined }
    : bindConversationId(sessionKey, { reset: recovery?.kind === "rebase" })
  const conversationId = bound.conversationId
  if (bound.reset) {
    trace(
      `conversation reset: reason=${recovery?.kind === "rebase" ? "interrupted-run" : "unknown"} ` +
        `sessionKey=${sessionKey ?? "(none)"} ` +
        `previousId=${bound.previousId ?? "-"} → conversationId=${conversationId}`,
    )
  }

  const lastUser = [...prompt].reverse().find((message) => message.role === "user")
  const userText = recovery?.kind === "rebase"
    ? "Continue the interrupted turn from the conversation history above. Do not repeat completed work."
    : (extractUserText(lastUser as unknown as Record<string, unknown> | undefined) || ".")
  const systemPrompt = extractSystemPrompt(prompt)
  const history = extractPromptHistory(prompt, {
    preserveTrailingUser: recovery?.kind === "rebase",
    toolResults: recovery?.kind === "rebase" ? "trailing" : "omit",
  })

  await loadAvailableModels(options)

  const agentBaseUrl =
    resolveExplicitAgentBaseURL(options) ??
    (await resolveAgentUrl(token, {
      apiBaseURL: resolveApiBaseURL(options),
      telemetryEnabled: isTruthyEnv(process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY),
      cacheDir: options.cacheDir,
    }))

  const picked = extractCursorVariantParameters(providerOptions)
  const cursorModelId = resolveCursorWireModelId(providerOptions, modelId)
  const reasoningEffort = typeof providerOptions?.reasoningEffort === "string"
    ? providerOptions.reasoningEffort
    : undefined
  const hintMaxMode = !!(providerOptions?.maxMode ?? false)

  const modelInfo = _availableModels?.find((m) => m.id === cursorModelId)
  const parameterValues = resolveVariantParameters(modelInfo, {
    reasoningEffort,
    maxMode: hintMaxMode,
    picked,
  })
  const maxMode = hintMaxMode || paramsImplyMaxMode(parameterValues)

  const conversationState = resuming
    ? recovery.checkpoint
    : (bound.reset ? undefined : getCheckpoint(conversationId))
  const includeHistoryImages = !conversationState
  if (
    !resuming &&
    modelInfo?.supportsImages === false &&
    promptHasImages(prompt, includeHistoryImages)
  ) {
    throw new CursorImageInputError(`Cursor model ${cursorModelId} does not support image input.`)
  }
  const images: CursorImageInput[] =
    resuming || modelInfo?.supportsImages === false
      ? []
      : await extractPromptImages(prompt, {
          includeHistory: includeHistoryImages,
          signal: callOptions.abortSignal,
        })

  const stream = await bidiRunStream(token, {
    baseURL: agentBaseUrl,
    headers: options.headers,
    cacheDir: options.cacheDir,
  })
  const toolDescriptors = tools.length > 0 ? toolsToDescriptors(tools) : []
  const reqBytes = buildRunRequest({
    text: userText,
    images,
    modelId: cursorModelId,
    conversationId,
    systemPrompt: conversationState ? undefined : systemPrompt,
    history: conversationState ? undefined : history,
    conversationState,
    parameterValues,
    maxMode,
    tools,
    toolDescriptors,
    action: resuming ? "resume" : "user",
  })
  const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex")
  const historyChars = history.reduce((n, m) => n + m.content.length, 0)
  const usageEstimate = {
    inputTokens: estimateTokens(
      (systemPrompt?.length ?? 0) + userText.length + historyChars + (conversationState?.length ?? 0),
    ),
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningTokens: 0,
  }
  trace(
    `outbound Run: model=${cursorModelId} wireModel=${modelId} conversationId=${conversationId} ` +
      `params=${JSON.stringify(parameterValues ?? [])} ` +
      `maxMode=${maxMode} systemPromptLen=${systemPrompt?.length ?? 0} ` +
      `tools=${tools.length} images=${images.length} ` +
      `availableModels=${_availableModels?.length ?? 0} userTextLen=${userText.length} ` +
      `historyMsgs=${history.length} historyChars=${historyChars} ` +
      `checkpointLen=${conversationState?.length ?? 0} reset=${bound.reset} ` +
      `resume=${resuming} ` +
      `usageEstimateIn=${usageEstimate.inputTokens} runRequestBytes=${reqBytes.length}`,
  )
  trace(`hash run_request sha256=${sha(reqBytes)}`)
  if (systemPrompt) trace(`hash systemPrompt sha256=${sha(systemPrompt)}`)
  if (conversationState) trace(`hash checkpoint sha256=${sha(conversationState)}`)

  try {
    await writeWithBackpressure(stream, reqBytes, "initial Run request")
  } catch (error) {
    stream.destroy()
    throw error
  }

  const session: CursorSession = {
    sessionId: crypto.randomUUID(),
    conversationId,
    resumeCheckpoint: undefined,
    openCodeSessionId: sessionKey,
    stream,
    frames: stream.frames()[Symbol.asyncIterator](),
    pending: new Map(),
    blobs: new Map(),
    toolDescriptors,
    allowTools,
    usageEstimate,
    pumpActive: false,
    pumpOwner: null,
    heartbeat: null,
    heartbeatCancel: null,
    hardDeadlineTimer: null,
    semanticDeadlineCancel: null,
    terminalUnsubscribe: null,
    deferredTerminalReason: null,
    policy: continuationPolicy,
    createdAt: Date.now(),
    lastInboundAt: Date.now(),
    lastHeartbeatWriteAt: Date.now(),
    semanticDeadlineAt: Date.now() + continuationPolicy.semanticIdleMs,
    closeError: null,
    closed: false,
  }
  sessionManager.registerSession(session)
  let heartbeatWritePending = false
  session.heartbeat = setInterval(() => {
    if (session.closed) return
    if (heartbeatWritePending) {
      sessionManager.close(
        session,
        "heartbeat-write-failed",
        new CursorTransportError("Cursor heartbeat write remained backpressured", {
          transient: false,
          replaySafe: false,
          code: "CURSOR_HEARTBEAT_BACKPRESSURE",
        }),
      )
      return
    }
    heartbeatWritePending = true
    void writeWithBackpressure(stream, buildHeartbeat(), "heartbeat")
      .then(() => sessionManager.recordHeartbeatWrite(session))
      .catch((cause) => {
        sessionManager.close(
          session,
          "heartbeat-write-failed",
          toCursorProviderError(cause, {
            replaySafe: false,
            fallback: "Cursor heartbeat write failed",
          }),
        )
      })
      .finally(() => { heartbeatWritePending = false })
  }, continuationPolicy.heartbeatMs)
  session.heartbeat.unref?.()
  session.heartbeatCancel = () => {
    if (session.heartbeat) clearInterval(session.heartbeat)
  }

  callOptions.abortSignal?.addEventListener("abort", () => {
    trace("abortSignal aborted → closeUnlessPending")
    sessionManager.closeUnlessPending(session)
  }, { once: true })
  return session
}

export function findContinuationSession(
  toolResults: Array<{ sessionId: string; execId: number }>,
): CursorSession | undefined {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i]!
    const s = sessionManager.findByExecIds(r.sessionId, [r.execId])
    if (s) return s
  }
  return undefined
}

/**
 * Deliver trailing tool results onto a live continuation session.
 * Returns undefined after closing the session when a write fails, so the
 * caller can rebase onto a fresh Run instead of pumping a dead stream.
 */
export function deliverContinuationResults(
  session: CursorSession,
  trailingToolResults: ExtractedToolResult[],
): CursorSession | undefined {
  const pendingResults = trailingToolResults.filter(
    (r) => r.sessionId === session.sessionId && session.pending.has(r.execId),
  )
  trace(
    `continuation: ${trailingToolResults.length} trailing tool result(s), ` +
      `${pendingResults.length} pending for sessionId=${session.sessionId} ` +
      `pending={${[...session.pending.keys()].join(",")}}`,
  )
  for (const r of pendingResults) {
    const claim = sessionManager.claim(session.sessionId, r.execId)
    if ("kind" in claim) {
      if (claim.kind === "deliverable") {
        throw new CursorProtocolError("Cursor continuation claim remained unclaimed")
      }
      if (claim.kind === "duplicate") {
        trace(`continuation: skipped duplicate execId=${r.execId} reason=${claim.reason}`)
        continue
      }
      trace(`continuation: unavailable execId=${r.execId} reason=${claim.reason}`)
      return undefined
    }
    const pending = claim.pending
    let frames: Uint8Array[]
    try {
      frames = buildExecClientMessages({
        execId: r.execId,
        resultField: pending.resultField,
        output: r.output,
        error: r.error,
        toolName: pending.toolName ?? r.toolName,
        resultMetadata: pending.resultMetadata,
      })
    } catch (error) {
      trace(`continuation: result encode FAILED execId=${r.execId} err=${(error as Error).message}`)
      sessionManager.close(session, "result-write-failed")
      return undefined
    }
    const outcome = sessionManager.deliverClaim(claim, frames)
    if (outcome.kind !== "delivered") {
      trace(`continuation: delivery stopped execId=${r.execId} reason=${outcome.reason}`)
      if (outcome.kind === "duplicate") continue
      return undefined
    }
    session.usageEstimate.inputTokens += estimateTokens(r.output.length)
    trace(
      `continuation: wrote exec result execId=${r.execId} field=${pending.resultField} ` +
        `frames=${outcome.framesWritten} outLen=${r.output.length}`,
    )
  }
  return session
}

async function loadAvailableModels(options: CreateCursorAdapterOptions): Promise<void> {
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  try {
    const filePath = cacheFilePath(cacheDir)
    let mtime = 0
    try {
      const stat = await fs.promises.stat(filePath)
      mtime = stat.mtimeMs
    } catch {
      // file missing
    }
    if (mtime !== _availableModelsMtimeMs) {
      const cached = await readCache(cacheDir)
      _availableModels = cached?.models
      _availableModelsMtimeMs = mtime
    }
  } catch { /* ignore */ }
}

function resolveApiBaseURL(options: CreateCursorAdapterOptions): string {
  return options.apiBaseURL ?? process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`
}

function resolveExplicitAgentBaseURL(options: CreateCursorAdapterOptions): string | undefined {
  const raw = options.agentBaseURL
  if (!raw) return undefined
  const normalized = normalizeAgentRunOrigin(raw)
  if (!normalized) {
    throw new CursorProtocolError(
      "Invalid Cursor agent base URL override: expected https://*.cursor.sh",
    )
  }
  return normalized
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true"
}

async function writeWithBackpressure(
  stream: BidiStream,
  message: Uint8Array,
  operation: string,
): Promise<void> {
  let accepted: boolean | void
  try {
    accepted = stream.write(message)
  } catch (cause) {
    throw toCursorProviderError(cause, {
      replaySafe: false,
      fallback: `Cursor ${operation} write failed`,
    })
  }
  if (accepted !== false) return
  if (!stream.waitForDrain) {
    throw new CursorTransportError(`Cursor ${operation} write was backpressured`, {
      transient: false,
      replaySafe: false,
      code: "CURSOR_WRITE_BACKPRESSURE",
    })
  }
  try {
    await stream.waitForDrain(5_000)
  } catch (cause) {
    throw toCursorProviderError(cause, {
      replaySafe: false,
      fallback: `Cursor ${operation} backpressure drain failed`,
    })
  }
}

/** Test helper — clear in-memory model cache for the adapter. */
export function resetAdapterModelCacheForTests(): void {
  _availableModels = undefined
  _availableModelsMtimeMs = -1
}