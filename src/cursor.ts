import { createCursor } from "cursor-opencode-provider"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { AppConfig } from "./config.ts"

export function getLanguageModel(
  modelId: string,
  accessToken: string,
  config: AppConfig,
): LanguageModelV3 {
  const cursor = createCursor({
    name: "cursor",
    accessToken,
    cacheDir: config.cacheDir,
    workspaceRoot: config.workspaceRoot,
    apiBaseURL: config.apiBaseURL,
    agentBaseURL: config.agentBaseURL,
  })
  return cursor.languageModel(modelId)
}
