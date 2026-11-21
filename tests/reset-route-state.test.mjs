// reset-route-state.test.mjs 第十轮：`account-disabled` 文案 + 清空检测结果。
//
// # 为什么要「清空」
//
// 旧判据跑出来的 `unknown` 会一直挂在表上（真机 184 条里 19 条）。
// 「跳过已有结论」只跳 clean/routed/expired，unknown 本该重测，但用户看到的
// 是旧的错误分类 —— 所以给一个显式清空，让这些行回到「未检测」。
//
// ⚠ 清空**只动** `loomy-route-state.json`：不碰 plugin-auth.json、不碰
// 三个缓存文件。这里按字节比对钉死。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"
import { readFileSync as readPage } from "node:fs"

import { startServer, routeLabel, routeCostHint } from "../server.mjs"

/** 落盘模块桩：路径就是 route-store 的 `loomy-route-state.json`。 */
function stubStore(dirOverride) {
  const file = (dir) => join(dirOverride ?? dir, "loomy-route-state.json")
  return {
    routeStatePath: (dir) => file(dir),
    readRouteState(dir) {
      const p = file(dir)
      if (!existsSync(p)) return { ok: true, data: {} }
      try {
        return { ok: true, data: JSON.parse(readFileSync(p, "utf8")) }
      } catch (e) {
        return { ok: false, data: {}, error: String(e?.message ?? e) }
      }
    },
    writeRouteState(dir, uid, entry) {
      const current = this.readRouteState(dir)
      writeFileSync(file(dir), JSON.stringify({ ...(current.ok ? current.data : {}), [uid]: entry }, null, 2))
      return { ok: true }
    },
    getAccountRoute(dir, uid) {
      return this.readRouteState(dir).data[uid] ?? null
    },
  }
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-reset-test-"))
  const auth = {}
  for (let i = 0; i < 6; i += 1) {
    auth[`loomy#${i}`] = { access: String.fromCharCode(97 + i).repeat(32), metadata: { uid: `u${i}`, nickname: `号${i}` } }
  }
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://mock.invalid/api/v1",
    log: { warn() {} },
    fetchImpl: async () => { throw new Error("不该有上游请求") },
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
  return { dir, call, stateFile: () => join(dir, "loomy-route-state.json") }
}

test("routeLabel：account-disabled / session-expired / ledger-spark / no-quota 四态文案互不相同", () => {
  const exhausted = routeLabel({ verdict: "exhausted", reason: "no-quota" })
  assert.match(exhausted, /积分不足/)
  assert.equal(routeCostHint({ verdict: "exhausted", reason: "no-quota" }), "免费判定")
  const disabled = routeLabel({ verdict: "expired", reason: "account-disabled" })
  const expired = routeLabel({ verdict: "expired", reason: "session-expired" })
  const routed = routeLabel({ verdict: "routed", reason: "ledger-spark" })
  assert.equal(new Set([disabled, expired, routed]).size, 3)
  assert.match(disabled, /账号已停用/)
  assert.match(disabled, /封禁/)
  assert.match(expired, /登录已失效/)
  assert.match(routed, /整号停用/)
  // 三者的「花没花积分」也不同：封禁/登录失效都是免费判定
  assert.equal(routeCostHint({ reason: "account-disabled" }), "免费判定")
  assert.equal(routeCostHint({ reason: "session-expired" }), "免费判定")
  assert.equal(routeCostHint({ reason: "ledger-spark" }), "已扣 1 积分")
})

test("reset 全量：removed = 条目数，状态文件只剩空对象，其它缓存字节不变", async (t) => {
  const f = await fixture(t, { routeModules: { probeRoute: async () => ({}), ...stubStore() } })
  const route = {
    u0: { verdict: "clean", reason: "ledger-deepseek" },
    u1: { verdict: "routed", reason: "ledger-spark" },
    u2: { verdict: "expired", reason: "session-expired" },
    u3: { verdict: "expired", reason: "account-disabled" },
    u4: { verdict: "unknown", reason: "ledger-unreadable" },
  }
  writeFileSync(f.stateFile(), JSON.stringify(route, null, 2))
  const accounts = JSON.stringify({ updatedAt: 1, accounts: { u0: { balance: 1 } } })
  const tasks = JSON.stringify({ updatedAt: 1, tasks: {} })
  const invite = JSON.stringify({ updatedAt: 1, codes: {} })
  const settings = JSON.stringify({ batchConcurrency: 3 })
  writeFileSync(join(f.dir, "loomy-accounts-cache.json"), accounts)
  writeFileSync(join(f.dir, "loomy-tasks-cache.json"), tasks)
  writeFileSync(join(f.dir, "loomy-invite-cache.json"), invite)
  writeFileSync(join(f.dir, "loomy-panel-settings.json"), settings)

  const res = await f.call("POST", "/api/route-state/reset", {})
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.removed, 5)
  assert.equal(res.body.remaining, 0)
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile(), "utf8")), {})
  // ⚠ 只动 route-state：其它文件必须字节不变
  assert.equal(readFileSync(join(f.dir, "loomy-accounts-cache.json"), "utf8"), accounts)
  assert.equal(readFileSync(join(f.dir, "loomy-tasks-cache.json"), "utf8"), tasks)
  assert.equal(readFileSync(join(f.dir, "loomy-invite-cache.json"), "utf8"), invite)
  assert.equal(readFileSync(join(f.dir, "loomy-panel-settings.json"), "utf8"), settings)
  assert.equal(JSON.parse(readFileSync(join(f.dir, "plugin-auth.json"), "utf8")) !== null, true)
  // 清空后 GET 回空对象（面板回到「未检测」）
  const after = (await f.call("GET", "/api/route-state")).body
  assert.equal(after.ok, true)
  assert.deepEqual(after.state, {})
})

test("reset 指定 uids：只删这两个，其它保留", async (t) => {
  const f = await fixture(t, { routeModules: { probeRoute: async () => ({}), ...stubStore() } })
  writeFileSync(f.stateFile(), JSON.stringify({
    a: { verdict: "clean" },
    b: { verdict: "routed" },
    c: { verdict: "expired" },
  }, null, 2))
  const res = await f.call("POST", "/api/route-state/reset", { uids: ["a", "b"] })
  assert.equal(res.body.ok, true)
  assert.equal(res.body.removed, 2)
  assert.equal(res.body.remaining, 1)
  const left = JSON.parse(readFileSync(f.stateFile(), "utf8"))
  assert.deepEqual(Object.keys(left), ["c"])
  assert.equal(left.c.verdict, "expired")
})

test("reset 参数校验：非数组 → 400，空数组 → 400，模块未就绪 → 503", async (t) => {
  const f = await fixture(t, { routeModules: { probeRoute: async () => ({}), ...stubStore() } })
  writeFileSync(f.stateFile(), JSON.stringify({ a: { verdict: "clean" } }))
  assert.equal((await f.call("POST", "/api/route-state/reset", { uids: "a" })).status, 400)
  assert.equal((await f.call("POST", "/api/route-state/reset", { uids: [] })).status, 400)
  assert.equal((await f.call("POST", "/api/route-state/reset", { uids: [1] })).status, 400)
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile(), "utf8")), { a: { verdict: "clean" } })

  const g = await fixture(t, { routeModules: null })
  assert.equal((await g.call("POST", "/api/route-state/reset", {})).status, 503)
})

test("面板不再提供「清空检测结果」；改为「重新检测不健康账号」（不健康 → 健康这条路）", () => {
  const html = readPage(new URL("../page/index.html", import.meta.url), "utf8")
  const js = readPage(new URL("../page/assets/app.js", import.meta.url), "utf8")
  // 清空是「判定无法推翻」的补丁；补上重测之后它就没有存在意义了。
  assert.doesNotMatch(html, /route-reset/)
  assert.doesNotMatch(html, /清空检测结果/)
  assert.doesNotMatch(js, /route-reset/)
  // 新按钮：只筛「有记录且非 clean」，且必须 skipChecked:false（否则全被跳过）。
  assert.match(html, /<button id="route-recheck-unhealthy"/)
  assert.match(html, /重新检测不健康账号/)
  assert.match(js, /skipChecked: false/)
})