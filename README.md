# cursor-openai

OpenAI-compatible HTTP API that talks to Cursor subscription models via [`cursor-opencode-provider`](https://www.npmjs.com/package/cursor-opencode-provider) (`LanguageModelV3` → Cursor Connect-RPC agent protocol).

**MVP:** text chat completions only (no tools). Local / trusted-network use.

## Requirements

- [Bun](https://bun.sh)
- A Cursor account with API access (`sk-...` from [cursor.com/settings](https://cursor.com/settings), or an access JWT)

Personal use only — same ToS caveats as the upstream provider. Do not expose this proxy publicly without understanding that client `Bearer` tokens are forwarded to Cursor.

## Install

```bash
bun install
```

## Configure

| Variable | Required | Description |
|----------|----------|-------------|
| `CURSOR_API_KEY` | one of key/token | Cursor API key (`sk-...`) |
| `CURSOR_ACCESS_TOKEN` | one of key/token | Cursor JWT access token |
| `PORT` | no | Listen port (default `8787`) |
| `CURSOR_CACHE_DIR` | no | Host cache for `cursor-models.json` (default `~/.cache/opencode`) |
| `CURSOR_WORKSPACE` | no | Optional workspace root passed to the provider |
| `CURSOR_API_BASE_URL` | no | Override Cursor API base |
| `CURSOR_AGENT_BASE_URL` | no | Override Cursor agent Run host |
| `CURSOR_MODELS` | no | Comma-separated model ids for `GET /v1/models` |
| `CURSOR_PROVIDER_DEBUG` | no | Provider wire debug (`1` / `true`) |

Credential precedence per request:

1. `Authorization: Bearer <value>` (if `sk-…` → API key, else → access token)
2. `CURSOR_ACCESS_TOKEN`
3. `CURSOR_API_KEY`
4. else `401`

## Run

```bash
export CURSOR_API_KEY=sk-...
bun start
# or: bun run dev
```

Listens on `http://localhost:8787`.

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/health` | Liveness |
| `GET` | `/v1/models` | Allowlist → cache → fallback `composer-2.5` |
| `POST` | `/v1/chat/completions` | Stream + non-stream; text only |

## Examples

```bash
curl -s http://localhost:8787/v1/models

curl -s http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Say hi in one sentence."}]
  }'

curl -N http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
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
  apiKey: process.env.CURSOR_API_KEY,
  baseURL: "http://localhost:8787/v1",
})

const completion = await client.chat.completions.create({
  model: "composer-2.5",
  messages: [{ role: "user", content: "Hello!" }],
})
```

## Layout

See [docs/plans/](./docs/plans/) for the implementation plan. Runtime code lives under `src/`. The `./cursor-opencode-provider` tree is a local reference clone only — the app depends on the npm package.
