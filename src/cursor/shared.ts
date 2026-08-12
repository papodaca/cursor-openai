import os from "node:os"
import path from "node:path"

export const CURSOR_API_HOST = "api2.cursor.sh"
export const CURSOR_WEBSITE_HOST = "cursor.com"
export const FALLBACK_CLIENT_VERSION = "cli-2026.07.09-a3815c0"
export const CURSOR_PROVIDER_ID = "cursor"
/** Private provider option injected by the OpenCode plugin for summary turns. */
export const CURSOR_COMPACTION_OPTION = "opencodeCompaction"
export const TOKEN_EXPIRY_THRESHOLD_S = 300

export const RUN_PATH = "/agent.v1.AgentService/Run"
export const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels"
export const SERVER_CONFIG_PATH = "/aiserver.v1.ServerConfigService/GetServerConfig"

export const MODEL_CACHE_FILE = "cursor-models.json"
/** Bumped when the on-disk model cache shape/semantics change (forces refetch). */
export const MODEL_CACHE_SCHEMA_VERSION = 3
export const MODEL_CACHE_TTL_MS = 86_400_000
export const VERSION_CACHE_FILE = "cursor-client-version.json"

export const CONTENT_TYPE_CONNECT_PROTO = "application/connect+proto"
export const CONNECT_PROTOCOL_VERSION = "1"

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max"
export type ContextOption = "200k" | "272k" | "300k" | "1m"

/**
 * Own-config cache root fallback for model/version caches. Deliberately never
 * derived from process.cwd() — the proxy has no workspace concept at any scope.
 */
export function defaultCacheDir(): string {
  if (process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.length > 0) {
    return path.join(process.env.XDG_CACHE_HOME, "opencode")
  }
  // Prefer HOME/USERPROFILE so tests (and containers) can redirect the cache
  // root without relying on os.homedir() process-start snapshots.
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
  return path.join(home, ".cache", "opencode")
}
