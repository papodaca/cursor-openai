export function levels(counts) {
  const positive = counts.filter((count) => count > 0)
  if (positive.length === 0) return counts.map(() => 0)
  const max = Math.max(...positive)
  const min = Math.min(...positive)
  if (min === max) return counts.map((count) => (count > 0 ? 1 : 0))
  return counts.map((count) => {
    if (count <= 0) return 0
    const ratio = (count - min) / (max - min)
    if (ratio >= 1) return 4
    if (ratio >= 0.66) return 3
    if (ratio >= 0.33) return 2
    return 1
  })
}

const CHART = { w: 640, h: 180, padL: 40, padR: 16, padT: 16, padB: 28 }

export function chartGeometry(hourly, size) {
  const chart = {
    ...CHART,
    w: size?.w ?? CHART.w,
    h: size?.h ?? CHART.h,
  }
  const max = Math.max(1, ...hourly, 0)
  const innerW = chart.w - chart.padL - chart.padR
  const innerH = chart.h - chart.padT - chart.padB
  const coords = hourly.map((value, i) => {
    const x = chart.padL + (hourly.length <= 1 ? innerW / 2 : (i / (hourly.length - 1)) * innerW)
    const y = chart.padT + innerH - (value / max) * innerH
    return { x, y, value }
  })
  return { ...chart, max, innerH, coords }
}
