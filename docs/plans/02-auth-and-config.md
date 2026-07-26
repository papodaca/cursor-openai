# Phase 1: Auth and configuration

**Status:** in-progress  
**Depends on:** [00-overview.md](./00-overview.md)  
**Pairs with:** [01-mvp-openai-bridge.md](./01-mvp-openai-bridge.md)  
**Date:** 2026-07-26

## Objective

Define how this server obtains Cursor credentials and runtime options, and how (if at all) OpenAI clients pass auth.

## Decisions

| Topic | Choice for MVP |
|-------|----------------|
| Primary credentials | Env vars (server-side) |
| Client `Authorization: Bearer` | **Passthrough allowed** — if present, use as Cursor `apiKey` or `accessToken`; else fall back to env |
| OAuth browser login | Not built here; users obtain `sk-...` from cursor.com/settings or reuse a JWT from existing OpenCode/provider login |
| Config style | Env vars first; optional later config file |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CURSOR_API_KEY` | one of key/token | Raw Cursor API key (`sk-...`) → `createCursor({ apiKey })` |
| `CURSOR_ACCESS_TOKEN` | one of key/token | JWT access token → `createCursor({ accessToken })` |
| `PORT` | no | HTTP listen port (default `8787`) |
| `CURSOR_CACHE_DIR` | no | Host cache root for model cache / provider metadata |
| `CURSOR_WORKSPACE` | no | Optional workspace root passed as `workspaceRoot` |
| `CURSOR_API_BASE_URL` | no | Override API base (auth/models/GetServerConfig) |
| `CURSOR_AGENT_BASE_URL` | no | Override agent Run host |
| `CURSOR_MODELS` | no | Comma-separated model ids for `GET /v1/models` |
| `CURSOR_PROVIDER_DEBUG` | no | Forwarded/provider debug (document provider’s own env) |

Credential precedence per request:

1. `Authorization: Bearer <value>` from the OpenAI client (if non-empty)
2. Else `CURSOR_ACCESS_TOKEN`
3. Else `CURSOR_API_KEY`
4. Else 401

Heuristic for Bearer value: if it starts with `sk-`, pass as `apiKey`; otherwise pass as `accessToken` (JWT). Document that clients may send either.

## Server auth surface

- Do **not** invent a separate API key for this proxy in MVP unless needed later.
- This proxy is assumed **local / trusted network**. Document that exposing it publicly forwards whoever’s Bearer token to Cursor.

## `createCursor` wiring

```ts
createCursor({
  name: "cursor",
  apiKey,          // or accessToken
  cacheDir: process.env.CURSOR_CACHE_DIR,
  workspaceRoot: process.env.CURSOR_WORKSPACE,
  apiBaseURL: process.env.CURSOR_API_BASE_URL,
  agentBaseURL: process.env.CURSOR_AGENT_BASE_URL,
})
```

Factory may be per-request when Bearer differs from env (avoid leaking one user’s token into a shared singleton). Simple approach: create provider per request, or cache by credential fingerprint.

## Acceptance criteria

- [ ] Server starts with env credentials and can complete a chat turn. _(needs live Cursor credentials)_
- [x] Request with Bearer override uses that credential for the Cursor call.
- [x] Missing credentials → 401 OpenAI-shaped error.
- [x] README documents all env vars and Bearer passthrough behavior.
- [x] Disclaimer: personal use / Cursor ToS; do not expose publicly without understanding credential forwarding.

## Steps

1. Add `src/config.ts` — parse env, defaults, validate port.
2. Add `src/auth.ts` — resolve credential from request headers + env; classify key vs token.
3. Integrate into chat route and optional models fetch path.
4. Document security posture in README (local trusted use).

## Out of scope

- PKCE OAuth UI / device login in this repo
- Reading OpenCode `auth.json` automatically (nice-to-have later)
- Multi-tenant auth / API keys for the proxy itself