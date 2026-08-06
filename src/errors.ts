export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public type: string = "invalid_request_error",
    public code: string | null = null,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

function providerErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/** Map upstream Cursor provider failures into clearer OpenAI-shaped errors. */
export function mapProviderError(err: unknown): ApiError | null {
  if (!(err instanceof Error)) return null
  const code = providerErrorCode(err)
  const message = err.message

  if (code === "not_found" || /code=not_found\b/i.test(message)) {
    return new ApiError(
      "Cursor model not found (code=not_found). Use an id from GET /v1/models " +
        "(e.g. default, composer-2.5). Aliases: auto→default; cursor/<id> and " +
        "provider/<id> prefixes are stripped.",
      404,
      "invalid_request_error",
      "model_not_found",
    )
  }

  if (err.name === "CursorAuthError" || code === "unauthenticated" || code === "permission_denied") {
    return new ApiError(
      message || "Cursor authentication failed; refresh oauth credentials.",
      401,
      "authentication_error",
      code ?? "cursor_auth",
    )
  }

  return null
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json(
      {
        error: {
          message: err.message,
          type: err.type,
          code: err.code,
        },
      },
      { status: err.status, headers: corsHeaders() },
    )
  }

  const mapped = mapProviderError(err)
  if (mapped) return errorResponse(mapped)

  const message = err instanceof Error ? err.message : String(err)
  return Response.json(
    {
      error: {
        message,
        type: "api_error",
        code: null,
      },
    },
    { status: 502, headers: corsHeaders() },
  )
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Session-Id, X-OpenCode-Session, X-Conversation-Id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  }
}
