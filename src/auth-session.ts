import { readFile, writeFile } from "node:fs/promises"

/** On-disk Cursor oauth auth file (OpenCode-compatible shape). */
export type AuthFile = {
  type: "oauth"
  refresh: string
  access: string
  /** Access-token expiry as epoch milliseconds. */
  expires: number
}

export type TokenPair = {
  accessToken: string
  refreshToken: string
}

const REFRESH_SKEW_MS = 5 * 60 * 1000
const MIN_REFRESH_DELAY_MS = 1_000
const MAX_REFRESH_DELAY_MS = 24 * 60 * 60 * 1000

export class AuthRefreshError extends Error {
  constructor(message: string, public override cause?: unknown) {
    super(message)
    this.name = "AuthRefreshError"
  }
}

export function decodeJwtExpiryMs(jwt: string): number | null {
  try {
    const segment = jwt.split(".")[1]
    if (!segment) return null
    const json = Buffer.from(segment, "base64url").toString("utf8")
    const payload = JSON.parse(json) as unknown
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
    const exp = (payload as { exp?: unknown }).exp
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null
    return exp * 1000
  } catch {
    return null
  }
}

const PLACEHOLDER_TOKEN = /^(?:<[^>]+>|your[-_]?.*token|changeme|todo|xxx+)$/i

function assertToken(value: unknown, field: "access" | "refresh"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`auth file missing string "${field}"`)
  }
  const token = value.trim()
  if (PLACEHOLDER_TOKEN.test(token) || token.length < 20) {
    throw new Error(
      `auth file "${field}" looks like a placeholder (got ${JSON.stringify(token.slice(0, 32))}). ` +
        `Copy real Cursor oauth tokens (e.g. from ~/.local/share/opencode/auth.json → cursor), ` +
        `or re-login via the upstream provider.`,
    )
  }
  return token
}

function asOauthRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.type === "oauth") return obj
  return null
}

/**
 * Accept either:
 * - flat `{ type, refresh, access, expires }` (this project's format)
 * - OpenCode provider map `{ cursor: { type, refresh, access, expires }, ... }`
 */
export function parseAuthFile(raw: unknown): AuthFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("auth file must be a JSON object")
  }

  const root = raw as Record<string, unknown>
  const obj =
    asOauthRecord(root) ??
    asOauthRecord(root.cursor) ??
    asOauthRecord(root.Cursor)

  if (!obj) {
    throw new Error(
      'auth file must be oauth credentials (flat, or OpenCode map with a "cursor" entry)',
    )
  }

  const refresh = assertToken(obj.refresh, "refresh")
  const access = assertToken(obj.access, "access")
  if (typeof obj.expires !== "number" || !Number.isFinite(obj.expires)) {
    throw new Error('auth file missing numeric "expires"')
  }

  return {
    type: "oauth",
    refresh,
    access,
    expires: obj.expires,
  }
}

export async function refreshAccessToken(
  refreshToken: string,
  apiBaseURL: string,
): Promise<TokenPair> {
  let res: Response
  try {
    // Cursor has no POST /auth/token. Refresh is the same exchange OpenCode uses:
    // Bearer refresh token, empty JSON body.
    res = await fetch(`${apiBaseURL.replace(/\/$/, "")}/auth/exchange_user_api_key`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    })
  } catch (cause) {
    throw new AuthRefreshError("Token refresh request failed", cause)
  }

  if (!res.ok) {
    throw new AuthRefreshError(
      `Token refresh failed: ${res.status} ${res.statusText}`,
    )
  }

  let body: Record<string, unknown>
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch (cause) {
    throw new AuthRefreshError("Token refresh returned malformed JSON", cause)
  }

  if (typeof body.accessToken !== "string") {
    throw new AuthRefreshError("Refresh response missing tokens")
  }

  return {
    accessToken: body.accessToken,
    refreshToken:
      typeof body.refreshToken === "string" && body.refreshToken.length > 0
        ? body.refreshToken
        : refreshToken,
  }
}

/**
 * Holds Cursor oauth tokens, persists updates to disk, and schedules refresh
 * via setTimeout before `expires`.
 */
export class AuthSession {
  private state: AuthFile
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshInFlight: Promise<void> | undefined
  private stopped = false

  private constructor(
    private readonly authPath: string,
    private readonly apiBaseURL: string,
    state: AuthFile,
  ) {
    this.state = state
  }

  static async load(authPath: string, apiBaseURL: string): Promise<AuthSession> {
    const raw = JSON.parse(await readFile(authPath, "utf8")) as unknown
    const session = new AuthSession(authPath, apiBaseURL, parseAuthFile(raw))
    await session.ensureFresh()
    session.scheduleRefresh()
    return session
  }

  /** Current access token; refreshes first if near expiry. */
  async getAccessToken(): Promise<string> {
    await this.ensureFresh()
    return this.state.access
  }

  /** Snapshot for tests / diagnostics (no secrets logged by callers). */
  getExpires(): number {
    return this.state.expires
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private isExpiringSoon(now = Date.now()): boolean {
    return this.state.expires - now <= REFRESH_SKEW_MS
  }

  private async ensureFresh(): Promise<void> {
    if (!this.isExpiringSoon()) return
    await this.refreshNow()
  }

  private scheduleRefresh(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)

    const delay = Math.min(
      MAX_REFRESH_DELAY_MS,
      Math.max(MIN_REFRESH_DELAY_MS, this.state.expires - Date.now() - REFRESH_SKEW_MS),
    )

    this.timer = setTimeout(() => {
      void this.refreshNow()
        .then(() => this.scheduleRefresh())
        .catch((err) => {
          console.error("[auth] scheduled refresh failed:", err)
          // Retry soon instead of stalling until the next request.
          this.timer = setTimeout(() => {
            void this.refreshNow()
              .then(() => this.scheduleRefresh())
              .catch((retryErr) => {
                console.error("[auth] refresh retry failed:", retryErr)
                this.scheduleRefresh()
              })
          }, 30_000)
        })
    }, delay)

    // Keep the process from staying alive solely for the refresh timer? No —
    // the HTTP server keeps the process alive; leave the timer as a normal ref.
  }

  private async refreshNow(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight

    this.refreshInFlight = (async () => {
      const pair = await refreshAccessToken(this.state.refresh, this.apiBaseURL)
      const expires =
        decodeJwtExpiryMs(pair.accessToken) ?? Date.now() + 60 * 60 * 1000
      this.state = {
        type: "oauth",
        access: pair.accessToken,
        refresh: pair.refreshToken,
        expires,
      }
      await this.persist()
      console.log(
        `[auth] refreshed access token; expires ${new Date(expires).toISOString()}`,
      )
    })()

    try {
      await this.refreshInFlight
    } finally {
      this.refreshInFlight = undefined
    }
  }

  private async persist(): Promise<void> {
    await writeFile(this.authPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8")
  }
}