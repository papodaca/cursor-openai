# Phase 1: OpenAI chat completions bridge (MVP)

**Status:** in-progress  
**Depends on:** [00-overview.md](./00-overview.md), [02-auth-and-config.md](./02-auth-and-config.md)  
**Date:** 2026-07-26

## Objective

Ship a Bun HTTP server that accepts OpenAI Chat Completions (stream + non-stream), maps them to `LanguageModelV3` via `cursor-opencode-provider`, and returns OpenAI-shaped JSON/SSE. Text only — no tool calling.

## Acceptance criteria

- [x] `bun install` pulls `cursor-opencode-provider` from npm (not the local clone).
- [x] `GET /health` returns 200.
- [x] `GET /v1/models` returns an OpenAI-shaped model list (from cache and/or allowlist).
- [x] `POST /v1/chat/completions` with `stream: false` returns a valid `chat.completion` with text content.
- [x] Same endpoint with `stream: true` emits SSE chunks ending in `data: [DONE]`.
- [x] Requests that include legacy `functions` / `function_call` are rejected with a clear 400. (`tools` / `tool_choice` are phase 2+ — see [03](./03-future-tool-calling.md).)
- [ ] Smoke test with `curl` and the official OpenAI JS/Python client against `baseURL=http://localhost:<port>/v1` succeeds for plain chat. _(unit/mock covered; live Cursor turn needs credentials)_
- [x] README documents how to run, auth env vars, and example model ids.

## Dependencies

```json
{
  "dependencies": {
    "cursor-opencode-provider": "0.2.9"
  },
  "devDependencies": {
    "@ai-sdk/provider": "3.0.8",
    "@types/bun": "latest",
    "typescript": "^5"
  }
}
```

Pin `@ai-sdk/provider` to match the provider’s dependency for types. Call `doStream` / `doGenerate` **directly** — do not pull the high-level `ai` package in MVP.

Local `./cursor-opencode-provider` stays unlinked; use only as protocol/reference docs.

## Suggested layout

```
src/
  server.ts          # Bun.serve routes
  openai/request.ts  # parse + validate chat completions body
  openai/response.ts # JSON + SSE emitters
  bridge.ts          # OpenAI ↔ LanguageModelV3 mapping
  cursor.ts          # createCursor factory / singleton
  models.ts          # GET /v1/models from cache / allowlist
index.ts             # entry: start server
```

## Steps

### 1. Wire package and entry

- Add npm dependency on `cursor-opencode-provider@0.2.9`.
- Replace hello-world `index.ts` with server bootstrap (`PORT` default `8787`).
- Add `package.json` scripts: `"start": "bun run index.ts"`, `"dev": "bun --watch index.ts"`.

### 2. Cursor client factory (`src/cursor.ts`)

- Import `createCursor` from `cursor-opencode-provider`.
- Build options from auth config (see phase 02): `name: "cursor"`, `apiKey` or `accessToken`, optional `cacheDir`, `workspaceRoot`, `apiBaseURL`, `agentBaseURL`.
- Expose `getLanguageModel(modelId: string)` that returns `cursor.languageModel(modelId)`.

### 3. Request parsing (`src/openai/request.ts`)

- Validate JSON body: required `model`, `messages` (non-empty array).
- Support message roles: `system`, `user`, `assistant` with string or text-part content.
- Reject multimodal / unknown content parts for MVP with 400.
- If `tools`, `functions`, or `function_call` / `tool_choice` (other than absent/`none`) present → **400** with message that tools are not supported yet.
- Capture `stream`, `temperature`, `max_tokens` / `max_completion_tokens`, `stop`.

### 4. Bridge (`src/bridge.ts`)

- Map OpenAI messages → `LanguageModelV3` prompt:
  - `system` → `{ role: "system", content: string }`
  - `user` → `{ role: "user", content: [{ type: "text", text }] }`
  - `assistant` → `{ role: "assistant", content: [{ type: "text", text }] }`
- Call options: `prompt`, `temperature`, `maxOutputTokens`, `abortSignal`.
- Prefer `toolChoice: undefined` / no tools.
- **Non-stream:** `await model.doGenerate(options)` → concatenate text content parts.
- **Stream:** `await model.doStream(options)` → async-iterate `stream` parts; emit only `text-delta` (and finish/usage). Omit reasoning/thinking in MVP unless trivial to fold later.

### 5. OpenAI responses (`src/openai/response.ts`)

- Non-stream shape:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 0,
  "model": "<model>",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

- Map V3 usage fields when present (`inputTokens` / `outputTokens`); otherwise omit or zero.
- Stream: `text/event-stream` chunks with `object: "chat.completion.chunk"`, `choices[0].delta.content`, final chunk with `finish_reason`, then `data: [DONE]\n\n`.
- Generate completion ids (`chatcmpl-` + random).

### 6. Models list (`src/models.ts`)

Package does not export AvailableModels. MVP strategy (in order):

1. If `CURSOR_MODELS` env is set (comma-separated ids), return those.
2. Else try read `<cacheDir>/cursor-models.json` (default host cache used by the provider, e.g. `~/.cache/opencode/cursor-models.json`) and map to OpenAI `{ id, object: "model", created, owned_by: "cursor" }`.
3. Else return a minimal documented fallback list (e.g. `composer-2.5`) and note in README that discovery may be empty until auth + cache exist.

`GET /v1/models` always returns `{ object: "list", data: [...] }`.

### 7. HTTP routes (`src/server.ts`)

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/health` | `{ ok: true }` |
| GET | `/v1/models` | model list |
| POST | `/v1/chat/completions` | bridge |
| * | other | 404 JSON error |

- CORS: optional simple `Access-Control-Allow-Origin: *` for local IDE clients (document; enable by default for localhost use).
- Errors: OpenAI-ish `{ error: { message, type, code } }` with appropriate status (400 validation, 401 auth, 502 upstream).

### 8. Docs and smoke test

- Update root `README.md`: install, env, run, curl examples (stream + non-stream), OpenAI SDK `baseURL` example.
- Manual smoke:

```bash
curl -s http://localhost:8787/v1/models
curl -s http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Say hi in one sentence."}]}'
```

## Out of scope for this phase

- Tool/function calling (see [03-future-tool-calling.md](./03-future-tool-calling.md))
- Publishing as an OpenCode plugin
- Automatic OAuth browser login
- Responses API / `/v1/completions` legacy

## Implementation notes

- Provider injects OpenCode-oriented system guidance mainly when tools are present; chat-only path should stay relatively clean.
- Pass `workspaceRoot` only if configured — generic API clients may not have a project tree.
- Abort: wire request abort / client disconnect to `AbortSignal` passed into `doStream`/`doGenerate`.