// plugin-shape.test.mjs 入口钩子集合的「形状契约」（T-38 的四条证据）。
//
// # 这一集专门钉三件事
//
//	1. **`auth.refresh` 不存在**（不是空壳）：本上游没有 refresh token，session
//	   也不会过期（见 `src/credential.mjs`）。造一个空 refresh 会让 magpie 以为
//	   「能自动恢复」，从而把换号重试当成有效处置。
//	2. **`auth.usage` 真的打上游**：先积分网关 `/points/records`，失败才回落本机
//	   缓存。用户明确要求「usage 这些也不要改」，所以这里断言它**会**发请求。
//	3. **`auth.models` 的缓存不再按账号打上游**：301 个号并发只 1 次请求
//	   （`tests/models-cache.test.mjs` 有完整版，这里用入口钩子再钉一遍）。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LoomyAuthPlugin } from "../index.mjs"

const SESSION = "s".repeat(32)
const UID = "260911173523492332"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-shape-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("`auth.refresh` / `auth.checkin` 不存在（typeof === \"undefined\"）", async () => {
  const p = await LoomyAuthPlugin({}, {})
  assert.equal(typeof p.auth.refresh, "undefined", "不提供 refresh —— 宿主据此知道「本上游只能人工重登」")
  assert.equal(typeof p.auth.checkin, "undefined", "不提供 checkin —— 上游日额度服务端自动重置")
  assert.ok(!("refresh" in p.auth), "连键都不该有（空壳会自动恢复误判）")
})

test("`auth.usage` 会真实打上游（积分网关 ≥1 次请求）", async (t) => {
  const dir = tempDir(t)
  /** @type {string[]} */
  const urls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return Response.json({ code: "000000", desc: "ok", data: { balance: 25000, dailyBalance: 1434, availableBalance: 26434 } })
  }
  t.after(() => {
    globalThis.fetch = real
  })

  const p = await LoomyAuthPlugin({ directory: dir }, {})
  const usage = await p.auth.usage(async () => ({ type: "oauth", access: SESSION, uid: UID }))

  assert.ok(urls.length >= 1, `auth.usage 必须至少打一次上游，实际 ${urls.length}`)
  assert.ok(urls.some((u) => u.includes("/points/records")), `应当走积分网关，实际: ${urls.join(" | ")}`)
  assert.ok(Array.isArray(usage.windows) && usage.windows.length > 0, "额度窗口要真的算出来")
  assert.equal(usage.error, undefined, "有数据时不许塞 error（那会整块替换额度区）")
})

test("`provider.models` 走文件缓存：同一个 baseUrl 并发 301 次只 1 次上游", async (t) => {
  const dir = tempDir(t)
  let calls = 0
  const real = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({ code: "000000", data: [{ id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash(x2.0)" }] })
  }
  t.after(() => {
    globalThis.fetch = real
  })

  const p = await LoomyAuthPlugin({ directory: dir }, {})
  const auth = (i) => ({ type: "oauth", access: String(i).padStart(32, "0"), uid: `acc-${i}` })

  await Promise.all(Array.from({ length: 301 }, (_, i) => p.provider.models({ models: {} }, { auth: auth(i) })))

  assert.equal(calls, 1, `301 个账号并发只该产生 1 次 /models 请求，实际 ${calls}`)
  assert.ok(existsSync(join(dir, "loomy-models-cache.json")), "拉成功后必须落盘（重启就不再发请求）")

  // 再来一轮（模拟 magpie 重启）：文件命中 ⇒ 0 次
  const before = calls
  await p.provider.models({ models: {} }, { auth: auth(999) })
  assert.equal(calls, before, "缓存命中时绝不许再打上游")
})