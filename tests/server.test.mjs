import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { request } from "node:http"
import { startServer } from "../server.mjs"
import { TASK_DEFS } from "../src/points.mjs"
import { toSignInResult } from "../src/importer.mjs"
import { parseCredential, marshalCredential } from "../src/credential.mjs"

/**
 * `GET /api/settings` 的完整期望集合（第十三～二十轮把并发拆成了每个 job 一条，
 * 并加了 `gapMs` / `autoApply` / `magpiePath`）。
 *
 * ⚠ 这些键是**用户明确要求**的：凡是涉及并发的地方都要能在设置里调；
 *   不许为了让测试变绿而把它们从服务端删掉。
 */
const EXPECTED_SETTINGS = Object.freeze({
  accountConcurrency: 20,
  bindConcurrency: 20,
  routeConcurrency: 2,
  batchConcurrency: 2,
  balanceConcurrency: 2,
  tasksConcurrency: 2,
  inviteConcurrency: 2,
  gapMs: 300,
  autoApply: true,
  magpiePath: "",
  batchSkipChecked: true,
  ledgerReads: 3,
  // T-35：切回窗口自动重读，**默认关**（用户要求「禁止自动刷新」）
  focusRefresh: false,
})

/** 只有 legacy 两项变了（并发两键的合并测试里用）。 */
const withLegacy = (accountConcurrency, bindConcurrency) => ({ ...EXPECTED_SETTINGS, accountConcurrency, bindConcurrency })

async function fixture(t, handler, count = 3, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-panel-test-"))
  const auth = Object.fromEntries(Array.from({ length: count }, (_, i) => [`loomy#${i}`, { access: `fake-session-${i}`, metadata: { uid: `u${i}`, nickname: `名字${i}`, phone: `phone${i}`, ...(i === 0 ? { firstLogin: false } : {}) } }]))
  const original = JSON.stringify(auth)
  writeFileSync(join(dir, "plugin-auth.json"), original)
  const calls = []
  const opts = { port: 0, configDir: dir, clientStoreDir: "", log: { warn() {} }, baseUrl: "https://mock.invalid/api/v1", fetchImpl: async (url, init) => {
    const call = { path: new URL(url).pathname.replace("/api/v1", ""), method: init.method, token: init.headers.get("token"), body: init.body ? JSON.parse(init.body) : null }
    calls.push(call)
    const custom = await handler?.(call, dir)
    if (custom instanceof Response) return custom
    const data = custom ?? (call.path === "/points/activation" ? { activated: false } : call.path === "/onboarding/tasks" ? { tasks: Object.fromEntries(TASK_DEFS.map((d) => [d.key, true])) } : call.path === "/points/records" ? { balance: 10, dailyBalance: 5, availableBalance: 15 } : { list: [] })
    return Response.json({ code: "000000", data })
  }, ...options }
  let server = await startServer(opts)
  t.after(async () => { await server.close(); assert.equal(readFileSync(join(dir, "plugin-auth.json"), "utf8"), original); rmSync(dir, { recursive: true, force: true }) })
  const api = (path, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (chunk) => { text += chunk })
      res.on("end", () => resolve(JSON.parse(text)))
    })
    req.on("error", reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
  const raw = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, headers: { Origin: "null", "Content-Type": "application/json", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type", ...headers } }, (res) => {
      let text = ""
      res.on("data", (chunk) => { text += chunk })
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body))
  })
  // ⚠ `raw()` 用 `text += chunk` 拼的是**字符串**（二进制会被隐式转码），
  //    所以「发出去多少字节」必须另开一个按 Buffer 收的通道，否则测出来的
  //    是字符数而不是字节数 —— 这正是 48 KiB 误判的来源。
  const rawBytes = (method, path) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method }, (res) => {
      const chunks = []
      res.on("data", (chunk) => { chunks.push(Buffer.from(chunk)) })
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end()
  })
  return { api, raw, rawBytes, calls, dir, restart: async () => { await server.close(); server = await startServer(opts) } }
}

test("Origin null JSON POST 的预检无副作用并可执行初始化", async (t) => {
  const receipt = { alreadyProcessed: true, registerReward: 0, balance: 123 }
  const f = await fixture(t, (c) => c.path === "/points/first-login" ? { ...receipt, session: c.token, nested: { token: c.token } } : undefined)
  for (const path of ["/api/do", "/api/accounts", "/api/tasks", "/api/invite", "/api/hello"]) {
    const response = await f.raw("OPTIONS", path)
    assert.equal(response.status, 204)
    assert.equal(response.text, "")
    assert.equal(response.headers["access-control-allow-origin"], "*")
    assert.equal(response.headers["access-control-allow-methods"], "GET, POST, OPTIONS")
    assert.equal(response.headers["access-control-allow-headers"], "Content-Type")
  }
  assert.equal(f.calls.length, 0)
  const response = await f.raw("POST", "/api/do", { action: "first-login", uid: "u0" })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.text).receipt, { ...receipt, nested: {} })
  assert.match(f.calls[0].body.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(response.text.includes("fake-session"), false)
})

test("Origin null 私有网络预检按请求授权且不调用上游", async (t) => {
  const f = await fixture(t)
  for (const value of [undefined, "true", "false"]) {
    const headers = value === undefined ? {} : { "Access-Control-Request-Private-Network": value }
    const response = await f.raw("OPTIONS", "/api/do", undefined, headers)
    assert.equal(response.status, 204)
    assert.equal(response.text, "")
    assert.equal(response.headers["access-control-allow-origin"], "*")
    assert.equal(response.headers["access-control-allow-methods"], "GET, POST, OPTIONS")
    assert.equal(response.headers["access-control-allow-headers"], "Content-Type")
    assert.equal(response.headers["access-control-allow-private-network"], value === "true" ? "true" : undefined)
    assert.equal(response.headers.vary, "Access-Control-Request-Private-Network")
  }
  assert.equal(f.calls.length, 0)
  assert.equal((await f.api("/api/hello")).ok, true)
})

test("上游同步异常和读正文失败返回 JSON，服务仍存活", async (t) => {
  for (const mode of ["throw", "body"]) {
    const f = await fixture(t, () => {
      if (mode === "throw") throw new Error("fake-session-0")
      const response = Response.json({})
      response.text = async () => { throw new Error("fake-session-0") }
      return response
    })
    const response = await f.raw("POST", "/api/do", { action: "repair-tasks", uid: "u0" })
    assert.equal(response.status, 200)
    assert.equal(response.headers["access-control-allow-origin"], "*")
    const result = JSON.parse(response.text)
    assert.equal(result.ok, false)
    assert.match(result.failed[0].error, /POST \/points\/first-login.*网络请求失败/)
    assert.equal(response.text.includes("fake-session"), false)
    assert.equal((await f.api("/api/hello")).ok, true)
  }
})

test("旧绑定字段不影响分配且首登和用户状态文件保持不变", async (t) => {
  const f = await fixture(t)
  const accounts = {
    u0: { firstLogin: true, bind: { tried: true, status: "success" } },
    u1: { bind: { tried: true, status: "failed" } },
    u2: { bind: { tried: true, status: "pending" } },
  }
  const original = JSON.stringify({ accounts })
  const file = join(f.dir, "loomy-panel-state.json")
  writeFileSync(file, original)
  await f.restart()
  assert.deepEqual(Object.keys(await f.api("/api/invite")).sort(), ["cached", "rows", "updatedAt"])
  assert.deepEqual((await f.api("/api/invite?uids=u1")).rows.map((r) => r.uid), ["u1"])
  const result = await f.api("/api/do", { ...bulk, count: 3 })
  assert.equal(result.bound, 3)
  assert.deepEqual(result.results.map((r) => r.uid), ["u0", "u1", "u2"])
  assert.equal((await f.api("/api/do", { action: "bind-invite", uid: "u0", code: "A" })).ok, true)
  await f.restart()
  assert.equal((await f.api("/api/accounts?uids=u0")).accounts[0].firstLogin, true)
  assert.equal(readFileSync(file, "utf8"), original)
})

test("列表查询只读缓存：零上游请求、顺序稳定、未知激活不标未绑定", async (t) => {
  let active = 0
  let peak = 0
  const f = await fixture(t, async (c) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    if (c.path === "/points/activation") return {}
  }, 9)
  for (const path of ["accounts", "tasks", "invite"]) {
    peak = 0
    const response = await f.api("/api/" + path)
    // ⚠ 这三个列表现在**一发上游请求都不发**（只读缓存）：刷新走各自的 refresh 任务
    assert.equal(peak, 0, `${path} 不得在列表接口里打上游`)
    const rows = response.accounts ?? response.rows
    assert.deepEqual(rows.map((r) => r.uid), Array.from({ length: 9 }, (_, i) => `u${i}`))
    if (path === "invite") assert.ok(rows.every((r) => r.activation === null))
  }
  assert.equal(f.calls.length, 0)
})

test("上游错误脱敏且 action 错误结构保持", async (t) => {
  const f = await fixture(t, (c) => {
    if (c.path === "/points/first-login") throw new Error(`token=${c.token} private body`)
    return Response.json({ code: "FAIL", desc: `session=${c.token} private body` })
  })
  const result = await f.api("/api/do", { action: "first-login", uid: "u0" })
  assert.equal(result.ok, false)
  assert.equal(result.failed[0].key, "first-login")
  assert.match(result.failed[0].error, /POST \/points\/first-login.*网络请求失败/)
  // tasks/invite/accounts 都改成只读缓存（零上游请求），上游错误只会出现在 /api/do
  for (const path of ["accounts", "tasks", "invite"]) {
    const text = JSON.stringify(await f.api("/api/" + path))
    assert.equal(/fake-session|private body|FAIL/.test(text), false)
  }
  // 错误结构保留，但正文里的 session 必须被脱敏（不出现 FAIL 原样回显也没关系）
  assert.equal(/fake-session|private body/.test(JSON.stringify(result)), false)
})

test("保留真实昵称且宿主 accountId 仍显示手机号", async () => {
  const raw = { session: "fake-only", phone: "138****0000", nickname: "真实昵称" }
  const cred = parseCredential(marshalCredential(parseCredential(raw)))
  const result = await toSignInResult(cred)
  assert.equal(result.accountId, raw.phone)
  assert.equal(result.metadata.nickname, raw.nickname)
})

const bulk = { action: "bind-invite-bulk", mode: "one-many", codes: "CODE", count: 2, concurrency: 2 }

test("限定账号、三态 metadata、无 session 输出", async (t) => {
  const f = await fixture(t)
  const result = await f.api("/api/accounts?uids=" + encodeURIComponent("u0,u2,unknown"))
  assert.deepEqual(result.accounts.map((a) => [a.uid, a.phone, a.firstLogin]), [["u0", "phone0", false], ["u2", "phone2", null]])
  assert.deepEqual(Object.keys(result.accounts[0]).sort(), ["uid", "name", "phone", "firstLogin", "quota", "error", "cached", "at"].sort())
  assert.equal(JSON.stringify(result).includes("fake-session"), false)
  assert.equal((await f.api("/api/tasks?uids=u1")).rows.length, 1)
  assert.equal((await f.api("/api/invite?uids=u1")).rows[0].uid, "u1")
  assert.equal((await f.api("/api/accounts?uids=")).total, 0)
  assert.equal((await f.api("/api/accounts")).total, 3)
})

test("repair 先初始化、跳过完成项、逐项失败且重启保留首登", async (t) => {
  const f = await fixture(t, (c) => {
    if (c.path === "/onboarding/tasks") return { tasks: { first_message: true } }
    if (c.body?.key === "pick_skill") return Response.json({ code: "FAIL", desc: "失败" })
  })
  const result = await f.api("/api/do", { action: "repair-tasks", uid: "u1", code: "NEVER" })
  assert.equal(result.ok, false)
  assert.equal(result.done.length, 6)
  assert.equal(result.failed[0].key, "pick_skill")
  assert.deepEqual(f.calls.slice(0, 2).map((c) => c.path), ["/points/first-login", "/onboarding/tasks"])
  assert.equal("inviteCode" in f.calls[0].body, false)
  assert.equal(f.calls.some((c) => c.body?.key === "first_message"), false)
  await f.restart()
  assert.equal((await f.api("/api/accounts?uids=u1")).accounts[0].firstLogin, true)
})

test("初始化不可信回执和 HTTP 失败不标成功", async (t) => {
  for (const response of [Response.json({ data: {} }), Response.json({ code: "000000" }, { status: 500 })]) {
    const f = await fixture(t, (c) => c.path === "/points/first-login" ? response : undefined)
    assert.equal((await f.api("/api/do", { action: "first-login", uid: "u0" })).ok, false)
    assert.equal((await f.api("/api/accounts?uids=u0")).accounts[0].firstLogin, false)
  }
})

test("bulk 严格参数、无前置账号依赖", async (t) => {
  const f = await fixture(t, undefined, 0)
  for (const override of [{ mode: "bad" }, { count: "2" }, { count: 1.5 }, { count: 1000 }, { count: 0 }, { concurrency: "2" }, { concurrency: 0 }, { concurrency: 51 }, { concurrency: 1.1 }, { codes: "A\nB" }]) {
    assert.equal((await f.api("/api/do", { ...bulk, ...override })).ok, false)
  }
  assert.equal(f.calls.length, 0)
  const result = await f.api("/api/do", bulk)
  assert.equal(result.requested, 2)
  assert.equal(result.unassigned, 2)
})

for (const mode of ["one-each", "one-many"]) {
  test(`${mode} 失败账号下批直接绑定，每批每账号仅分配一次且不写状态`, async (t) => {
    const bound = new Set()
    let fail = true
    const f = await fixture(t, (c) => {
      if (c.path !== "/points/activation") return
      if (c.method === "GET") return { activated: bound.has(c.token) }
      if (c.token === "fake-session-1" && fail) return Response.json({ code: "FAIL" })
      bound.add(c.token)
    })
    const input = { ...bulk, mode, codes: mode === "one-each" ? "A\nB" : "CODE" }
    const result = await f.api("/api/do", input)
    assert.equal(result.bound, 1)
    assert.equal(result.failed, 1)
    assert.deepEqual(result.results.map((r) => r.uid), ["u0", "u1"])
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 2)
    assert.throws(() => readFileSync(join(f.dir, "loomy-panel-state.json")), { code: "ENOENT" })
    await f.restart()
    fail = false
    const next = await f.api("/api/do", input)
    assert.equal(next.bound, 2)
    assert.deepEqual(next.results.map((r) => r.uid), ["u1", "u2"])
    assert.deepEqual(next.results.map((r) => r.code), mode === "one-each" ? ["A", "B"] : ["CODE", "CODE"])
    assert.throws(() => readFileSync(join(f.dir, "loomy-panel-state.json")), { code: "ENOENT" })
  })
}

test("单账号失败后仍未绑定可直接再次绑定", async (t) => {
  let attempts = 0
  const f = await fixture(t, (c) => {
    if (c.path === "/points/activation" && c.method === "POST" && ++attempts === 1) return Response.json({ code: "FAIL" })
  })
  const input = { action: "bind-invite", uid: "u0", code: "A" }
  assert.equal((await f.api("/api/do", input)).ok, false)
  assert.equal((await f.api("/api/do", input)).ok, true)
  assert.equal(attempts, 2)
})

test("已激活和未知状态不候选，单账号也检查", async (t) => {
  const f = await fixture(t, (c) => c.path === "/points/activation" ? (c.token === "fake-session-0" ? { activated: true } : {}) : undefined)
  const result = await f.api("/api/do", bulk)
  assert.equal(result.unassigned, 2)
  assert.equal((await f.api("/api/do", { action: "bind-invite", uid: "u0", code: "A" })).ok, false)
  assert.equal(f.calls.some((c) => c.method === "POST"), false)
})

test("设置默认 20、分别合并持久化且重启保留，不访问上游或宿主账号", async (t) => {
  const f = await fixture(t)
  // ⚠ 形状变了：`{ok, settings, defaults}`（设置 tab 要显示默认值）
  const first = await f.api("/api/settings")
  assert.equal(first.ok, true)
  assert.deepEqual(first.settings, EXPECTED_SETTINGS)
  assert.deepEqual(first.defaults, first.settings)
  const accounts = { u0: { firstLogin: true } }
  writeFileSync(join(f.dir, "loomy-panel-state.json"), JSON.stringify({ accounts }))
  await f.restart()
  assert.deepEqual((await f.api("/api/settings", { accountConcurrency: 1 })).settings, withLegacy(1, 20))
  assert.deepEqual((await f.api("/api/settings", { bindConcurrency: 50 })).settings, withLegacy(1, 50))
  await f.restart()
  assert.deepEqual((await f.api("/api/settings")).settings, withLegacy(1, 50))
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "loomy-panel-state.json"), "utf8")), { accounts, settings: { accountConcurrency: 1, bindConcurrency: 50 } })
  assert.equal(f.calls.length, 0)
})

test("设置拒绝非法值、额外字段及非法 JSON，写入失败不改变当前值", async (t) => {
  const f = await fixture(t)
  // ⚠ T-49：未知字段改为**忽略**（不再把整次保存打回 400），但只要一个可识别的键
  // 都没有，仍然 400（防止拼错键名后“以为存上了”）。所以这里用“全是未知键”的样本。
  for (const body of ["{", null, [], {}, { other: 20 }, { accounts: {} }, ...[0, 1.5, "20", true, null].flatMap((value) => [{ accountConcurrency: value }, { bindConcurrency: value }])]) {
    assert.equal((await f.raw("POST", "/api/settings", body)).status, 400)
  }
  // 新键的校验（第 17/18 轮新增）：并发必须整数 ≥1，gapMs 0..5000，类型要对
  for (const body of [
    { routeConcurrency: 0 },
    { routeConcurrency: 1.5 },
    { tasksConcurrency: 1.5 },
    { inviteConcurrency: 0 },
    { balanceConcurrency: -1 },
    { gapMs: -1 },
    { gapMs: 9999 },
    { gapMs: 1.5 },
    { autoApply: "true" },
    { magpiePath: 123 },
    // T-38：巡检接口整段删除，`patrolConcurrency` 不再是合法键（避免「存着不生效」）
    { patrolConcurrency: 3 },
    // T-35：新开关只收布尔值
    { focusRefresh: "true" },
    { focusRefresh: 1 },
  ]) {
    assert.equal((await f.raw("POST", "/api/settings", body)).status, 400, JSON.stringify(body))
    assert.deepEqual((await f.api("/api/settings")).settings, EXPECTED_SETTINGS, `${JSON.stringify(body)} 不得写盘`)
  }
  // gapMs 的边界是可用的（0 = 不等待，5000 = 上限）
  assert.equal((await f.raw("POST", "/api/settings", { gapMs: 0 })).status, 200)
  assert.equal((await f.api("/api/settings")).settings.gapMs, 0)
  assert.equal((await f.raw("POST", "/api/settings", { gapMs: 5000 })).status, 200)
  assert.equal((await f.api("/api/settings")).settings.gapMs, 5000)
  assert.equal((await f.raw("POST", "/api/settings", { gapMs: 300 })).status, 200)
  // T-35：focusRefresh 落盘后可读回（默认 false，显式 true 也要能存）
  assert.equal((await f.raw("POST", "/api/settings", { focusRefresh: true })).status, 200)
  assert.equal((await f.api("/api/settings")).settings.focusRefresh, true)
  assert.equal((await f.raw("POST", "/api/settings", { focusRefresh: false })).status, 200)

  assert.deepEqual((await f.api("/api/settings")).settings, EXPECTED_SETTINGS)
  mkdirSync(join(f.dir, "loomy-panel-state.json"))
  assert.equal((await f.raw("POST", "/api/settings", { accountConcurrency: 30 })).status, 500)
  assert.deepEqual((await f.api("/api/settings")).settings, EXPECTED_SETTINGS)

})

test("无 configDir 时读取默认值，保存明确失败且不访问宿主或上游", async (t) => {
  const f = await fixture(t, undefined, 0, { configDir: "" })
  assert.deepEqual((await f.api("/api/settings")).settings, EXPECTED_SETTINGS)
  const result = await f.raw("POST", "/api/settings", { bindConcurrency: 30 })
  assert.equal(result.status, 503)
  assert.match(JSON.parse(result.text).error, /configDir/)
  assert.equal(f.calls.length, 0)
})

for (const concurrency of [1, 2, 20, 50]) {
  test(`bulk 实际 worker 按请求并发 ${concurrency} 有界执行且顺序稳定`, async (t) => {
    let active = 0
    let peak = 0
    const f = await fixture(t, async (c) => {
      if (c.method !== "POST") return
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    }, 23)
    const result = await f.api("/api/do", { ...bulk, count: 23, concurrency })
    assert.equal(result.bound, 23)
    assert.equal(peak, Math.min(concurrency, 23))
    assert.deepEqual(result.results.map((r) => r.uid), Array.from({ length: 23 }, (_, i) => `u${i}`))
  })
}

test("bulk 运行时拒绝批量和单账号绑定重叠", async (t) => {
  let release
  let entered
  const ready = new Promise((r) => { entered = r })
  const gate = new Promise((r) => { release = r })
  const f = await fixture(t, async (c) => {
    if (c.path === "/points/activation" && c.method === "POST") { entered(); await gate }
  })
  const pending = f.api("/api/do", { ...bulk, count: 1 })
  await ready
  try {
    assert.equal((await f.api("/api/do", bulk)).ok, false)
    assert.equal((await f.api("/api/do", { action: "bind-invite", uid: "u1", code: "A" })).ok, false)
  } finally { release() }
  assert.equal((await pending).bound, 1)
})

// ── 静态资源必须**完整下发**（T-50：48 KiB 疑云的回归钉） ─────────────────
//
// # 这一集在钉什么
//
// 有人报「`/assets/app.js` 只发出 49,152 字符 = 48 KiB，被截断」。实测后：
//   ① 服务端发的是**字节**。59,766 B 的 app.js 解码成字符串正好是 49,152 个
//      **字符**（中文 1 字符 = 3 字节）—— 那个「整数 48 KiB」是字符数，
//      **不是**截断点。字节数一个都不少（sha256 与磁盘一致）。
//   ② 但原实现不带 `Content-Length`（走 chunked）。一旦中间层/WebView 提前
//      收尾，前端拿到的就是半截 JS（SyntaxError ⇒ 整段脚本不执行 ⇒ 表现正是
//      「代码改了，浏览器里还是旧行为」）。
//
// 所以这里钉三件事，且一律用**逐字节 sha256** 比对，不只看长度：
//   · 200 KB / 600 KB 的静态文件字节数与内容都必须与磁盘一致；
//   · 真实 `page/assets/app.js`（>60 KB）下发长度 == 磁盘长度；
//   · 响应必须带 `Content-Length`（等于**字节数**，不是字符数）且不再走 chunked。

/** 造一个长度可控的假静态文件（ASCII 填充，内容可哈希），用完删掉。 */
function writeTempAsset(assetsDir, size) {
  const name = `__probe-${size}-${Math.random().toString(36).slice(2)}.bin`
  const file = join(assetsDir, name)
  writeFileSync(file, Buffer.alloc(size, 0x42))
  return { name, file }
}

test("静态文件 200KB / 600KB：字节数与 sha256 都必须与磁盘一致，且带 Content-Length", async (t) => {
  const { createHash } = await import("node:crypto")
  const sha = (buf) => createHash("sha256").update(buf).digest("hex")
  const assetsDir = join(dirname(new URL("../page/assets/app.js", import.meta.url).pathname.slice(1)), "")
  const f = await fixture(t, undefined, 1)

  for (const size of [200 * 1024, 600 * 1024]) {
    const { name, file } = writeTempAsset(assetsDir, size)
    t.after(() => { try { rmSync(file) } catch {} })
    const res = await f.rawBytes("GET", `/assets/${name}`)
    const disk = readFileSync(file)
    assert.equal(res.status, 200, `${size}B：必须能取到`)
    assert.equal(Number(res.headers["content-length"]), size, `${size}B：Content-Length 必须是字节数`)
    assert.equal(res.headers["transfer-encoding"], undefined, `${size}B：给了长度就不该再走 chunked`)
    assert.equal(res.body.length, size, `${size}B：收到的字节数必须等于磁盘长度`)
    assert.equal(sha(res.body), sha(disk), `${size}B：内容必须逐字节一致`)
  }
})

test("真实 page/assets/app.js（>60KB）下发长度 == 磁盘长度，且逐字节一致", async (t) => {
  const { createHash } = await import("node:crypto")
  const sha = (buf) => createHash("sha256").update(buf).digest("hex")
  const diskFile = new URL("../page/assets/app.js", import.meta.url)
  const disk = readFileSync(diskFile)
  assert.ok(disk.length > 60 * 1024, `app.js 现在只有 ${disk.length}B，这集的意义（>60KB）就没了`)
  const f = await fixture(t, undefined, 1)
  const res = await f.rawBytes("GET", "/assets/app.js")
  assert.equal(res.status, 200)
  assert.equal(Number(res.headers["content-length"]), disk.length, "Content-Length 必须等于磁盘字节数")
  assert.equal(res.body.length, disk.length, `下发 ${res.body.length}B ≠ 磁盘 ${disk.length}B`)
  assert.equal(sha(res.body), sha(disk), "内容必须逐字节一致")
})

test("含中文的 index.html：Content-Length 用的是字节数而不是字符数", async (t) => {
  const diskFile = new URL("../page/index.html", import.meta.url)
  const raw = readFileSync(diskFile, "utf8")
  // 端口替换只会改变数字长度；只要源文件里的 4391 是 4 位、替换成 4~5 位，
  // 长度差最多 1 个字节 × 出现次数。用「字符数 < 字节数」这个铁律来钉判据。
  assert.ok(raw.length < Buffer.byteLength(raw, "utf8"), "这集的前提：index.html 里有中文（字符 < 字节）")
  const f = await fixture(t, undefined, 1)
  const res = await f.rawBytes("GET", "/index.html")
  assert.equal(res.status, 200)
  const cl = Number(res.headers["content-length"])
  assert.equal(cl, res.body.length, "Content-Length 必须等于实际发出的字节数（用 str.length 会算小）")
  assert.ok(cl > raw.length, `Content-Length(${cl}) 必须大于字符数(${raw.length})，否则就是拿字符数当字节数了`)
})
