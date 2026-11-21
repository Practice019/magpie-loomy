// 「没有这个刷新任务」不是失败。
//
// # 真机现象（2026-11-21 16:06）
//
//	[邀请] ✓ 16793569472
//	[邀请] ✓ 16251262696
//	[邀请] ✓ 17007484580
//	[邀请] 进度查询失败：没有这个刷新任务     ← 两秒后，红字 + toast
//
// 刷新任务表在**面板服务的进程内存**里（`ctx.refreshJobs`）。插件更新、宿主
// 重启、服务换端口都会清空它，而页面还拿着旧 jobId 轮询 —— 服务端只能答
// 「没有这个刷新任务」。任务结果其实已经写进缓存，把它报成「失败」是在骗人。
//
// 所以三处轮询（批量检测 / 余额任务 / 分配）都必须把它当成「任务不在了」：
// 停轮询、不打红字、回读缓存。

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const js = () => readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")

test("① 有统一的 jobGone 判据，匹配「没有这个刷新任务」", () => {
  const src = js()
  assert.match(src, /function jobGone\(e\)/)
  assert.match(src, /没有这个刷新任务/)
})

test("② 批量检测轮询：任务不在了 → 不弹红字，改回读 route-state", () => {
  const src = js()
  const block = src.match(/async function pollBatch\(\)[\s\S]*?scheduleBatchPoll\(\)|async function pollBatch\(\)[\s\S]*?return\s*\n\s*\}/)
  assert.ok(block, "找不到 pollBatch")
  assert.match(block[0], /jobGone\(e\)/)
  // jobGone 分支里不许出现 toast 报错
  const gone = block[0].match(/if \(jobGone\(e\)\) \{[\s\S]*?\n    \}/)
  assert.ok(gone, "pollBatch 里应有 jobGone 分支")
  assert.doesNotMatch(gone[0], /toast\([^)]*,\s*true\)/)
  assert.match(gone[0], /routeStates\(\)/)
})

test("③ 余额/任务/邀请任务轮询：任务不在了 → 回读对应缓存", () => {
  const src = js()
  const block = src.match(/async function pollJob\(kind\)[\s\S]*?\n\}/)
  assert.ok(block, "找不到 pollJob")
  const gone = block[0].match(/if \(jobGone\(e\)\) \{[\s\S]*?\n    \}/)
  assert.ok(gone, "pollJob 里应有 jobGone 分支")
  assert.doesNotMatch(gone[0], /toast\([^)]*,\s*true\)/)
  assert.match(gone[0], /balances\(\)|tasks\(\)|invites\(\)/)
})

test("④ 分配轮询：任务不在了 → 回读码池", () => {
  const src = js()
  const block = src.match(/function scheduleAssignPoll[\s\S]*?\n\}/)
  assert.ok(block, "找不到 scheduleAssignPoll")
  assert.match(block[0], /jobGone\(e\)/)
  assert.match(block[0], /poolState\(\)/)
})

test("⑤ 真错误仍然报红（别把 jobGone 变成万能吞错）", () => {
  const src = js()
  assert.match(src, /进度查询失败：\$\{e\.message\}/)
})
