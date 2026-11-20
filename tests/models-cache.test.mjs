// models-cache.test.mjs `auth.models` 的文件缓存 —— **掉号的根因**（T-38）。
//
// # 背景（真机）
//
// 原来的 `provider.models` **每个账号各拉一次** `/api/v1/models`，零缓存：
//
//	301 个账号 × 每次 magpie 重读模型列表 = 301 次请求
//	开发者一天重启 8 次 ≈ 2400 次 ⇒ 服务端判成批量探测 ⇒ 风控 ⇒ session 失效
//	（实测 19 个 expired，其中 18 个是 session-expired）
//
// 而模型目录是 **provider 级**属性：对所有账号相同。一次就够。
//
// # 用户的要求（原话）
//
//	「更新缓存我们控制不要自动」「不会过期」「重启不要发请求」
//
// 所以这里的判据是**上游请求次数**，一条一条钉死：
//
//	1. 缓存命中 ⇒ **0 次**
//	2. 301 个账号并发 ⇒ **1 次**（模块级单飞）
//	3. 无缓存时拉一次并写文件；第二次调用读文件 ⇒ **0 次**
//	4. 拉失败**不写缓存**（下次仍会重试）
//	5. 缓存「不会自动过期」：文件在，隔很久也命中（没有任何 TTL 代码）
//	6. 缓存坏了 ⇒ 当没有缓存（重拉一次），不抛错

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeModelsHook, resetCatalogInflight } from "../src/hooks/models.mjs"
import {
  MODELS_CACHE_FILE,
  modelsCachePath,
  readModelsCache,
  readCachedModels,
  writeModelsCache,
  clearModelsCache,
} from "../src/models-cache.mjs"

const SESSION = "s".repeat(32)
const BASE = "https://loomyad.xunfei.cn/api/v1"

/** 一个计数的假上游：返回这一个模型，并记下被调次数。 */
function countingCatalog(entries = [{ id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash(x2.0)" }]) {
  const stats = { calls: 0 }
  const fetchImpl = async () => {
    stats.calls += 1
    return Response.json({ code: "000000", data: entries })
  }
  return { stats, fetchImpl }
}

/** 临时 configDir（每个用例独立，避免缓存互相污染）。 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-models-cache-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 一个账号形状的 auth（uid 各不相同 = 模拟 301 个号）。 */
function authOf(i = 0) {
  return { type: "oauth", access: `${String(i).padStart(32, "0")}`, uid: `u${i}` }
}

function hookFor({ dir, fetchImpl, log = { warn() {} } }) {
  return makeModelsHook({ baseUrl: BASE, configDir: dir, routeStore: null, fetchImpl, log })
}

// ── 1. 缓存命中 ⇒ 零上游 ───────────────────────────────────────────────

test("① 缓存命中：`auth.models` 一次上游都不打（fetch 计数 = 0）", async (t) => {
  const dir = tempDir(t)
  resetCatalogInflight()
  writeModelsCache(dir, BASE, [{ id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash(x2.0)" }])

  const up = countingCatalog()
  const hook = hookFor({ dir, fetchImpl: up.fetchImpl })
  const out = await hook({ models: {} }, { auth: authOf(1) })

  assert.equal(up.stats.calls, 0, `缓存命中时上游请求数必须是 0，实际 ${up.stats.calls}`)
  assert.ok(out["DeepSeek-V4.1-Flash"], "缓存内容必须原样变成模型列表")
  assert.equal(out["DeepSeek-V4.1-Flash"].rate, 2, "缓存里存的还是原始条目 ⇒ 倍率照常解析")
})

// ── 2. 301 个账号并发 ⇒ 只剩 1 次 ──────────────────────────────────────

test("② 301 个账号并发调用 `auth.models`，上游**只被调 1 次**", async (t) => {
  const dir = tempDir(t)
  resetCatalogInflight()

  const up = countingCatalog()
  // 每个账号一个 hook 实例：这是 magpie 的真实调用方式（按账号喂同一个 baseUrl）
  const results = await Promise.all(
    Array.from({ length: 301 }, (_, i) => {
      const hook = hookFor({ dir, fetchImpl: up.fetchImpl })
      return hook({ models: {} }, { auth: authOf(i) })
    }),
  )

  assert.equal(up.stats.calls, 1, `301 个账号并发只该产生 1 次上游请求，实际 ${up.stats.calls}`)
  for (const out of results) {
    assert.ok(out["DeepSeek-V4.1-Flash"], "每个账号都要拿到同一份目录（provider 级，不是账号级）")
  }
  // 拉成功之后缓存文件真的写下了
  assert.ok(existsSync(modelsCachePath(dir)), "成功一次就要落盘 —— 否则重启又会打一轮")
})

// ── 3. 无缓存 ⇒ 拉一次 + 写文件；第二次读文件 ⇒ 零上游 ────────────────

test("③ 无缓存时拉一次并写文件；第二次调用读到文件，零上游", async (t) => {
  const dir = tempDir(t)
  resetCatalogInflight()

  const first = countingCatalog()
  await hookFor({ dir, fetchImpl: first.fetchImpl })({ models: {} }, { auth: authOf(1) })
  assert.equal(first.stats.calls, 1)

  const file = modelsCachePath(dir)
  assert.equal(file, join(dir, MODELS_CACHE_FILE))
  const table = JSON.parse(readFileSync(file, "utf8"))
  assert.ok(table[BASE], "缓存表的键是 baseUrl（换基址就是另一份目录）")
  assert.equal(table[BASE].source, "live")
  assert.equal(table[BASE].list[0].id, "DeepSeek-V4.1-Flash")

  // 第二次：换一个上游实现（若真被调用，它就是「重启后又打了一轮」）
  const second = countingCatalog([{ id: "SHOULD-NOT-APPEAR" }])
  const out = await hookFor({ dir, fetchImpl: second.fetchImpl })({ models: {} }, { auth: authOf(2) })
  assert.equal(second.stats.calls, 0, "第二次必须读文件，不许再打上游")
  assert.ok(out["DeepSeek-V4.1-Flash"], "拿到的应是文件里那份，不是新上游的")
  assert.equal(out["SHOULD-NOT-APPEAR"], undefined)
})

// ── 4. 拉失败不写缓存（下次仍会重试）────────────────────────────────────

test("④ 拉失败：回退静态表，**不写缓存**（下次还会重试）", async (t) => {
  const dir = tempDir(t)
  resetCatalogInflight()

  const bad = async () => new Response("boom", { status: 502 })
  const out = await hookFor({ dir, fetchImpl: bad })({ models: {} }, { auth: authOf(1) })
  assert.ok(Object.keys(out).length > 0, "失败要回静态表，不能给空目录（那会让号「消失」）")
  assert.equal(existsSync(modelsCachePath(dir)), false, "失败绝不许写缓存 —— 否则一次抖动会被永久记住")

  // 再试一次（模拟重启）：应当重新打上游，且这次成功
  const ok = countingCatalog()
  await hookFor({ dir, fetchImpl: ok.fetchImpl })({ models: {} }, { auth: authOf(1) })
  assert.equal(ok.stats.calls, 1, "上次失败不留下痕迹 ⇒ 这次必须真的再拉一次")
  assert.ok(existsSync(modelsCachePath(dir)), "这次成功 ⇒ 缓存落盘")
})

// ── 5. 不会过期（没有任何 TTL）────────────────────────────────────────

test("⑤ 缓存**不会**自动失效：时间过去再久（含进程重启），仍然零上游", async (t) => {
  const dir = tempDir(t)
  resetCatalogInflight()
  // 写一份「很久以前」的缓存（2000 年）
  writeModelsCache(dir, BASE, [{ id: "DeepSeek-V4.1-Flash" }], { now: () => 946_684_800_000 })

  const up = countingCatalog()
  const out = await hookFor({ dir, fetchImpl: up.fetchImpl })({ models: {} }, { auth: authOf(1) })

  assert.equal(up.stats.calls, 0, "用户原话「不会过期」：文件在就命中，永不自动失效")
  assert.ok(out["DeepSeek-V4.1-Flash"])
})

// ── 6. 缓存损坏 ⇒ 当没有缓存（重拉一次），不抛 ───────────────────────

test("⑥ 缓存文件损坏 / 形状不对 ⇒ 当作没有缓存，重拉一次（不抛错）", async (t) => {
  const dir = tempDir(t)
  resetCatalogInflight()
  const file = modelsCachePath(dir)
  writeFileSync(file, "{ 这不是 JSON")

  assert.deepEqual(readModelsCache(dir), {}, "坏文件读出来是空表，不是异常")
  assert.equal(readCachedModels(dir, BASE), null)

  const up = countingCatalog()
  const out = await hookFor({ dir, fetchImpl: up.fetchImpl })({ models: {} }, { auth: authOf(1) })
  assert.equal(up.stats.calls, 1, "坏缓存必须重拉一次")
  assert.ok(out["DeepSeek-V4.1-Flash"])

  // `list` 不是数组同样算坏记录（拿它当目录会让模型列表静默变空）
  writeFileSync(file, JSON.stringify({ [BASE]: { at: 1, list: "oops", source: "live" } }))
  assert.equal(readCachedModels(dir, BASE), null)
})

// ── 7. 只有用户/面板显式要求才清缓存 ─────────────────────────────────

test("⑦ 清缓存是显式动作（`clearModelsCache`），清完之后下一次会真拉", async (t) => {
  const dir = tempDir(t)
  resetCatalogInflight()
  writeModelsCache(dir, BASE, [{ id: "DeepSeek-V4.1-Flash" }])
  const stat1 = statSync(modelsCachePath(dir)).size

  const cleared = clearModelsCache(dir, BASE)
  assert.equal(cleared.ok, true)
  assert.equal(existsSync(modelsCachePath(dir)), false, "只剩这一份时直接删文件")
  assert.ok(stat1 > 0)

  const up = countingCatalog()
  await hookFor({ dir, fetchImpl: up.fetchImpl })({ models: {} }, { auth: authOf(1) })
  assert.equal(up.stats.calls, 1, "缓存被清 ⇒ 必须重新拉一次（这是唯一的「刷新」路径）")
})