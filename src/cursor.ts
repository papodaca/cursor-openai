import { createCursor } from "cursor-opencode-provider"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { AppConfig } from "./config.ts"
import type { CursorCredential } from "./auth.ts"

export function getLanguageModel(
  modelId: string,
  credential: CursorCredential,
  config: AppConfig,
): LanguageModelV3 {
  const cursor = createCursor({
    name: "cursor",
    ...(credential.kind === "apiKey"
      ? { apiKey: credential.value }
      : { accessToken: credential.value }),
    cacheDir: config.cacheDir,
    workspaceRoot: config.workspaceRoot,
    apiBaseURL: config.apiBaseURL,
    agentBaseURL: config.agentBaseURL,
  })
  return cursor.languageModel(modelId)
}
