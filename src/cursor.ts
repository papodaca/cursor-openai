import { createCursor } from "./cursor/index.ts"
import type { CursorFactory } from "./cursor/index.ts"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { AppConfig } from "./config.ts"

let cached: {
  accessToken: string
  cacheKey: string
  cursor: CursorFactory
} | undefined

function factoryCacheKey(accessToken: string, config: AppConfig): string {
  return [
    accessToken,
    config.cacheDir,
    config.apiBaseURL,
    config.agentBaseURL ?? "",
  ].join("\0")
}

/** Process-wide Cursor provider so held-open Runs survive across HTTP tool turns. */
export function getCursor(accessToken: string, config: AppConfig): CursorFactory {
  const key = factoryCacheKey(accessToken, config)
  if (cached && cached.cacheKey === key) return cached.cursor

  const cursor = createCursor({
    name: "cursor",
    accessToken,
    cacheDir: config.cacheDir,
    apiBaseURL: config.apiBaseURL,
    agentBaseURL: config.agentBaseURL,
  })
  cached = { accessToken, cacheKey: key, cursor }
  return cursor
}

export function getLanguageModel(
  modelId: string,
  accessToken: string,
  config: AppConfig,
): LanguageModelV3 {
  return getCursor(accessToken, config).languageModel(modelId)
}

/** Test helper — clear the cached provider factory. */
export function resetCursorCacheForTests(): void {
  cached = undefined
}
