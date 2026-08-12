import { createCursorLanguageModel } from "./language-model.js"
import { CURSOR_PROVIDER_ID, defaultCacheDir } from "./shared.js"
import type { CursorContinuationOptions } from "./session.js"

export type CursorRetryOptions = {
  /** Total attempts including the initial request. Default: 3. */
  maxAttempts?: number
  /** Initial full-jitter backoff ceiling. Default: 500ms. */
  baseDelayMs?: number
  /** Exponential backoff ceiling. Default: 8000ms. */
  maxDelayMs?: number
}

export type CreateCursorOptions = {
  name?: string
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

export { defaultCacheDir }

export type CursorFactory = {
  languageModel(modelId: string): ReturnType<typeof createCursorLanguageModel>
}

/**
 * Vendored protocol translator: transport, message/stream mapping, held-Run
 * session continuity. No context injection, no workspace model, no host-side
 * execution — see docs/plans/04-vendored-cursor-protocol.md.
 */
export function createCursor(options: CreateCursorOptions): CursorFactory {
  const providerId = options.name ?? CURSOR_PROVIDER_ID
  const resolved: CreateCursorOptions = {
    ...options,
    cacheDir: options.cacheDir ?? defaultCacheDir(),
  }
  return {
    languageModel(modelId: string) {
      return createCursorLanguageModel(modelId, providerId, resolved)
    },
  }
}

export type { CursorContinuationOptions, CursorContinuationPolicy } from "./session.js"
