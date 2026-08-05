# Phase 2+: OpenAI tool calling (post-MVP)

**Status:** implemented (unit/mock covered; live Cursor tool loop optional smoke)  
**Depends on:** [01-mvp-openai-bridge.md](./01-mvp-openai-bridge.md)  
**Date:** 2026-07-26  
**Updated:** 2026-08-05

## Objective

After text-only chat works, support OpenAI-style function/tool calling as **pass-through**: client supplies tools; model returns `tool_calls`; client executes tools and sends results in follow-up messages. No local Cursor-native filesystem/shell execution in this phase.

## Why separate

`cursor-opencode-provider` is agent-oriented: Cursor may request native exec (read/shell/edit) and OpenCode-shaped tools. Mapping OpenAI tools onto `LanguageModelV3` tool defs is straightforward; keeping Cursor from also demanding native exec, and round-tripping multi-turn tool results, needs careful testing.

## Target behavior

1. Client `POST /v1/chat/completions` with `tools: [{ type: "function", function: { name, description, parameters } }]`.
2. Bridge converts tools → V3 tool definitions; set `toolChoice` from OpenAI `tool_choice`.
3. On stream/generate, map V3 `tool-call` parts → OpenAI `message.tool_calls` / streaming `delta.tool_calls`.
4. Client runs tools, sends `role: "tool"` messages with `tool_call_id`.
5. Bridge maps tool results into V3 prompt and continues.

## Non-goals for this phase

- Executing Cursor native tools locally (full agent)
- OpenCode plugin packaging
- Guaranteeing parity with every Cursor interaction/query type
- Legacy OpenAI `functions` / `function_call` fields (reject with 400; use `tools` / `tool_choice`)

## Open questions (resolved)

### 1. OpenCode system guidance with arbitrary OpenAI tools?

**Answer:** Yes, the provider still calls `buildOpenCodeInteractionGuidance` whenever the advertised tool list is non-empty. Guidance always includes: the exact executable tool list for the turn, workspace-root grounding, “call only listed tools,” and “emit the actual tool call.” Named redirects (question / todowrite / custom_websearch / write / edit / …) fire **only** when those OpenCode tool names are present.

For typical OpenAI clients advertising only custom functions (e.g. `get_weather`), the model sees the generic list/workspace lines plus those custom names — not OpenCode agent chrome. That is acceptable for pass-through; clients should not advertise OpenCode-native names unless they implement them.

### 2. Held-open Run / session across separate HTTP requests?

**Answer:** Continuations are process-local. When Cursor emits an exec, the provider keeps the Run open and tags `toolCallId` as `cursor_<sessionId>_<execId>`. The next `doStream`/`doGenerate` that ends the prompt with matching `role: "tool"` results delivers them onto that Run (`findContinuationSession` / `deliverContinuationResults`). If the held session is gone (timeout, restart, failed write), the provider rebases a fresh Run from prompt history (trailing tool results retained).

**Bridge requirements:**

- Reuse one process-wide `createCursor` factory so module-level `sessionManager` state is used consistently.
- Do **not** abort the upstream Run when the HTTP response that returned `tool_calls` completes normally (provider already avoids wiring call `abortSignal` into the h2 stream; we only pass client disconnect).
- Clients must echo `tool_call_id` unchanged on `role: "tool"` messages.
- Optional sticky conversation binding: send `X-Session-Id` (or `X-OpenCode-Session`) on every turn of a tool loop; the bridge forwards it as `x-opencode-session` on V3 call options so `resolveConversationId` stays sticky. Without it, each call still works for tool follow-ups via `toolCallId`, but conversation id binding is weaker.

Documented in README under tool calling.

### 3. Auto-reject unknown Cursor exec so the model falls back to client tools?

**Answer:** Out of scope for this bridge. The provider already advertises only the tools we pass, injects “call only tools in that exact list,” and fails unsupported/unknown Cursor exec variants explicitly rather than inventing replies. Declining native UI interactions is provider-owned. We do not add extra rejection logic here.

## Acceptance criteria

- [x] Tool defs round-trip; model can emit at least one `tool_calls` response. _(mock LanguageModelV3)_
- [x] Streaming tool call argument deltas match OpenAI client expectations. _(mock)_
- [x] Follow-up with `role: tool` continues the turn successfully. _(prompt mapping covered; live sticky Run depends on Cursor)_
- [x] Document session/conversation requirements if sticky Cursor Runs are required. _(README + resolved questions above)_

## Suggested approach

1. Extend `src/openai/request.ts` to accept tools; remove the MVP 400.
2. Extend `src/bridge.ts` for tool defs + tool-result messages.
3. Extend `src/openai/response.ts` for `tool_calls` and finish_reason `tool_calls`.
4. Add integration tests with a mock `LanguageModelV3` before live Cursor tests.
5. Live test with a simple OpenAI SDK tool loop.
6. Cache `createCursor`; forward optional session headers; update README.