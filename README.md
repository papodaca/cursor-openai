# cursor-openai

OpenAI-compatible HTTP API that talks to Cursor subscription models via [`cursor-opencode-provider`](https://www.npmjs.com/package/cursor-opencode-provider) (`LanguageModelV3` → Cursor Connect-RPC agent protocol).

**MVP + tools:** Chat completions with optional OpenAI-style tool pass-through (client executes tools). Local / trusted-network use.

## Requirements

- [Bun](https://bun.sh)
- Cursor oauth tokens in an `auth.json` file (refresh + access + expires), typically obtained via OpenCode / the upstream provider login flow

Personal use only — same ToS caveats as the upstream provider. Do not expose this proxy publicly without an API key and network controls.

## Install

```bash
bun install
```

## Auth model

Two separate credentials:

1. **Proxy API key** (`--api-key`) — clients must send `Authorization: Bearer <proxy-api-key>`. This authenticates callers to *this* server only.
2. **Cursor oauth** (`--auth`) — server loads `auth.json`, uses the access token for Cursor API calls, and refreshes on a timer before expiry (persisting updates back to the file).

`auth.json` shape (flat):

```json
{
  "type": "oauth",
  "refresh": "<refresh-token>",
  "access": "<access-jwt>",
  "expires": 1710000000000
}
```

`expires` is epoch **milliseconds**. Placeholder values like `"<snip>"` are rejected at startup.

You can also point `--auth` at OpenCode's provider map (`~/.local/share/opencode/auth.json`); the `cursor` entry is used.

## Configure

### Required CLI flags

| Flag | Env fallback | Description |
|------|--------------|-------------|
| `--auth <path>` | `CURSOR_AUTH_FILE` | Path to oauth `auth.json` (`@path` supported, e.g. `--auth @auth.json`) |
| `--api-key <key>` | `CURSOR_OPENAI_API_KEY` or `API_KEY` | Proxy API key clients must present as Bearer |

### Optional

| Flag / Variable | Description |
|-----------------|-------------|
| `--port` / `PORT` | Listen port (default `8787`) |
| `--cache-dir` / `CURSOR_CACHE_DIR` | Host cache for `cursor-models.json` (default `~/.cache/opencode`) |
| `--workspace` / `CURSOR_WORKSPACE` | Optional workspace root passed to the provider |
| `--api-base-url` / `CURSOR_API_BASE_URL` | Override Cursor API base |
| `--agent-base-url` / `CURSOR_AGENT_BASE_URL` | Override Cursor agent Run host |
| `CURSOR_MODELS` | Comma-separated model ids for `GET /v1/models` |
| `CURSOR_PROVIDER_DEBUG` | Provider wire debug (`1` / `true`) |

## Run

```bash
bun start --auth @auth.json --api-key "local-dev-secret"
# or: bun run dev -- --auth @auth.json --api-key "local-dev-secret"
```

Listens on `http://localhost:8787`.

### Docker

Images are published to `ghcr.io/papodaca/cursor-openai` on pushes to `main` (`latest`) and on `v*` tags.

```bash
docker run --rm -p 8787:8787 \
  -e API_KEY=local-dev-secret \
  -v "$PWD/auth.json:/data/auth.json" \
  ghcr.io/papodaca/cursor-openai:latest
```

Mount your Cursor oauth `auth.json` at `/data/auth.json` (the default `CURSOR_AUTH_FILE`). The container refreshes tokens and writes updates back to that file, so use a read-write mount. Cache lives under `/data/cache` (optional volume).

Build locally instead of pulling:

```bash
docker build -t cursor-openai .
docker run --rm -p 8787:8787 \
  -e API_KEY=local-dev-secret \
  -v "$PWD/auth.json:/data/auth.json" \
  cursor-openai
```

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET` | `/health` | no | Liveness |
| `GET` | `/v1/models` | Bearer proxy key | Allowlist → cache → fallback `composer-2.5` |
| `POST` | `/v1/chat/completions` | Bearer proxy key | Stream + non-stream; optional `tools` / `tool_choice` |

### Model ids

Use bare Cursor ids from `GET /v1/models` (e.g. `composer-2.5`, `default`). Accepted aliases:

- `auto` → `default` (Cursor’s auto-router; common OpenCode placeholder)
- `cursor/<id>` / `cursor:<id>` / `<provider>/<id>` → `<id>`

Unknown ids still yield Cursor `code=not_found` (mapped to HTTP 404 `model_not_found`).

### OpenCode (`@ai-sdk/openai-compatible`)

Point a custom provider at this proxy and list **real** Cursor model ids (or `auto`, which aliases to `default`):

```jsonc
{
  "provider": {
    "cursor2": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:8787/v1",
        "apiKey": "your-proxy-api-key"
      },
      "models": {
        "default": {},
        "composer-2.5": {},
        "auto": {}
      }
    }
  }
}
```

Select e.g. `cursor2/composer-2.5` or `cursor2/default` in the OpenCode UI. A lone `auto` model key works via the alias, but prefer listing ids from `GET /v1/models`.

## Tool calling

Pass-through only: this server does **not** execute tools. The client supplies `tools`, receives `tool_calls`, runs the functions locally, then continues with `role: "tool"` messages.

Requirements for multi-turn tool loops against a live Cursor Run:

1. Echo `tool_call_id` values unchanged (ids look like `cursor_<sessionId>_<execId>`).
2. Keep the server process up between the `tool_calls` response and the follow-up with results (held-open Runs are process-local).
3. Optionally send a stable session header on every turn: `X-Session-Id`, `X-OpenCode-Session`, or `X-Conversation-Id`. The bridge forwards it as `x-opencode-session` for sticky conversation binding.

Legacy OpenAI `functions` / `function_call` fields are rejected; use `tools` / `tool_choice`.

Example (non-stream):

```bash
curl -s http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROXY_KEY" \
  -H "X-Session-Id: demo-tool-loop" \
  -d '{
    "model": "composer-2.5",
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    }],
    "messages": [{"role": "user", "content": "Weather in SF?"}]
  }'
```

Then append the assistant `tool_calls` message and your `role: "tool"` result(s) and POST again with the same `X-Session-Id`.

OpenAI JS SDK tool loop works with `baseURL=http://localhost:8787/v1` the same way as against OpenAI.

## Examples

```bash
export PROXY_KEY=local-dev-secret

curl -s http://localhost:8787/v1/models \
  -H "Authorization: Bearer $PROXY_KEY"

curl -s http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROXY_KEY" \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Say hi in one sentence."}]
  }'

curl -N http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROXY_KEY" \
  -d '{
    "model": "composer-2.5",
    "stream": true,
    "messages": [{"role": "user", "content": "Count to three."}]
  }'
```

OpenAI JS SDK:

```ts
import OpenAI from "openai"

const client = new OpenAI({
  apiKey: process.env.PROXY_KEY, // proxy API key, not a Cursor sk-
  baseURL: "http://localhost:8787/v1",
  defaultHeaders: {
    // Optional sticky id for multi-turn tool loops / conversation binding
    "X-Session-Id": "demo-session",
  },
})
// model: "composer-2.5"  — not "cursor/composer-2.5" (prefix is stripped if present)

const completion = await client.chat.completions.create({
  model: "composer-2.5",
  messages: [{ role: "user", content: "Hello!" }],
})
```

## Layout

See [docs/plans/](./docs/plans/) for the implementation plan. Runtime code lives under `src/`. The `./cursor-opencode-provider` tree is a local reference clone only — the app depends on the npm package.