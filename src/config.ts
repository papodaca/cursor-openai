import path from "node:path"
import { homedir } from "node:os"

export type AppConfig = {
  port: number
  /** API key clients must send as Authorization: Bearer … */
  proxyApiKey: string
  /** Path to Cursor oauth auth.json (refresh/access/expires). */
  authPath: string
  cacheDir: string
  apiBaseURL: string
  agentBaseURL?: string
  modelsAllowlist?: string[]
}

export type CliOptions = {
  authPath: string
  proxyApiKey: string
  port?: number
  cacheDir?: string
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

/** Strip a leading `@` used as a file-path marker (`--auth @auth.json`). */
export function resolveAuthPath(raw: string): string {
  const trimmed = raw.trim()
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed
  if (!withoutAt) {
    throw new Error("Auth path is empty after resolving `@` prefix")
  }
  return path.resolve(withoutAt)
}

/**
 * Parse CLI flags:
 *   --auth @auth.json | --auth auth.json
 *   --api-key <key>
 *   --port <n> (optional)
 */
export function parseArgs(argv: string[]): CliOptions {
  let authPath: string | undefined
  let proxyApiKey: string | undefined
  let port: number | undefined
  let cacheDir: string | undefined
  let apiBaseURL: string | undefined
  let agentBaseURL: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`)
      }
      return value
    }

    switch (arg) {
      case "--auth":
        authPath = resolveAuthPath(next())
        break
      case "--api-key":
        proxyApiKey = next()
        break
      case "--port":
        port = Number(next())
        break
      case "--cache-dir":
        cacheDir = next()
        break
      case "--api-base-url":
        apiBaseURL = next()
        break
      case "--agent-base-url":
        agentBaseURL = next()
        break
      case "--help":
      case "-h":
        throw new HelpRequested()
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  authPath ??= optionalEnv("CURSOR_AUTH_FILE")
    ? resolveAuthPath(optionalEnv("CURSOR_AUTH_FILE")!)
    : undefined
  proxyApiKey ??= optionalEnv("CURSOR_OPENAI_API_KEY") ?? optionalEnv("API_KEY")

  if (!authPath) {
    throw new Error("Missing --auth <path> (or CURSOR_AUTH_FILE)")
  }
  if (!proxyApiKey) {
    throw new Error("Missing --api-key <key> (or CURSOR_OPENAI_API_KEY)")
  }

  const modelsRaw = optionalEnv("CURSOR_MODELS")
  const modelsAllowlist = modelsRaw
    ? modelsRaw.split(",").map((id) => id.trim()).filter(Boolean)
    : undefined

  return {
    authPath,
    proxyApiKey,
    port,
    cacheDir,
    apiBaseURL,
    agentBaseURL,
    modelsAllowlist,
  }
}

export class HelpRequested extends Error {
  constructor() {
    super("help")
    this.name = "HelpRequested"
  }
}

export function usage(): string {
  return `Usage:
  bun start --auth @auth.json --api-key <proxy-api-key> [--port 8787]

Clients send Authorization: Bearer <proxy-api-key>.
Cursor calls use oauth tokens from the auth file (auto-refreshed).

Options:
  --auth <path>           Cursor oauth auth.json (@path supported)
  --api-key <key>         Proxy API key required on client requests
  --port <n>              Listen port (default PORT env or 8787)
  --cache-dir <path>      Model cache directory
  --api-base-url <url>    Cursor API base (default https://api2.cursor.sh)
  --agent-base-url <url>  Cursor agent Run host override
`
}

export function loadConfig(cli: CliOptions, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const portRaw = cli.port !== undefined ? String(cli.port) : env.PORT?.trim() || "8787"
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${portRaw}`)
  }

  return {
    port,
    proxyApiKey: cli.proxyApiKey,
    authPath: cli.authPath,
    cacheDir: cli.cacheDir ?? optionalEnv("CURSOR_CACHE_DIR") ?? defaultCacheDir(),
    apiBaseURL:
      cli.apiBaseURL ??
      optionalEnv("CURSOR_API_BASE_URL") ??
      "https://api2.cursor.sh",
    agentBaseURL: cli.agentBaseURL ?? optionalEnv("CURSOR_AGENT_BASE_URL"),
    modelsAllowlist: cli.modelsAllowlist,
  }
}
