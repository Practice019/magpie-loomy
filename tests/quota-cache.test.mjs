// quota-cache.test.mjs `auth.usage` **零上游**（T-54 核心回归）。
//
// # 这一集在拦什么（真机事故）
//
// magpie 每次渲染账号卡都调 `auth.usage`。旧实现是每个账号一次
// `GET /points/records` —— 301 个账号 = 301 次上游请求，全挤在启动那一瞬间。
// 用户从 `%LOCALAPPDATA%\magpie\logs\app.log` 数出来（启动后 3 分钟）：
//
//	额度相关警告 723 条   points/records 失败 70 条   登录已失效 82 次
//
// 上游把这个遍历识别成扫描 ⇒ 风控 ⇒ 成批掉号。用户原话：
// 「一定不可以这样。你想办法限制它。想办法把这个关掉，不要让它自动打。」
//
// # 四条位置（就是验收要的三项证据之一）
//
//	① 有缓存    → 零上游
//	② 无缓存    → 零上游，回「说明 · 额度未读」
//	③ 缓存窗口  → 原样返回 + 追加「说明 · 额度读于 …」
//	④ 301 个号连续调用 → 上游请求 **0** 次（核心回归）

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeUsageHook } from "../src/hooks/usage.mjs"
import { usageFromPoints } from "../src/usage.mjs"
import { USAGE_CACHE_FILE, AGE_NOTE, UNREAD_NOTE, readUsageCache, ageText } from "../src/quota-cache.mjs"

const SESSION = "s".repeat(32)

/** 造一个 configDir；`entry` 为 `undefined` 时不写缓存（模拟「从没刷新过」）。 */
function cfgDir(t, entry) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-quota-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  if (entry) {
    writeFileSync(join(dir, USAGE_CACHE_FILE), JSON.stringify({ updatedAt: entry.at, accounts: { [entry.uid]: entry.value } }))
  }
  return dir
}

/**
 * 一个「只要被调用就计数」的 fetch。
 *
 * ⚠ 这不是「假上游」，而是**证据计数器**：本文件所有断言的落点都是它 === 0。
 */
function countingFetch() {
  const state = { calls: 0, urls: [] }
  const fetchImpl = async (url) => {
    state.calls += 1
    state.urls.push(String(url))
    return Response.json({ code: "000000", data: { balance: 1, dailyBalance: 1, availableBalance: 1 } })
  }
  return { fetchImpl, state }
}

const POINTS = { available: 26434, daily: 1434, dailyKnown: true, permanent: 25000, permanentKnown: true }

/** 一份与面板刷新写盘**同形状**的缓存记录。 */
function cacheEntry(uid, points = POINTS, at = Date.now() - 5 * 60_000) {
  const { windows } = usageFromPoints(points)
  return { uid, at, value: { at, windows, plan: "free", permanent: points.permanent, limited: false } }
}

/**
 * 只用**缓存 + 计数器**构造 hook。
 *
 * ⚠ 刻意**不传** `baseUrl` / `fetchImpl`：即使传了也不该被调用。
 *   这里传进去正是为了证明「就算递到手里也不会用」。
 */
function usageOf({ dir, fetchImpl, extra = {} } = {}) {
  const hook = makeUsageHook({ configDir: dir, log: { warn() {} }, ...extra })
  return (auth) => hook(async () => auth)
}

test("① 有缓存时**零上游**（注入的 fetch 计数器必须 === 0）", async (t) => {
  const entry = cacheEntry("u-cached")
  const dir = cfgDir(t, entry)
  const { fetchImpl, state } = countingFetch()

  // 即使把 fetchImpl 递进 options，也一个请求都不许发
  const usage = usageOf({ dir, extra: { baseUrl: "https://loomyad.xunfei.cn/api/v1", fetchImpl } })
  const u = await usage({ type: "oauth", access: SESSION, uid: "u-cached" })

  assert.equal(state.calls, 0, `有缓存时不许打上游，实际 ${state.calls} 次: ${state.urls.join(" | ")}`)
  assert.equal(u.error, undefined, "有数据时不许塞 error（会整块替换额度区）")
  assert.ok(Array.isArray(u.windows) && u.windows.length >= 4, `应当有 3 条额度窗 + 1 条说明，实际 ${JSON.stringify(u.windows)}`)
})

test("② 无缓存时也**零上游**，返回「说明 · 额度未读」", async (t) => {
  const dir = cfgDir(t, undefined)
  const { fetchImpl, state } = countingFetch()

  const usage = usageOf({ dir, extra: { baseUrl: "https://loomyad.xunfei.cn/api/v1", fetchImpl } })
  const u = await usage({ type: "oauth", access: SESSION, uid: "u-never-read" })

  assert.equal(state.calls, 0, `没有缓存也不许「顺手查一下」，实际 ${state.calls} 次`)
  assert.equal(u.error, undefined, "「还没读过」不是错误，是初始状态（error 会把额度区整块替掉）")
  assert.deepEqual(u.windows.map((w) => w.name), [UNREAD_NOTE])
  assert.equal(u.windows[0].aside, true, "不参与路由")
  assert.match(String(u.windows[0].display), /刷新额度/, "要告诉用户点哪里")
})

test("③ 缓存里的 windows 原样返回，并追加一条「说明 · 额度读于 …」（aside）", async (t) => {
  const at = Date.now() - 2 * 3600_000
  const entry = cacheEntry("u-fresh", POINTS, at)
  const dir = cfgDir(t, entry)
  const { fetchImpl, state } = countingFetch()

  const usage = usageOf({ dir, extra: { fetchImpl } })
  const u = await usage({ type: "oauth", access: SESSION, uid: "u-fresh" })

  assert.equal(state.calls, 0)

  // 原样：缓存里那 3 条按顺序、按内容一模一样地出现
  assert.deepEqual(u.windows.slice(0, entry.value.windows.length), entry.value.windows, "缓存窗口必须原样返回，不许重算 / 改写")

  const age = u.windows.at(-1)
  assert.equal(age.name, AGE_NOTE, "名字固定（时间只进 display，否则卡片每次都改名）")
  assert.equal(age.aside, true, "说明窗不参与路由")
  assert.equal(age.used, undefined, "说明窗不许带 used（会进额度排序）")
  assert.match(String(age.display), /小时前/, `应写清是多久前读的，实际: ${age.display}`)
  assert.match(String(age.display), /刷新额度/, "要告诉用户怎么更新")
})

test("④ 核心回归：301 个账号连续调用 `auth.usage` → 上游请求 **0** 次", async (t) => {
  // 一半有缓存、一半没有 —— 两种分支都要覆盖，避免「只有缓存命中才不打」的半吊子实现
  const dir = mkdtempSync(join(tmpdir(), "loomy-quota-301-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  /** @type {Record<string, any>} */
  const accounts = {}
  for (let i = 0; i < 301; i += 1) {
    if (i % 2 === 0) {
      const { windows } = usageFromPoints(POINTS)
      accounts[`acc-${i}`] = { at: Date.now() - i * 1000, windows, plan: "free", permanent: 25000, limited: false }
    }
  }
  writeFileSync(join(dir, USAGE_CACHE_FILE), JSON.stringify({ updatedAt: Date.now(), accounts }))

  const { fetchImpl, state } = countingFetch()
  const hook = makeUsageHook({ configDir: dir, log: { warn() {} }, baseUrl: "https://loomyad.xunfei.cn/api/v1", fetchImpl })

  const started = Date.now()
  for (let i = 0; i < 301; i += 1) {
    const u = await hook(async () => ({ type: "oauth", access: String(i).padStart(32, "0"), uid: `acc-${i}` }))
    assert.ok(Array.isArray(u.windows) && u.windows.length > 0, `第 ${i} 个账号必须给出窗口`)
  }
  const ms = Date.now() - started

  assert.equal(state.calls, 0, `301 个账号不许发任何上游请求，实际 ${state.calls} 次: ${state.urls.slice(0, 5).join(" | ")}`)
  // 纯本地读：301 次应当很快（真机上这一瞬间曾是 301 个网络往返）
  assert.ok(ms < 5000, `301 次本地读不该这么慢（${ms}ms）——是不是又去发请求了？`)
})

test("缓存按 uid 落盘，凭证里 accountId 也能命中（身份不匹配那次线上故障）", async (t) => {
  const entry = cacheEntry("260911173523492332")
  const dir = cfgDir(t, entry)
  const usage = usageOf({ dir })

  // 凭证里 uid 与 accountId 同时存在，且都不等于缓存键时 → 未读
  const miss = await usage({ type: "oauth", access: SESSION, uid: "other", accountId: "150****3411" })
  assert.equal(miss.windows[0].name, UNREAD_NOTE, "键都对不上就该是「未读」")

  // accountId 命中缓存键时也要能读出来（`accountKeys()` 会给多个候选）
  const hit = await usage({ type: "oauth", access: SESSION, accountId: "260911173523492332" })
  assert.notEqual(hit.windows[0].name, UNREAD_NOTE, "accountId 作为候选键必须能命中")
})

test("readUsageCache：缺文件 / 损坏 / 形状不对 → 空表（绝不抛，退化成「未读」）", (t) => {
  const missing = cfgDir(t, undefined)
  assert.deepEqual(readUsageCache(missing), { updatedAt: 0, accounts: {} })

  const broken = mkdtempSync(join(tmpdir(), "loomy-quota-broken-"))
  t.after(() => rmSync(broken, { recursive: true, force: true }))
  writeFileSync(join(broken, USAGE_CACHE_FILE), "{broken")
  assert.deepEqual(readUsageCache(broken), { updatedAt: 0, accounts: {} })

  writeFileSync(join(broken, USAGE_CACHE_FILE), JSON.stringify({ updatedAt: 7, accounts: [] }))
  assert.deepEqual(readUsageCache(broken), { updatedAt: 7, accounts: {} })

  assert.deepEqual(readUsageCache(""), { updatedAt: 0, accounts: {} }, "没有 configDir 也不能抛")
})

test("ageText：刚刚 / 分钟 / 小时 / 天", () => {
  const now = 1_800_000_000_000
  assert.equal(ageText(now - 5_000, now), "刚刚")
  assert.equal(ageText(now - 3 * 60_000, now), "3 分钟前")
  assert.equal(ageText(now - 5 * 3600_000, now), "5 小时前")
  assert.equal(ageText(now - 3 * 86400_000, now), "3 天前")
  // 时钟回拨（记录在未来）不许输出负数
  assert.equal(ageText(now + 60_000, now), "刚刚")
})