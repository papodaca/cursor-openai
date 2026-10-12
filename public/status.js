import { chartGeometry, levels } from "./status-chart.js"
import { createSnapshotParser } from "./status-snapshot.js"

const form = document.querySelector("#key-form")
const keyInput = document.querySelector("#proxy-key")
const bar = document.querySelector("#bar")
const linkLabel = document.querySelector("#link-label")
const busyLabel = document.querySelector("#busy-label")
const errorEl = document.querySelector("#error")
const tbody = document.querySelector("#rows")
const activity = document.querySelector("#activity")
const hourlySvg = document.querySelector("#hourly")
const hourlyTip = document.querySelector("#hourly-tip")
const hourlyTotal = document.querySelector("#hourly-total")
const dailyTotal = document.querySelector("#daily-total")
const monthsEl = document.querySelector("#months")
const gridEl = document.querySelector("#grid")
const svgNs = "http://www.w3.org/2000/svg"

let key = ""
let attempt = null
let closed = false
let retryWait = 1000
let retryTimer = 0

function setLamps(live, busy) {
  bar.dataset.live = live
  bar.dataset.busy = busy ? "1" : "0"
  linkLabel.textContent = live === "connected" ? "Connected" : live === "disconnected" ? "Disconnected" : "Not connected"
  busyLabel.textContent = busy ? "Busy" : "Idle"
  form.hidden = live === "connected"
}

function countLabel(total) {
  return total === 1 ? "· 1 call" : `· ${total} calls`
}

function svgEl(name, attrs) {
  const node = document.createElementNS(svgNs, name)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  return node
}

function hideHourTip() {
  hourlyTip.hidden = true
  hourlyTip.replaceChildren()
}

function showHourTip(dot, date, count) {
  const when = document.createElement("div")
  when.textContent = date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  const calls = document.createElement("div")
  calls.textContent = count === 1 ? "1 call" : `${count} calls`
  hourlyTip.replaceChildren(when, calls)
  const wrap = hourlySvg.parentElement
  const wrapBox = wrap.getBoundingClientRect()
  const box = dot.getBoundingClientRect()
  let x = box.left + box.width / 2 - wrapBox.left
  const y = box.top - wrapBox.top
  hourlyTip.hidden = false
  hourlyTip.style.left = `${x}px`
  hourlyTip.style.top = `${y}px`
  const tipBox = hourlyTip.getBoundingClientRect()
  if (tipBox.left < wrapBox.left) x += wrapBox.left - tipBox.left
  else if (tipBox.right > wrapBox.right) x -= tipBox.right - wrapBox.right
  hourlyTip.style.left = `${x}px`
}

let hourFrame = null
let hourKey = ""

function drawHourly(hourly, hourlyStart) {
  hourFrame = { hourly, hourlyStart }
  const width = Math.max(280, Math.round(hourlySvg.clientWidth || 640))
  const height = Math.max(120, Math.round(hourlySvg.clientHeight || 148))
  const key = `${width}x${height}:${hourlyStart}:${hourly.join(",")}`
  if (key === hourKey) return
  hourKey = key
  hideHourTip()
  if (hourly.length === 0) {
    hourlySvg.replaceChildren()
    return
  }
  const geo = chartGeometry(hourly, { w: width, h: height })
  const baseline = geo.padT + geo.innerH
  hourlySvg.replaceChildren()
  hourlySvg.setAttribute("viewBox", `0 0 ${geo.w} ${geo.h}`)
  const coords = geo.coords
  const line = coords.map((point) => `${point.x},${point.y}`).join(" ")
  const area = `${coords[0].x},${baseline} ${line} ${coords[coords.length - 1].x},${baseline}`
  hourlySvg.append(svgEl("polygon", { class: "area", points: area }))
  hourlySvg.append(svgEl("line", {
    class: "axis",
    x1: geo.padL,
    y1: baseline,
    x2: geo.w - geo.padR,
    y2: baseline,
  }))
  hourlySvg.append(svgEl("polyline", { class: "line", points: line }))
  const maxLabel = svgEl("text", { x: geo.padL - 6, y: geo.padT + 4, "text-anchor": "end" })
  maxLabel.textContent = String(geo.max)
  const zeroLabel = svgEl("text", { x: geo.padL - 6, y: baseline, "text-anchor": "end" })
  zeroLabel.textContent = "0"
  hourlySvg.append(maxLabel, zeroLabel)
  for (const index of [0, 12, 23]) {
    const point = coords[index]
    if (!point) continue
    const label = svgEl("text", {
      x: point.x,
      y: geo.h - 8,
      "text-anchor": index === 0 ? "start" : index === 23 ? "end" : "middle",
    })
    label.textContent = new Date(hourlyStart + index * 3_600_000).toLocaleTimeString([], { hour: "numeric" })
    hourlySvg.append(label)
  }
  coords.forEach((point, index) => {
    const at = new Date(hourlyStart + index * 3_600_000)
    const dot = svgEl("circle", {
      class: "dot",
      cx: point.x,
      cy: point.y,
      r: point.value > 0 ? 3.5 : 2.5,
      "data-index": index,
      "data-value": point.value,
    })
    const hit = svgEl("circle", {
      class: "hit",
      cx: point.x,
      cy: point.y,
      r: 12,
    })
    hit.addEventListener("pointerenter", () => showHourTip(hit, at, point.value))
    hit.addEventListener("pointerleave", hideHourTip)
    hourlySvg.append(dot, hit)
  })
}

function drawGrid(daily, dailyStart) {
  const shades = levels(daily)
  const cols = Math.ceil(daily.length / 7)
  const colStride = 14
  monthsEl.replaceChildren()
  monthsEl.style.width = `${Math.max(0, cols * colStride - 3)}px`
  gridEl.replaceChildren()
  let lastMonthCol = -3
  for (let col = 0; col < cols; col++) {
    let month = ""
    for (let row = 0; row < 7; row++) {
      const index = col * 7 + row
      if (index >= daily.length) break
      const date = new Date(dailyStart + index * 86_400_000)
      if (date.getDate() === 1) month = date.toLocaleString([], { month: "short" })
    }
    if (month && col - lastMonthCol >= 3) {
      const span = document.createElement("span")
      span.textContent = month
      span.style.left = `${col * colStride}px`
      monthsEl.append(span)
      lastMonthCol = col
    }
  }
  daily.forEach((count, index) => {
    const cell = document.createElement("div")
    cell.className = "cell"
    cell.dataset.level = String(shades[index])
    const date = new Date(dailyStart + index * 86_400_000)
    const when = date.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    cell.title = count === 1 ? `${when}: 1 call` : `${when}: ${count} calls`
    gridEl.append(cell)
  })
  const total = daily.reduce((sum, count) => sum + count, 0)
  gridEl.setAttribute("aria-label", total === 1 ? "1 call in the last year" : `${total} calls in the last year`)
}

export function renderStatus(snapshot) {
  if (bar.dataset.live === "connected") setLamps("connected", snapshot.inFlight)
  activity.hidden = false
  const hourTotal = snapshot.hourly.reduce((sum, count) => sum + count, 0)
  const dayTotal = snapshot.daily.reduce((sum, count) => sum + count, 0)
  hourlyTotal.textContent = countLabel(hourTotal)
  dailyTotal.textContent = countLabel(dayTotal)
  drawHourly(snapshot.hourly, snapshot.hourlyStart)
  drawGrid(snapshot.daily, snapshot.dailyStart)
  renderRows(snapshot.rows, true)
}

let primedRows = false
let previousRows = []

function sameCall(a, b) {
  return a.at === b.at
}

function formatAt(at) {
  if (!at) return "—"
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })
}

function freshRowIndexes(prev, next) {
  const fresh = new Set()
  let cursor = 0
  for (let index = 0; index < next.length; index++) {
    let found = -1
    for (let prevIndex = cursor; prevIndex < prev.length; prevIndex++) {
      if (sameCall(prev[prevIndex], next[index])) {
        found = prevIndex
        break
      }
    }
    if (found === -1) fresh.add(index)
    else cursor = found + 1
  }
  return fresh
}

function renderRows(rows, fromStream) {
  const fresh = fromStream && primedRows ? freshRowIndexes(previousRows, rows) : new Set()
  if (fromStream) {
    primedRows = true
    previousRows = rows.map((row) => ({ ...row }))
  }
  tbody.replaceChildren()
  if (rows.length === 0) {
    const tr = document.createElement("tr")
    const cell = document.createElement("td")
    cell.colSpan = 5
    cell.className = "empty"
    cell.textContent = "No chats yet."
    tr.append(cell)
    tbody.append(tr)
    return
  }
  rows.forEach((row, index) => {
    const tr = document.createElement("tr")
    if (fresh.has(index)) tr.className = "arrived"
    for (const value of [
      formatAt(row.at),
      row.address,
      row.model,
      String(row.requestBytes),
      String(row.responseBytes),
    ]) {
      const cell = document.createElement("td")
      cell.textContent = value
      tr.append(cell)
    }
    tbody.append(tr)
  })
}

function showError(message) {
  errorEl.textContent = message
  errorEl.hidden = message === ""
}

function markDisconnected(generation, activeKey) {
  setLamps("disconnected", false)
  scheduleRetry(generation, activeKey)
}

function scheduleRetry(generation, activeKey) {
  if (closed || generation.controller.signal.aborted) return
  if (key !== activeKey) return
  const wait = retryWait
  retryWait = Math.min(retryWait * 2, 8000)
  retryTimer = setTimeout(() => {
    if (closed || key !== activeKey || generation.controller.signal.aborted) return
    connect()
  }, wait)
}

function connect() {
  if (attempt) attempt.controller.abort()
  clearTimeout(retryTimer)
  const controller = new AbortController()
  const activeKey = key
  const generation = { controller }
  attempt = generation
  fetch("/status/events", {
    headers: { Authorization: "Bearer " + activeKey },
    signal: controller.signal,
  }).then(async (res) => {
    if (controller.signal.aborted || closed) return
    if (res.status === 401) {
      setLamps("", false)
      const body = await res.json().catch(() => null)
      const message = body && body.error && body.error.message ? body.error.message : "Unauthorized"
      showError(message)
      return
    }
    if (!res.ok || !res.body) {
      markDisconnected(generation, activeKey)
      return
    }
    showError("")
    setLamps("connected", false)
    retryWait = 1000
    const parser = createSnapshotParser((snapshot) => {
      renderStatus(snapshot)
    })
    const reader = res.body.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      parser.push(chunk.value)
    }
    if (controller.signal.aborted || closed) return
    markDisconnected(generation, activeKey)
  }).catch(() => {
    if (controller.signal.aborted || closed) return
    markDisconnected(generation, activeKey)
  })
}

form.addEventListener("submit", (event) => {
  event.preventDefault()
  key = keyInput.value
  retryWait = 1000
  connect()
})

window.addEventListener("pagehide", () => {
  closed = true
  if (attempt) attempt.controller.abort()
  clearTimeout(retryTimer)
})

new ResizeObserver(() => {
  if (!hourFrame) return
  drawHourly(hourFrame.hourly, hourFrame.hourlyStart)
}).observe(hourlySvg)

renderRows([])

const urlKey = new URLSearchParams(window.location.search).get("api_key")
if (urlKey) {
  key = urlKey
  keyInput.value = urlKey
  connect()
}
