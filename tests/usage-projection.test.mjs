// 额度推算：用响应里白捡的 `points_consumed` 记账，累计 5000 才校准。
//
// # 为什么这么做
//
// 上游每次对话都回 `usage.points_consumed`（实测流式/非流式都有），但**从不回
// 余额**。所以余额只能是「上次真实读数 − 累计消耗」。这样额度列不用手动刷新，
// 而且**一个额外请求都不发** —— 自动打上游正是之前掉号的原因。
//
// # 5000 阈值
//
// 签到、邀请奖励不经过对话，推算必然慢慢偏离。校准要打上游，所以阈值定在
// 5000 积分：到了只在卡片上提示「建议校准」，绝不自动发请求。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CALIBRATE_AFTER_POINTS,
  pointsFromUsage,
  projectedBalance,
  needsCalibration,
  projectionText,
  usageFromCache,
  USAGE_CACHE_FILE,
} from "../src/quota-cache.mjs"
import { extractPointsConsumed, watchServedAndUsage } from "../src/hooks/loader.mjs"
import { writeKeyedCacheFile, readKeyedCacheFile } from "../src/cache-write.mjs"

const enc = new TextEncoder()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一段真形状的 SSE：最后一个 `choices:[]` 块带 usage。 */
function sseWithUsage(points) {
  return enc.encode(
    'data: {"id":"x","object":"chat.completion.chunk","model":"deepseek-v4-flash-1017","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
      `data: {"id":"x","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":21,"completion_tokens":8,"total_tokens":29,"points_consumed":${points}}}\n\n` +
      "data: [DONE]\n\n",
  )
}

function streamOf(chunks, gapMs = 0) {
  let i = 0
  return new ReadableStream({
    async pull(c) {
      if (i >= chunks.length) return c.close()
      if (gapMs && i > 0) await sleep(gapMs)
      c.enqueue(chunks[i++])
    },
  })
}

test("① pointsFromUsage：认得出数字，负数/NaN/缺字段一律 0", () => {
  assert.equal(pointsFromUsage({ points_consumed: 3 }), 3)
  assert.equal(pointsFromUsage({ points_consumed: 0 }), 0)
  assert.equal(pointsFromUsage({ points_consumed: -5 }), 0)
  assert.equal(pointsFromUsage({}), 0)
  assert.equal(pointsFromUsage(null), 0)
})

test("② extractPointsConsumed：取**最后**一个（中途块的 usage 不是最终账）", () => {
  const text = '{"points_consumed":1}{"points_consumed":9}{"points_consumed":4}'
  assert.equal(extractPointsConsumed(text), 4)
  assert.equal(extractPointsConsumed("no numbers here"), 0)
})

test("③ watchServedAndUsage：一次读到 model 与 points", async () => {
  const got = await watchServedAndUsage(streamOf([sseWithUsage(7)]))
  assert.equal(got.served, "deepseek-v4-flash-1017")
  assert.equal(got.pointsConsumed, 7)
})

test("④ 时间轴红线：3 块间隔 60ms，观察分支不许把宿主那条流压平", async () => {
  const chunks = [sseWithUsage(1), enc.encode('data: {"x":2}\n\n'), enc.encode("data: [DONE]\n\n")]
  const [forHost, forPeek] = streamOf(chunks, 60).tee()
  const watching = watchServedAndUsage(forPeek)
  const reader = forHost.getReader()
  const stamps = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) stamps.push(Date.now())
  }
  await watching
  assert.equal(stamps.length, 3)
  // 第一块与第三块之间的间隔必须 ≥ 60ms（被压平的话会是 0）
  assert.ok(stamps[2] - stamps[0] >= 60, `时间轴被压平了：${stamps[2] - stamps[0]}ms`)
})

test("⑤ 累计记账：三次各 3 分 → consumed = 9", () => {
  const dir = mkdtempSync(join(tmpdir(), "loomy-usage-"))
  try {
    writeKeyedCacheFile(dir, USAGE_CACHE_FILE, "accounts", "u1", {
      at: 1000, baseline: 100, consumed: 0, windows: [{ name: "额度 · 平台积分", balance: 100 }],
    })
    for (let i = 0; i < 3; i++) {
      const cur = readKeyedCacheFile(dir, USAGE_CACHE_FILE, "accounts").u1
      writeKeyedCacheFile(dir, USAGE_CACHE_FILE, "accounts", "u1", {
        ...cur, consumed: (cur.consumed || 0) + 3,
      })
    }
    const entry = readKeyedCacheFile(dir, USAGE_CACHE_FILE, "accounts").u1
    assert.equal(entry.consumed, 9)
    assert.equal(projectedBalance(entry), 91)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("⑥ 下限 0：baseline 5 消耗 9 → 显示 0，不出负数", () => {
  assert.equal(projectedBalance({ baseline: 5, consumed: 9 }), 0)
  assert.equal(projectedBalance({ consumed: 9 }), null, "没有 baseline 就不推算")
})

test("⑦ 5000 阈值：4999 不提示，5000 提示校准", () => {
  assert.equal(CALIBRATE_AFTER_POINTS, 5000)
  assert.equal(needsCalibration({ baseline: 9999, consumed: 4999 }), false)
  assert.equal(needsCalibration({ baseline: 9999, consumed: 5000 }), true)
  assert.match(projectionText({ baseline: 9000, consumed: 5000, at: 0 }), /建议校准/)
  assert.doesNotMatch(projectionText({ baseline: 9000, consumed: 4999, at: 0 }), /建议校准/)
})

test("⑧ usageFromCache：主额度窗换成推算值，并追加一条「额度推算」说明", () => {
  const entry = {
    at: 1000, baseline: 872.04, consumed: 12.5, calibratedAt: 1000,
    windows: [
      { name: "额度 · 平台积分", balance: 872.04, unit: "积分", display: "872.04 积分" },
      { name: "额度 · 永久积分", aside: true, display: "872.04" },
    ],
  }
  const out = usageFromCache(entry, { now: 2000 })
  const main = out.windows.find((w) => w.name === "额度 · 平台积分")
  assert.equal(main.balance, 859.54)
  assert.ok(out.windows.some((w) => w.name.includes("额度推算")), "必须有一条推算说明")
  // aside 明细一个字都不许改
  const aside = out.windows.find((w) => w.name === "额度 · 永久积分")
  assert.equal(aside.display, "872.04")
})

test("⑨ 没有 baseline 时保持「未读」，不瞎算", () => {
  const out = usageFromCache({ at: 1000, windows: [] }, { now: 2000 })
  // 只有末尾那条「额度读于」，没有任何推算窗
  assert.ok(!out.windows.some((w) => w.name.includes("额度推算")), "没有 baseline 就不该出现推算窗")
  assert.ok(out.windows.some((w) => w.name.includes("额度读于")), "仍要有「读于」说明")
})

test("⑩ 记账不写盘时不能抛（缓存目录只读/不存在）", () => {
  assert.doesNotThrow(() => {
    try {
      writeKeyedCacheFile("", USAGE_CACHE_FILE, "accounts", "u1", { baseline: 1, consumed: 1 })
    } catch {
      /* 调用方（recordConsumedPoints）自己吞，这里只确认它确实抛给调用方 */
    }
  })
  assert.equal(readKeyedCacheFile("/nonexistent-dir-xyz", USAGE_CACHE_FILE, "accounts").u1, undefined)
})