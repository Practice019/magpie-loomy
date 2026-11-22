// speed.test.mjs —— 速率分档（T-62）：**只从 magpie 自己记录的请求**算，不自己测速。
//
// # 这一集在钉什么
//
//   · 单次速率 = out / (flow_ms/1000)，`out>0 && flow_ms>0` 是**数学必要条件**
//     （分母为零 / 分子为零算不出速率）；`status` 非 2xx 的请求（实测有 499 取消）
//     同样不进速度表。
//   · A = 每个 (账号, 模型) 的 **sum(out) / sum(秒)**，不是「每次速率再平均」
//     （后者会让「一大段慢 + 一小段快」被平均掉）。
//   · B = 同一模型下所有账号 A 的**中位数**（抗单个快号/慢号拉偏）。
//   · 判定看**最近一次**，不是平均 —— 突发限速只有最近一次能抓到（用例 8）。
//   · 超过 STALE_DAYS 没有新记录 ⇒ unknown（自动回到候选，不会被旧结论钉死）。
//
// ⚠ 本集是**纯函数**：一个文件不读、一个请求不发。真实数据源见
//   `POST /api/speed/refresh`（server.mjs）。

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  SLOW_RATIO,
  STALE_DAYS,
  MIN_FAST,
  B_MAX,
  speedOfRow,
  median,
  accountAverage,
  classify,
  buildSpeedTable,
} from "../src/speed.mjs"

const NOW = Date.parse("2026-11-22T16:00:00+08:00")
const DAY = 86_400_000
const at = (ms) => new Date(ms).toISOString()

/** 一条 usage/requests 行（形状来自实测，见 server.mjs 的注释）。 */
const sample = (over = {}) => ({
  provider: "loomy",
  providerAccount: "u1",
  model: "deepseek-v4-flash-1017",
  status: 200,
  ...over,
})

// ── 一、单次速率 ────────────────────────────────────────────────────────

test("speedOfRow：实测样本 out=2067 / flow_ms=17118 ≈ 120.75 tok/s", () => {
  const s = speedOfRow(sample({ out: 2067, flow_ms: 17118 }))
  // 2067 / 17.118 = 120.751…（手算：17.118×120 = 2054.16，余 12.84 ⇒ 0.75）
  assert.ok(Math.abs(s - 120.75) < 0.01, `应≈120.75，实际 ${s}`)
})

test("speedOfRow：out=0 → null；flow_ms=0 → null（分母为零算不出速率）", () => {
  assert.equal(speedOfRow(sample({ out: 0, flow_ms: 17118 })), null)
  assert.equal(speedOfRow(sample({ out: 2067, flow_ms: 0 })), null)
  // 字段缺失同样是「算不出」，不是 0
  assert.equal(speedOfRow(sample({ out: 100 })), null)
  assert.equal(speedOfRow(sample({ flow_ms: 1000 })), null)
  assert.equal(speedOfRow(null), null)
})

// ── 二、中位数 ──────────────────────────────────────────────────────────

test("median：奇数取中间、偶数取中间两个平均、空数组 → null", () => {
  assert.equal(median([300, 50, 100]), 100, "奇数：排序后取中间")
  assert.equal(median([100, 50]), 75, "偶数：中间两个平均")
  assert.equal(median([]), null, "空数组没有中位数")
  assert.equal(median([50]), 50, "单元素就是它自己")
})

// ── 三、A：per (账号, 模型) ─────────────────────────────────────────────

test("accountAverage：sum(out)/sum(秒)，不是「每次速率再平均」", () => {
  const rows = [
    sample({ out: 100, flow_ms: 1000 }),
    sample({ out: 300, flow_ms: 1000 }),
  ]
  assert.equal(accountAverage(rows), 200, "400 tok / 2.0 s = 200 tok/s")

  // 判别性用例：两次速率 100 与 25 ⇒ sum/sum = 40，而「平均值再平均」会给出 62.5
  const skewed = [
    sample({ out: 100, flow_ms: 1000 }),
    sample({ out: 100, flow_ms: 4000 }),
  ]
  assert.equal(accountAverage(skewed), 40, "200 tok / 5.0 s = 40 tok/s（不是 62.5）")
})

test("accountAverage：out=0 / flow_ms=0 / 非 2xx 的行不参与分子分母", () => {
  const rows = [
    sample({ out: 100, flow_ms: 1000 }),
    sample({ out: 0, flow_ms: 9000 }),
    sample({ out: 900, flow_ms: 0 }),
    sample({ out: 500, flow_ms: 1000, status: 499 }),
  ]
  assert.equal(accountAverage(rows), 100, "只有第一行可算：100 tok / 1.0 s")
  assert.equal(accountAverage([]), null, "没有可用行 ⇒ null，不是 0")
})

// ── 四、classify：最近一次 + 新鲜度 ─────────────────────────────────────

test("classify：最近一次是 4 天前 → unknown（超过 STALE_DAYS 自动回到候选）", () => {
  const last = { lastSpeed: 200, lastAt: NOW - 4 * DAY }
  assert.equal(classify(last, 100, NOW), "unknown")
  // 3 天内仍然是有效结论（边界：2.9 天）
  assert.equal(classify({ lastSpeed: 200, lastAt: NOW - 2.9 * DAY }, 100, NOW), "normal")
})

test("classify：b 为 null → unknown（这个模型没有中位数，无法分档）", () => {
  assert.equal(classify({ lastSpeed: 200, lastAt: NOW - 1000 }, null, NOW), "unknown")
  assert.equal(classify(null, 100, NOW), "unknown", "没有最近记录 ⇒ unknown")
})

test("classify：0.6b → slow；0.8b → normal（阈值 SLOW_RATIO = 0.7）", () => {
  const b = 100
  assert.equal(classify({ lastSpeed: 60, lastAt: NOW - 1000 }, b, NOW), "slow")
  assert.equal(classify({ lastSpeed: 80, lastAt: NOW - 1000 }, b, NOW), "normal")
  // 恰好在阈值上：>= b×0.7 就算正常（70 不判慢）
  assert.equal(classify({ lastSpeed: 70, lastAt: NOW - 1000 }, b, NOW), "normal")
})

test("classify：直接吃原始 row 也行（out/flow_ms/t 现算）", () => {
  const row = { out: 60, flow_ms: 1000, t: at(NOW - 1000) }
  assert.equal(classify(row, 100, NOW), "slow")
})

// ── 五、B 与整表 ────────────────────────────────────────────────────────

test("buildSpeedTable：同模型 3 个账号 A=[50,100,300] ⇒ B 取中位数 100", () => {
  const rows = [
    sample({ providerAccount: "a", model: "m", out: 50, flow_ms: 1000, t: at(NOW - 60_000) }),
    sample({ providerAccount: "b", model: "m", out: 100, flow_ms: 1000, t: at(NOW - 60_000) }),
    sample({ providerAccount: "c", model: "m", out: 300, flow_ms: 1000, t: at(NOW - 60_000) }),
  ]
  const table = buildSpeedTable(rows, { now: NOW })
  assert.equal(table.b.m, 100, "B 是账号 A 的中位数，不是平均（180）")
  assert.equal(table.updatedAt, NOW)
  assert.deepEqual(Object.keys(table.accounts).sort(), ["m|a", "m|b", "m|c"])
  assert.equal(table.accounts["m|c"].avgSpeed, 300)
  assert.equal(table.accounts["m|c"].lastSpeed, 300)
  assert.equal(table.accounts["m|c"].calls, 1)
  assert.equal(table.accounts["m|c"].verdict, "normal")
})

test("核心：20 次 130 + 最后 1 次 25 ⇒ lastSpeed=25 判 slow（平均抓不到突发限速）", () => {
  const rows = []
  // 前 20 次都是 130 tok/s（每次 130 tok / 1 s），时间由早到晚
  for (let i = 0; i < 20; i++) {
    rows.push(sample({
      providerAccount: "slowpoke",
      model: "m",
      out: 130,
      flow_ms: 1000,
      t: at(NOW - (21 - i) * 60_000),
    }))
  }
  // 最近一次突发掉到 25 tok/s
  rows.push(sample({
    providerAccount: "slowpoke",
    model: "m",
    out: 25,
    flow_ms: 1000,
    t: at(NOW - 30_000),
  }))
  // 另外两个正常号把这个模型的 B 拉到 ~130
  rows.push(sample({ providerAccount: "fast1", model: "m", out: 130, flow_ms: 1000, t: at(NOW - 50_000) }))
  rows.push(sample({ providerAccount: "fast2", model: "m", out: 130, flow_ms: 1000, t: at(NOW - 50_000) }))

  const table = buildSpeedTable(rows, { now: NOW })
  const entry = table.accounts["m|slowpoke"]
  assert.equal(entry.calls, 21)
  assert.equal(entry.lastSpeed, 25, "最近一次是 25 tok/s")
  assert.equal(entry.verdict, "slow", "最近一次 < b×0.7 ⇒ slow")
  // 这就是为什么要看最近一次：它的平均（≈125）落在正常区间，判不出来
  assert.ok(entry.avgSpeed > table.b.m * SLOW_RATIO, `平均 ${entry.avgSpeed} 会被判成正常（B=${table.b.m}）`)
})

test("buildSpeedTable：常量与口径（SLOW_RATIO 0.7 / STALE_DAYS 3 / MIN_FAST 1）", () => {
  assert.equal(SLOW_RATIO, 0.7)
  assert.equal(STALE_DAYS, 3)
  assert.equal(MIN_FAST, 1)
})

// ── 六、B_MAX：B 被 `flow_ms≈1ms` 的行污染时不许当基准 ────────────────────

/**
 * 造一个「中位数 = target」的模型：3 个号，A = [target×0.9, target, target×1.1]。
 * 每号一条行 ⇒ A 就等于该行的单次速率。
 */
function rowsWithMedian(account, model, target) {
  return [0.9, 1, 1.1].map((k, i) =>
    sample({ providerAccount: `${account}${i}`, model, out: 100 * k, flow_ms: 1000 / target * 100, t: at(NOW - 60_000) }),
  )
}

test("B_MAX 边界包含：中位数恰为 1000 ⇒ 仍参与判定（按 1000 判）", () => {
  assert.equal(B_MAX, 1000, "真实解码峰值 300–500 tok/s：1000 是「物理不可能」的分界")
  const table = buildSpeedTable(rowsWithMedian("acc", "m", 1000), { now: NOW })
  assert.equal(table.b.m, 1000, "恰好等于上限仍是有效基准")
  // 1000×0.7 = 700：900 > 700 ⇒ normal
  assert.equal(table.accounts["m|acc0"].verdict, "normal")
  assert.equal(table.accounts["m|acc1"].verdict, "normal")
  assert.equal(table.accounts["m|acc2"].verdict, "normal")
})

test("B_MAX：中位数 1001（略高于上限）⇒ 视为无参考，全员 unknown", () => {
  const table = buildSpeedTable(rowsWithMedian("acc", "m", 1001), { now: NOW })
  assert.equal(table.b.m, undefined, "越过 1000 就不许当基准")
  assert.equal(Object.values(table.accounts).every((e) => e.verdict === "unknown"), true)
})

test("buildSpeedTable：没有可用行 / 没有账号的模型不出现在 b 里", () => {
  const rows = [
    sample({ providerAccount: "a", model: "m", out: 0, flow_ms: 1000, t: at(NOW - 1000) }),
    sample({ providerAccount: "b", model: "", out: 100, flow_ms: 1000, t: at(NOW - 1000) }),
  ]
  const table = buildSpeedTable(rows, { now: NOW })
  assert.deepEqual(table.b, {}, "算不出 A 的账号不参与中位数（否则 B 会被 0 拉低）")
  assert.equal(table.accounts["m|a"].avgSpeed, null)
  assert.equal(table.accounts["m|a"].verdict, "unknown")
})
