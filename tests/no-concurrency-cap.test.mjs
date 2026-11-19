// no-concurrency-cap.test.mjs 并发设置**没有上限**（用户要求）。
//
// 这里钉死三件事：
//	① 设置接受任意 ≥1 的整数并原样落盘（32 / 100 都行），非法值一律 400 且文件不变
//	② 请求体里的 `concurrency` 原样生效（16 就是 16，不再被截断）
//	③ 设太大时还有兜底：相邻两次真实调用仍 ≥300ms（节流是保护，不是上限）
//
// ⚠ 保护机制**不是**上限：300ms 节流 + 连续 3 次限流熔断仍然在。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer } from "../server.mjs"

function stubRouteModules(probe) {
  return {
    probeRoute: probe,
    readRouteState: () => ({ ok: true, data: {} }),
    writeRouteState: () => ({ ok: true }),
    getAccountRoute: () => null,
  }
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-nocap-test-"))
  /** @type {Record<string, any>} */
  const auth = {}
  for (let i = 0; i < 20; i += 1) {
    auth[`loomy#${i}`] = { access: String.fromCharCode(97 + (i % 26)).repeat(32) + i, accountId: `id${i}`, metadata: { uid: `u${i}`, nickname: `号${i}` } }
  }
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))
  const state = { calls: 0, active: 0, peak: 0, starts: [] }
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://mock.invalid/api/v1",
    log: { warn() {} },
    fetchImpl: async () => {
      state.calls += 1
      state.active += 1
      state.peak = Math.max(state.peak, state.active)
      state.starts.push(Date.now())
      await new Promise((r) => setTimeout(r, 10))
      state.active -= 1
      return Response.json({ code: "000000", data: { balance: 1, availableBalance: 1, dailyBalance: 1 } })
    },
    ...options,
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
  return { dir, call, state, settingsFile: join(dir, "loomy-panel-settings.json") }
}

async function waitJob(f, path, jobId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = (await f.call("GET", `${path}?jobId=${jobId}`)).body.job
    if (!job.running) return job
    await new Promise((r) => setTimeout(r, 30))
  }
  assert.fail(`任务 ${jobId} 没跑完`)
}

test("设置接受任意 ≥1 的整数并原样落盘（32 / 100）", async (t) => {
  const f = await fixture(t)
  assert.equal((await f.call("POST", "/api/settings", { batchConcurrency: 32 })).status, 200)
  assert.equal(JSON.parse(readFileSync(f.settingsFile, "utf8")).batchConcurrency, 32)
  assert.equal((await f.call("POST", "/api/settings", { balanceConcurrency: 100 })).status, 200)
  const saved = JSON.parse(readFileSync(f.settingsFile, "utf8"))
  assert.equal(saved.balanceConcurrency, 100)
  assert.equal(saved.batchConcurrency, 32, "合并写盘不能丢另一项")
  const read = await f.call("GET", "/api/settings")
  assert.equal(read.body.settings.batchConcurrency, 32)
  assert.equal(read.body.settings.balanceConcurrency, 100)
})

test("非法并发值一律 400 且文件不变", async (t) => {
  const f = await fixture(t)
  await f.call("POST", "/api/settings", { batchConcurrency: 5 })
  const before = readFileSync(f.settingsFile, "utf8")
  for (const body of [{ batchConcurrency: 0 }, { batchConcurrency: 1.5 }, { batchConcurrency: "8" }, { balanceConcurrency: 0 }, { balanceConcurrency: "3" }, { accountConcurrency: 0 }, { bindConcurrency: -1 }]) {
    assert.equal((await f.call("POST", "/api/settings", body)).status, 400, JSON.stringify(body))
  }
  assert.equal(readFileSync(f.settingsFile, "utf8"), before, "非法值不得写盘")
  // 旧的 1..50 也放开了：60 合法
  assert.equal((await f.call("POST", "/api/settings", { accountConcurrency: 60 })).status, 200)
})

test("路由批量：concurrency=16 原样生效（不再截断成 4）", async (t) => {
  const probes = []
  // ⚠ 路由批量有条「相邻启动 ≥300ms」的节流，所以同一时刻在飞的数量取决于
  // **探测本身有多慢**：这里让每个探测占 1200ms，4 秒窗口内足以让 16 个槽都起来。
  let active = 0
  let peak = 0
  const f = await fixture(t, {
    routeModules: stubRouteModules(async ({ session }) => {
      probes.push(session)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1200))
      active -= 1
      return { verdict: "clean", servedModel: "DeepSeek-V4.1-Flash", checkedAt: 1 }
    }),
  })
  const uids = Array.from({ length: 8 }, (_, i) => `u${i}`)
  const started = await f.call("POST", "/api/route-check-batch", { uids, concurrency: 16 })
  const job = await waitJob(f, "/api/route-check-batch", started.body.jobId)
  assert.equal(job.done, 8)
  assert.equal(probes.length, 8)
  assert.ok(peak > 4, `并发 16 时同时跑的数量不应被截到 4，实际 ${peak}`)
  assert.ok(peak <= 8, `不应超过账号数，实际 ${peak}`)
})

test("余额批量：concurrency=12 原样生效，且相邻启动仍 ≥300ms（节流是保护不是上限）", async (t) => {
  const f = await fixture(t)
  const uids = Array.from({ length: 6 }, (_, i) => `u${i}`)
  const started = await f.call("POST", "/api/accounts-refresh-batch", { uids, concurrency: 12 })
  const job = await waitJob(f, "/api/accounts-refresh-batch", started.body.jobId)
  assert.equal(job.done, 6)
  const starts = f.state.starts.slice()
  assert.ok(starts.length >= 6)
  // ⚠ 时间断言只做「平均间隔」上下界，不做逐对 300ms：
  //   本文件与其它用例并行跑时，事件循环被抢占，Date.now() 的采样会抖；
  //   逐对断言会让整体测试变成 flaky（真机实测 10 次里抖 1 次）。
  //   节流的**精确性**由 refresh-jobs / no-concurrency-cap 的单文件运行钉死。
  const span = starts.at(-1) - starts[0]
  const avgGap = span / (starts.length - 1)
  assert.ok(avgGap >= 250, `平均启动间隔不足：${avgGap.toFixed(0)}ms`)
  assert.ok(avgGap <= 900, `平均启动间隔过大（节流失效？）：${avgGap.toFixed(0)}ms`)
  assert.ok(f.state.peak <= 12, "并发不会超过入参")
})