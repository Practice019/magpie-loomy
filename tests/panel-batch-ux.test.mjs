// 批量检测 / 刷新任务的**操作体验**：按钮不许重复点，日志必须逐条。
//
// # 为什么钉这两件
//
// 真机：点「重新检测不健康账号」后进度走到 96/226，按钮还是可点的。再点一次
// = 同一批号被并发检测两遍，白扣积分，还可能撞上游限流。所以批量在跑时按钮
// 必须 disabled。
//
// 另一半是日志。批量 200+ 个号要跑几分钟，界面上只有一个 `96/226` —— 事后
// 想查「哪个号变成了什么」完全没有线索。所以每条完成都要落一行，判定**变化**
// 的那条单独标出来（重测的意义就是看谁从坏变好）。

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const js = () => readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")

test("① 批量检测进行中，「重新检测不健康账号」必须禁用", () => {
  const src = js()
  // 找到那段赋值：disabled 必须同时受 batch.running 约束
  const m = src.match(/route-recheck-unhealthy"\)\s*\n?\s*if \(recheck\)[^\n]*/)
  assert.ok(m, "render() 里必须给 #route-recheck-unhealthy 设 disabled")
  assert.match(m[0], /state\.batch\.running/, "批量在跑时按钮必须禁用，否则会重复点")
})

test("② 批量完成逐条日志：含判定变化与失败原因", () => {
  const src = js()
  assert.match(src, /判定变化：\$\{before\} → \$\{after\}/)
  assert.match(src, /✗ \$\{uid\} \$\{label\}/)
  assert.match(src, /✓ \$\{uid\} 正常/)
})

test("③ 同一个号只记一行（poll 会反复回放 results）", () => {
  const src = js()
  // 去重集合是懒初始化的（老批次没有这个字段），判据是「先 has 再 add」
  assert.match(src, /state\.batch\.logged \?\?= new Set\(\)/)
  assert.match(src, /state\.batch\.logged\?\.has\(uid\)\) continue/)
  assert.match(src, /state\.jobs\[kind\]\.logged\.has\(uid\)\) continue/)
})

test("④ 余额 / 任务 / 邀请刷新任务也逐条记", () => {
  const src = js()
  assert.match(src, /state\.jobs\[kind\]\.logged \?\?= new Set\(\)/)
  assert.match(src, /log\(JOB_LABEL\[kind\], `✗ \$\{who\}：/)
})

test("⑤ 每次开新任务都要清空 logged，否则第二轮一行都不打", () => {
  const src = js()
  const starts = src.match(/logged: new Set\(\)/g) ?? []
  // 至少三处：checkBatchSelected、重新检测不健康账号、jobs 启动
  assert.ok(starts.length >= 3, `开新任务处必须重置 logged（找到 ${starts.length} 处）`)
})
