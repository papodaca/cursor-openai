# Vendored Cursor protocol — attribution

This directory contains a vendored, heavily edited copy of the Connect-RPC /
protobuf agent protocol implementation originally published as the MIT-licensed
npm package `cursor-opencode-provider`.

## Upstream source

| Field | Value |
|-------|-------|
| Package | `cursor-opencode-provider` |
| Upstream tag | **v0.4.2** |
| Upstream commit | `444dbc5b01aa046067c49e7f45c90deda72db85a` |
| Upstream copyright | © 2026 Oleksiy Akimov |
| License | MIT (full text below) |

Host-adapter behavior from upstream (workspace/context collectors, system-prompt
injection, local filesystem exec intercepts, OpenCode plugin entries, pricing /
image-input chrome) has been deleted. What remains is transport, framing, and
message/stream translation — see `docs/plans/04-vendored-cursor-protocol.md`.

## Forward-sync rule

When a newer `cursor-opencode-provider` tag ships that might carry protocol fixes:

1. Diff the upstream tag against the recorded commit above, scoped to files that
   map into this directory (see the copy/drop tables in
   `docs/plans/04-vendored-cursor-protocol.md`).
2. Apply the **intake verdicts** from that plan as the template:
   - **Take:** protocol / message / session / tools / framing / stream-safety fixes
     that affect the SDK `LanguageModelV3` path.
   - **Leave:** host-chrome — OpenCode plugin/opencode2, pricing, model metadata,
     image input, workspace/session-directory tracking, MCP resource execution,
     local FS exec intercepts, context collectors / prompt injection.
3. Re-run `bun run typecheck` and `bun test src` (especially
   `src/cursor/__tests__/no-injection.test.ts` and `request.test.ts`).
4. Update the **Upstream tag** and **Upstream commit** rows in this file to the
   newly synced revision.

Do not reintroduce workspace, `request_context` population, or proxy-local tool
execution under any sync.

## MIT License

```
MIT License

Copyright (c) 2026 Oleksiy Akimov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```