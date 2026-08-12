import type { LanguageModelV3FinishReason, LanguageModelV3Usage } from "@ai-sdk/provider"
import {
  CursorRunInterruptedError,
} from "./transport/connect.js"
import { trace } from "./debug.js"
import { decodeFramePayload } from "./protocol/framing.js"
import { debugWalkTurnEnded, decodeMessage } from "./protocol/messages.js"
import {
  parseExecServerMessage,
  buildToolCallPart,
  buildExecClientMessages,
  buildRequestContextResult,
  buildMcpStateResult,
  buildListMcpResourcesFallback,
  buildReadMcpResourceFallback,
  detectExecVariantField,
  advertisedToolNamesFromDescriptors,
  type ParsedExecRequest,
} from "./protocol/tools.js"
import { describeCursorExecVariant } from "./protocol/exec-variants.js"
import { handleKvServerMessage } from "./protocol/kv.js"
import { handleInteractionQuery } from "./protocol/interactions.js"
import { setCheckpoint } from "./protocol/checkpoint.js"
import { conversationBlobCount } from "./protocol/blob-store.js"
import {
  sessionManager,
  type CursorSession,
  type Frame,
} from "./session.js"
import {
  CursorProtocolError,
  CursorProviderError,
  CursorRetryExhaustedError,
  CursorTransportError,
  retrySuppressedError,
  toCursorProviderError,
} from "./errors.js"
import { analyzeReplayFrame, AttemptReplaySafety } from "./replay-safety.js"
import { readAllFieldsStrict } from "./protocol/struct.js"
import {
  buildLanguageModelV3UsageFromEstimate,
  buildLanguageModelV3UsageFromTurnEnded,
  turnEndedCounter,
} from "./usage.js"
import {
  connectFrameError,
  DEFAULT_RETRY_POLICY,
  retryDelayMs,
  sleepForRetry,
  type CursorRetryPolicy,
} from "./retry.js"
import {
  cursorTurnEndedProviderMetadata,
  estimateTokens,
  spanEndParts,
  type V3Part,
} from "./prompt.js"

const RUN_REQUEST_DECODE_FAILED = "CURSOR_RUN_REQUEST_DECODE_FAILED"
const RUN_REQUEST_UNSUPPORTED = "CURSOR_RUN_REQUEST_UNSUPPORTED"
const RUN_REPLY_FAILED = "CURSOR_RUN_REPLY_FAILED"

/**
 * Schema-minimal empty RequestContext (zero populated fields) for the
 * must-reply exec #10 / #36 control-plane probes.
 */
const EMPTY_REQUEST_CONTEXT: Record<string, unknown> = {}

type ResponseRequiredChannel = "exec" | "kv" | "interaction" | "multiple"
const RESPONSE_REQUIRED_CHANNEL_BY_FIELD = new Map<
  number,
  Exclude<ResponseRequiredChannel, "multiple">
>([
  [2, "exec"],
  [4, "kv"],
  [7, "interaction"],
])

function responseRequiredChannel(payload: Uint8Array): ResponseRequiredChannel | undefined {
  const fields = readAllFieldsStrict(payload)
  if (fields) {
    const channels = fields
      .map((field) => RESPONSE_REQUIRED_CHANNEL_BY_FIELD.get(field.fn))
      .filter((channel): channel is Exclude<ResponseRequiredChannel, "multiple"> => !!channel)
    if (channels.length > 1) return "multiple"
    return channels[0]
  }

  const tag = payload[0]
  return tag !== undefined ? RESPONSE_REQUIRED_CHANNEL_BY_FIELD.get(tag >> 3) : undefined
}

function normalizeCheckpointBytes(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array) return raw
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw)
  if (Array.isArray(raw)) return Uint8Array.from(raw)
  if (raw && typeof raw === "object" && "type" in (raw as object) && "data" in (raw as object)) {
    const data = (raw as { data: unknown }).data
    if (Array.isArray(data)) return Uint8Array.from(data)
  }
  return undefined
}

async function nextFrameWithSemanticDeadline(
  session: CursorSession,
): Promise<IteratorResult<Frame>> {
  const remainingMs = session.semanticDeadlineAt - Date.now()
  if (remainingMs <= 0) {
    throw new CursorTransportError(
      `Cursor semantic-progress timeout after ${session.policy.semanticIdleMs}ms`,
      { transient: true, replaySafe: true, code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" },
    )
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectCancelled: ((error: CursorProviderError) => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    rejectCancelled = reject
    timer = setTimeout(() => {
      reject(
        new CursorTransportError(
          `Cursor semantic-progress timeout after ${session.policy.semanticIdleMs}ms`,
          { transient: true, replaySafe: true, code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" },
        ),
      )
    }, remainingMs)
    timer.unref?.()
  })
  session.semanticDeadlineCancel = () => {
    rejectCancelled?.(
      session.closeError ?? new CursorTransportError("Cursor semantic wait cancelled locally", {
        transient: false,
        replaySafe: false,
      }),
    )
  }
  try {
    return await Promise.race([session.frames.next(), deadline])
  } finally {
    if (timer) clearTimeout(timer)
    session.semanticDeadlineCancel = null
  }
}

export type CursorRunRecovery =
  | { kind: "rebase" }
  | { kind: "resume"; conversationId: string; checkpoint: Uint8Array }

export async function pumpWithRecovery(input: {
  initialSession: CursorSession
  controller: ReadableStreamDefaultController<V3Part>
  abortSignal?: AbortSignal
  promptTokens?: number
  retryPolicy?: CursorRetryPolicy
  recover: (recovery: CursorRunRecovery) => Promise<CursorSession>
  onSession?: (session: CursorSession) => void
  maxRecoveries?: number
}): Promise<CursorSession> {
  let session = input.initialSession
  const retryPolicy = input.retryPolicy ?? {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: (input.maxRecoveries ?? 1) + 1,
  }
  const maxRecoveries = retryPolicy.maxAttempts - 1
  const requestUsage = { outputChars: 0 }
  input.onSession?.(session)

  for (let attempt = 0; ; attempt++) {
    const pumpedSession = session
    const pumpOwner = Symbol("cursor-pump")
    sessionManager.beginPump(pumpedSession, pumpOwner)
    try {
      await pump(
        pumpedSession,
        input.controller,
        {
          textId: crypto.randomUUID(),
          reasoningId: crypto.randomUUID(),
          promptTokens: input.promptTokens ?? 0,
          requestUsage,
        },
        input.abortSignal,
      )
      return session
    } catch (error) {
      const failure = toCursorProviderError(error, {
        replaySafe: error instanceof CursorProviderError ? error.replaySafe : false,
        fallback: "Cursor Run interrupted",
      })
      if (!failure.transient) throw failure
      const checkpoint = pumpedSession.resumeCheckpoint
      if (!failure.replaySafe && !checkpoint) {
        throw retrySuppressedError(
          failure,
          "after visible output or stateful server activity",
          attempt + 1,
          maxRecoveries + 1,
        )
      }
      if (attempt >= maxRecoveries) {
        throw new CursorRetryExhaustedError(attempt + 1, failure)
      }
      trace(
        `Run interrupted: sessionId=${pumpedSession.sessionId} attempt=${attempt + 1}/${maxRecoveries} ` +
          `err=${failure.message} — ${checkpoint ? `resuming ${checkpoint.length}B checkpoint` : "rebasing fresh Run"}`,
      )
      sessionManager.close(pumpedSession, "remote-error", failure)
      const delayMs = retryDelayMs(failure, attempt + 1, retryPolicy)
      trace(`Run retry backoff: attempt=${attempt + 1}/${maxRecoveries} delayMs=${delayMs}`)
      await sleepForRetry(delayMs, input.abortSignal)
      const recovery: CursorRunRecovery = checkpoint
        ? {
            kind: "resume",
            conversationId: pumpedSession.conversationId,
            checkpoint: Uint8Array.from(checkpoint),
          }
        : { kind: "rebase" }
      session = await input.recover(recovery)
      if (recovery.kind === "resume") {
        session.hadToolCallBoundary = pumpedSession.hadToolCallBoundary
        session.usageEstimate = { ...pumpedSession.usageEstimate }
      }
      input.onSession?.(session)
    } finally {
      sessionManager.endPump(pumpedSession, pumpOwner)
    }
  }
}

/**
 * Read the held-open stream, emitting stream parts, until the turn boundary:
 *  - a tool call (exec_server_message) → emit tool-call, finish "tool-calls",
 *    and KEEP the session open for the result on the next doStream call;
 *  - turn_ended → finish "stop" and close the session;
 *  - transport EOF before turn_ended → throw for one fresh-Run recovery.
 */
export async function pump(
  session: CursorSession,
  controller: ReadableStreamDefaultController<V3Part>,
  ids: {
    textId: string
    reasoningId: string
    promptTokens?: number
    requestUsage?: { outputChars: number }
  },
  abortSignal?: AbortSignal,
): Promise<void> {
  sessionManager.registerSession(session)
  const { textId, reasoningId } = ids
  const promptTokens = ids.promptTokens ?? 0
  const advertisedToolNames = advertisedToolNamesFromDescriptors(session.toolDescriptors)
  const advertisedToolNameSet = new Set(advertisedToolNames)
  let textStarted = false
  let reasoningStarted = false
  const requestUsage = ids.requestUsage ?? { outputChars: 0 }
  const replaySafety = new AttemptReplaySafety(session.sessionId)
  const failRunProtocol = (message: string, code: string): never => {
    replaySafety.markBarrier("unknown-or-malformed-frame")
    const error = new CursorProtocolError(message, { code })
    sessionManager.close(session, "remote-error", error)
    throw error
  }

  let streamClosed = false
  const safeEnqueue = (part: V3Part): boolean => {
    if (streamClosed) return false
    try {
      controller.enqueue(part)
      return true
    } catch (e) {
      streamClosed = true
      trace(`pump: enqueue on closed controller (suppressing) err=${(e as Error).message}`)
      return false
    }
  }
  const safeError = (err: Error): void => {
    if (streamClosed) return
    try {
      controller.error(err)
    } catch (e) {
      trace(`pump: controller.error failed (suppressing) err=${(e as Error).message}`)
    }
    streamClosed = true
  }

  const rejectExec = (parsed: ParsedExecRequest, reason: string, label: string): boolean => {
    try {
      for (const frame of buildExecClientMessages({
        execId: parsed.id,
        resultField: parsed.resultField,
        output: "",
        error: reason,
        toolName: parsed.toolName,
        resultMetadata: parsed.resultMetadata,
      })) {
        session.stream.write(frame)
      }
      trace(`exec: REFUSED ${label} toolName=${parsed.toolName} id=${parsed.id}`)
      return true
    } catch (e) {
      const error = new Error(
        `Failed to reject Cursor tool request (${label}): ${(e as Error).message}`,
      )
      trace(`exec: REFUSED reply FAILED ${error.message}`)
      safeError(error)
      sessionManager.close(session)
      return false
    }
  }

  const closeOpenSpans = () => {
    for (const part of spanEndParts({ textStarted, reasoningStarted, textId, reasoningId })) {
      safeEnqueue(part as V3Part)
    }
    reasoningStarted = false
    textStarted = false
  }

  const emitText = (text: string) => {
    if (!text) return
    replaySafety.markBarrier("visible-text")
    if (reasoningStarted && !textStarted) {
      safeEnqueue({ type: "reasoning-end", id: reasoningId } as V3Part)
      reasoningStarted = false
    }
    if (!textStarted) {
      safeEnqueue({ type: "text-start", id: textId } as V3Part)
      textStarted = true
    }
    session.usageEstimate.outputTokens += estimateTokens(text.length)
    if (safeEnqueue({ type: "text-delta", id: textId, delta: text } as V3Part)) {
      requestUsage.outputChars += text.length
    }
  }
  const emitReasoning = (text: string) => {
    if (!text) return
    replaySafety.markBarrier("visible-reasoning")
    if (!reasoningStarted) {
      safeEnqueue({ type: "reasoning-start", id: reasoningId } as V3Part)
      reasoningStarted = true
    }
    session.usageEstimate.outputTokens += estimateTokens(text.length)
    if (safeEnqueue({ type: "reasoning-delta", id: reasoningId, delta: text } as V3Part)) {
      requestUsage.outputChars += text.length
    }
  }
  const emitFinish = (
    te: Record<string, unknown> | undefined,
    reason: LanguageModelV3FinishReason,
  ) => {
    closeOpenSpans()
    const cumulativeTurnEnded = !!te && session.hadToolCallBoundary === true
    if (te && !cumulativeTurnEnded) {
      session.usageEstimate = {
        inputTokens: turnEndedCounter(te, "input_tokens"),
        outputTokens: turnEndedCounter(te, "output_tokens"),
        cacheRead: turnEndedCounter(te, "cache_read"),
        cacheWrite: turnEndedCounter(te, "cache_write"),
        reasoningTokens: turnEndedCounter(te, "reasoning_tokens"),
      }
    }
    const est = session.usageEstimate
    const usage: LanguageModelV3Usage = te && !cumulativeTurnEnded
      ? buildLanguageModelV3UsageFromTurnEnded(te)
      : buildLanguageModelV3UsageFromEstimate(
          est,
          promptTokens,
          requestUsage.outputChars,
          estimateTokens,
        )
    if (!te) session.hadToolCallBoundary = true
    const providerMetadata = te ? cursorTurnEndedProviderMetadata(te) : undefined
    const reasonLabel = typeof reason === "object" && reason && "unified" in reason
      ? String((reason as { unified?: string }).unified ?? "unknown")
      : String(reason)
    const inTotal = usage.inputTokens?.total ?? 0
    const outTotal = usage.outputTokens?.total ?? 0
    trace(
      `finish: reason=${reasonLabel} ` +
        `v3In=${inTotal} v3Out=${outTotal} ` +
        `v3CacheRead=${usage.inputTokens?.cacheRead ?? 0} v3CacheWrite=${usage.inputTokens?.cacheWrite ?? 0} ` +
        `v3Reasoning=${usage.outputTokens?.reasoning ?? 0} ` +
        `rawIn=${te ? turnEndedCounter(te, "input_tokens") : est.inputTokens} ` +
        `rawOut=${te ? turnEndedCounter(te, "output_tokens") : est.outputTokens} ` +
        `rawCacheRead=${te ? turnEndedCounter(te, "cache_read") : est.cacheRead} ` +
        `rawCacheWrite=${te ? turnEndedCounter(te, "cache_write") : est.cacheWrite} ` +
        `source=${te ? (cumulativeTurnEnded ? "estimate-cumulative-turn-ended" : "turn_ended") : "estimate"}`,
    )
    safeEnqueue({
      type: "finish",
      usage,
      finishReason: reason,
      ...(providerMetadata ? { providerMetadata } : {}),
    } as V3Part)
  }

  while (true) {
    if (streamClosed) {
      trace(`pump: stream closed (consumer cancelled) pending=${session.pending.size}`)
      sessionManager.closeUnlessPending(session)
      return
    }
    if (abortSignal?.aborted) {
      trace(`pump: abortSignal aborted pending=${session.pending.size}`)
      sessionManager.closeUnlessPending(session)
      return
    }

    let next: IteratorResult<Frame>
    try {
      next = session.pending.size === 0
        ? await nextFrameWithSemanticDeadline(session)
        : await session.frames.next()
    } catch (error) {
      closeOpenSpans()
      const failure = error instanceof CursorProviderError
        ? error
        : new CursorRunInterruptedError(
            `Cursor Run frame stream interrupted: ${(error as Error).message}`,
            { cause: error },
          )
      throw replaySafety.applyTo(failure)
    }
    if (next.done) {
      closeOpenSpans()
      trace("pump: frames iterator ended before turn_ended")
      const failure = new CursorRunInterruptedError()
      throw replaySafety.applyTo(failure)
    }
    const frame = next.value as Frame

    if (frame.flags & 0x02) {
      let payload = ""
      if (frame.payload.length > 0) {
        try {
          payload = new TextDecoder().decode(decodeFramePayload(frame))
        } catch {
          replaySafety.markBarrier("unknown-or-malformed-frame")
        }
      }
      closeOpenSpans()
      const failure = payload
        ? connectFrameError(payload)
        : new CursorRunInterruptedError()
      throw replaySafety.applyTo(failure)
    }

    let payload: Uint8Array
    try {
      payload = decodeFramePayload(frame)
    } catch (e) {
      replaySafety.markBarrier("unknown-or-malformed-frame")
      trace(`gunzip FAILED (skipping frame): flags=0x${frame.flags.toString(16)} len=${frame.payload.length} err=${(e as Error).message}`)
      continue
    }
    let asm: Record<string, unknown>
    try {
      asm = decodeMessage<Record<string, unknown>>("AgentServerMessage", payload)
    } catch {
      replaySafety.markBarrier("unknown-or-malformed-frame")
      const channel = responseRequiredChannel(payload)
      if (channel) {
        failRunProtocol(`Cursor ${channel} request could not be decoded`, RUN_REQUEST_DECODE_FAILED)
      }
      trace(`decode FAILED (skipping non-request frame): flags=0x${frame.flags.toString(16)} len=${payload.length}`)
      continue
    }
    const iu = asm.interaction_update as Record<string, unknown> | undefined
    const esm = asm.exec_server_message as Record<string, unknown> | undefined
    const kv = asm.kv_server_message as Record<string, unknown> | undefined
    const execControl = asm.exec_server_control_message as Record<string, unknown> | undefined
    const interactionQuery = asm.interaction_query as Record<string, unknown> | undefined
    const checkpointRaw = asm.conversation_checkpoint_update
    const topField = payload.length > 0 ? payload[0]! >> 3 : 0
    const checkpointProgress = normalizeCheckpointBytes(checkpointRaw)
    const requiredChannel = responseRequiredChannel(payload)
    if (
      requiredChannel === "multiple" ||
      (requiredChannel === "exec" && !esm) ||
      (requiredChannel === "kv" && !kv) ||
      (requiredChannel === "interaction" && !interactionQuery)
    ) {
      failRunProtocol("Cursor response-requiring request could not be decoded", RUN_REQUEST_DECODE_FAILED)
    }
    const replayFrame = analyzeReplayFrame(payload, {
      interactionUpdate: iu,
      exec: esm,
      kv,
      execControl,
      interactionQuery,
      checkpointBytes: checkpointProgress,
    })
    if (replayFrame.semanticProgress) {
      sessionManager.recordSemanticProgress(session)
    }
    if (replayFrame.barrier) replaySafety.markBarrier(replayFrame.barrier)

    {
      const iuKind = iu ? Object.keys(iu).find((k) => iu[k]) : undefined
      trace(
        `pump frame: topField=${topField} interaction_update=${iuKind ?? "-"} ` +
          `exec=${esm ? "yes" : "no"} kv=${kv ? "yes" : "no"} ` +
          `interaction_query=${interactionQuery ? "yes" : "no"} ` +
          `checkpoint=${checkpointRaw ? "yes" : "no"}`,
      )
    }

    try {
    if (checkpointRaw != null) {
      const bytes = normalizeCheckpointBytes(checkpointRaw)
      if (bytes && bytes.length > 0) {
        setCheckpoint(session.conversationId, bytes)
        session.resumeCheckpoint = Uint8Array.from(bytes)
        trace(
          `checkpoint: stored ${bytes.length}B for conversationId=${session.conversationId}`,
        )
      }
    }

    if (iu?.text_delta) {
      emitText(((iu.text_delta as Record<string, unknown>).text as string) ?? "")
    } else if (iu?.thinking_delta) {
      emitReasoning(((iu.thinking_delta as Record<string, unknown>).text as string) ?? "")
    } else if (iu?.turn_ended) {
      trace(`turn_ended raw wire fields: ${debugWalkTurnEnded(payload)}`)
      emitFinish(iu.turn_ended as Record<string, unknown>, { unified: "stop", raw: undefined })
      sessionManager.close(session)
      return
    } else if (iu?.tool_call_started || iu?.tool_call_completed) {
      // Display-only path — proxy posture is exec pass-through only; do not
      // bridge Cursor display ToolCalls into host tool names.
      const kind = iu.tool_call_started ? "started" : "completed"
      const body = (iu.tool_call_started ?? iu.tool_call_completed) as Record<string, unknown>
      const callId = typeof body.call_id === "string" ? body.call_id : ""
      trace(`display tool_call_${kind}: ignored (no host bridge) callId=${callId || "-"}`)
    } else if (esm) {
      const esmId = (esm.id as number) ?? 0
      if (esm.request_context_args) {
        try {
          session.stream.write(buildRequestContextResult(esmId, EMPTY_REQUEST_CONTEXT))
          trace(`exec request_context: replied empty id=${esmId}`)
        } catch {
          failRunProtocol("Cursor request-context reply failed", RUN_REPLY_FAILED)
        }
      } else if (esm.mcp_state_exec_args) {
        const stateArgs = esm.mcp_state_exec_args as Record<string, unknown>
        const requested = Array.isArray(stateArgs.server_identifiers)
          ? stateArgs.server_identifiers.join(",")
          : ""
        try {
          session.stream.write(buildMcpStateResult(esmId, stateArgs, EMPTY_REQUEST_CONTEXT))
          trace(`exec mcp_state: replied id=${esmId} requested=[${requested}]`)
        } catch {
          failRunProtocol("Cursor MCP-state reply failed", RUN_REPLY_FAILED)
        }
      } else if (esm.list_mcp_resources_exec_args) {
        const args = esm.list_mcp_resources_exec_args as Record<string, unknown>
        const server = typeof args.server === "string" ? args.server : ""
        try {
          session.stream.write(buildListMcpResourcesFallback(esmId))
          trace(`exec list_mcp_resources: replied id=${esmId} server=${server || "(all)"} success{resources:[]}`)
        } catch {
          failRunProtocol("Cursor list_mcp_resources reply failed", RUN_REPLY_FAILED)
        }
      } else if (esm.read_mcp_resource_exec_args) {
        const args = esm.read_mcp_resource_exec_args as Record<string, unknown>
        const server = typeof args.server === "string" ? args.server : ""
        const uri = typeof args.uri === "string" ? args.uri : ""
        try {
          session.stream.write(buildReadMcpResourceFallback(esmId, server, uri))
          trace(`exec read_mcp_resource: replied id=${esmId} server=${server} uri=${uri} error{server not found}`)
        } catch {
          failRunProtocol("Cursor read_mcp_resource reply failed", RUN_REPLY_FAILED)
        }
      } else {
        replaySafety.markBarrier("non-control-exec")
        const parsed = parseExecServerMessage(esm)
        trace(`exec: id=${parsed?.id} variant=${parsed ? Object.keys(parsed).join(",") : "none"} toolName=${parsed?.toolName} resultField=${parsed?.resultField}`)
        if (parsed) {
          if (parsed.localError) {
            if (!rejectExec(parsed, parsed.localError, "invalid mapping")) return
            continue
          }
          // toolChoice "none" / no tools — refuse on the Cursor channel and keep pumping.
          if (!session.allowTools) {
            const reason = "Tool calls are not available during this turn."
            if (!rejectExec(parsed, reason, "allowTools=false")) return
            continue
          }
          // Cursor has native capabilities beyond the descriptors we advertised.
          // Emitting those as host tool-calls would invent tools the client never
          // offered. Refuse on the held-open exec channel instead.
          if (!advertisedToolNameSet.has(parsed.toolName)) {
            const available = advertisedToolNames.length > 0
              ? advertisedToolNames.join(", ")
              : "none"
            const reason =
              `Tool '${parsed.toolName}' is unavailable. Available tools: ${available}. ` +
              `Continue using only available tools; do not retry '${parsed.toolName}'.`
            trace(
              `exec: unavailable catalog target toolName=${parsed.toolName} ` +
                `advertised=[${advertisedToolNames.join(",")}]`,
            )
            if (!rejectExec(parsed, reason, "unavailable tool")) return
            continue
          }
          const tc = buildToolCallPart(parsed, session.sessionId)
          sessionManager.registerPending(
            parsed.id,
            session,
            parsed.resultField,
            parsed.toolName,
            parsed.resultMetadata,
          )
          trace(`exec: EMITTED tool-call toolCallId=${tc.toolCallId} toolName=${tc.toolName} inputLen=${tc.input.length}`)
          closeOpenSpans()
          safeEnqueue({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          } as V3Part)
          emitFinish(undefined, { unified: "tool-calls", raw: undefined })
          return
        }
        const variantField = detectExecVariantField(payload)
        const variantDescription = describeCursorExecVariant(variantField)
        const hex = Array.from(payload.subarray(0, 48))
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("")
        trace(
          `exec UNMAPPED: id=${esmId} variant=${variantDescription} keys=[${Object.keys(esm).join(",")}] hex=${hex}`,
        )
        failRunProtocol(
          `Unsupported Cursor exec variant ${variantDescription} (id=${esmId})`,
          RUN_REQUEST_UNSUPPORTED,
        )
      }
    } else if (interactionQuery) {
      const handled = (() => {
        try {
          return handleInteractionQuery(interactionQuery, payload)
        } catch {
          return failRunProtocol("Cursor interaction request could not be handled", RUN_REQUEST_UNSUPPORTED)
        }
      })()
      try {
        if (handled.outcome === "acknowledged") {
          replaySafety.markBarrier("stateful-interaction")
        }
        session.stream.write(handled.reply)
        trace(
          `interaction_query: replied id=${handled.id} variant=${handled.variantName} ` +
            `field=${handled.variantField} outcome=${handled.outcome}`,
        )
      } catch {
        failRunProtocol("Cursor interaction reply failed", RUN_REPLY_FAILED)
      }
    } else if (kv) {
      trace(
        `kv frame raw: gunzippedLen=${payload.length} id=${kv.id ?? "?"} ` +
          `get=${!!kv.get_blob_args} set=${!!kv.set_blob_args} ` +
          `getBlobIdLen=${(kv.get_blob_args as any)?.blob_id?.length ?? "-"} ` +
          `setBlobIdLen=${(kv.set_blob_args as any)?.blob_id?.length ?? "-"} ` +
          `setDataLen=${(kv.set_blob_args as any)?.blob_data?.length ?? "-"}`,
      )
      const handled = handleKvServerMessage(kv, session)
      if (handled) {
        try {
          session.stream.write(handled.reply)
          trace(
            `kv replied: kind=${handled.kind} id=${handled.id} blobId=${handled.blobIdHex.slice(0, 16)}… ` +
              `found=${handled.found} echoed=${!!handled.echoed} ` +
              `sessionBlobs=${session.blobs.size} convBlobs=${conversationBlobCount(session.conversationId)}`,
          )
        } catch {
          failRunProtocol("Cursor KV reply failed", RUN_REPLY_FAILED)
        }
      } else {
        failRunProtocol("Cursor KV request could not be handled", RUN_REQUEST_UNSUPPORTED)
      }
    }
    } catch (e) {
      if (e instanceof CursorProtocolError) throw e
      if (requiredChannel) {
        failRunProtocol(`Cursor ${requiredChannel} request could not be handled`, RUN_REQUEST_UNSUPPORTED)
      }
      trace(`frame dispatch FAILED (skipping): topField=${topField}`)
    }
  }
}