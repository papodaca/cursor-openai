function rowFrom(value) {
  const row = value && typeof value === "object" ? value : {}
  return {
    at: typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0,
    address: typeof row.address === "string" ? row.address : "",
    model: typeof row.model === "string" ? row.model : "",
    requestBytes: typeof row.requestBytes === "number" ? row.requestBytes : 0,
    responseBytes: typeof row.responseBytes === "number" ? row.responseBytes : 0,
  }
}

function countSeries(value, exactLength) {
  const empty = exactLength === undefined ? [] : Array(exactLength).fill(0)
  if (!Array.isArray(value)) return empty
  const nums = value.map((n) =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0,
  )
  if (exactLength !== undefined && nums.length !== exactLength) return empty
  return nums
}

function unixMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function snapshotFromBlock(block) {
  const data = []
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart())
  }
  if (data.length === 0) return null
  const parsed = JSON.parse(data.join("\n"))
  const rows = Array.isArray(parsed.rows) ? parsed.rows.map((row) => rowFrom(row)) : []
  return {
    rows,
    inFlight: parsed.inFlight === true,
    hourly: countSeries(parsed.hourly, 24),
    hourlyStart: unixMs(parsed.hourlyStart),
    daily: countSeries(parsed.daily),
    dailyStart: unixMs(parsed.dailyStart),
  }
}

export function createSnapshotParser(onSnapshot) {
  let buffered = ""
  const decoder = new TextDecoder()
  return {
    push(bytes) {
      buffered += decoder.decode(bytes, { stream: true })
      for (;;) {
        const split = buffered.indexOf("\n\n")
        if (split === -1) break
        const block = buffered.slice(0, split)
        buffered = buffered.slice(split + 2)
        const snapshot = snapshotFromBlock(block)
        if (snapshot) onSnapshot(snapshot)
      }
    },
  }
}
