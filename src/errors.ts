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
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  }
}
