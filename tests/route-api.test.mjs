// route-api.test.mjs DS4.1 路由检测的接口层与登录钩子。
//
// # 为什么这些用例不 import src/route.mjs / src/route-store.mjs
//
// 那两个模块由另一条任务线（T-01）并行开发，本分支上**可能还不存在**。
// 所以这里一律通过注入点提供**本地桩**：
//
//	· server.mjs     → `startServer({ routeModules })`
//	· methods.mjs    → `makeMethods({ routeModules })`
//
// 桩本身仍然读真实临时目录里的状态文件、仍然用注入的 fetchImpl 打假上游 ——
// 这样测的是「服务器把 configDir / session / fetchImpl 正确交出去、把结论
// 正确落盘与回显」，而不是桩自己的行为。
//
// # 契约（产品结论已定）
//
//	probeRoute({baseUrl, session, fetchImpl}) → {verdict:"clean"|"routed"|"unknown",
//		servedModel, checkedAt, requested}
//	结论是**账号级**：被限制 = 整号停用，没有「仅某个模型被路由」这种中间态。
//
// # 钉死的事
//
//	① `/api/route-state` 没有状态文件时回 `{ok:true, state:{}}`
//	② `/api/route-check` 用注入的 fetchImpl 拿到 routed 结论，落盘并回显（含 label）
//	③ 同一 uid 并发两次检测只跑一次探测（in-flight 合并）
//	④ 登录成功后 callback 立即返回（<100ms），探测挂起也不等（AGENTS.md 坑 #7）
//	⑤ `routeLabel` 三态文案互不相同（前后端共用这一份）
//	⑥ 失败的探测不覆盖已有的 clean 记录

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer, routeLabel, routeCostHint, ROUTE_COST_HINT } from "../server.mjs"
import { makeMethods } from "../src/hooks/methods.mjs"

const S0 = "a".repeat(32)
const S1 = "b".repeat(32)

/** 真实的（极小）状态仓库桩：语义与 route-store.mjs 的契约一致。 */
function stubStore() {
  const file = (configDir) => join(configDir, "route-state.json")
  return {
    routeStatePath: (configDir) => file(configDir),
    readRouteState(configDir) {
      const p = file(configDir)
      if (!existsSync(p)) return { ok: true, data: {} }
      try {
        const data = JSON.parse(readFileSync(p, "utf8"))
        return data && typeof data === "object" && !Array.isArray(data) ? { ok: true, data } : { ok: false, data: {}, error: "状态文件形状不对" }
      } catch (e) {
        return { ok: false, data: {}, error: String(e?.message ?? e) }
      }
    },
    writeRouteState(configDir, uid, entry) {
      const current = this.readRouteState(configDir)
      const data = { ...(current.ok ? current.data : {}), [uid]: entry }
      writeFileSync(file(configDir), JSON.stringify(data))
      return { ok: true, data }
    },
    getAccountRoute(configDir, uid) {
      return this.readRouteState(configDir).data[uid] ?? null
    },
  }
}

/** 用注入的 fetchImpl 打 /points/records 的探测桩（模拟 T-01 的判定逻辑）。 */
function recordsProbe(calls) {
  return async ({ baseUrl, session, fetchImpl }) => {
    calls.push({ baseUrl, session })
    const url = String(baseUrl).replace(/\/+$/, "") + "/points/records?pageNo=1&pageSize=1"
    const resp = await fetchImpl(url, { method: "GET", headers: new Headers({ Accept: "application/json", token: session }) })
    const body = await resp.json()
    const top = Array.isArray(body?.data) ? body.data[0] : null
    const served = String(top?.modelName ?? "")
    return {
      verdict: served === "spark-x2.6-low" ? "routed" : served ? "clean" : "unknown",
      servedModel: served,
      checkedAt: String(top?.createdAt ?? ""),
      requested: "DeepSeek-V4.1-Flash",
    }
  }
}

/** 假上游：/points/records 里那条记录显示实际落到 spark-x2.6-low。 */
function upstream() {
  return async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith("/points/records")) {
      const token = init?.headers?.get?.("token") ?? ""
      const served = token === S1 ? "spark-x2.6-low" : "DeepSeek-V4.1-Flash"
      return Response.json({ code: "000000", data: [{ id: "led-1", createdAt: "2026-11-19T00:38:00Z", modelName: served }] })
    }
    return Response.json({ code: "000000", data: {} })
  }
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-route-test-"))
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({
    loomy: { access: S0, metadata: { uid: "u0", nickname: "甲号", phone: "138****0000" } },
    "loomy#1": { access: S1, metadata: { uid: "u1", nickname: "乙号", phone: "139****0000" } },
  }))
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://mock.invalid/api/v1",
    log: { warn() {} },
    fetchImpl: upstream(),
    ...options,
  })
  t.after(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const raw = (method, path, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const call = async (method, path, body) => {
    const res = await raw(method, path, body)
    return { ...res, body: JSON.parse(res.text) }
  }
  return { dir, call, raw, stateFile: () => join(dir, "route-state.json") }
}

test("① /api/route-state 没有状态文件时返回空对象", async (t) => {
  const never = async () => { throw new Error("不该探测") }
  const f = await fixture(t, { routeModules: { probeRoute: never, ...stubStore() } })
  const res = await f.call("GET", "/api/route-state")
  assert.equal(res.status, 200)
  // 第十四轮：响应多一个 fetchedAt（页面用它显示「路由状态截至 HH:mm:ss」）
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.state, {})
  assert.equal(typeof res.body.fetchedAt, "number")
  assert.equal(existsSync(f.stateFile()), false, "只读接口不该写盘")
})

test("② /api/route-check 用注入的 fetchImpl 得到 routed 结论，落盘并回显", async (t) => {
  const probes = []
  const f = await fixture(t, { routeModules: { probeRoute: recordsProbe(probes), ...stubStore() } })
  const res = await f.call("POST", "/api/route-check", { uid: "u1" })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.uid, "u1")
  assert.equal(res.body.entry.verdict, "routed")
  assert.ok(res.body.entry.servedModel, "servedModel 必须非空（面板要靠它说清落到哪个模型）")
  assert.equal(res.body.entry.label, routeLabel({ verdict: "routed" }))
  assert.equal(res.text.includes(S1), false, "响应里不能出现 session")

  // 探测拿到的是**这个账号**的 session 与服务注入的 fetchImpl
  assert.equal(probes.length, 1)
  assert.equal(probes[0].session, S1)
  assert.equal(probes[0].baseUrl, "https://mock.invalid/api/v1")

  // 结论确实落进了 configDir 下的状态文件；GET 读回时同样带 label
  const saved = JSON.parse(readFileSync(f.stateFile(), "utf8"))
  assert.equal(saved.u1.verdict, "routed")
  assert.equal(saved.u1.label, undefined, "label 是展示层产物，不写进状态文件")
  const state = await f.call("GET", "/api/route-state")
  assert.equal(state.body.ok, true)
  assert.equal(typeof state.body.fetchedAt, "number")
  assert.deepEqual(state.body.state, { u1: { ...saved.u1, label: routeLabel(saved.u1), costHint: routeCostHint(saved.u1) } })
})

test("③ 同一 uid 并发两次检测只跑一次探测", async (t) => {
  const probes = []
  let release
  let entered
  const gate = new Promise((r) => { release = r })
  const started = new Promise((r) => { entered = r })
  const probe = async (opts) => {
    probes.push(opts)
    entered()
    await gate
    return { verdict: "routed", servedModel: "spark-x2.6-low", checkedAt: "2026-11-19T00:40:00.000Z", requested: "DeepSeek-V4.1-Flash" }
  }
  const f = await fixture(t, { routeModules: { probeRoute: probe, ...stubStore() } })
  const first = f.call("POST", "/api/route-check", { uid: "u0" })
  await Promise.race([started, timeoutAfter(2000, "探测未被触发")])
  const second = f.call("POST", "/api/route-check", { uid: "u0" })
  // ⚠ 这里必须等第二个请求真的**到达**服务端再放闸（回环上几毫秒）：
  // 否则第一个探测先结束、in-flight 记录已清掉，第二次就成了「真并发之后
  // 的新探测」—— 那样断言会变成在测时序，而不是在测合并。
  // 先断言「放闸前只跑过一次」，再放闸、再确认总数仍是一次。
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(probes.length, 1, "第二个请求在途时不该再起一次探测")
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(probes.length, 1, "并发检测必须合并成一次探测")
  assert.equal(a.body.ok, true)
  assert.deepEqual(b.body, a.body)
  assert.equal(JSON.parse(readFileSync(f.stateFile(), "utf8")).u0.verdict, "routed")
})

test("route-check 参数与未知账号都被拒绝，不触发探测", async (t) => {
  const probes = []
  const f = await fixture(t, { routeModules: { probeRoute: recordsProbe(probes), ...stubStore() } })
  assert.equal((await f.call("POST", "/api/route-check", {})).status, 400)
  const unknown = await f.call("POST", "/api/route-check", { uid: "nope" })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.ok, false)
  assert.match(unknown.body.error, /session/)
  assert.equal(probes.length, 0)
})

test("⑥ 探测失败回 ok:false，且不覆盖已有的 clean 记录", async (t) => {
  const f = await fixture(t, {
    routeModules: {
      probeRoute: async () => { throw new Error(`upstream said token=${S0} bad`) },
      ...stubStore(),
    },
  })
  const before = { verdict: "clean", servedModel: "DeepSeek-V4.1-Flash", checkedAt: "2026-11-19T00:30:00.000Z" }
  writeFileSync(f.stateFile(), JSON.stringify({ u0: before }))

  const res = await f.call("POST", "/api/route-check", { uid: "u0" })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /探测失败/)
  assert.equal(res.text.includes(S0), false, "错误信息要脱敏")
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile(), "utf8")).u0, before, "失败的探测不能抹掉上一次的结论")
})

test("⑥ 结论是 unknown 时也不覆盖已有的 clean 记录（只是这次没测清）", async (t) => {
  const f = await fixture(t, {
    routeModules: {
      probeRoute: async () => ({ verdict: "unknown", servedModel: "", checkedAt: "2026-11-19T00:50:00.000Z", requested: "DeepSeek-V4.1-Flash", reason: "ledger-timeout" }),
      ...stubStore(),
    },
  })
  const before = { verdict: "clean", servedModel: "DeepSeek-V4.1-Flash", checkedAt: "2026-11-19T00:30:00.000Z" }
  writeFileSync(f.stateFile(), JSON.stringify({ u0: before }))

  const res = await f.call("POST", "/api/route-check", { uid: "u0" })
  assert.equal(res.body.ok, true)
  assert.equal(res.body.entry.verdict, "unknown")
  assert.match(res.body.note, /保留上一次/)
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile(), "utf8")).u0, before, "unknown 不该抹掉有效结论")

  // 但「一条记录都没有」时要留痕，否则面板永远只说「未检测」
  writeFileSync(f.stateFile(), JSON.stringify({}))
  const fresh = await f.call("POST", "/api/route-check", { uid: "u0" })
  assert.equal(fresh.body.ok, true)
  assert.equal(JSON.parse(readFileSync(f.stateFile(), "utf8")).u0.verdict, "unknown")
})

test("⑤ 探测模块缺失时接口回 503，面板其它接口不受影响", async (t) => {
  const f = await fixture(t, { routeModules: null })
  for (const [method, path, body] of [["GET", "/api/route-state", undefined], ["POST", "/api/route-check", { uid: "u0" }]]) {
    const res = await f.call(method, path, body)
    assert.equal(res.status, 503)
    assert.equal(res.body.ok, false)
    assert.match(res.body.error, /未就绪/)
  }
  const hello = await f.call("GET", "/api/hello")
  assert.equal(hello.status, 200)
  assert.equal(hello.body.ok, true)
})

test("routeLabel 三态文案互不相同，且成本提示写清计费", () => {
  const clean = routeLabel({ verdict: "clean" })
  const routed = routeLabel({ verdict: "routed" })
  const unknown = routeLabel({ verdict: "unknown" })
  assert.equal(new Set([clean, routed, unknown]).size, 3)
  assert.equal(clean, "正常")
  assert.match(routed, /整号停用/)
  assert.match(unknown, /未检测/)
  assert.equal(routeLabel(null), unknown, "没有记录与「检测不完整」同文案")
  assert.match(ROUTE_COST_HINT, /扣 1 积分/)
})

const paste = (m) => m.find((x) => x.label.includes("粘贴"))

/** 等一个「应该发生」的信号；超时即失败（否则红灯会变成永久挂起）。 */
function timeoutAfter(ms, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时（${ms}ms）：${label}`)), ms)
    timer.unref?.()
  })
}

/** 让测试等在后台链路上（探测在 `void` 里跑，不能直接 await）。 */
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail(`等不到：${label}`)
}

test("④ 粘贴 session 登录立即返回，探测挂起也不阻塞", async () => {
  let entered
  const started = new Promise((r) => { entered = r })
  const probes = []
  const m = makeMethods({
    routeModules: {
      probeRoute: async (opts) => { probes.push(opts); entered(); return new Promise(() => {}) },
      writeRouteState: () => { throw new Error("不该被调用") },
    },
    configDir: "",
    log: { warn() {} },
    fetchImpl: async (url) => String(url).includes("/models")
      ? Response.json({ data: [{ id: "spark-x2.6" }] })
      : Response.json({ code: "000000", data: {} }),
  })
  const begin = Date.now()
  const result = await paste(m).authorize({ session: S0 })
  const elapsed = Date.now() - begin
  assert.equal(result.type, "success")
  assert.ok(elapsed < 100, `登录返回用了 ${elapsed}ms，探测被同步等待了`)
  await Promise.race([started, timeoutAfter(2000, "探测未被触发")])
  assert.equal(probes.length, 1)
  assert.equal(probes[0].session, S0)
})

test("④ 本机登录态 callback 也立即返回（探测挂起）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loomy-client-store-"))
  const session = "c".repeat(32)
  writeFileSync(join(dir, "000003.log"), `loomy-auth-session{"phone":"137****0000","session":"${session}","userid":"u-local","loggedInAt":"2026-11-18T10:00:00.000Z"}`)
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  let entered
  const started = new Promise((r) => { entered = r })
  const m = makeMethods({
    clientStoreDir: dir,
    configDir: "",
    log: { warn() {} },
    routeModules: { probeRoute: async () => { entered(); return new Promise(() => {}) }, writeRouteState: () => {} },
    fetchImpl: async () => Response.json({ data: [{ id: "spark-x2.6" }] }),
  })
  const method = m.find((x) => x.label.includes("本机"))
  const pending = await method.authorize()
  assert.equal(pending.type, undefined, "authorize 只返回待办，不返回成功结果")
  const begin = Date.now()
  const result = await pending.callback()
  const elapsed = Date.now() - begin
  assert.equal(result.type, "success")
  assert.ok(elapsed < 100, `callback 用了 ${elapsed}ms，探测被同步等待了`)
  await Promise.race([started, timeoutAfter(2000, "探测未被触发")])
})

test("登录成功后在后台落盘，uid 取自登录结果 metadata", async () => {
  const writes = []
  const m = makeMethods({
    configDir: "C:\\fake-config",
    log: { warn() {} },
    routeModules: {
      probeRoute: async () => ({ verdict: "routed", servedModel: "spark-x2.6-low", checkedAt: "2026-11-19T00:41:00.000Z", requested: "DeepSeek-V4.1-Flash" }),
      writeRouteState: (configDir, uid, entry) => { writes.push({ configDir, uid, entry }); return { ok: true } },
    },
    fetchImpl: async (url) => String(url).includes("/models")
      ? Response.json({ data: [{ id: "spark-x2.6" }] })
      : Response.json({ code: "000000", data: {} }),
  })
  const result = await paste(m).authorize({ session: S0, phone: "138****0000" })
  assert.equal(result.type, "success")
  await until(() => writes.length > 0, "后台落盘")
  assert.equal(writes.length, 1)
  assert.equal(writes[0].uid, result.metadata.uid)
  assert.equal(writes[0].configDir, "C:\\fake-config")
  assert.equal(writes[0].entry.verdict, "routed")
})

test("登录后拿到 unknown 结论时不落盘（保留已有的有效结论）", async () => {
  const writes = []
  const m = makeMethods({
    configDir: "C:\\fake-config",
    log: { warn() {} },
    routeModules: {
      probeRoute: async () => ({ verdict: "unknown", servedModel: "", checkedAt: "2026-11-19T00:52:00.000Z" }),
      writeRouteState: (configDir, uid, entry) => { writes.push({ uid, entry }) },
    },
    fetchImpl: async (url) => String(url).includes("/models")
      ? Response.json({ data: [{ id: "spark-x2.6" }] })
      : Response.json({ code: "000000", data: {} }),
  })
  const result = await paste(m).authorize({ session: S0 })
  assert.equal(result.type, "success")
  // 这条链路「什么都不做」，没有可等的信号：等一小段时间，确认确实没写
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(writes.length, 0, "unknown 结论不该被当成有效结论写盘")
})

test("探测失败只 warn，登录结果照旧成功", async () => {
  const warns = []
  const m = makeMethods({
    configDir: "C:\\fake-config",
    log: { warn: (msg) => warns.push(msg) },
    routeModules: {
      probeRoute: async () => { throw new Error("boom") },
      writeRouteState: () => {},
    },
    fetchImpl: async (url) => String(url).includes("/models")
      ? Response.json({ data: [{ id: "spark-x2.6" }] })
      : Response.json({ code: "000000", data: {} }),
  })
  const result = await paste(m).authorize({ session: S0 })
  assert.equal(result.type, "success")
  await until(() => warns.some((w) => /路由探测失败/.test(w)), "warn 日志")
  assert.equal(result.access, S0)
})

test("探测模块不存在时登录照常，不抛异常（并行开发期）", async () => {
  const m = makeMethods({
    configDir: "",
    log: { warn() {} },
    fetchImpl: async (url) => String(url).includes("/models")
      ? Response.json({ data: [{ id: "spark-x2.6" }] })
      : Response.json({ code: "000000", data: {} }),
  })
  const result = await paste(m).authorize({ session: S0 })
  assert.equal(result.type, "success")
})

test("状态文件读不出来时 route-state 不炸，回空对象与原因", async (t) => {
  const never = async () => { throw new Error("不该探测") }
  const f = await fixture(t, { routeModules: { probeRoute: never, ...stubStore() } })
  mkdirSync(f.stateFile())
  const res = await f.call("GET", "/api/route-state")
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.state, {})
  assert.match(res.body.error, /读取失败/)
})