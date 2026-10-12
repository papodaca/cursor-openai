import { describe, expect, test } from "bun:test"
import { createSnapshotParser } from "../public/status-snapshot.js"

type StatusSnapshot = {
  rows: Array<{
    at: number
    address: string
    model: string
    requestBytes: number
    responseBytes: number
  }>
  inFlight: boolean
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function collect(chunks: string[]): StatusSnapshot[] {
  const seen: StatusSnapshot[] = []
  const parser = createSnapshotParser((snapshot) => {
    seen.push(snapshot)
  })
  for (const chunk of chunks) parser.push(encode(chunk))
  return seen
}

function withActivity<T extends { rows: unknown; inFlight: boolean }>(snapshot: T) {
  return {
    hourly: Array(24).fill(0),
    hourlyStart: 0,
    daily: [] as number[],
    dailyStart: 0,
    ...snapshot,
  }
}

const row = {
  at: 1_700_000_000_000,
  address: "127.0.0.1",
  model: "composer-2.5",
  requestBytes: 40,
  responseBytes: 90,
}

describe("createSnapshotParser", () => {
  test("parses a snapshot after a heartbeat comment", () => {
    const snapshot = { rows: [row], inFlight: false }
    const seen = collect([`: keep-alive\n\ndata: ${JSON.stringify(snapshot)}\n\n`])
    expect(seen).toEqual([withActivity(snapshot)])
  })

  test("returns a model string unchanged", () => {
    const model = "<img src=x onerror=alert(1)>"
    const snapshot = {
      rows: [{ ...row, model }],
      inFlight: true,
    }
    expect(collect([`data: ${JSON.stringify(snapshot)}\n\n`])).toEqual([withActivity(snapshot)])
  })

  test("parses an empty snapshot", () => {
    expect(collect(['data: {"rows":[],"inFlight":false}\n\n'])).toEqual([
      withActivity({ rows: [], inFlight: false }),
    ])
  })

  test("keeps a newline and data: inside one model field", () => {
    const model = "first line\ndata: still the model"
    const snapshot = {
      rows: [{ ...row, model }],
      inFlight: false,
    }
    const seen = collect([`data: ${JSON.stringify(snapshot)}\n\n`])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.rows[0]?.model).toBe(model)
  })

  test("a heartbeat comment leaves the previous snapshot in place", () => {
    const snapshot = { rows: [row], inFlight: true }
    const seen = collect([
      `data: ${JSON.stringify(snapshot)}\n\n`,
      ": keep-alive\n\n",
    ])
    expect(seen).toEqual([withActivity(snapshot)])
  })

  test("keeps hourly and daily counts and rejects a short hourly series", () => {
    const hourly = Array(24).fill(0)
    hourly[23] = 4
    const daily = [0, 2]
    const snapshot = {
      rows: [],
      inFlight: false,
      hourly,
      hourlyStart: 1_700_000_000_000,
      daily,
      dailyStart: 1_699_000_000_000,
    }
    expect(collect([`data: ${JSON.stringify(snapshot)}\n\n`])).toEqual([snapshot])
    const broken = { ...snapshot, hourly: [1, 2, 3] }
    expect(collect([`data: ${JSON.stringify(broken)}\n\n`])[0]?.hourly).toEqual(Array(24).fill(0))
  })
})
