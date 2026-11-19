// patrol-api.test.mjs 免费巡检**面板接口**（0 积分）。
//
// `src/patrol.mjs` 的单元行为由另一条任务线的 `tests/patrol.test.mjs` 覆盖；
// 这里只钉面板这一层：
//	① `POST /api/route-patrol-batch` 立刻回 jobId，且全程 **0 次 chat/completions**
//	② `keep:true` 的号：verdict **不变**，只更新 `catalogOkAt`
//	③ 有结论（目录缺失等免费判定）的号：覆盖 verdict
//	④ `GET ?jobId=` 带 `costHint:0` 与 `kept` 计数
//	⑤ `uids` 省略 = 全部；`uids: []` → 400

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer } from "../server.mjs"

function stubStore() {
  const file = (dir) => join(dir, "loomy-route-state.json")
  return {
    routeStatePath: (dir) => file(dir),
    readRouteState(dir) {
      if (!existsSync(file(dir))) return { ok: true, data: {} }
      try { return { ok: true, data: JSON.parse(readFileSync(file(dir), "utf8")) } } catch { return { ok: true, data: {} } }
    },
    writeRouteState(dir, uid, entry) {
      const cur = this.readRouteState(dir).data
      writeFileSync(file(dir), JSON.stringify({ ...cur, [uid]: entry }, null, 2))
      return { ok: true }
    },
    getAccountRoute(dir, uid) { return this.readRouteState(dir).data[uid] ?? null },
  }
}

/** `catalog`：模型目录里给什么；`ledger`：账本第一页给什么。 */
function upstream(seen, { catalog = ["DeepSeek-V4.1-Flash"], ledger = [] } = {}) {
  return async (url) => {
    const path = new URL(String(url)).pathname
    seen.push(path)
    if (path.endsWith("/models")) return Response.json({ code: "000000", data: catalog.map((id) => ({ id })) })
    if (path.endsWith("/points/records")) return Response.json({ code: "000000", data: ledger })
    return Response.json({ code: "000000", data: {} })
  }
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-patrol-api-"))
  const auth = {}
  for (let i = 0; i < 4; i += 1) auth[`loomy#${i}`] = { access: String.fromCharCode(97 + i).repeat(32), metadata: { uid: `u${i}` } }
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))
  const seen = []
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    log: { warn() {} },
    routeModules: { probeRoute: async () => { throw new Error("巡检不得走付费探测") }, ...stubStore() },
    fetchImpl: upstream(seen, options.upstream),
    ...options,
  })
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }) })
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return { dir, call, seen, stateFile: () => join(dir, "loomy-route-state.json") }
}

async function waitJob(f, jobId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = (await f.call("GET", `/api/route-patrol-batch?jobId=${jobId}`)).body.job
    if (!job.running) return job
    await new Promise((r) => setTimeout(r, 30))
  }
  assert.fail("巡检任务没跑完")
}

test("① 巡检立刻回 jobId，且全程 0 次 chat/completions", async (t) => {
  const f = await fixture(t)
  const begin = Date.now()
  const started = await f.call("POST", "/api/route-patrol-batch", { uids: ["u0", "u1"] })
  assert.ok(Date.now() - begin < 500, "必须立刻回 jobId")
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.costHint, 0)
  await waitJob(f, started.body.jobId)
  assert.equal(f.seen.filter((p) => p.endsWith("/chat/completions")).length, 0, "巡检绝不发 chat")
  assert.ok(f.seen.some((p) => p.endsWith("/models")), "至少要读模型目录")
})

test("② keep:true：verdict 不变，只更新 catalogOkAt", async (t) => {
  // 目录里有 DS4.1、账本空 → 巡检拿不到结论 → keep
  const f = await fixture(t, { upstream: { catalog: ["DeepSeek-V4.1-Flash", "GLM-5.3-Flash"], ledger: [] } })
  const before = { verdict: "clean", reason: "ledger-deepseek", checkedAt: 111, catalogOkAt: 0 }
  writeFileSync(f.stateFile(), JSON.stringify({ u0: before }))
  const started = await f.call("POST", "/api/route-patrol-batch", { uids: ["u0"] })
  const job = await waitJob(f, started.body.jobId)
  assert.equal(job.kept, 1, "这条应该是 keep")
  const saved = JSON.parse(readFileSync(f.stateFile(), "utf8")).u0
  assert.equal(saved.verdict, "clean", "keep 不得改 verdict")
  assert.equal(saved.checkedAt, before.checkedAt, "keep 不得改 checkedAt")
  assert.ok(Number(saved.catalogOkAt) > 0, "keep 只更新 catalogOkAt")
})

test("③ 免费判定有结论时覆盖 verdict（目录缺失 → routed）", async (t) => {
  const f = await fixture(t, { upstream: { catalog: ["spark-x2.6"], ledger: [] } })
  writeFileSync(f.stateFile(), JSON.stringify({ u0: { verdict: "clean", checkedAt: 1 } }))
  const started = await f.call("POST", "/api/route-patrol-batch", { uids: ["u0"] })
  const job = await waitJob(f, started.body.jobId)
  assert.equal(job.updated, 1)
  const saved = JSON.parse(readFileSync(f.stateFile(), "utf8")).u0
  assert.equal(saved.verdict, "routed")
  assert.match(String(saved.reason), /catalog-missing/)
})

test("④ 进度带 costHint:0 与 kept 计数", async (t) => {
  const f = await fixture(t)
  const started = await f.call("POST", "/api/route-patrol-batch", { uids: ["u0"] })
  const job = await waitJob(f, started.body.jobId)
  assert.equal(job.costHint, 0)
  assert.equal(typeof job.kept, "number")
  assert.equal(typeof job.updated, "number")
  assert.equal(job.done, 1)
  assert.equal(job.kind, "patrol")
})

test("⑤ uids 省略 = 全部；空数组 / 非数组 / 非字符串 → 400", async (t) => {
  const f = await fixture(t)
  const all = await f.call("POST", "/api/route-patrol-batch", {})
  assert.equal(all.status, 200)
  assert.equal(all.body.total, 4)
  await waitJob(f, all.body.jobId)

  assert.equal((await f.call("POST", "/api/route-patrol-batch", { uids: [] })).status, 400)
  assert.equal((await f.call("POST", "/api/route-patrol-batch", { uids: "abc" })).status, 400)
  assert.equal((await f.call("POST", "/api/route-patrol-batch", { uids: [1] })).status, 400)
  assert.equal((await f.call("GET", "/api/route-patrol-batch?jobId=nope")).status, 404)
})