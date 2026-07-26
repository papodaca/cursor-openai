# Phase 1: Auth and configuration

**Status:** done  
**Depends on:** [00-overview.md](./00-overview.md)  
**Pairs with:** [01-mvp-openai-bridge.md](./01-mvp-openai-bridge.md)  
**Date:** 2026-07-26

## Objective

Define how this server obtains Cursor credentials and runtime options, and how OpenAI clients authenticate to the proxy.

## Decisions

| Topic | Choice |
|-------|--------|
| Cursor credentials | OAuth tokens in `auth.json` (`type` / `refresh` / `access` / `expires`) |
| Client auth | Separate **proxy API key** via `--api-key`; clients send `Authorization: Bearer <proxy-api-key>` |
| Bearer passthrough to Cursor | **No** — client Bearer is only the proxy key; Cursor calls use oauth access token from the auth session |
| Token refresh | Scheduled `setTimeout` before `expires` (5m skew); persist updated tokens to `auth.json` |
| OAuth browser login | Not built here; reuse tokens from OpenCode / upstream provider login |
| Config style | Required CLI `--auth` + `--api-key`; optional flags and env fallbacks |

## CLI / environment

| Flag | Env fallback | Required | Description |
|------|--------------|----------|-------------|
| `--auth <path>` | `CURSOR_AUTH_FILE` | yes | Path to oauth auth.json (`@path` supported) |
| `--api-key <key>` | `CURSOR_OPENAI_API_KEY` / `API_KEY` | yes | Proxy API key for client Bearer |
| `--port` | `PORT` | no | Listen port (default `8787`) |
| `--cache-dir` | `CURSOR_CACHE_DIR` | no | Model cache directory |
| `--workspace` | `CURSOR_WORKSPACE` | no | Workspace root for provider |
| `--api-base-url` | `CURSOR_API_BASE_URL` | no | Cursor API base |
| `--agent-base-url` | `CURSOR_AGENT_BASE_URL` | no | Agent Run host override |
| | `CURSOR_MODELS` | no | Comma-separated model allowlist |
| | `CURSOR_PROVIDER_DEBUG` | no | Provider debug |

## Server auth surface

- `/health` — open
- `/v1/models`, `/v1/chat/completions` — require matching Bearer proxy API key (timing-safe compare)
- Cursor `createCursor({ accessToken })` uses tokens from `AuthSession`, never the client Bearer

## `createCursor` wiring

```ts
createCursor({
  name: "cursor",
  accessToken: await authSession.getAccessToken(),
  cacheDir: config.cacheDir,
  workspaceRoot: config.workspaceRoot,
  apiBaseURL: config.apiBaseURL,
  agentBaseURL: config.agentBaseURL,
})
```

## Acceptance criteria

- [x] CLI requires `--auth` and `--api-key` (with env fallbacks).
- [x] Client Bearer must match proxy API key → else 401.
- [x] Cursor calls use oauth access token from auth file.
- [x] Access token refreshed on a timer before expiry; file updated on disk.
- [x] README documents CLI, auth split, and security posture.
- [ ] Live chat turn with real Cursor oauth _(needs valid tokens)_

## Out of scope

- PKCE OAuth UI / device login in this repo
- Multi-tenant proxy keys / user accounts
- Forwarding client credentials to Cursor
