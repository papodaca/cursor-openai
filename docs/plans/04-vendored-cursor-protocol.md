# Phase 4: Vendor the Cursor protocol — drop `cursor-opencode-provider`

**Status:** implemented (Phases A–C complete; live Phase B verified 2026-08-11)
**Date:** 2026-08-11
**Supersedes:** the "Cursor integration" decision in [00-overview.md](./00-overview.md) (reuse npm package → vendor in repo)

## Objective

Replace the runtime dependency on `cursor-opencode-provider` with our own implementation of Cursor's Connect-RPC/protobuf agent protocol, vendored in-repo as a **protocol translator only**.

Driving principle: **separation of concerns.** A proxy owns transport and message/stream translation — nothing else. All agentic content (system prompt, tool guidance, workspace/context, tool execution) is the caller's responsibility, always supplied by the client in the request. The npm package is built as an *OpenCode host adapter*: it injects guidance and collects host context because an OpenCode host delegates those to it. That is a different job from ours, and no amount of configuration makes a host adapter into a clean proxy.

## Scope: proxy vs caller

| Concern | Owner | Notes |
|---------|-------|-------|
| HTTP/2 Connect-RPC transport, protobuf framing | **proxy** | vendored `transport/`, `protocol/` |
| OpenAI ↔ Cursor message mapping, SSE streaming | **proxy** | existing `src/bridge.ts` + vendored mapping |
| Tool-call bridging (Cursor exec ⇄ OpenAI `tool_calls`) | **proxy** | translation only — never execution, never answers on the client's behalf |
| Held-Run session continuity across tool turns | **proxy** | transport mechanics keyed by session header; process-local |
| System prompt / interaction & tool guidance | **caller** | sent verbatim; proxy appends nothing, ever |
| Workspace, project context, env, rules, skills | **caller** | if a client wants Cursor to know a workspace, the client says so in its messages; the proxy has no workspace concept |
| Tool execution and results | **caller** | pass-through, exactly as today |
| Auth to Cursor (oauth refresh) | **proxy** | unchanged (`AuthSession`) |

Anything the provider did that lands in a "caller" row above is **deleted**, not replaced or made configurable.

## Why vendor (motivation)

Current behavior inherited from the npm package violates that contract:

1. **cwd → prompt injection.** `language-model.js:485` resolves `options.workspaceRoot || process.cwd()`; `buildOpenCodeInteractionGuidance` then appends `Workspace root: "<proxy cwd>". Resolve workspace paths against exactly this root…` to the system prompt on every tool-enabled turn. Verified present in upstream v0.2.9 **and** latest v0.4.2 (the v0.4.2 `getSessionDirectory` fix only applies to the OpenCode 2.0 daemon plugin path, which a plain `createCursor()` consumer never triggers).
2. **Host-context collectors.** Every Run request carries `request_context` built from that root: env (`workspace_paths`, `process_working_directory`), git status/branch, directory layout, AGENTS.md/rules, skills, plugins (upstream `context/*`). None of it is the client's project.
3. **Local filesystem touchpoints on the proxy host.** `rejectMissingReadTarget` / `recoverMissingEditRead` stat paths on the proxy server's disk (resolved against the proxy cwd) to answer Cursor-native read/edit execs. Wrong for multi-client use; also a path-disclosure surface.
4. **Supply-chain churn.** 0.4.0/0.4.1/0.4.2 shipped within ~36 hours; much of the diff is OpenCode-plugin machinery (pricing, opencode2, image input, MCP bridging) this proxy never executes.
5. **Dependency-shape liabilities.** Removes the `@ai-sdk/provider` version-split problem permanently (upstream pins 3.0.8; our type-only usage is now free-standing) and drops the `@opencode-ai/plugin` peer chain (`effect`, `zod`, msgpackr native builds, …) from the tree.

### Alternatives rejected

| Alternative | Why rejected |
|-------------|--------------|
| `--workspace` / `CURSOR_WORKSPACE` flag | Static per process; a stateless multi-client proxy has no single "the" workspace. Treats the symptom for one client only. |
| Per-request workspace header forwarded into provider options | Still feeds client-uncontrolled paths into prompt guidance and host-side collectors; still stats the proxy's disk on read/edit execs. The injection design is the problem, not the value supplied. |
| Wait for upstream to fix | v0.4.2 keeps the `process.cwd()` fallback on the SDK path by design (host = OpenCode plugin). |
| Fork on npm | We need deep deletions, not configuration; an in-repo vendor is simpler than maintaining a published fork. |

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Copy source | Upstream git tag **v0.4.2** `src/` TypeScript — latest at vendor time, so all protocol fixes that apply to our use case are in the base (see intake table below). Not `dist/`. Tag + commit sha recorded in `src/cursor/NOTICE.md` |
| Posture | We take upstream's **protocol knowledge** (how to build/keep/map Cursor Runs), not its host behavior. The vendored tree is our owned reference implementation of "how to call Cursor models," stripped of host-adapter chrome |
| License | MIT (© Oleksiy Akimov): retain copyright header in each vendored file + add `src/cursor/NOTICE.md` with the full license text |
| Interface | Vendored model still implements `LanguageModelV3` (`doStream`/`doGenerate`); `src/bridge.ts` and the OpenAI surface are **untouched** |
| Context injection | Delete entirely: no interaction guidance, no `request_context`, no env/workspace paths, no collectors — not configurable, just absent |
| Workspace model | None. No flag, no env var, no cwd fallback anywhere in the vendored path. Remove `--workspace`/`CURSOR_WORKSPACE` from this repo's config (v0 proxy; breaking change acceptable) |
| Cursor-native execs | **All** pass through to the client as tool calls. The provider's local stat/read special-casing is deleted (see behavioral delta below) |
| Session state | Unchanged from today: held-open Runs stay process-local, keyed by `x-opencode-session` header / `toolCallId`. This is the *only* retained statefulness |
| Model discovery | Vendor upstream `models.ts`; delete the `createRequire` + deep-`dist`-import hack in `src/models.ts` |
| Auth | Keep this repo's `AuthSession` (auth.json load + refresh). Drop upstream `auth.ts` (duplicated responsibility); vendored code receives a plain access token |
| Upstream sync | Re-vendor against newer tags via tag diff when warranted (see Risks). No git-subtree/submodule automation |

## Copy vs drop (upstream v0.4.2 `src/`)

**Copy into `src/cursor/`** (preserve upstream file layout for diffability):

| Upstream file(s) | Role |
|---|---|
| `language-model.ts` | `LanguageModelV3` impl — **heavily edited**, see edit list |
| `transport/connect.ts`, `protocol/{framing,struct,stream}.ts` | HTTP/2 Connect-RPC transport + protobuf framing |
| `protocol/{messages,request,tools,tool-call-bridge,exec-variants,interactions,conversation-bind,checkpoint,blob-store,kv}.ts` | Run request/response mapping, tool bridging, continuation delivery |
| `protocol/{client-version,device-id,checksum,thinking}.ts` | Cursor handshake/versioning bits |
| `session.ts`, `replay-safety.ts`, `activity.ts`, `deadline.ts` | Held-open Run sessions, stream safety |
| `agent-url.ts` | GetServerConfig → region Run host resolution |
| `models.ts` | AvailableModels discovery + cache |
| `errors.ts`, `debug.ts`, `shared.ts`, `shell-timeout.ts` | Support (`shell-timeout.ts` only if still referenced after exec edits — audit) |

**Drop:**

| Upstream file(s) | Why |
|---|---|
| `plugin.ts`, `plugin-v2.ts`, `plugin-core.ts`, `plugin-opencode2.ts`, `opencode2/`, `session-directory.ts`, `compaction-marker.ts`, `index.ts` | OpenCode plugin entries & session/workspace tracking — host-adapter machinery (we write a minimal local `index.ts` exporting our factory) |
| `context/` (all) | Collectors, env builder, paths — the injection machinery |
| `web-tools.ts`, `web-search-tool.ts` | Host custom tools |
| `pricing.ts`, `pricing-data.ts`, `model-config.ts`, `model-metadata.ts` | Host cost/metadata chrome |
| `image-input.ts` | Host multimodal input (our bridge is text-only today; see intake table) |
| `protocol/apply-patch.ts` | Host-side apply_patch exec handling (execs pass through as tool calls; audit references from kept protocol files) |
| `auth.ts` | Duplicates `AuthSession`; keep only `decodeJwtExpiryMs`/`isExpiringSoon` helpers **if** referenced by session logic |
| upstream `scripts/`, most fixtures | Pricing/opencode2 tooling |

Estimated vendored size after edits: ~8–9k LOC (vs ~13k in upstream dist).

## Upstream 0.3.x/0.4.x intake — what applies to our use case

Since the base moves to v0.4.2, mapping the 0.2.9→0.4.2 diff against the proxy contract:

| Upstream change | Verdict | Why |
|---|---|---|
| `f94072b` preserve tool edits; request-local usage | **take** (in base) | Protocol/message-mapping correctness for the tool pass-through path |
| `36a5952` forward TurnEnded usage; bound abandoned open Runs | **take** (in base) | Accurate `usage` in responses; session hygiene for a long-lived multi-client process |
| `bfefd8f` apply_patch host support; 50 KB read-cap reporting | **partial** | Take the exec-variant *parsing* in `protocol/tools.ts`; drop the host cap-reporting behavior (a client's tool limits are caller-owned; `protocol/apply-patch.ts` dropped) |
| `3c1a123` CodeQL scanning fixes | **take** where they touch kept files | Generic hardening |
| usage/payload truncation handling (`usage-from-turn-ended`, `payload-truncation` tests) | **take** (in base) | Protocol-level wire safety |
| `60716e4` Cursor docs pricing on model costs | leave | Host cost display |
| `6b940c6`,`ad4f642` OpenCode 2.0 plugin, daemon workspace dir, session-directory | leave | Host-adapter machinery (the workspace fix that doesn't apply to us anyway) |
| `1092314`,`5be4c28` model metadata + image input | leave (revisit if the bridge goes multimodal) | Our OpenAI surface is text-only |
| `444dbc5` native MCP resource exec bridging | leave | Host-side execution |

## Edit list — the neutering (upstream v0.4.2 line refs)

All in `language-model.ts` unless noted:

1. **Delete** the workspace resolution `path.resolve(getSessionDirectory(sessionKey) ?? (options.workspaceRoot || process.cwd()))` (l.662), the `session-directory` import, and the `workspaceRoot` concept from the model/options type entirely.
2. **Delete** `buildOpenCodeInteractionGuidance` import + call (l.665; definition l.2021, incl. the `Workspace root:` line at l.2100); `systemPrompt = extractSystemPrompt(prompt)` verbatim — the client's system messages, nothing else.
3. **Delete** `buildRequestContext` import + call (l.747). `buildRunRequest` treats `requestContext` as optional (omitted from the encoded message when undefined), so Runs go out with **no** `request_context` field.
4. **Delete local-fs exec intercepts**: `recoverMissingEditRead`, `rejectMissingReadTarget`, `resolveReadTargetPath`, `classifyMissingReadTarget`, `buildReadRejectionMessages` (+ `fs` imports). Native read/edit/shell execs now become ordinary pass-through tool calls, consistent with every other tool.
5. **Delete** `workspaceRootFromRequestContext` usage and the `session.requestContext` field (audit remaining references in `session.ts`).
6. **Delete** image-input wiring (multipart/image parts in message mapping; text-only bridge) and any reference to dropped files (`apply-patch.ts`, model metadata, pricing).
7. `CreateCursorOptions` equivalent: drop `workspaceRoot`, `baseURL` (deprecated upstream), `telemetryEnabled`; keep `continuation`/`retry`; keep `headers` (bridge forwards the session header through it).
8. Mechanical: rewrite import specifiers to repo convention (`./x.ts`), satisfy `verbatimModuleSyntax` (`import type` where required). No runtime dependency on `@ai-sdk/provider` exists upstream — keep it that way (types only).

## Resulting architecture

```
OpenAI client → src/server.ts → src/bridge.ts → LanguageModelV3 (src/cursor/) → Cursor agent API
                                     ↑ unchanged        ↑ vendored, no context injection
```

`package.json` after migration: `cursor-opencode-provider` removed; `protobufjs` becomes a **direct** runtime dependency (vendored framing needs it); `@ai-sdk/provider` stays devDep (types only); `@opencode-ai/plugin` peer chain leaves the tree entirely.

## Phases & acceptance criteria

### Phase A — vendor + neuter

1. Copy the keep-list from upstream tag **v0.4.2** into `src/cursor/` with license headers + `NOTICE.md` (recording tag + commit sha); write minimal `src/cursor/index.ts` (factory + `LanguageModelV3` export surface only).
2. Apply the neutering edit list (1–8).
3. Rewire `src/cursor.ts` (repo root) to the local factory — same cache-key behavior minus the workspace dimension. Rewire `src/models.ts` to a direct import of vendored discovery.
4. Remove `--workspace`/`CURSOR_WORKSPACE` from `src/config.ts`, `usage()`, README.
5. Port upstream unit tests that cover retained behavior: `test/{messages,request,interactions,exec-variants,session,continuation-session,models,tools,run-interruption,usage-from-turn-ended,payload-truncation}.test.ts` → `src/cursor/__tests__/`, adapted to deletions. (Skip host-chrome suites: plugin/opencode2/pricing/image/read-cap/workspace-root.)
6. **New regression tests:**
   - Golden Run-request test: fixed prompt+auth fixture → encoded `AgentClientMessage` has **no** `request_context` and system prompt equals the client's verbatim input (byte/struct assertion on the decoded frame).
   - No-`process.cwd()` test: static assert via grep in CI, or a unit test that `chdir`s the process between turns and observes no change in emitted frames.
   - Continuation: existing `bridge.test.ts` tool-loop tests still pass against the vendored model's session machinery (mocked transport).
7. `bun remove cursor-opencode-provider && bun add protobufjs`; `bun run typecheck` and `bun test src` green.

**Exit criteria:** typecheck + full test suite green with the vendored model; no import of `cursor-opencode-provider` anywhere; new no-injection tests pass.

### Phase B — live verification & hardening

1. Live smoke against real Cursor auth: `/v1/models`, non-stream chat, streaming chat.
2. Multi-turn tool loop (OpenCode client): verify `cursor_<sessionId>_<execId>` id echo still binds to the held Run with `X-Session-Id`; verify behavior without the header (rebase path).
3. Multi-client check: two concurrent OpenCode sessions/projects → no cross-talk of conversation ids or content.
4. Confirm Cursor tooling still functions when native read/shell execs arrive as pass-through tool calls (OpenCode has read/shell tools); log if the model stalls without typed read rejections.
5. Idle-held-Run hygiene: confirm heartbeat/idle timeouts reap sessions (port `session.test.ts` coverage; manual soak optional).

**Exit criteria:** items 1–3 work; item 4 documented either way. _(Live-verified 2026-08-11: `/v1/models`, OpenCode chat, parallel tool calls, concurrent sessions OK; native read/shell/edit pass-through functioned without typed missing-read rejections.)_

### Phase C — docs & upstream tracking

1. ✅ README: layout section (vendored `src/cursor/`), remove `--workspace` docs, note MIT vendored attribution, update tool-calling section (native execs are pure pass-through now; typed missing-read rejections removed).
2. ✅ `docs/plans/00-overview.md`: mark superseded decision, note Phase 4.
3. ✅ Forward-sync rule: documented in `src/cursor/NOTICE.md` — on new upstream tags, review the tag diff against `src/cursor/` using the intake verdicts as the template — protocol/message/session/tools fixes apply; host-chrome (plugin, pricing, metadata, workspace/session tracking) does not. Record the synced upstream tag in `src/cursor/NOTICE.md` each time.

## Behavioral deltas vs today

These are the contract working as intended — corrections, not regressions:

| Change | Why it's correct |
|---|---|
| System prompt arrives from the client verbatim; proxy appends nothing | Guidance is the caller's input, by definition. OpenCode already ships its own system prompt; a curl/CLI user simply gets what they asked for. |
| No `request_context` on Runs | The proxy has no project to describe; describing the proxy's own directory was the bug. |
| Native execs (read/shell/edit/…) reach the client as ordinary tool calls | The client executes against *its* project. The provider answering them on the proxy's disk was wrong twice over (wrong machine, wrong directory). |
| `--workspace` flag removed | The proxy no longer has a workspace concept at any scope. |

Open protocol questions for Phase B (plumbing, not context):

- **`request_context` omitted entirely** — schema-optional and unproven against live Cursor. If the agent API refuses or degrades without the field, send a schema-minimal empty struct (zero populated fields) — protocol satisficing only, never derived from cwd, env, or client paths.
- **Cursor looping on absent read targets** — if observed, reintroduce a typed `file_not_found` rejection computed purely from the tool-call args (no fs stat).

## Risks

- **Live-protocol unknowns.** Omitting `request_context` is schema-valid but unproven against Cursor until Phase B. Mitigation: fall back to a schema-minimal empty struct (plumbing, still no context), or gate behind one release with the npm package.
- **Maintenance burden.** ~8–9k LOC of protocol code becomes ours. Mitigation: preserve upstream file boundaries/commit-style for tag-diff reviews; ported upstream tests act as the drift detector.
- **Upstream drift after vendoring.** Base freezes at v0.4.2; future Cursor protocol fixes land upstream, not here. Mitigation: the Phase C forward-sync rule (tag-diff review with the intake-verdict template); protocol fixes are usually small, localized changes.
- **License.** MIT requires retaining copyright notice. Mitigation: per-file headers + `src/cursor/NOTICE.md`.
- **AI SDK type drift.** Vendored v3-spec code compiles against `@ai-sdk/provider@4.0.7`'s re-exported V3 types today (verified); a future 4.x/5.x removing V3 aliases breaks typecheck. Mitigation: keep devDep pinned exact; bump deliberately with typecheck as the gate.

## Non-goals

- Reimplementing protobuf schemas from scratch (we copy upstream's `struct.ts` encoding approach).
- OpenCode plugin/packaging features, pricing data, image input, MCP resource bridging (upstream 0.3/0.4 additions).
- A per-request workspace concept of any kind.
- Session persistence across proxy restarts (held Runs remain process-local, as today).