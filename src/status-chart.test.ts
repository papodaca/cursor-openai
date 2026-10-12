import { describe, expect, test } from "bun:test"
import { chartGeometry, levels } from "../public/status-chart.js"

describe("status chart", () => {
  test("a flat series stays on the baseline and the peak uses the top", () => {
    const flat = chartGeometry(Array(24).fill(0))
    expect(flat.coords.every((point) => point.y === flat.padT + flat.innerH)).toBe(true)
    const peaked = chartGeometry([0, 4])
    expect(peaked.coords[1]?.y).toBe(peaked.padT)
    expect(peaked.coords[0]?.y).toBeGreaterThan(peaked.coords[1]?.y ?? 0)
  })

  test("equal counts share the lightest shade and a spike is darker", () => {
    expect(levels([0, 0, 0])).toEqual([0, 0, 0])
    expect(levels([1, 1, 1])).toEqual([1, 1, 1])
    const spread = levels([1, 1, 1, 9])
    expect(spread[0]).toBe(1)
    expect(spread[3]).toBe(4)
  })
})
