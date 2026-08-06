import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { readFile } from "node:fs/promises"
import type { AppConfig } from "./config.ts"

export type OpenAIModel = {
  id: string
  object: "model"
  created: number
  owned_by: string
}

const FALLBACK_MODELS = ["composer-2.5"]

/** Subset of provider ModelInfo used for OpenAI listing. */
export type DiscoverModelsFn = (
  token: string,
  cacheDir: string,
  options?: { apiBaseURL?: string; baseURL?: string; timeoutMs?: number },
) => Promise<Array<{ id: string }>>

export type ListModelsOptions = {
  accessToken?: string
  /** Override for tests; defaults to provider discoverModels. */
  discover?: DiscoverModelsFn
}

// Package exports omit models; resolve the dist file next to the installed package.
const require = createRequire(import.meta.url)
const providerModelsUrl = pathToFileURL(
  path.join(
    path.dirname(require.resolve("cursor-opencode-provider/package.json")),
    "dist/models.js",
  ),
).href

let cachedDiscover: DiscoverModelsFn | undefined

async function defaultDiscover(
  ...args: Parameters<DiscoverModelsFn>
): ReturnType<DiscoverModelsFn> {
  if (!cachedDiscover) {
    const mod = (await import(providerModelsUrl)) as {
      discoverModels: DiscoverModelsFn
    }
    cachedDiscover = mod.discoverModels
  }
  return cachedDiscover(...args)
}

/**
 * Normalize client model ids to Cursor wire ids.
 * OpenCode-style `cursor/composer-2.5` (or `cursor:…`) is a common source of
 * Cursor `code=not_found` when sent verbatim to the agent Run API.
 * OpenCode openai-compatible configs often use a placeholder id `auto`;
 * Cursor expects `default` for its auto-router.
 */
export function normalizeModelId(modelId: string): string {
  let trimmed = modelId.trim()
  const slash = /^cursor\//i.exec(trimmed)
  if (slash) trimmed = trimmed.slice(slash[0].length).trim()
  else {
    const colon = /^cursor:/i.exec(trimmed)
    if (colon) trimmed = trimmed.slice(colon[0].length).trim()
  }
  // OpenCode provider keys are not Cursor wire ids (e.g. cursor2/auto → auto).
  const providerPrefixed = /^[a-z0-9_-]+\//i.exec(trimmed)
  if (providerPrefixed && !trimmed.includes(" ")) {
    const rest = trimmed.slice(providerPrefixed[0].length).trim()
    if (rest) trimmed = rest
  }
  if (trimmed.toLowerCase() === "auto") return "default"
  return trimmed
}

function toOpenAIModel(id: string, created = 0): OpenAIModel {
  return {
    id,
    object: "model",
    created,
    owned_by: "cursor",
  }
}

async function readCachedModelIds(cacheDir: string): Promise<string[] | null> {
  const filePath = path.join(cacheDir, "cursor-models.json")
  try {
    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const models = (parsed as { models?: unknown }).models
    if (!Array.isArray(models)) return null
    const ids: string[] = []
    for (const entry of models) {
      if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
        ids.push((entry as { id: string }).id)
      }
    }
    return ids.length > 0 ? ids : null
  } catch {
    return null
  }
}

export async function listModels(
  config: AppConfig,
  options: ListModelsOptions = {},
): Promise<{
  object: "list"
  data: OpenAIModel[]
}> {
  if (config.modelsAllowlist && config.modelsAllowlist.length > 0) {
    return {
      object: "list",
      data: config.modelsAllowlist.map((id) => toOpenAIModel(id)),
    }
  }

  const created = Math.floor(Date.now() / 1000)
  const discover = options.discover ?? defaultDiscover

  if (options.accessToken) {
    try {
      const models = await discover(options.accessToken, config.cacheDir, {
        apiBaseURL: config.apiBaseURL,
      })
      if (models.length > 0) {
        return {
          object: "list",
          data: models.map((m) => toOpenAIModel(m.id, created)),
        }
      }
    } catch {
      // Fall through to on-disk cache / hardcoded fallback.
    }
  }

  const cached = await readCachedModelIds(config.cacheDir)
  if (cached) {
    return {
      object: "list",
      data: cached.map((id) => toOpenAIModel(id, created)),
    }
  }

  return {
    object: "list",
    data: FALLBACK_MODELS.map((id) => toOpenAIModel(id)),
  }
}
