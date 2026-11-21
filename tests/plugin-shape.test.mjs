// plugin-shape.test.mjs 入口钩子集合的「形状契约」（T-38 的四条证据）。
//
// # 这一集专门钉三件事
//
//	1. **`auth.refresh` 不存在**（不是空壳）：本上游没有 refresh token，session
//	   也不会过期（见 `src/credential.mjs`）。造一个空 refresh 会让 magpie 以为
//	   「能自动恢复」，从而把换号重试当成有效处置。
//	2. **`auth.usage` 零上游**：它只读 `<configDir>/loomy-usage-cache.json`。
//	   T-54 之前这里是「每个账号打一次 `/points/records`」—— 301 个号全挤在启动
//	   瞬间，上游风控直接成批掉号（用户原话：「一定不可以这样」）。
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

test("`auth.usage` **零上游**：连调 301 次一个请求都不发（T-54 核心回归）", async (t) => {
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
  /** @type {any} */
  let last
  for (let i = 0; i < 301; i += 1) {
    last = await p.auth.usage(async () => ({ type: "oauth", access: String(i).padStart(32, "0"), uid: `acc-${i}` }))
  }

  // ⚠ 这正是用户在 `app.log` 里数出来的那 301 次 `GET /points/records`。
  //    它曾经全挤在启动瞬间 ⇒ 上游风控 ⇒ 成批掉号。现在必须是 0。
  assert.deepEqual(urls, [], `auth.usage 不许打上游，实际: ${urls.join(" | ")}`)
  assert.equal(last.error, undefined, "「还没读过」不是错误（error 会整块替换额度区）")
  assert.ok(Array.isArray(last.windows) && last.windows.length > 0, "仍要给出一条「额度未读」说明")
  assert.ok(
    last.windows.some((w) => String(w.name).startsWith("说明 · ") && w.aside === true),
    `应当是「说明 · 额度未读」，实际: ${JSON.stringify(last.windows)}`,
  )
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