import { describe, expect, it } from "bun:test"
import {
  cursorCatalogFields,
  mapAvailableModelsResponse,
  normalizeModelCache,
  resolveVariantMaxMode,
  resolveVariantParameters,
  type ModelInfo,
} from "../models.ts"

const model: ModelInfo = {
  id: "composer-2.5",
  variants: [
    {
      key: "composer-2.5",
      displayName: "low",
      isDefaultNonMax: true,
      isDefaultMax: false,
      parameterValues: [
        { id: "effort", value: "low" },
        { id: "context", value: "200k" },
      ],
    },
    {
      key: "composer-2.5",
      displayName: "high",
      isDefaultNonMax: false,
      isDefaultMax: false,
      parameterValues: [
        { id: "effort", value: "high" },
        { id: "context", value: "200k" },
      ],
    },
    {
      key: "composer-2.5",
      displayName: "high 1m",
      isDefaultNonMax: false,
      isDefaultMax: true,
      parameterValues: [
        { id: "effort", value: "high" },
        { id: "context", value: "1m" },
      ],
    },
  ],
}

const pickedLow = [
  { id: "effort", value: "low" },
  { id: "context", value: "200k" },
]

describe("grok-4.7 image override", () => {
  const reported = {
    name: "grok-4.7",
    clientDisplayName: "Grok 4.7",
    supportsImages: false,
    supportsThinking: true,
    supportsAgent: true,
    supportsMaxMode: true,
    variants: [],
  }

  it("marks grok-4.7 as accepting images from AvailableModels", () => {
    const [model] = mapAvailableModelsResponse({ models: [reported] })
    expect(model?.supportsImages).toBe(true)
    expect(cursorCatalogFields(model!).supportsImages).toBe(true)
  })

  it("marks a cached grok-4.7 entry as accepting images", () => {
    const cache = normalizeModelCache({
      fetchedAt: 1,
      models: [{ ...reported, id: "grok-4.7" }],
    })
    expect(cache?.models[0]?.supportsImages).toBe(true)
  })

  it("leaves another model's image flag alone", () => {
    const [model] = mapAvailableModelsResponse({
      models: [{ ...reported, name: "text-only", clientDisplayName: "Text only" }],
    })
    expect(model?.supportsImages).toBe(false)
  })
})

describe("cursorCatalogFields", () => {
  it("uses the larger context window and image input modalities", () => {
    expect(cursorCatalogFields({
      ...model,
      displayName: "Composer 2.5",
      maxContext: 200_000,
      maxContextForMaxMode: 1_000_000,
      supportsImages: true,
    })).toEqual({
      id: "composer-2.5",
      name: "Composer 2.5",
      contextLength: 1_000_000,
      supportsImages: true,
    })
  })
})

describe("resolveVariantParameters", () => {
  it("keeps a picked variant when a reasoning hint disagrees", () => {
    const params = resolveVariantParameters(model, {
      picked: pickedLow,
      reasoningEffort: "high",
      maxMode: true,
    })
    expect(params).toEqual(pickedLow)
    expect(resolveVariantMaxMode(params, { picked: pickedLow, maxMode: true })).toBe(false)
  })

  it("sets max_mode from a picked 1m variant", () => {
    const picked = [
      { id: "effort", value: "high" },
      { id: "context", value: "1m" },
    ]
    const params = resolveVariantParameters(model, {
      picked,
      reasoningEffort: "low",
      maxMode: false,
    })
    expect(params).toEqual(picked)
    expect(resolveVariantMaxMode(params, { picked, maxMode: false })).toBe(true)
  })

  it("uses the reasoning hint only when no variant was picked", () => {
    expect(resolveVariantParameters(model, { reasoningEffort: "high" })).toEqual([
      { id: "effort", value: "high" },
      { id: "context", value: "200k" },
    ])
  })

  it("uses the max hint only when no variant was picked", () => {
    const params = resolveVariantParameters(model, { maxMode: true })
    expect(params).toEqual([
      { id: "effort", value: "high" },
      { id: "context", value: "1m" },
    ])
    expect(resolveVariantMaxMode(params, { maxMode: true })).toBe(true)
  })
})
