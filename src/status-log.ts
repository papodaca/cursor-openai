import { mkdirSync } from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"

const MODEL_LIMIT = 200
const CAP = 100
const HOUR = 3_600_000
const DAY = 86_400_000
const WEEKS = 53
const RETAIN_DAYS = 366

export type StatusRow = {
  at: number
  address: string
  model: string
  requestBytes: number
  responseBytes: number
}

export type StatusSnapshot = {
  rows: StatusRow[]
  inFlight: boolean
  hourly: number[]
  hourlyStart: number
  daily: number[]
  dailyStart: number
}

type StatusCall = {
  address: string
  model: string
  requestBytes: number
}

type Entry = StatusCall & {
  id: string
  responseBytes: number
  open: number
}

function clipModel(model: string): string {
  return model.slice(0, MODEL_LIMIT)
}

function startOfHour(at: number, offsetMin: number): number {
  const shifted = at + offsetMin * 60_000
  return Math.floor(shifted / HOUR) * HOUR - offsetMin * 60_000
}

function startOfDay(at: number, offsetMin: number): number {
  const shifted = at + offsetMin * 60_000
  return Math.floor(shifted / DAY) * DAY - offsetMin * 60_000
}

function activityWindow(at: number, offsetMin: number): {
  hourlyStart: number
  dailyStart: number
  days: number
} {
  const hourlyStart = startOfHour(at, offsetMin) - 23 * HOUR
  const today = startOfDay(at, offsetMin)
  const weekday = new Date(today + offsetMin * 60_000).getUTCDay()
  const days = (WEEKS - 1) * 7 + weekday + 1
  const dailyStart = today - (days - 1) * DAY
  return { hourlyStart, dailyStart, days }
}

function openDatabase(filename: string): Database {
  if (filename !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
  }
  const db = new Database(filename)
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL,
      model TEXT NOT NULL,
      request_bytes INTEGER NOT NULL,
      response_bytes INTEGER NOT NULL,
      open INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS call_hours (
      bucket INTEGER PRIMARY KEY,
      n INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS call_days (
      bucket INTEGER PRIMARY KEY,
      n INTEGER NOT NULL
    );
  `)
  db.run("DELETE FROM requests WHERE open != 0")
  return db
}

export function createStatusLog(options?: {
  onChange?: (snapshot: StatusSnapshot) => void
  /** SQLite file path. Defaults to a private in-memory database. */
  path?: string
  now?: () => number
  /** Minutes east of UTC. Defaults to the host zone at `now`. */
  timeZoneOffsetMinutes?: number
}): {
  record(call: StatusCall & { responseBytes: number }): void
  start(call: StatusCall): string
  finish(id: string, responseBytes: number): void
  snapshot(): StatusSnapshot
  close(): void
} {
  const db = openDatabase(options?.path ?? ":memory:")
  const insert = db.query<unknown, [string, string, string, number, number, number, number]>(
    `INSERT INTO requests (id, address, model, request_bytes, response_bytes, open, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const finishRow = db.query<{ changes: number }, [number, string]>(
    `UPDATE requests SET response_bytes = ?, open = 0 WHERE id = ?`,
  )
  const countRows = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM requests`)
  const oldestFinished = db.query<{ seq: number }, []>(
    `SELECT seq FROM requests WHERE open = 0 ORDER BY seq ASC LIMIT 1`,
  )
  const oldest = db.query<{ seq: number }, []>(
    `SELECT seq FROM requests ORDER BY seq ASC LIMIT 1`,
  )
  const deleteSeq = db.query(`DELETE FROM requests WHERE seq = ?`)
  const selectRows = db.query<
    { at: number; address: string; model: string; request_bytes: number; response_bytes: number },
    []
  >(
    `SELECT at, address, model, request_bytes, response_bytes FROM requests ORDER BY seq DESC`,
  )
  const bumpHour = db.query(
    `INSERT INTO call_hours (bucket, n) VALUES (?, 1)
     ON CONFLICT(bucket) DO UPDATE SET n = n + 1`,
  )
  const bumpDay = db.query(
    `INSERT INTO call_days (bucket, n) VALUES (?, 1)
     ON CONFLICT(bucket) DO UPDATE SET n = n + 1`,
  )
  const pruneHours = db.query(`DELETE FROM call_hours WHERE bucket < ?`)
  const pruneDays = db.query(`DELETE FROM call_days WHERE bucket < ?`)
  const selectHours = db.query<{ bucket: number; n: number }, [number]>(
    `SELECT bucket, n FROM call_hours WHERE bucket >= ? ORDER BY bucket ASC`,
  )
  const selectDays = db.query<{ bucket: number; n: number }, [number]>(
    `SELECT bucket, n FROM call_days WHERE bucket >= ? ORDER BY bucket ASC`,
  )

  const openIds = new Set<string>()
  let closed = false

  function clock(): number {
    return options?.now?.() ?? Date.now()
  }

  function zoneOffset(at: number): number {
    if (options?.timeZoneOffsetMinutes !== undefined) return options.timeZoneOffsetMinutes
    return -new Date(at).getTimezoneOffset()
  }

  function tally(rows: { bucket: number; n: number }[]): Map<number, number> {
    const map = new Map<number, number>()
    for (const row of rows) map.set(row.bucket, Number(row.n))
    return map
  }

  function activity(at: number): Pick<StatusSnapshot, "hourly" | "hourlyStart" | "daily" | "dailyStart"> {
    const window = activityWindow(at, zoneOffset(at))
    const hours = tally(selectHours.all(window.hourlyStart))
    const days = tally(selectDays.all(window.dailyStart))
    const hourly: number[] = []
    for (let i = 0; i < 24; i++) hourly.push(hours.get(window.hourlyStart + i * HOUR) ?? 0)
    const daily: number[] = []
    for (let i = 0; i < window.days; i++) daily.push(days.get(window.dailyStart + i * DAY) ?? 0)
    return {
      hourly,
      hourlyStart: window.hourlyStart,
      daily,
      dailyStart: window.dailyStart,
    }
  }

  function snapshot(): StatusSnapshot {
    return {
      rows: selectRows.all().map((row) => ({
        at: Number(row.at),
        address: row.address,
        model: row.model,
        requestBytes: row.request_bytes,
        responseBytes: row.response_bytes,
      })),
      inFlight: openIds.size > 0,
      ...activity(clock()),
    }
  }

  function emit(): void {
    options?.onChange?.(snapshot())
  }

  function evictOne(): void {
    const target = oldestFinished.get() ?? oldest.get()
    if (target) deleteSeq.run(target.seq)
  }

  function prune(at: number): void {
    const offset = zoneOffset(at)
    const window = activityWindow(at, offset)
    const retainStart = startOfDay(at, offset) - (RETAIN_DAYS - 1) * DAY
    pruneHours.run(window.hourlyStart)
    pruneDays.run(Math.max(window.dailyStart, retainStart))
  }

  const writeEntry = db.transaction((entry: Entry, at: number) => {
    const count = countRows.get()?.n ?? 0
    if (count >= CAP) evictOne()
    insert.run(
      entry.id,
      entry.address,
      entry.model,
      entry.requestBytes,
      entry.responseBytes,
      entry.open,
      at,
    )
    const offset = zoneOffset(at)
    bumpHour.run(startOfHour(at, offset))
    bumpDay.run(startOfDay(at, offset))
    prune(at)
  })

  prune(clock())
  const pruneTimer = setInterval(() => {
    if (!closed) prune(clock())
  }, DAY)
  pruneTimer.unref?.()

  return {
    snapshot,
    record(call) {
      writeEntry(
        {
          id: crypto.randomUUID(),
          address: call.address,
          model: clipModel(call.model),
          requestBytes: call.requestBytes,
          responseBytes: call.responseBytes,
          open: 0,
        },
        clock(),
      )
      emit()
    },
    start(call) {
      const id = crypto.randomUUID()
      openIds.add(id)
      writeEntry(
        {
          id,
          address: call.address,
          model: clipModel(call.model),
          requestBytes: call.requestBytes,
          responseBytes: 0,
          open: 1,
        },
        clock(),
      )
      emit()
      return id
    },
    finish(id, responseBytes) {
      if (!openIds.delete(id)) return
      const updated = finishRow.run(responseBytes, id)
      if (updated.changes > 0 || openIds.size === 0) emit()
    },
    close() {
      if (closed) return
      closed = true
      clearInterval(pruneTimer)
      db.close()
    },
  }
}
