// usage-refresh.test.mjs `POST /api/usage/refresh` —— 额度**唯一的写入入口**。
//
// # 为什么要有这个入口
//
// `auth.usage` 现在只读缓存、零上游（见 `tests/quota-cache.test.mjs`）。所以
// 「额度怎么更新」这个问题只有一个答案：**用户点面板按钮**。这条链路就是那个按钮。
//
// # 钉死的东西
//
//	① 单号刷新 → 恰好 **1** 次上游请求，并写进 `loomy-usage-cache.json`
//	② 批量刷 10 个号 → 实测最大并发 **== 设置里的值**（参数化 1 / 5 / 20）
//	③ 遇风控 → **立即停止**，剩余的号一次都不打（这是保护，不是限速）
//	④ 并发/间隔全部来自设置，代码里**没有**硬上限
//	⑤ `/api/hello` 暴露 `gate: { waiting, capacity }` 便于诊断
//
// ⚠ ② 的测量必须在 `gapMs = 0` 下做：`gapMs` 是「相邻两次**启动**的间隔」，
//   它会人为压低峰值。并发是并发，节流是节流 —— 两者分开验，否则测的是混合效果。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer } from "../server.mjs"
import { usageFromPoints } from "../src/usage.mjs"
import { USAGE_CACHE_FILE } from "../src/quota-cache.mjs"

/**
 * 造一个面板夹具。
 *
 * @param {import("node:test").TestContext} t
 * @param {{accounts?: number, delayMs?: number, rateLimited?: boolean}} [options]
 */
async function fixture(t, options = {}) {
  const count = Number(options.accounts ?? 12)
  const delayMs = Number(options.delayMs ?? 15)
  const dir = mkdtempSync(join(tmpdir(), "loomy-usage-refresh-"))
  /** @type {Record<string, any>} */
  const auth = {}
  for (let i = 0; i < count; i += 1) {
    auth[`loomy#${i}`] = {
      access: `${String.fromCharCode(97 + (i % 26))}${i}`.padEnd(32, "x"),
      accountId: `138****${String(i).padStart(4, "0")}`,
      metadata: { uid: `u${i}`, nickname: `号${i}`, phone: `138****${String(i).padStart(4, "0")}` },
    }
  }
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))

  const state = { calls: 0, active: 0, peak: 0, paths: [], rateLimited: options.rateLimited === true }
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://mock.invalid/api/v1",
    log: { warn() {} },
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname
      state.calls += 1
      state.paths.push(path)
      state.active += 1
      state.peak = Math.max(state.peak, state.active)
      await new Promise((r) => setTimeout(r, delayMs))
      state.active -= 1
      if (state.rateLimited) return Response.json({ code: "429", desc: "too many requests" }, { status: 429 })
      return Response.json({ code: "000000", desc: "ok", data: { balance: 25000, dailyBalance: 1434, availableBalance: 26434 } })
    },
  })
  t.after(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return { dir, call, state, port: server.port }
}

async function waitJob(f, jobId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = (await f.call("GET", `/api/usage/refresh?jobId=${jobId}`)).body.job
    if (!job.running) return job
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(`额度刷新任务 ${jobId} 没跑完`)
}

function readUsageCacheFile(dir) {
  return JSON.parse(readFileSync(join(dir, USAGE_CACHE_FILE), "utf8"))
}

test("① 单号刷新 → 恰好 1 次上游请求，并写进 loomy-usage-cache.json", async (t) => {
  const f = await fixture(t)
  const started = await f.call("POST", "/api/usage/refresh", { uids: ["u3"] })
  assert.equal(started.status, 200)
  assert.ok(started.body.jobId, "必须立刻回 jobId（后台跑）")

  const job = await waitJob(f, started.body.jobId)
  assert.equal(job.done, 1)
  assert.equal(f.state.calls, 1, `单号刷新必须**恰好** 1 次上游请求，实际 ${f.state.calls}`)
  assert.ok(f.state.paths[0].endsWith("/points/records"), `应走积分网关，实际 ${f.state.paths[0]}`)

  const cache = readUsageCacheFile(f.dir)
  const entry = cache.accounts.u3
  assert.ok(entry, `必须写进 ${USAGE_CACHE_FILE}`)
  assert.equal(typeof entry.at, "number", "要记读数时刻（卡片靠它说「多久前」）")
  assert.ok(Array.isArray(entry.windows) && entry.windows.length >= 3, "要存算好的窗口（auth.usage 原样回给宿主）")
  assert.equal(entry.windows.find((w) => String(w.name).startsWith("额度 · 每日赠送")).amount, 1434)
  assert.equal(entry.permanent, 25000)
  // 同一次读数也要落到面板那份缓存（否则两处显示会打架）
  const accounts = JSON.parse(readFileSync(join(f.dir, "loomy-accounts-cache.json"), "utf8"))
  assert.equal(accounts.accounts.u3.balance, 26434)
})

for (const concurrency of [1, 5, 20]) {
  // ⚠ 显式 timeout：这条要真的跑出「峰值 == 设置值」，最慢的一档（并发 1）
  //    要 24 × 60ms 串行 + 轮询。并行全量时事件循环被抢占，默认超时不稳。
  test(`② 并发 = 设置值：设 ${concurrency}，刷 24 个号的实测最大并发 == ${concurrency}`, { timeout: 30000 }, async (t) => {
    const f = await fixture(t, { accounts: 24, delayMs: 60 })
    // gapMs=0：这一条验的是**并发**，不是节流；节流另有断言（见 ③ 与 refresh-jobs）
    const saved = await f.call("POST", "/api/settings", { balanceConcurrency: concurrency, gapMs: 0 })
    assert.equal(saved.status, 200)

    const uids = Array.from({ length: 24 }, (_, i) => `u${i}`)
    const started = await f.call("POST", "/api/usage/refresh", { uids })
    assert.equal(started.body.total, 24, "24 个号都要进任务（不许截断）")
    const job = await waitJob(f, started.body.jobId)

    assert.equal(job.done, 24)
    assert.equal(job.failCount, 0)
    assert.equal(f.state.calls, 24, `24 个号应当 24 次请求，实际 ${f.state.calls}`)
    assert.equal(
      f.state.peak,
      concurrency,
      `实测最大并发必须等于设置值 ${concurrency}（不是「不超过」，也不是被代码截断），实际 ${f.state.peak}`,
    )
  })
}

// ⚠ 300 个号 × 20 并发是**故意的**：`maxConcurrency: 4` / 301 个号是这个插件的
//    真实规格，压到 30 个号就把「用户设 20 就真的跑 20」这件事验成了假命题。
//    代价是这条要跑几秒 —— 并行全量时会被挤，所以显式放宽到 60s。
test("②′ 设 20 并发刷 300 个号：不截断、不报错（用户要的就是这个自由度）", { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { accounts: 300, delayMs: 2 })
  await f.call("POST", "/api/settings", { balanceConcurrency: 20, gapMs: 0 })
  const uids = Array.from({ length: 300 }, (_, i) => `u${i}`)
  const started = await f.call("POST", "/api/usage/refresh", { uids })
  const job = await waitJob(f, started.body.jobId, 60000)
  assert.equal(job.total, 300, "300 个号全部进任务")
  assert.equal(job.done, 300, "全部跑完")
  assert.ok(f.state.peak <= 20, `峰值不得超过设置值 20，实际 ${f.state.peak}`)
  assert.equal(Object.keys(readUsageCacheFile(f.dir).accounts).length, 300, "300 个号都要落盘")
})

test("③ 遇风控**立即停止**：连续 3 个号被判限流后，剩余账号一次都不打", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { delayMs: 5, rateLimited: true })
  await f.call("POST", "/api/settings", { balanceConcurrency: 1, gapMs: 0 })
  const uids = Array.from({ length: 10 }, (_, i) => `u${i}`)
  const started = await f.call("POST", "/api/usage/refresh", { uids })
  const job = await waitJob(f, started.body.jobId)

  assert.equal(job.stopped, "upstream-rate-limited", "熔断原因要能看见")
  assert.equal(job.done, 3, `连续 3 个风控就停，实际打了 ${job.done} 个`)
  assert.equal(f.state.calls, 3, `剩余 7 个号一次都不许打，实际总请求 ${f.state.calls}`)
})

test("④ 代码里没有硬上限：concurrency 传 12（> 默认）也原样生效", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { delayMs: 40 })
  await f.call("POST", "/api/settings", { gapMs: 0 })
  const started = await f.call("POST", "/api/usage/refresh", { uids: Array.from({ length: 12 }, (_, i) => `u${i}`), concurrency: 12 })
  const job = await waitJob(f, started.body.jobId)
  assert.equal(job.done, 12)
  assert.equal(f.state.peak, 12, `入参 12 必须原样生效（不许被截到 3 / 6），实际 ${f.state.peak}`)
})

test("⑤ `/api/hello` 暴露 gate：{waiting, capacity}，且容量不低于用户并发", async (t) => {
  const f = await fixture(t)
  const hello = await f.call("GET", "/api/hello")
  assert.equal(hello.status, 200)
  assert.ok(hello.body.gate, `必须暴露 gate 诊断字段，实际 ${JSON.stringify(hello.body)}`)
  assert.equal(typeof hello.body.gate.waiting, "number")
  assert.equal(hello.body.gate.waiting, 0, "空闲时不许有排队")
  assert.ok(hello.body.gate.capacity >= 20, `容量至少 20（不许把用户卡在 6），实际 ${hello.body.gate.capacity}`)

  // 用户把并发调到 40 → 闸的容量必须跟着涨（否则就是偷偷限速）
  await f.call("POST", "/api/settings", { balanceConcurrency: 40 })
  const after = await f.call("GET", "/api/hello")
  assert.ok(after.body.gate.capacity >= 40, `容量要跟着设置走，实际 ${after.body.gate.capacity}`)
})

test("参数校验：非法 uids / concurrency 一律 400，且一个请求都不发", async (t) => {
  const f = await fixture(t)
  for (const body of [{ uids: "u0" }, { uids: [1, 2] }, { uids: ["u0"], concurrency: 0 }, { uids: ["u0"], concurrency: "3" }]) {
    const res = await f.call("POST", "/api/usage/refresh", body)
    assert.equal(res.status, 400, JSON.stringify(body))
  }
  assert.equal(f.state.calls, 0, "校验失败不许花任何上游请求")
})

test("刷新后 `auth.usage`（同一份缓存）立即能读到新值，且仍然零上游", async (t) => {
  const f = await fixture(t)
  await f.call("POST", "/api/settings", { gapMs: 0 })
  const started = await f.call("POST", "/api/usage/refresh", { uids: ["u0"] })
  await waitJob(f, started.body.jobId)
  const afterRefresh = f.state.calls

  // 用同一份缓存目录起一个 usage hook（等价于 magpie 那边读文件）
  const { makeUsageHook } = await import("../src/hooks/usage.mjs")
  const hook = makeUsageHook({ configDir: f.dir, log: { warn() {} } })
  const u = await hook(async () => ({ type: "oauth", access: "s".repeat(32), uid: "u0" }))

  assert.equal(f.state.calls, afterRefresh, "读缓存不许再打上游")
  assert.ok(
    (u.windows ?? []).some((w) => String(w.name).startsWith("额度 · 每日赠送")),
    `刷新后卡片要能读到额度，实际: ${JSON.stringify(u.windows)}`,
  )
  // 缓存里那份窗口形状与 usageFromPoints 一致（防止两边各写一套映射）
  const cached = readUsageCacheFile(f.dir).accounts.u0
  assert.deepEqual(cached.windows, usageFromPoints({ available: 26434, daily: 1434, dailyKnown: true, permanent: 25000, permanentKnown: true }).windows)
})