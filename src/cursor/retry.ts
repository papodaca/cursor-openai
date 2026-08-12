import {
  CursorAuthError,
  CursorLocalCancellationError,
  CursorProtocolError,
  CursorProviderError,
  CursorServerError,
  isTransientGrpcStatus,
} from "./errors.js"

export type CursorRetryOptions = {
  /** Total attempts including the initial request. Default: 3. */
  maxAttempts?: number
  /** Initial full-jitter backoff ceiling. Default: 500ms. */
  baseDelayMs?: number
  /** Exponential backoff ceiling. Default: 8000ms. */
  maxDelayMs?: number
}

export type CursorRetryPolicy = {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
} as const

const MAX_RETRY_ATTEMPTS = 10
export const MAX_RETRY_DELAY_MS = 30_000

function retryInteger(name: string, value: unknown, fallback: number): number {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new CursorProtocolError(`Cursor retry ${name} must be a positive integer`)
  }
  return resolved
}

export function resolveRetryPolicy(options: CursorRetryOptions | undefined): CursorRetryPolicy {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    throw new CursorProtocolError("Cursor retry options must be an object")
  }
  for (const key of Object.keys(options ?? {})) {
    if (!["maxAttempts", "baseDelayMs", "maxDelayMs"].includes(key)) {
      throw new CursorProtocolError(`Unknown Cursor retry option: ${key}`)
    }
  }
  const maxAttempts = retryInteger("maxAttempts", options?.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts)
  const baseDelayMs = retryInteger("baseDelayMs", options?.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs)
  const maxDelayMs = retryInteger("maxDelayMs", options?.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs)
  if (maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new CursorProtocolError(`Cursor retry maxAttempts must be no greater than ${MAX_RETRY_ATTEMPTS}`)
  }
  if (baseDelayMs > MAX_RETRY_DELAY_MS || maxDelayMs > MAX_RETRY_DELAY_MS) {
    throw new CursorProtocolError(`Cursor retry delays must be no greater than ${MAX_RETRY_DELAY_MS}ms`)
  }
  if (baseDelayMs > maxDelayMs) {
    throw new CursorProtocolError("Cursor retry baseDelayMs must be no greater than maxDelayMs")
  }
  return { maxAttempts, baseDelayMs, maxDelayMs }
}

export function retryDelayMs(error: CursorProviderError, attempt: number, policy: CursorRetryPolicy): number {
  if (error.retryAfterMs !== undefined) return Math.min(MAX_RETRY_DELAY_MS, error.retryAfterMs)
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1))
  return Math.floor(Math.random() * ceiling)
}

export function sleepForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CursorLocalCancellationError("Cursor retry cancelled"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    const onAbort = () => finish(new CursorLocalCancellationError("Cursor retry cancelled"))
    function finish(error?: Error) {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function retryDelayFromValue(value: unknown): number | undefined {
  if (typeof value === "string") {
    const seconds = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
    if (seconds) return Math.ceil(Number(seconds[1]) * 1_000)
    const protobufDelay = retryInfoProtobufDelayMs(value.trim())
    if (protobufDelay !== undefined) return protobufDelay
  }
  if (!value || typeof value !== "object") return undefined
  const duration = value as { seconds?: unknown; nanos?: unknown }
  const seconds = Number(duration.seconds ?? 0)
  const nanos = Number(duration.nanos ?? 0)
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos) || seconds < 0 || nanos < 0) return undefined
  return Math.ceil(seconds * 1_000 + nanos / 1_000_000)
}

/** Decode google.rpc.RetryInfo.value without adding another protobuf schema. */
function retryInfoProtobufDelayMs(encoded: string): number | undefined {
  if (!encoded || encoded.length > 512 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) {
    return undefined
  }
  let bytes: Uint8Array
  try {
    bytes = Buffer.from(encoded.replaceAll("-", "+").replaceAll("_", "/"), "base64")
  } catch {
    return undefined
  }
  const readVarint = (input: Uint8Array, start: number): [bigint, number] | undefined => {
    let value = 0n
    let shift = 0n
    for (let offset = start; offset < input.length && offset < start + 10; offset++) {
      const byte = input[offset]!
      value |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return [value, offset + 1]
      shift += 7n
    }
    return undefined
  }
  const outerKey = readVarint(bytes, 0)
  if (!outerKey || outerKey[0] !== 0x0an) return undefined
  const outerLength = readVarint(bytes, outerKey[1])
  if (!outerLength || outerLength[0] > BigInt(bytes.length - outerLength[1])) return undefined
  const duration = bytes.subarray(
    outerLength[1],
    outerLength[1] + Number(outerLength[0]),
  )
  let offset = 0
  let seconds = 0n
  let nanos = 0n
  while (offset < duration.length) {
    const key = readVarint(duration, offset)
    if (!key) return undefined
    offset = key[1]
    const field = Number(key[0] >> 3n)
    if (Number(key[0] & 7n) !== 0) return undefined
    const item = readVarint(duration, offset)
    if (!item) return undefined
    offset = item[1]
    if (field === 1) seconds = item[0]
    else if (field === 2) nanos = item[0]
  }
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER) || nanos > 999_999_999n) return undefined
  return Math.ceil(Number(seconds) * 1_000 + Number(nanos) / 1_000_000)
}

export function connectFrameError(payload: string): CursorProviderError {
  try {
    const envelope = JSON.parse(payload) as {
      error?: { code?: unknown; details?: unknown; retryAfter?: unknown; retry_after?: unknown }
    }
    const code = typeof envelope.error?.code === "string" ? envelope.error.code : "unknown"
    if (code === "unauthenticated" || code === "permission_denied") {
      return new CursorAuthError(`Cursor authentication failed (${code}); reauthenticate with Cursor`, { code })
    }
    let retryAfterMs = retryDelayFromValue(
      envelope.error?.retryAfter ?? envelope.error?.retry_after,
    )
    let hasRetryInfo = false
    if (Array.isArray(envelope.error?.details)) {
      for (const detail of envelope.error.details) {
        if (!detail || typeof detail !== "object") continue
        const record = detail as Record<string, unknown>
        const type = record.type
        if (type === "google.rpc.RetryInfo" || (typeof type === "string" && type.endsWith("/google.rpc.RetryInfo"))) {
          hasRetryInfo = true
          retryAfterMs ??= retryDelayFromValue(
            record.retryDelay ?? record.retry_delay ?? record.value,
          )
        }
      }
    }
    return new CursorServerError(`Cursor API error (code=${code})`, {
      transient: isTransientGrpcStatus(code) || hasRetryInfo,
      replaySafe: true,
      code,
      retryAfterMs: retryAfterMs === undefined
        ? undefined
        : Math.min(MAX_RETRY_DELAY_MS, retryAfterMs),
    })
  } catch {
    return new CursorProtocolError("Cursor returned a malformed Connect error envelope")
  }
}
