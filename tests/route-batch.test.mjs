// route-batch.test.mjs 批量检测 / 余额缓存 / 设置 / resolveSession 的回归集。
//
// # 这一集在钉什么
//
//	· 批量检测是**异步任务**：立刻回 jobId，后台 2 并发 + 300ms 节流 + 连续限流熔断
//	· 打开面板**零上游请求**：`GET /api/accounts` 只读缓存（fetchImpl 调用数 = 0）
//	· 换号事故：uid 缺失/找不到时**绝不**回落到 accounts[0]
//	· 设置：新文件、默认值、非法值不写盘
//
// ⚠ src/route.mjs / src/route-store.mjs 通过 `routeModules` 注入本地桩，
// 这两个模块的真实实现属于另一条任务线。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer, routeLabel, routeCostHint } from "../server.mjs"

const S0 = "a".repeat(32)
const S1 = "b".repeat(32)

/** 状态仓库桩（与 route-store 契约同形）。 */
function stubStore() {
  const file = (dir) => join(dir, "route-state.json")
  return {
    readRouteState(configDir) {
      if (!existsSync(file(configDir))) return { ok: true, data: {} }
      try {
        return { ok: true, data: JSON.parse(readFileSync(file(configDir), "utf8")) }
      } catch (e) {
        return { ok: false, data: {}, error: String(e?.message ?? e) }
      }
    },
    writeRouteState(configDir, uid, entry) {
      const current = this.readRouteState(configDir)
      writeFileSync(file(configDir), JSON.stringify({ ...(current.ok ? current.data : {}), [uid]: entry }))
      return { ok: true }
    },
    getAccountRoute(configDir, uid) {
      return this.readRouteState(configDir).data[uid] ?? null
    },
  }
}

/** 假上游：/points/records 返回一条账本记录；chat 恒成功。 */
function upstreamFor(state) {
  return async (url) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith("/points/records")) {
      if (state.rateLimited) return Response.json({ code: "429", desc: "too many requests" }, { status: 429 })
      return Response.json({ code: "000000", data: [{ id: "led", createdAt: "2026-11-19T00:00:00Z", modelName: "spark-x2.6-low" }] })
    }
    if (path.endsWith("/chat/completions")) {
      if (state.rateLimited) return Response.json({ code: "429", desc: "rate limit" }, { status: 429 })
      return Response.json({ code: "000000", data: { created: 1795000000, model: "DeepSeek-V4.1-Flash" } })
    }
    return Response.json({ code: "000000", data: {} })
  }
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-batch-test-"))
  // 5 个号：批量/跳过/熔断都需要多个真实存在的 uid
  //（拿不到 session 的号根本到不了 probe，会把断言测成「0 次调用」）
  const auth = {
    loomy: { access: S0, accountId: "138****0000", metadata: { uid: "u0", nickname: "甲", phone: "138****0000" } },
    "loomy#1": { access: S1, accountId: "139****1111", metadata: { uid: "u1", nickname: "乙", phone: "139****1111" } },
    "loomy#2": { access: "c".repeat(32), accountId: "137****2222", metadata: { uid: "u2", nickname: "丙", phone: "137****2222" } },
    "loomy#3": { access: "d".repeat(32), accountId: "136****3333", metadata: { uid: "u3", nickname: "丁", phone: "136****3333" } },
    "loomy#4": { access: "e".repeat(32), accountId: "135****4444", metadata: { uid: "u4", nickname: "戊", phone: "135****4444" } },
  }
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))
  const state = { calls: 0, rateLimited: false }
  const upstream = upstreamFor(state)
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://mock.invalid/api/v1",
    log: { warn() {} },
    fetchImpl: async (...args) => { state.calls += 1; return upstream(...args) },
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
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text), text }))
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body))
  })
  return { dir, call, state }
}

/** 等到条件成立（异步任务在后台跑，没有回调可等）。 */
async function until(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(`等不到：${label}`)
}

function routeModules(probe, store = stubStore()) {
  return { probeRoute: probe, readRouteState: store.readRouteState, writeRouteState: store.writeRouteState, getAccountRoute: store.getAccountRoute }
}

const okEntry = { verdict: "clean", servedModel: "DeepSeek-V4.1-Flash", reason: "ledger-deepseek", checkedAt: 1 }

test("批量检测：无条数上限（500 个也接受），空数组/非数组/非字符串元素仍是 400", async (t) => {
  let probes = 0
  const store = stubStore()
  const f = await fixture(t, { routeModules: routeModules(async () => { probes += 1; return okEntry }, store) })
  // 空数组：没有意义 → 400
  assert.equal((await f.call("POST", "/api/route-check-batch", { uids: [] })).status, 400)
  // 非数组 → 400
  assert.equal((await f.call("POST", "/api/route-check-batch", { uids: "abc" })).status, 400)
  // 元素混入非字符串 → 400（口径：整批拒绝，不做静默丢弃）
  assert.equal((await f.call("POST", "/api/route-check-batch", { uids: [1, "a"] })).status, 400)
  assert.equal(probes, 0, "以上三种都必须在校验阶段拦下，不进队列")

  // 500 个：**不再 400**。为了不在 CI 里真跑 500 次节流探测（150 秒），
  // 这里让其中 495 个已有 clean 结论（跳过），只有 5 个要测。
  const many = Array.from({ length: 500 }, (_, i) => `x${i}`)
  const seeded = Object.fromEntries(many.slice(0, 495).map((uid) => [uid, { verdict: "clean", reason: "ledger-deepseek" }]))
  writeFileSync(join(f.dir, "route-state.json"), JSON.stringify(seeded))
  const started = await f.call("POST", "/api/route-check-batch", { uids: many })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.skippedTotal, 495)
  assert.equal(started.body.total, 5, "job.total 只算待测数，不是传入条数")

  // ⚠ 不再用「500 个全部要测」的第二种断言：那会在 CI 里真跑 150 秒节流探测
  //   （进程还得等计时器）。上面这条已经证明「500 条的载荷被接受」，而
  //   `total` 只统计待测数这条口径也一并钉住了。
})

test("批量检测：立刻回 jobId（<100ms），进度单调走到 total", async (t) => {
  let running = 0
  let peak = 0
  const probes = []
  const f = await fixture(t, {
    routeModules: routeModules(async () => {
      probes.push(Date.now())
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 30))
      running -= 1
      return okEntry
    }),
  })
  const uids = ["u0", "u1", "u0", "u1", "u0"]
  const begin = Date.now()
  const started = await f.call("POST", "/api/route-check-batch", { uids, concurrency: 2 })
  assert.equal(started.status, 200)
  assert.ok(Date.now() - begin < 100, "必须立刻返回 jobId")
  assert.equal(started.body.total, 2, "去重后只剩 2 个 uid")
  const seen = []
  for (let i = 0; i < 200; i += 1) {
    const progress = await f.call("GET", `/api/route-check-batch?jobId=${started.body.jobId}`)
    const job = progress.body.job
    seen.push(job.done)
    if (!job.running) break
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.equal(seen.at(-1), 2)
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] >= seen[i - 1], "进度不能倒退")
  assert.equal(probes.length, 2)
  assert.ok(peak <= 2, `并发不得超过 2，实际 ${peak}`)
})

test("批量检测：单个号失败不影响其它号，failCount 记 1", async (t) => {
  const f = await fixture(t, {
    routeModules: routeModules(async ({ session }) => {
      if (session === S1) throw new Error("chat-error: HTTP 500")
      return okEntry
    }),
  })
  const started = await f.call("POST", "/api/route-check-batch", { uids: ["u0", "u1"] })
  let job
  await until(async () => false, "", 0).catch(() => {})
  for (let i = 0; i < 200; i += 1) {
    job = (await f.call("GET", `/api/route-check-batch?jobId=${started.body.jobId}`)).body.job
    if (!job.running) break
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(job.failCount, 1)
  assert.equal(job.okCount, 1)
  assert.match(job.results.u1.error, /探测失败/)
})

test("批量检测：unknown 不覆盖已有 clean；未知 jobId → 404", async (t) => {
  const store = stubStore()
  const f = await fixture(t, { routeModules: routeModules(async () => ({ ...okEntry, verdict: "unknown", reason: "ledger-unreadable" }), store) })
  const before = { verdict: "clean", servedModel: "DeepSeek-V4.1-Flash", checkedAt: 9 }
  writeFileSync(join(f.dir, "route-state.json"), JSON.stringify({ u0: before }))
  const started = await f.call("POST", "/api/route-check-batch", { uids: ["u0"], skipChecked: false })
  for (let i = 0; i < 200; i += 1) {
    const job = (await f.call("GET", `/api/route-check-batch?jobId=${started.body.jobId}`)).body.job
    if (!job.running) break
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "route-state.json"), "utf8")).u0, before)
  assert.equal((await f.call("GET", "/api/route-check-batch?jobId=nope")).status, 404)
})

test("批量检测：跳过已有结论（unknown 要测），全跳过时不建任务", async (t) => {
  let probes = 0
  const store = stubStore()
  const f = await fixture(t, {
    routeModules: routeModules(async () => { probes += 1; return okEntry }, store),
  })
  writeFileSync(join(f.dir, "route-state.json"), JSON.stringify({
    u0: { verdict: "routed", reason: "ledger-spark" },
    u1: { verdict: "clean", reason: "ledger-deepseek" },
    u2: { verdict: "unknown", reason: "ledger-unreadable" },
  }))
  // 5 个 uid：2 个已有结论、1 个 unknown、2 个无记录 → 待测 3
  const started = await f.call("POST", "/api/route-check-batch", { uids: ["u0", "u1", "u2", "u3", "u4"] })
  assert.equal(started.body.total, 3)
  assert.deepEqual(started.body.skipped.sort(), ["u0", "u1"])
  for (let i = 0; i < 200; i += 1) {
    const job = (await f.call("GET", `/api/route-check-batch?jobId=${started.body.jobId}`)).body.job
    if (!job.running) break
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(probes, 3)

  // 全部都有结论 → 不创建任务、不探测
  const before = probes
  const skippedAll = await f.call("POST", "/api/route-check-batch", { uids: ["u0", "u1"] })
  assert.equal(skippedAll.body.jobId, "")
  assert.equal(skippedAll.body.total, 0)
  assert.match(skippedAll.body.message, /没有需要检测的账号/)
  assert.equal(probes, before)

  // skipChecked:false → 全都进待测组
  const all = await f.call("POST", "/api/route-check-batch", { uids: ["u0", "u1"], skipChecked: false })
  assert.equal(all.body.total, 2)
  assert.deepEqual(all.body.skipped, [])
})

test("批量检测：连续 3 个 429 → 熔断，剩余号不再调用", async (t) => {
  let probes = 0
  const f = await fixture(t, {
    routeModules: routeModules(async () => {
      probes += 1
      throw new Error("chat-error: HTTP 429 too many requests")
    }),
  })
  const started = await f.call("POST", "/api/route-check-batch", { uids: ["u0", "u1", "u2", "u3", "u4"], skipChecked: false, concurrency: 1 })
  let job
  for (let i = 0; i < 300; i += 1) {
    job = (await f.call("GET", `/api/route-check-batch?jobId=${started.body.jobId}`)).body.job
    if (!job.running) break
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(job.stopped, "upstream-rate-limited")
  assert.equal(probes, 3, "熔断后不得继续打上游")
})

test("批量检测：相邻两次探测启动间隔 ≥300ms", async (t) => {
  const starts = []
  const f = await fixture(t, {
    routeModules: routeModules(async () => { starts.push(Date.now()); return okEntry }),
  })
  const started = await f.call("POST", "/api/route-check-batch", { uids: ["u0", "u1"], skipChecked: false, concurrency: 2 })
  for (let i = 0; i < 300; i += 1) {
    const job = (await f.call("GET", `/api/route-check-batch?jobId=${started.body.jobId}`)).body.job
    if (!job.running) break
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(starts.length, 2)
  assert.ok(starts[1] - starts[0] >= 290, `节流不足：${starts[1] - starts[0]}ms`)
})

test("设置：默认值、非法值不写盘、合法值落盘", async (t) => {
  const f = await fixture(t)
  const first = await f.call("GET", "/api/settings")
  // 第 17/18 轮把并发拆成「每个 job 一条」并加了 gapMs / autoApply / magpiePath：
  // 期望集合必须跟着服务端真实形状走（这些键都是用户明确要求的，不许为了测试删掉）。
  assert.deepEqual(first.body.settings, {
    accountConcurrency: 20,
    bindConcurrency: 20,
    routeConcurrency: 2,
    batchConcurrency: 2,
    balanceConcurrency: 2,
    tasksConcurrency: 2,
    inviteConcurrency: 2,
    patrolConcurrency: 2,
    gapMs: 300,
    autoApply: true,
    magpiePath: "",
    batchSkipChecked: true,
    ledgerReads: 3,
    focusRefresh: false,
  })
  assert.equal((await f.call("POST", "/api/settings", { batchConcurrency: 0 })).status, 400)
  // 新键同样要挡住非法值（第 17/18 轮新增：每类并发、gapMs、autoApply、magpiePath）
  for (const body of [
    { routeConcurrency: 0 },
    { tasksConcurrency: 1.5 },
    { inviteConcurrency: "8" },
    { patrolConcurrency: null },
    { gapMs: -1 },
    { gapMs: 9999 },
    { autoApply: "true" },
    { magpiePath: 123 },
  ]) {
    assert.equal((await f.call("POST", "/api/settings", body)).status, 400, JSON.stringify(body))
  }
  assert.equal(existsSync(join(f.dir, "loomy-panel-settings.json")), false, "非法值不得写盘")
  assert.equal((await f.call("POST", "/api/settings", { batchConcurrency: 3 })).status, 200)
  const saved = JSON.parse(readFileSync(join(f.dir, "loomy-panel-settings.json"), "utf8"))
  assert.equal(saved.batchConcurrency, 3)
  // 别名双写：写老键必须同时写新键，两者永远一致
  assert.equal(saved.routeConcurrency, 3, "batchConcurrency 是 routeConcurrency 的别名，必须双写")
  assert.equal((await f.call("GET", "/api/settings")).body.settings.batchConcurrency, 3)
  assert.equal((await f.call("GET", "/api/settings")).body.settings.routeConcurrency, 3)
  // 损坏的文件 → 回默认值，不抛
  writeFileSync(join(f.dir, "loomy-panel-settings.json"), "{not json")
  assert.equal((await f.call("GET", "/api/settings")).body.settings.batchConcurrency, 2)
})

test("GET /api/accounts 零上游请求：空缓存 / 有缓存 / 损坏缓存都不 fetch", async (t) => {
  const f = await fixture(t, { routeModules: routeModules(async () => okEntry) })
  const empty = await f.call("GET", "/api/accounts")
  assert.equal(empty.status, 200)
  assert.equal(f.state.calls, 0, "打开面板不得发任何上游请求")
  assert.ok(empty.body.accounts.every((a) => a.cached === false && a.at === 0))

  writeFileSync(join(f.dir, "loomy-accounts-cache.json"), JSON.stringify({
    updatedAt: 1795053000000,
    accounts: { u0: { balance: 34689, daily: 4689, permanent: 30000, at: 1795052000000, error: "" } },
  }))
  const cached = await f.call("GET", "/api/accounts")
  const row = cached.body.accounts.find((a) => a.uid === "u0")
  assert.equal(row.cached, true)
  assert.equal(row.at, 1795052000000)
  assert.equal(cached.body.updatedAt, 1795053000000)

  writeFileSync(join(f.dir, "loomy-accounts-cache.json"), "{broken")
  const broken = await f.call("GET", "/api/accounts")
  assert.equal(broken.status, 200)
  assert.ok(broken.body.accounts.every((a) => a.cached === false))
  assert.equal(f.state.calls, 0)
})

test("余额刷新任务：立刻回 jobId，写缓存，单行只动自己", async (t) => {
  const f = await fixture(t, {
    routeModules: routeModules(async () => okEntry),
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith("/points/records")) {
        return Response.json({ code: "000000", data: { balance: 100, dailyBalance: 40, availableBalance: 100 } })
      }
      return Response.json({ code: "000000", data: {} })
    },
  })
  const begin = Date.now()
  const started = await f.call("POST", "/api/accounts-refresh-batch", { uids: ["u0", "u1"] })
  assert.ok(Date.now() - begin < 100)
  let job
  for (let i = 0; i < 300; i += 1) {
    job = (await f.call("GET", `/api/accounts-refresh-batch?jobId=${started.body.jobId}`)).body.job
    if (!job.running) break
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(job.done, 2)
  const cache = JSON.parse(readFileSync(join(f.dir, "loomy-accounts-cache.json"), "utf8"))
  assert.equal(cache.accounts.u0.balance, 100)
  assert.equal(cache.accounts.u1.balance, 100)

  // 单行刷新只写自己：先把 u1 的缓存改成哨兵值，再刷 u0
  cache.accounts.u1.balance = 777
  writeFileSync(join(f.dir, "loomy-accounts-cache.json"), JSON.stringify(cache))
  const one = await f.call("POST", "/api/accounts-refresh", { uid: "u0" })
  assert.equal(one.body.ok, true)
  const after = JSON.parse(readFileSync(join(f.dir, "loomy-accounts-cache.json"), "utf8"))
  assert.equal(after.accounts.u1.balance, 777, "单行刷新不得动别的号")
})

test("resolveSession：uid 为空不回落第一个号；按 accountId 能命中", async (t) => {
  const f = await fixture(t, { routeModules: routeModules(async () => okEntry) })
  const missing = await f.call("POST", "/api/do", { action: "first-login" })
  assert.equal(missing.body.ok, false)
  assert.match(missing.body.error, /uid/)
  assert.equal(f.state.calls, 0, "缺 uid 时绝不能拿别人的号去打上游")

  const byAccountId = await f.call("POST", "/api/do", { action: "first-login", uid: "139****1111" })
  assert.equal(byAccountId.body.ok, true, "accountId（手机号）也要能解析到账号")

  const unknown = await f.call("POST", "/api/do", { action: "first-login", uid: "不存在的号" })
  assert.equal(unknown.body.ok, false)
  assert.match(unknown.body.error, /找不到账号/)
})

test("routeLabel 按 reason 分文案，costHint 区分免费/计费", () => {
  const catalog = routeLabel({ verdict: "routed", reason: "catalog-missing-ds41" })
  const spark = routeLabel({ verdict: "routed", reason: "ledger-spark" })
  const other = routeLabel({ verdict: "routed", reason: "ledger-other-family", servedModel: "glm-5" })
  assert.notEqual(catalog, spark)
  assert.match(catalog, /目录无 DS4\.1/)
  assert.match(spark, /整号停用/)
  assert.match(other, /被换到其它厂商（→ glm-5）/)
  assert.equal(routeLabel({ verdict: "clean", reason: "ledger-deepseek" }), "正常")
  assert.equal(routeLabel({ verdict: "unknown" }), "未检测 / 检测不完整")
  assert.equal(routeCostHint({ reason: "catalog-missing-ds41" }), "免费判定")
  assert.equal(routeCostHint({ reason: "ledger-spark" }), "已扣 1 积分")
})
