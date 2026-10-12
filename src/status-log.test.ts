import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { createStatusLog } from "./status-log.ts"

const call = {
  address: "127.0.0.1",
  model: "composer-2.5",
  requestBytes: 40,
}

describe("createStatusLog", () => {
  test("start shows the row in flight and finish stores response bytes", () => {
    const log = createStatusLog()
    const id = log.start(call)
    const started = log.snapshot().rows[0]
    expect(started).toMatchObject({ ...call, responseBytes: 0 })
    expect(started?.at).toEqual(expect.any(Number))
    expect(log.snapshot().inFlight).toBe(true)

    log.finish(id, 90)
    expect(log.snapshot().rows[0]).toMatchObject({ ...call, responseBytes: 90, at: started?.at })
    expect(log.snapshot().inFlight).toBe(false)
    expect(log.snapshot().hourly.reduce((sum, count) => sum + count, 0)).toBe(1)
  })

  test("the 101st finished row drops the oldest finished row", () => {
    const log = createStatusLog()
    for (let i = 0; i < 101; i++) {
      log.record({
        address: String(i),
        model: "composer-2.5",
        requestBytes: i,
        responseBytes: i,
      })
    }
    const snap = log.snapshot()
    expect(snap.rows).toHaveLength(100)
    expect(snap.rows[0]?.address).toBe("100")
    expect(snap.rows[99]?.address).toBe("1")
  })

  test("a model longer than 200 characters is stored as its first 200", () => {
    const log = createStatusLog()
    log.record({
      address: "127.0.0.1",
      model: "a".repeat(250),
      requestBytes: 1,
      responseBytes: 1,
    })
    expect(log.snapshot().rows[0]?.model).toBe("a".repeat(200))
  })

  test("drops a finished row when the oldest row is still in flight", () => {
    const log = createStatusLog()
    log.start({ address: "open", model: "composer-2.5", requestBytes: 1 })
    for (let i = 0; i < 99; i++) {
      log.record({
        address: `done-${i}`,
        model: "composer-2.5",
        requestBytes: 1,
        responseBytes: 1,
      })
    }
    log.record({
      address: "newest",
      model: "composer-2.5",
      requestBytes: 1,
      responseBytes: 1,
    })

    const addresses = log.snapshot().rows.map((row) => row.address)
    expect(addresses).toHaveLength(100)
    expect(addresses[0]).toBe("newest")
    expect(addresses).not.toContain("done-0")
    expect(addresses.at(-1)).toBe("open")
    expect(log.snapshot().inFlight).toBe(true)
  })

  test("finishing an evicted id does not insert a row and still decrements", () => {
    const log = createStatusLog()
    const ids: string[] = []
    for (let i = 0; i < 100; i++) {
      ids.push(log.start({ address: String(i), model: "composer-2.5", requestBytes: 1 }))
    }
    const extra = log.start({ address: "extra", model: "composer-2.5", requestBytes: 1 })

    expect(log.snapshot().rows.map((row) => row.address)).not.toContain("0")
    log.finish(ids[0]!, 50)
    expect(log.snapshot().rows).toHaveLength(100)
    expect(log.snapshot().rows.some((row) => row.address === "0")).toBe(false)
    expect(log.snapshot().inFlight).toBe(true)

    for (const id of ids.slice(1)) log.finish(id, 1)
    log.finish(extra, 1)
    expect(log.snapshot().inFlight).toBe(false)
  })

  test("a second finish for the same id does not decrement twice", () => {
    const log = createStatusLog()
    const first = log.start(call)
    const second = log.start({ ...call, address: "10.0.0.2" })
    log.finish(first, 90)
    log.finish(first, 1)
    expect(log.snapshot().inFlight).toBe(true)
    expect(log.snapshot().rows.find((row) => row.address === call.address)?.responseBytes).toBe(90)

    log.finish(second, 4)
    expect(log.snapshot().inFlight).toBe(false)
  })

  test("snapshot rows have no prompt or response text fields", () => {
    const log = createStatusLog()
    log.record({
      address: "127.0.0.1",
      model: "composer-2.5",
      requestBytes: 8,
      responseBytes: 3,
    })
    const snap = log.snapshot()
    expect(Object.keys(snap).sort()).toEqual([
      "daily",
      "dailyStart",
      "hourly",
      "hourlyStart",
      "inFlight",
      "rows",
    ])
    expect(Object.keys(snap.rows[0] ?? {}).sort()).toEqual([
      "address",
      "at",
      "model",
      "requestBytes",
      "responseBytes",
    ])
  })

  test("onChange receives the snapshot after record, start, and finish", () => {
    const seen: Array<{ inFlight: boolean; length: number; lastResponse: number | undefined }> = []
    const log = createStatusLog({
      onChange(snapshot) {
        seen.push({
          inFlight: snapshot.inFlight,
          length: snapshot.rows.length,
          lastResponse: snapshot.rows[0]?.responseBytes,
        })
      },
    })
    log.record({ ...call, responseBytes: 5 })
    const id = log.start(call)
    log.finish(id, 90)
    expect(seen).toEqual([
      { inFlight: false, length: 1, lastResponse: 5 },
      { inFlight: true, length: 2, lastResponse: 0 },
      { inFlight: false, length: 2, lastResponse: 90 },
    ])
  })
})

describe("status sqlite file", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function dbPath(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "cursor-openai-status-"))
    dirs.push(dir)
    return path.join(dir, "nested", "status.sqlite")
  }

  test("finished rows survive a restart and an unfinished row does not", () => {
    const file = dbPath()
    const first = createStatusLog({ path: file })
    first.record({ ...call, responseBytes: 12 })
    first.start({ ...call, address: "10.0.0.8" })
    first.close()

    const second = createStatusLog({ path: file })
    const snap = second.snapshot()
    expect(snap.rows[0]).toMatchObject({ ...call, responseBytes: 12 })
    expect(snap.rows[0]?.at).toEqual(expect.any(Number))
    expect(snap.inFlight).toBe(false)
    expect(snap.hourly.reduce((sum, count) => sum + count, 0)).toBe(2)
    expect(snap.daily.reduce((sum, count) => sum + count, 0)).toBe(2)
    second.close()
  })

  test("deletes day counts older than 366 days when the log opens", () => {
    const file = dbPath()
    let now = Date.UTC(2025, 9, 10, 12)
    const first = createStatusLog({ path: file, now: () => now, timeZoneOffsetMinutes: 0 })
    first.record({ ...call, address: "stale", responseBytes: 1 })
    now = Date.UTC(2025, 9, 12, 12)
    first.record({ ...call, address: "kept", responseBytes: 1 })
    first.close()

    now = Date.UTC(2026, 9, 11, 15)
    const second = createStatusLog({ path: file, now: () => now, timeZoneOffsetMinutes: 0 })
    const snap = second.snapshot()
    expect(snap.daily[0]).toBe(1)
    expect(snap.daily.reduce((sum, count) => sum + count, 0)).toBe(1)
    second.close()

    const db = new Database(file, { readonly: true })
    const days = db.query<{ bucket: number }, []>("SELECT bucket FROM call_days ORDER BY bucket").all()
    expect(days).toEqual([{ bucket: Date.UTC(2025, 9, 12) }])
    db.close()
  })
})

describe("call charts", () => {
  const day = 86_400_000

  function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0)
  }

  test("buckets the last 24 hours and the year grid in the chosen zone", () => {
    let now = Date.UTC(2025, 0, 1, 12, 0, 0)
    const log = createStatusLog({ now: () => now, timeZoneOffsetMinutes: 0 })
    log.record({ ...call, address: "old", responseBytes: 1 })
    now = Date.UTC(2026, 9, 10, 15, 0, 0)
    log.record({ ...call, address: "yesterday", responseBytes: 1 })
    now = Date.UTC(2026, 9, 11, 14, 10, 0)
    log.record({ ...call, address: "earlier", responseBytes: 1 })
    now = Date.UTC(2026, 9, 11, 15, 30, 0)
    log.record({ ...call, responseBytes: 1 })

    const snap = log.snapshot()
    expect(snap.hourly).toHaveLength(24)
    expect(snap.hourly[23]).toBe(1)
    expect(snap.hourly[22]).toBe(1)
    expect(sum(snap.hourly)).toBe(2)
    expect(snap.hourlyStart).toBe(Date.UTC(2026, 9, 10, 16, 0, 0))
    expect(new Date(snap.dailyStart).getUTCDay()).toBe(0)
    expect(snap.dailyStart + (snap.daily.length - 1) * day).toBe(Date.UTC(2026, 9, 11))
    expect(snap.daily.at(-1)).toBe(2)
    expect(snap.daily.at(-2)).toBe(1)
    expect(sum(snap.daily)).toBe(3)
    expect(snap.rows).toHaveLength(4)
    log.close()
  })

  test("a call before the 24-hour window stays on the year grid", () => {
    let now = Date.UTC(2026, 9, 10, 14, 0, 0)
    const log = createStatusLog({ now: () => now, timeZoneOffsetMinutes: 0 })
    log.record({ ...call, responseBytes: 1 })
    now = Date.UTC(2026, 9, 11, 15, 30, 0)
    const snap = log.snapshot()
    expect(sum(snap.hourly)).toBe(0)
    expect(snap.daily.at(-1)).toBe(0)
    expect(snap.daily.at(-2)).toBe(1)
    log.close()
  })

  test("the chart keeps calls that have fallen off the recent table", () => {
    const now = Date.UTC(2026, 9, 11, 15, 0, 0)
    const log = createStatusLog({ now: () => now, timeZoneOffsetMinutes: 0 })
    for (let i = 0; i < 101; i++) {
      log.record({
        address: String(i),
        model: "composer-2.5",
        requestBytes: 1,
        responseBytes: 1,
      })
    }
    const snap = log.snapshot()
    expect(snap.rows).toHaveLength(100)
    expect(sum(snap.hourly)).toBe(101)
    expect(snap.daily.at(-1)).toBe(101)
    log.close()
  })

  test("finishing a call does not count it twice", () => {
    const now = Date.UTC(2026, 9, 11, 15, 30, 0)
    const log = createStatusLog({ now: () => now, timeZoneOffsetMinutes: 0 })
    const id = log.start(call)
    log.finish(id, 90)
    expect(sum(log.snapshot().hourly)).toBe(1)
    expect(log.snapshot().daily.at(-1)).toBe(1)
    log.close()
  })

  test("uses the host zone when no offset is passed", () => {
    const log = createStatusLog()
    log.record({ ...call, responseBytes: 1 })
    const snap = log.snapshot()
    expect(sum(snap.hourly)).toBe(1)
    expect(sum(snap.daily)).toBe(1)
    const offset = -new Date().getTimezoneOffset()
    expect(new Date(snap.dailyStart + offset * 60_000).getUTCDay()).toBe(0)
    log.close()
  })
})
