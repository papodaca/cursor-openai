# Phase 2+: OpenAI tool calling (post-MVP)

**Status:** drafted (not started)  
**Depends on:** [01-mvp-openai-bridge.md](./01-mvp-openai-bridge.md)  
**Date:** 2026-07-26

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

## Open questions (resolve before implementing)

- Does the provider still inject OpenCode system guidance when arbitrary OpenAI tools are present? If yes, does that confuse non-OpenCode clients?
- How does the held-open Run / session behave across separate HTTP requests for tool follow-ups? (May need conversation/session id headers.)
- Should unknown Cursor exec requests be auto-rejected so the model falls back to client tools?

## Acceptance criteria (when started)

- [ ] Tool defs round-trip; model can emit at least one `tool_calls` response.
- [ ] Streaming tool call argument deltas match OpenAI client expectations.
- [ ] Follow-up with `role: tool` continues the turn successfully.
- [ ] Document session/conversation requirements if sticky Cursor Runs are required.

## Suggested approach

1. Extend `src/openai/request.ts` to accept tools; remove the MVP 400.
2. Extend `src/bridge.ts` for tool defs + tool-result messages.
3. Extend `src/openai/response.ts` for `tool_calls` and finish_reason `tool_calls`.
4. Add integration tests with a mock `LanguageModelV3` before live Cursor tests.
5. Live test with a simple OpenAI SDK tool loop.
