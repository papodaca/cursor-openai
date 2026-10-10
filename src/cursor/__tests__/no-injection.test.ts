import { describe, expect, it } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { buildRunRequest } from "../protocol/request.ts"
import { decodeMessage } from "../protocol/messages.ts"

const CURSOR_ROOT = path.resolve(import.meta.dir, "..")

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "NOTICE.md") continue
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walkTsFiles(full, out)
    else if (name.endsWith(".ts")) out.push(full)
  }
  return out
}

describe("proxy posture: no host context injection", () => {
  it("sends the caller system prompt as the only request_context field", () => {
    const systemPrompt = "You are a verbatim client system prompt."
    const data = buildRunRequest({
      text: "Hello from the client",
      modelId: "composer-2",
      conversationId: "conv-golden-no-rc",
      systemPrompt,
      tools: [
        {
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    })

    const decoded = decodeMessage<any>("AgentClientMessage", data)
    const action = decoded.run_request.action.user_message_action
    expect(action.user_message.text).toBe("Hello from the client")
    expect(action.request_context.rules).toEqual([
      {
        full_path: "System instructions",
        content: systemPrompt,
        type: { global: {} },
      },
    ])
    const context = action.request_context
    expect(context.env ?? null).toBeNull()
    expect(context.mcp_meta_tool_options ?? null).toBeNull()
    expect(context.hooks_additional_context ?? "").toBe("")
    for (const key of ["git_repos", "project_layouts", "repository_info", "agent_skills", "tools"]) {
      expect(context[key] ?? []).toEqual([])
    }

    const cs = decodeMessage<any>(
      "ConversationStateStructure",
      decoded.run_request.conversation_state,
    )
    expect(cs.root_prompt_messages_json ?? []).toHaveLength(0)
  })

  it("does not change emitted Run bytes when process.cwd() changes", () => {
    const original = process.cwd()
    const mk = (cwdLabel: string) => {
      // Label is unused in the request — only process.cwd() differs between calls.
      void cwdLabel
      return buildRunRequest({
        text: "stable prompt",
        modelId: "composer-2",
        conversationId: "conv-cwd-invariant",
        systemPrompt: "system",
        messageId: "fixed-message-id",
        tools: [{ name: "grep", description: "Search", inputSchema: { type: "object" } }],
      })
    }

    try {
      process.chdir("/tmp")
      const a = mk("tmp")
      process.chdir(CURSOR_ROOT)
      const b = mk("repo")
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    } finally {
      process.chdir(original)
    }
  })

  it("static: vendored sources never call process.cwd() for request building", () => {
    // Allowlist: comments and the intentional cwd-invariant regression test itself.
    const files = walkTsFiles(CURSOR_ROOT)
    const offenders: string[] = []
    for (const file of files) {
      const src = readFileSync(file, "utf8")
      const lines = src.split("\n")
      lines.forEach((line, idx) => {
        if (!line.includes("process.cwd(")) return
        const trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return
        offenders.push(`${path.relative(CURSOR_ROOT, file)}:${idx + 1}: ${trimmed}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
