import { timingSafeEqual } from "node:crypto"
import type { AppConfig } from "./config.ts"
import { ApiError } from "./errors.ts"

function safeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) {
    // Compare against self to keep timing roughly flat on length mismatch.
    timingSafeEqual(aBuf, aBuf)
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}

/** Require Authorization: Bearer <proxyApiKey>. */
export function requireProxyApiKey(req: Request, config: AppConfig): void {
  const auth = req.headers.get("authorization")
  if (!auth) {
    throw new ApiError(
      "Missing Authorization header. Expected Bearer <api-key>.",
      401,
      "authentication_error",
      "missing_credentials",
    )
  }

  const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
  const token = match?.[1]?.trim()
  if (!token) {
    throw new ApiError(
      "Invalid Authorization header. Expected Bearer <api-key>.",
      401,
      "authentication_error",
      "invalid_credentials",
    )
  }

  if (!safeEqualStrings(token, config.proxyApiKey)) {
    throw new ApiError(
      "Invalid API key.",
      401,
      "authentication_error",
      "invalid_api_key",
    )
  }
}
