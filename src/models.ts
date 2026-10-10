import { cursorCatalogFields, discoverModels, readCache } from "./cursor/models.ts"
import type { BackendLLM, BackendModelInfo } from "./cursor.ts"
import type { AppConfig } from "./config.ts"

export type OpenAIModelArchitecture = {
  modality: "text->text" | "text+image->text"
  input_modalities: Array<"text" | "image">
  output_modalities: ["text"]
}

export type OpenAIModel = {
  id: string
  object: "model"
  created: number
  owned_by: string
  name?: string
  context_length?: number
  max_model_len?: number
  architecture?: OpenAIModelArchitecture
  top_provider?: { context_length: number }
}

const FALLBACK_MODELS = ["composer-2.5"]

/** Subset of provider ModelInfo used for OpenAI listing. */
export type DiscoverModelsFn = (
  token: string,
  cacheDir: string,
  options?: { apiBaseURL?: string; baseURL?: string; timeoutMs?: number },
) => Promise<BackendModelInfo[]>

export type ListModelsOptions = {
  accessToken?: string
  /** Preferred: list via the Cursor backend adapter. */
  backend?: Pick<BackendLLM, "listModels">
  /** Override for tests; defaults to vendored discoverModels. */
  discover?: DiscoverModelsFn
}

const defaultDiscover: DiscoverModelsFn = async (token, cacheDir, options) => {
  const models = await discoverModels(token, cacheDir, options)
  return models.map((model) => cursorCatalogFields(model))
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

function toOpenAIModel(model: BackendModelInfo | string, created = 0): OpenAIModel {
  if (typeof model === "string") {
    return { id: model, object: "model", created, owned_by: "cursor" }
  }
  const entry: OpenAIModel = {
    id: model.id,
    object: "model",
    created,
    owned_by: "cursor",
  }
  if (model.name) entry.name = model.name
  if (model.contextLength !== undefined) {
    entry.context_length = model.contextLength
    entry.max_model_len = model.contextLength
    entry.top_provider = { context_length: model.contextLength }
  }
  if (typeof model.supportsImages === "boolean") {
    entry.architecture = model.supportsImages
      ? {
          modality: "text+image->text",
          input_modalities: ["text", "image"],
          output_modalities: ["text"],
        }
      : {
          modality: "text->text",
          input_modalities: ["text"],
          output_modalities: ["text"],
        }
  }
  return entry
}

async function readCachedCatalog(cacheDir: string): Promise<BackendModelInfo[] | null> {
  const cached = await readCache(cacheDir)
  if (!cached || cached.models.length === 0) return null
  return cached.models.map((model) => cursorCatalogFields(model))
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

  if (options.backend || options.accessToken) {
    try {
      const models = options.backend
        ? await options.backend.listModels()
        : await discover(options.accessToken!, config.cacheDir, {
            apiBaseURL: config.apiBaseURL,
          })
      if (models.length > 0) {
        return {
          object: "list",
          data: models.map((model) => toOpenAIModel(model, created)),
        }
      }
    } catch {
      // Fall through to on-disk cache / hardcoded fallback.
    }
  }

  const cached = await readCachedCatalog(config.cacheDir)
  if (cached) {
    return {
      object: "list",
      data: cached.map((model) => toOpenAIModel(model, created)),
    }
  }

  return {
    object: "list",
    data: FALLBACK_MODELS.map((id) => toOpenAIModel(id)),
  }
}