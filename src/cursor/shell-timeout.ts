/**
 * Shell-call bookkeeping for Cursor shell_stream / background_shell_spawn execs.
 *
 * The proxy does not execute shells. It only:
 *   - registers metadata when Cursor emits a shell-related tool call
 *   - rewrites `background_shell_spawn` into a detach wrapper the client runs
 *   - parses the client's tool output back into a typed CursorShellOutcome
 *
 * Soft-background (TIMEOUT_BACKGROUND) host wrapping from the OpenCode plugin
 * path was deleted; timeout_behavior=2 is recorded but no longer rewrites the
 * client command.
 */

/** Private marker for Cursor `background_shell_spawn_args` detach wrappers. */
export const BACKGROUND_SHELL_MARKER = "__CURSOR_BACKGROUND_SHELL__"

export type CursorShellPolicy = {
  command: string
  workingDirectory: string
  timeoutMs: number
  timeoutBehavior: number
  hardTimeoutMs?: number
  /** Immediate nohup detach for Cursor `background_shell_spawn_args`. */
  backgroundSpawn?: boolean
}

export type CursorShellOutcome =
  | { kind: "exit"; code: number }
  | { kind: "timeout"; timeoutMs: number }
  | {
      kind: "backgrounded"
      shellId: number
      pid: number
      command: string
      workingDirectory: string
      msToWait: number
      reason: 1
    }

const MAX_TRACKED_SHELL_CALLS = 512
const policies = new Map<string, CursorShellPolicy>()
const outcomes = new Map<string, CursorShellOutcome>()

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_TRACKED_SHELL_CALLS) {
    const oldest = map.keys().next().value as string | undefined
    if (!oldest) break
    map.delete(oldest)
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function shellPolicyFromMetadata(
  metadata: Record<string, unknown> | undefined,
): CursorShellPolicy | undefined {
  if (!metadata) return undefined
  if (metadata.background_shell_spawn === true) {
    return {
      command: typeof metadata.command === "string" ? metadata.command : "",
      workingDirectory:
        typeof metadata.working_directory === "string" ? metadata.working_directory : "",
      timeoutMs: 0,
      timeoutBehavior: 0,
      backgroundSpawn: true,
    }
  }
  if (metadata.shell_stream !== true) return undefined
  const timeoutMs = finiteNonNegative(metadata.timeout_ms) ?? 30_000
  const timeoutBehavior = finiteNonNegative(metadata.timeout_behavior) ?? 0
  const hardTimeoutMs = finiteNonNegative(metadata.hard_timeout_ms)
  return {
    command: typeof metadata.command === "string" ? metadata.command : "",
    workingDirectory:
      typeof metadata.working_directory === "string" ? metadata.working_directory : "",
    timeoutMs,
    timeoutBehavior,
    ...(hardTimeoutMs !== undefined && hardTimeoutMs > 0 ? { hardTimeoutMs } : {}),
  }
}

/** Register a Cursor shell request before the client executes the tool call. */
export function registerCursorShellCall(
  toolCallId: string,
  metadata: Record<string, unknown> | undefined,
): void {
  const policy = shellPolicyFromMetadata(metadata)
  if (!policy || !toolCallId.startsWith("cursor_")) return
  remember(policies, toolCallId, policy)
}

/**
 * Detach wrapper for Cursor `background_shell_spawn_args`.
 *
 * Client bash tools are typically foreground-only. Detach inside that one call
 * (`nohup … &`) and print a private marker with PID + log path so the reply can
 * be typed as background_shell_spawn_result.
 */
export function buildBackgroundShellCommand(command: string): string {
  return [
    'bg_log="$(mktemp "${TMPDIR:-/tmp}/cursor-opencode-bg.XXXXXX")" || exit 1',
    `nohup sh -c ${shellQuote(command)} >"$bg_log" 2>&1 </dev/null &`,
    "bg_pid=$!",
    `printf '${BACKGROUND_SHELL_MARKER}%s:%s\\n' "$bg_pid" "$bg_log"`,
  ].join("\n")
}

function withoutMarker(output: string, index: number): string {
  let clean = output.slice(0, index).replace(/[\t ]+$/gm, "").replace(/\n{2,}$/, "\n")
  if (clean.trim() === "" || clean.trim() === "(no output)") clean = ""
  return clean
}

function formatShellOutcomeDisplay(clean: string, outcome: CursorShellOutcome): string {
  let notice: string | undefined
  if (outcome.kind === "backgrounded") {
    notice = outcome.msToWait > 0
      ? `Still running in the background (pid ${outcome.pid}) after ${outcome.msToWait}ms.`
      : `Started in the background (pid ${outcome.pid}).`
  } else if (outcome.kind === "timeout") {
    notice = `Timed out after ${outcome.timeoutMs}ms.`
  }
  if (!notice) return clean
  if (!clean) return `${notice}\n`
  return clean.endsWith("\n") ? `${clean}${notice}\n` : `${clean}\n${notice}\n`
}

function lastPrivateMarker(
  output: string,
  marker: string,
  valuePattern: string,
): { index: number; values: string[] } | undefined {
  const re = new RegExp(`(?:^|\\r?\\n)(${marker}${valuePattern})`, "g")
  let match: RegExpExecArray | null
  let last: { index: number; values: string[] } | undefined
  while ((match = re.exec(output)) !== null) {
    if (match.index === undefined || match[1] === undefined) continue
    const index = match[0].startsWith("\r\n")
      ? match.index + 2
      : match[0].startsWith("\n")
        ? match.index + 1
        : match.index
    last = { index, values: match.slice(2) }
  }
  return last
}

function parseOpenCodeTimeout(output: string): { output: string; timeoutMs: number } | undefined {
  const closeTag = "</shell_metadata>"
  const closeAt = output.lastIndexOf(closeTag)
  if (closeAt === -1 || output.slice(closeAt + closeTag.length).trim() !== "") return undefined

  const header = /<shell_metadata>\r?\nshell tool terminated command after exceeding timeout (\d+) ms\./
  const match = header.exec(output.slice(0, closeAt))
  if (!match || match.index === undefined) return undefined
  return { output: withoutMarker(output, match.index), timeoutMs: Number(match[1]) }
}

function parseBackgroundSpawnOutcome(
  output: string,
  policy: CursorShellPolicy | undefined,
): { output: string; outcome: CursorShellOutcome } | undefined {
  const match = lastPrivateMarker(output, BACKGROUND_SHELL_MARKER, "(\\d+):([^\\r\\n]+)")
  if (!match) return undefined
  const pid = Number(match.values[0])
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return undefined
  return {
    output: withoutMarker(output, match.index),
    outcome: {
      kind: "backgrounded",
      shellId: pid,
      pid,
      command: policy?.command ?? "",
      workingDirectory: policy?.workingDirectory ?? "",
      msToWait: 0,
      reason: 1,
    },
  }
}

function captureCursorShellResult(
  toolCallId: string,
  output: string,
  metadata?: Record<string, unknown>,
): string {
  if (typeof toolCallId !== "string" || !toolCallId.startsWith("cursor_")) return output
  const policy = policies.get(toolCallId)
  if (policy?.backgroundSpawn) {
    const spawn = parseBackgroundSpawnOutcome(output, policy)
    if (spawn) {
      remember(outcomes, toolCallId, spawn.outcome)
      return formatShellOutcomeDisplay(spawn.output, spawn.outcome)
    }
  }
  const timeout = parseOpenCodeTimeout(output)
  if (timeout) {
    const outcome = { kind: "timeout" as const, timeoutMs: timeout.timeoutMs }
    remember(outcomes, toolCallId, outcome)
    return formatShellOutcomeDisplay(timeout.output, outcome)
  }
  const exitCode = finiteNonNegative(metadata?.exit)
  if (exitCode !== undefined) remember(outcomes, toolCallId, { kind: "exit", code: exitCode })
  return output
}

/** Consume the structured result from client tool output / metadata. */
export function consumeCursorShellResult(
  toolCallId: string,
  output: string,
): { output: string; outcome?: CursorShellOutcome } {
  if (typeof toolCallId !== "string" || !toolCallId) {
    return { output }
  }
  let clean = output
  if (!outcomes.has(toolCallId)) clean = captureCursorShellResult(toolCallId, output)
  const outcome = outcomes.get(toolCallId)
  outcomes.delete(toolCallId)
  policies.delete(toolCallId)
  return { output: clean, outcome }
}
