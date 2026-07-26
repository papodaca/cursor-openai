import type { AppConfig } from "./config.ts"
import { ApiError } from "./errors.ts"

export type CursorCredential =
  | { kind: "apiKey"; value: string }
  | { kind: "accessToken"; value: string }

function classifyCredential(value: string): CursorCredential {
  if (value.startsWith("sk-")) {
    return { kind: "apiKey", value }
  }
  return { kind: "accessToken", value }
}

/** Resolve Cursor credential: Bearer header, then env access token, then env API key. */
export function resolveCredential(
  req: Request,
  config: AppConfig,
): CursorCredential {
  const auth = req.headers.get("authorization")
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match?.[1]?.trim()) {
      return classifyCredential(match[1].trim())
    }
  }

  if (config.accessToken) {
    return { kind: "accessToken", value: config.accessToken }
  }
  if (config.apiKey) {
    return { kind: "apiKey", value: config.apiKey }
  }

  throw new ApiError(
    "Missing Cursor credentials. Set CURSOR_API_KEY or CURSOR_ACCESS_TOKEN, or pass Authorization: Bearer <cursor-key-or-token>.",
    401,
    "authentication_error",
    "missing_credentials",
  )
}
