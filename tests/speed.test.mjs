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
  MIN_FLOW_MS,
  MAX_ROW_SPEED,
  speedOfRow,
  usableRow,
  usableB,
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

// ── 六、B_MAX：第二道保险（第一道是行级过滤 usableRow） ────────────────
//
// 行级过滤是**第一道**：`out=129/flow_ms=1` 这类行已经被 `usableRow` 挡掉，
// 于是 `A = Σout/Σ秒` 是逐行速率的耗时加权均值 ⇒ 每行不超过 MAX_ROW_SPEED 时 A 也
// 不会超过它 ⇒ 正常路径上 B 已经到不了 1000 以上（实测污染后 B=48000 正是靠第一道
// 被挡掉，见第七节）。`B_MAX` 仍然保留，兜的是**外来的**越界 b（旧缓存、人手改的
// 文件）与将来没被行级判据覆盖的异常形态 —— 宁可整模型作废，也不按错误基准错踢。

/**
 * 造一个「A 恰好 = target」的模型：3 个号，每号一条行 ⇒ A 就等于该行的单次速率。
 * `target` 必须 <= MAX_ROW_SPEED（超过 1000 的行会被第一道闸门直接剔掉）。
 */
function rowsWithAverage(account, model, target) {
  return [0, 1, 2].map((i) =>
    sample({ providerAccount: `${account}${i}`, model, out: target, flow_ms: 1000, t: at(NOW - 60_000) }),
  )
}

test("B_MAX 边界包含：中位数恰为 1000 ⇒ 仍参与判定（按 1000 判）", () => {
  assert.equal(B_MAX, 1000, "真实解码峰值 300–500 tok/s：1000 是「物理不可能」的分界")
  const table = buildSpeedTable(rowsWithAverage("acc", "m", 1000), { now: NOW })
  assert.equal(table.b.m, 1000, "恰好等于上限仍是有效基准")
  // 1000×0.7 = 700：1000 > 700 ⇒ normal
  assert.equal(table.accounts["m|acc0"].verdict, "normal")
  assert.equal(table.accounts["m|acc1"].verdict, "normal")
  assert.equal(table.accounts["m|acc2"].verdict, "normal")
})

test("B_MAX：越界的中位数（1001 / 48000）⇒ 视为无参考，全员 unknown", () => {
  assert.equal(usableB(1000), 1000, "边界包含：恰在上限上放行")
  assert.equal(usableB(1001), null, "越过 1000 就不许当基准")
  assert.equal(usableB(48000), null, "实测被污染模型的中位数，同样不许当基准")
  assert.equal(usableB(0), null)
  assert.equal(usableB(null), null)
  // 越界 b ⇒ classify 拿到 null ⇒ unknown ⇒ 一个都不跳过
  assert.equal(classify({ lastSpeed: 100, lastAt: NOW - 1000 }, usableB(48000), NOW), "unknown")
  assert.equal(classify({ lastSpeed: 100, lastAt: NOW - 1000 }, usableB(1001), NOW), "unknown")
  // 边界内的 b 照常判定（800 >= 1000×0.7 ⇒ normal）
  assert.equal(classify({ lastSpeed: 800, lastAt: NOW - 1000 }, usableB(1000), NOW), "normal")
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

// ── 七、行级物理过滤：`flow_ms≈1ms` 的异常行不许进分子分母（T-63） ────────
//
// 实测（2026-11-22，7d 全量 1473 行、有效 1273 行、101 个账号，**78 个账号含异常行**）：
// magpie 的 usage/requests 里有 `flow_ms=1` 的行（`out=129, flow_ms=1` → 129 000 tok/s）。
// 它在 `sum(out)/sum(flow_ms)` 里只往分子加 129、分母加 1 ms ⇒ 账号 A 被抬高
// ⇒ B 被抬高 ⇒ 判定线 `B×0.7` 抬高 ⇒ 真实 100 tok/s 的正常号被判 slow。
//
// 这不是「短请求」：20 ms 内解不出有意义的内容，1 ms 更不可能。物理上不成立。

test("usableRow：out=129 / flow_ms=1 → false（1 ms 里解不出 129 个 token）", () => {
  assert.equal(MIN_FLOW_MS, 20, "解码耗时下限（<20ms 的窗口不是模型吐字耗时）")
  assert.equal(usableRow(sample({ out: 129, flow_ms: 1 })), false, "1 ms 不可能")
  assert.equal(usableRow(sample({ out: 94, flow_ms: 19 })), false, "低于 MIN_FLOW_MS=20 一律不可信")
  assert.equal(usableRow(sample({ out: 20, flow_ms: 20 })), true, "边界包含：恰 20 ms 且 1000 tok/s 仍可信")
})

test("usableRow：单行速率越过物理上限 1000 tok/s → false；真实 100 tok/s → true", () => {
  assert.equal(MAX_ROW_SPEED, 1000, "真实解码峰值 300–500 tok/s：1000 已是保守上限")
  assert.equal(usableRow(sample({ out: 1000, flow_ms: 1 })), false, "1e6 tok/s：物理上不可能")
  assert.equal(usableRow(sample({ out: 100, flow_ms: 1000 })), true, "100 tok/s 是正常号")
  assert.equal(usableRow(sample({ out: 1000, flow_ms: 1000 })), true, "边界包含：1000 tok/s 仍可信")
  assert.equal(usableRow(sample({ out: 1001, flow_ms: 1000 })), false, "1001 越过上限")
})

test("核心：accountAverage 混入 1 ms 异常行 ⇒ 100（不是 229）", () => {
  const rows = [sample({ out: 100, flow_ms: 1000 }), sample({ out: 129, flow_ms: 1 })]
  assert.equal(accountAverage(rows), 100, "只算可信行：100 tok / 1.0 s")
  // 对照：不过滤时 (100+129)/(1.001) ≈ 228.8 —— 这就是误杀的来源
  assert.ok(Math.abs((100 + 129) / 1.001 - 228.77) < 0.05)
  assert.equal(accountAverage([sample({ out: 129, flow_ms: 1 })]), null, "全异常 ⇒ null，不是 129000")
})

test("核心：buildSpeedTable 真实污染比例（10 号 5 个含异常行）⇒ B 不被抬高", () => {
  /** 一个号的正常行：100 tok / 1000 ms = 100 tok/s。 */
  const normal = (account) => sample({ providerAccount: account, model: "m", out: 100, flow_ms: 1000, t: at(NOW - 60_000) })
  /** 该号额外多一条 1 ms 异常行（实测形态 out=129 / flow_ms=1）。 */
  const garbage = (account) => sample({ providerAccount: account, model: "m", out: 129, flow_ms: 1, t: at(NOW - 30_000) })

  const accounts = Array.from({ length: 10 }, (_, i) => `a${i}`)
  const rows = accounts.flatMap((a, i) => (i < 5 ? [normal(a), garbage(a)] : [normal(a)]))

  // 对照：不过滤时那 5 个号的 A = 229/1.001 ≈ 228.8 ⇒ 中位数被抬到 ≈164
  const unfiltered = median(accounts.map((a) =>
    (i2(rows, a).reduce((s, r) => s + Number(r.out), 0)) / (i2(rows, a).reduce((s, r) => s + Number(r.flow_ms), 0) / 1000),
  ))
  assert.ok(unfiltered > 150, `未过滤时 B 必须被抬高（实际 ${unfiltered}）`)

  const table = buildSpeedTable(rows, { now: NOW })
  assert.equal(table.b.m, 100, `过滤后 B 必须回到真实值 100（未过滤是 ${unfiltered}）`)
  for (const a of accounts) assert.equal(table.accounts[`m|${a}`].verdict, "normal", `${a} 是 100 tok/s 的正常号`)
})

/** 取出某账号在 rows 里的一行行（测试局部用，避免噪声）。 */
function i2(rows, account) {
  return rows.filter((r) => r.providerAccount === account)
}

test("核心：lastSpeed 取「最近一条**可信**行」—— 最近一条是异常行也不算", () => {
  const account = "g"
  const rows = [
    // t=100：正常 100 tok/s
    sample({ providerAccount: account, model: "m", out: 100, flow_ms: 1000, t: at(NOW - 100_000) }),
    // t=200：更新的那条是 1 ms 异常行（129 000 tok/s）
    sample({ providerAccount: account, model: "m", out: 129, flow_ms: 1, t: at(NOW - 10_000) }),
    // 另一个正常号，把 B 钉在 100
    sample({ providerAccount: "ref", model: "m", out: 100, flow_ms: 1000, t: at(NOW - 60_000) }),
  ]
  const table = buildSpeedTable(rows, { now: NOW })
  const entry = table.accounts[`m|${account}`]
  assert.equal(entry.lastSpeed, 100, "必须是可信行（t=100）的速率，不是 129000")
  assert.equal(entry.lastAt, NOW - 100_000, "lastAt 跟着那条可信行走")
  assert.equal(entry.avgSpeed, 100)
  assert.equal(entry.calls, 1, "calls 只数可信行")
  assert.equal(entry.verdict, "normal")
})

test("全部行异常 ⇒ lastSpeed=null ⇒ verdict=unknown ⇒ 面板显示 —，不判 slow", () => {
  const account = "13151743953"
  const rows = [
    // 实测：n=2 anom=2，两条都是 1 ms 行
    sample({ providerAccount: account, model: "m", out: 129, flow_ms: 1, t: at(NOW - 20_000) }),
    sample({ providerAccount: account, model: "m", out: 94, flow_ms: 1, t: at(NOW - 10_000) }),
    // 同模型另一个正常号：B 有基准，所以「unknown」不是因为 b=null，而是这号没可信样本
    sample({ providerAccount: "ref", model: "m", out: 100, flow_ms: 1000, t: at(NOW - 60_000) }),
  ]
  const table = buildSpeedTable(rows, { now: NOW })
  const entry = table.accounts[`m|${account}`]
  assert.ok(entry, "条目必须还在（面板要显示这一行，不能整条消失）")
  assert.equal(entry.lastSpeed, null, "宁可 null 也不要虚假值")
  assert.equal(entry.avgSpeed, null)
  assert.equal(entry.calls, 0)
  assert.equal(entry.verdict, "unknown", "未知 ≠ 不可用：不许判 slow")
  assert.equal(table.b.m, 100, "B 只来自可信行")
})
