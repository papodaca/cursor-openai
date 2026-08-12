# Phase 2+: OpenAI tool calling (post-MVP)

**Status:** implemented (unit/mock covered; live Cursor tool loop verified)  
**Depends on:** [01-mvp-openai-bridge.md](./01-mvp-openai-bridge.md)  
**Date:** 2026-07-26  
**Updated:** 2026-08-11 (Phase 4: guidance/injection answers below are historical — see [04](./04-vendored-cursor-protocol.md))

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

**Answer (historical, pre–Phase 4):** Yes, the npm provider called `buildOpenCodeInteractionGuidance` whenever the advertised tool list was non-empty (executable tool list, workspace-root grounding, “call only listed tools,” named redirects when OpenCode tool names were present).

**Superseded by [04](./04-vendored-cursor-protocol.md):** the vendored translator appends **no** interaction guidance and injects **no** workspace/`request_context`. The system prompt is the client’s verbatim input; native Cursor execs pass through as ordinary tool calls for the client to execute.

### 2. Held-open Run / session across separate HTTP requests?

**Answer:** Continuations are process-local. When Cursor emits an exec, the provider keeps the Run open and tags `toolCallId` as `cursor_<sessionId>_<execId>`. The next `doStream`/`doGenerate` that ends the prompt with matching `role: "tool"` results delivers them onto that Run (`findContinuationSession` / `deliverContinuationResults`). If the held session is gone (timeout, restart, failed write), the provider rebases a fresh Run from prompt history (trailing tool results retained).

**Bridge requirements:**

- Reuse one process-wide `createCursor` factory so module-level `sessionManager` state is used consistently.
- Do **not** abort the upstream Run when the HTTP response that returned `tool_calls` completes normally (provider already avoids wiring call `abortSignal` into the h2 stream; we only pass client disconnect).
- Clients must echo `tool_call_id` unchanged on `role: "tool"` messages.
- Optional sticky conversation binding: send `X-Session-Id` (or `X-OpenCode-Session`) on every turn of a tool loop; the bridge forwards it as `x-opencode-session` on V3 call options so `resolveConversationId` stays sticky. Without it, each call still works for tool follow-ups via `toolCallId`, but conversation id binding is weaker.

Documented in README under tool calling.

### 3. Auto-reject unknown Cursor exec so the model falls back to client tools?

**Answer (updated Phase 4):** Out of scope / deliberately absent. Native Cursor execs (read/shell/edit/…) are pure pass-through tool calls; the proxy does not invent typed missing-read rejections or execute anything on the proxy host. Unsupported variants fail at the protocol mapper rather than inventing replies. Clients that need filesystem tools must advertise and implement them.

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