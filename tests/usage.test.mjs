import { test } from "node:test"
import assert from "node:assert/strict"

import {
  DAILY_RESET_AMOUNT,
  nextBeijingMidnight,
  usageFromPoints,
  tasksSummary,
} from "../src/usage.mjs"

const FULL = {
  available: 26434,
  daily: 1434,
  dailyKnown: true,
  permanent: 25000,
  permanentKnown: true,
}

test("每日赠送参与路由（有 used），永久积分是 aside", () => {
  const u = usageFromPoints(FULL)
  const daily = u.windows.find((w) => w.name === "每日赠送")
  const permanent = u.windows.find((w) => w.name === "永久积分")

  assert.ok(typeof daily.used === "number", "每日赠送必须有 used（路由输入）")
  assert.equal(permanent.aside, true)
  assert.equal(permanent.used, undefined, "aside 窗口不该有 used")
})

test("每日赠送的 used 按 DAILY_RESET_AMOUNT 算百分比", () => {
  const u = usageFromPoints({ ...FULL, daily: DAILY_RESET_AMOUNT / 2 })
  const daily = u.windows.find((w) => w.name === "每日赠送")
  assert.equal(daily.used, 50)
})

test("每日赠送用光时 used = 100（不是 0！漏了会把耗尽的号顶到队首）", () => {
  const u = usageFromPoints({ ...FULL, daily: 0 })
  const daily = u.windows.find((w) => w.name === "每日赠送")
  assert.equal(daily.used, 100)
})

test("每日赠送满额时 used = 0", () => {
  const u = usageFromPoints({ ...FULL, daily: DAILY_RESET_AMOUNT })
  const daily = u.windows.find((w) => w.name === "每日赠送")
  assert.equal(daily.used, 0)
})

test("daily 未知时**不产生**每日赠送窗口（未知 ≠ 0）", () => {
  const u = usageFromPoints({ ...FULL, dailyKnown: false })
  assert.equal(u.windows.find((w) => w.name === "每日赠送"), undefined)
})

test("permanent 未知时不产生永久积分窗口", () => {
  const u = usageFromPoints({ ...FULL, permanentKnown: false })
  assert.equal(u.windows.find((w) => w.name === "永久积分"), undefined)
})

test("每日赠送带 resetsAt/runsOutAt（到期前用完的输入）", () => {
  const now = Date.UTC(2026, 10, 17, 10, 0, 0) // 北京时间 18:00
  const u = usageFromPoints(FULL, { now })
  const daily = u.windows.find((w) => w.name === "每日赠送")
  assert.equal(daily.resetsAt, nextBeijingMidnight(now))
  assert.equal(daily.runsOutAt, nextBeijingMidnight(now))
  assert.equal(daily.runsOut, 1434)
  assert.equal(daily.span, 86400)
})

test("nextBeijingMidnight 落在北京时间次日 00:00", () => {
  // 北京时间 2026-11-17 23:30 = UTC 15:30
  const now = Date.UTC(2026, 10, 17, 15, 30, 0)
  const next = nextBeijingMidnight(now)
  const beijing = new Date(next + 8 * 3600_000)
  assert.equal(beijing.getUTCHours(), 0)
  assert.equal(beijing.getUTCMinutes(), 0)
  assert.equal(beijing.getUTCDate(), 18)
})

test("nextBeijingMidnight 在北京时间 00:00 整点时返回下一个午夜（不是当天）", () => {
  const now = Date.UTC(2026, 10, 17, 16, 0, 0) // 北京 2026-11-18 00:00
  const next = nextBeijingMidnight(now)
  assert.equal(next - now, 86400_000)
})

test("可用总额即使有值也是 aside（算不出百分比）", () => {
  const u = usageFromPoints(FULL)
  const avail = u.windows.find((w) => w.name === "可用总额")
  assert.equal(avail.aside, true)
  assert.equal(avail.used, undefined)
})

test("三个窗口都有 display（卡片要能读）", () => {
  const u = usageFromPoints(FULL)
  for (const w of u.windows) {
    assert.ok(typeof w.display === "string" && w.display.length > 0, `${w.name} 缺 display`)
  }
})

test("tasksSummary 汇总完成数与积分", () => {
  const s = tasksSummary({ first_message: true, pick_skill: true })
  assert.equal(s.done, 2)
  assert.equal(s.total, 8)
  assert.equal(s.points, 1500)
  assert.match(s.text, /2\/8/)
})

test("tasksSummary 空 map 也不炸", () => {
  const s = tasksSummary({})
  assert.equal(s.done, 0)
  const s2 = tasksSummary(null)
  assert.equal(s2.done, 0)
})
