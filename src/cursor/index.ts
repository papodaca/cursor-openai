import type { LanguageModelV3 } from "@ai-sdk/provider"
import { discoverModels } from "./models.js"
import { CURSOR_PROVIDER_ID, defaultCacheDir } from "./shared.js"
import type { CursorContinuationOptions } from "./session.js"
import type { BackendLLM, BackendModelInfo } from "../cursor.js"
import {
  createCursorAdapterModel,
  type CreateCursorAdapterOptions,
} from "./model.js"
import type { CursorRetryOptions } from "./retry.js"

export type CreateCursorBackendOptions = {
  accessToken: string
  apiBaseURL?: string
  agentBaseURL?: string
  cacheDir?: string
  headers?: Record<string, string>
  continuation?: CursorContinuationOptions
  retry?: CursorRetryOptions
  /** Provider id surfaced on LanguageModelV3.provider. Default: "cursor". */
  name?: string
}

export type { CursorRetryOptions, CursorRetryPolicy } from "./retry.js"
export type { CreateCursorAdapterOptions } from "./model.js"
export { createCursorAdapterModel } from "./model.js"
export { defaultCacheDir }

/**
 * Pure factory: builds a BackendLLM that speaks Cursor's Connect-RPC agent
 * protocol. No process-wide caching — use getCursorBackend when held-open Runs
 * must survive across HTTP tool turns.
 */
export function createCursorBackend(options: CreateCursorBackendOptions): BackendLLM {
  const accessToken = options.accessToken.trim()
  const providerId = options.name ?? CURSOR_PROVIDER_ID
  const resolved: CreateCursorAdapterOptions = {
    accessToken,
    apiBaseURL: options.apiBaseURL,
    agentBaseURL: options.agentBaseURL,
    headers: options.headers,
    cacheDir: options.cacheDir ?? defaultCacheDir(),
    continuation: options.continuation,
    retry: options.retry,
  }

  return {
    id: providerId,
    languageModel(modelId: string): LanguageModelV3 {
      return createCursorAdapterModel(modelId, resolved, providerId)
    },
    async listModels(): Promise<BackendModelInfo[]> {
      const models = await discoverModels(accessToken, resolved.cacheDir!, {
        apiBaseURL: resolved.apiBaseURL,
      })
      return models.map((m) => ({ id: m.id }))
    },
  }
}

let cached: {
  cacheKey: string
  backend: BackendLLM
} | undefined

function factoryCacheKey(options: CreateCursorBackendOptions): string {
  return [
    options.accessToken,
    options.cacheDir ?? "",
    options.apiBaseURL ?? "",
    options.agentBaseURL ?? "",
    options.name ?? "",
  ].join("\0")
}

/**
 * Process-wide Cursor backend so held-open Runs survive across HTTP tool turns.
 * createCursorBackend itself stays pure; caching lives here.
 */
export function getCursorBackend(options: CreateCursorBackendOptions): BackendLLM {
  const key = factoryCacheKey(options)
  if (cached && cached.cacheKey === key) return cached.backend
  const backend = createCursorBackend(options)
  cached = { cacheKey: key, backend }
  return backend
}

/** Test helper — clear the cached backend factory. */
export function resetCursorBackendCacheForTests(): void {
  cached = undefined
}

export type { CursorContinuationOptions, CursorContinuationPolicy } from "./session.js"