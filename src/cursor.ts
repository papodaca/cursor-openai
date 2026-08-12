import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { AppConfig } from "./config.ts"
import {
  getCursorBackend,
  resetCursorBackendCacheForTests,
  type CreateCursorBackendOptions,
} from "./cursor/index.ts"

export type BackendModelInfo = { id: string }

export type BackendLLM = {
  readonly id: string
  languageModel(modelId: string): LanguageModelV3
  listModels(): Promise<BackendModelInfo[]>
}

function backendOptions(accessToken: string, config: AppConfig): CreateCursorBackendOptions {
  return {
    accessToken,
    cacheDir: config.cacheDir,
    apiBaseURL: config.apiBaseURL,
    agentBaseURL: config.agentBaseURL,
  }
}

/** Process-wide Cursor backend so held-open Runs survive across HTTP tool turns. */
export function getBackend(accessToken: string, config: AppConfig): BackendLLM {
  return getCursorBackend(backendOptions(accessToken, config))
}

export function getLanguageModel(
  modelId: string,
  accessToken: string,
  config: AppConfig,
): LanguageModelV3 {
  return getBackend(accessToken, config).languageModel(modelId)
}

/** Test helper — clear the cached backend factory. */
export function resetCursorCacheForTests(): void {
  resetCursorBackendCacheForTests()
}
