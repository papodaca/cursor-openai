import path from "node:path"
import { homedir } from "node:os"

export type AppConfig = {
  port: number
  apiKey?: string
  accessToken?: string
  cacheDir: string
  workspaceRoot?: string
  apiBaseURL?: string
  agentBaseURL?: string
  modelsAllowlist?: string[]
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined || value.trim() === "") return undefined
  return value.trim()
}

function defaultCacheDir(): string {
  if (process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.length > 0) {
    return path.join(process.env.XDG_CACHE_HOME, "opencode")
  }
  return path.join(homedir(), ".cache", "opencode")
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const portRaw = env.PORT?.trim() || "8787"
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${portRaw}`)
  }

  const modelsRaw = optionalEnv("CURSOR_MODELS")
  const modelsAllowlist = modelsRaw
    ? modelsRaw.split(",").map((id) => id.trim()).filter(Boolean)
    : undefined

  return {
    port,
    apiKey: optionalEnv("CURSOR_API_KEY"),
    accessToken: optionalEnv("CURSOR_ACCESS_TOKEN"),
    cacheDir: optionalEnv("CURSOR_CACHE_DIR") ?? defaultCacheDir(),
    workspaceRoot: optionalEnv("CURSOR_WORKSPACE"),
    apiBaseURL: optionalEnv("CURSOR_API_BASE_URL"),
    agentBaseURL: optionalEnv("CURSOR_AGENT_BASE_URL"),
    modelsAllowlist,
  }
}
