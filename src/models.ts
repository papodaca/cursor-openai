import path from "node:path"
import { readFile } from "node:fs/promises"
import type { AppConfig } from "./config.ts"

export type OpenAIModel = {
  id: string
  object: "model"
  created: number
  owned_by: string
}

const FALLBACK_MODELS = ["composer-2.5"]

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

export async function listModels(config: AppConfig): Promise<{
  object: "list"
  data: OpenAIModel[]
}> {
  if (config.modelsAllowlist && config.modelsAllowlist.length > 0) {
    return {
      object: "list",
      data: config.modelsAllowlist.map((id) => toOpenAIModel(id)),
    }
  }

  const cached = await readCachedModelIds(config.cacheDir)
  if (cached) {
    const created = Math.floor(Date.now() / 1000)
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
