# cursor-openai

OpenAI-compatible HTTP API that talks to Cursor subscription models via [`cursor-opencode-provider`](https://www.npmjs.com/package/cursor-opencode-provider) (`LanguageModelV3` → Cursor Connect-RPC agent protocol).

**MVP:** text chat completions only (no tools). Local / trusted-network use.

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

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET` | `/health` | no | Liveness |
| `GET` | `/v1/models` | Bearer proxy key | Allowlist → cache → fallback `composer-2.5` |
| `POST` | `/v1/chat/completions` | Bearer proxy key | Stream + non-stream; text only |

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
})

const completion = await client.chat.completions.create({
  model: "composer-2.5",
  messages: [{ role: "user", content: "Hello!" }],
})
```

## Layout

See [docs/plans/](./docs/plans/) for the implementation plan. Runtime code lives under `src/`. The `./cursor-opencode-provider` tree is a local reference clone only — the app depends on the npm package.