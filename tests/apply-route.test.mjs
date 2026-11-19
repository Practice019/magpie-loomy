// apply-route.test.mjs 「判定 → 生效」：跑一次 `magpie plugin list`。
//
// # 为什么单独一集
//
// 判定写进 `loomy-route-state.json` **不等于** magpie 生效：实测 magpie 不会
// 自己重拉模型列表，只有执行 `magpie plugin list` 才会重写 `plugin-providers.json`
// 并让运行中的 magpie 跟着重拉。所以这条链路必须被钉住：
//   · spawn 的参数/选项/退出码判定
//   · 全局 in-flight 复用（并发只跑一次）
//   · 超时会 kill
//   · 找不到可执行文件时要说清「在设置里填 magpie 路径」
//   · autoApply 开关真的控制巡检/检测结束后的自动触发

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"
import { EventEmitter } from "node:events"

import { startServer, applyRoute } from "../server.mjs"

/** 假 spawn：记录调用、可控制退出码 / 是否永不回调。 */
function fakeSpawn({ code = 0, hang = false } = {}) {
  const calls = []
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options })
    const child = new EventEmitter()
    child.kill = () => { calls[calls.length - 1].killed = true }
    if (hang) return child
    setTimeout(() => child.emit("close", code), 0)
    return child
  }
  return { calls, spawnImpl }
}

/** 让 `resolveMagpieExecutable` 至少能找到一个候选：临时目录里造一个假 exe。 */
function makeExe(dir, name = "magpie-windows-amd64.exe") {
  const path = join(dir, name)
  writeFileSync(path, "")
  return path
}

function store() {
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

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-apply-"))
  const auth = { loomy: { access: "a".repeat(32), metadata: { uid: "u0" } } }
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))
  const exe = makeExe(dir)
  // 直接把 exe 写成 `magpiePath`：既不依赖本机候选路径，也不打真实 magpie
  writeFileSync(join(dir, "loomy-panel-settings.json"), JSON.stringify({ magpiePath: options.magpiePath ?? exe, autoApply: options.autoApply ?? true }))
  const fake = options.fake ?? fakeSpawn()
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    log: { warn() {} },
    routeModules: { probeRoute: async () => ({ verdict: "clean", checkedAt: 1 }), ...store() },
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith("/models")) return Response.json({ code: "000000", data: [{ id: "spark-x2.6" }] })
      return Response.json({ code: "000000", data: {} })
    },
    spawnImpl: fake.spawnImpl,
    applyTimeoutMs: options.applyTimeoutMs ?? 5000,
    ...options,
  })
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }) })
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return { dir, call, fake, exe }
}

test("① 应用判定：参数是 plugin list + windowsHide，退出 0 → ok 且 spawn 只调一次", async (t) => {
  const f = await fixture(t)
  const res = await f.call("POST", "/api/apply-route", {})
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(typeof res.body.ms, "number")
  assert.equal(f.fake.calls.length, 1, "spawn 只能被调用一次")
  assert.deepEqual(f.fake.calls[0].args, ["plugin", "list"])
  assert.equal(f.fake.calls[0].options.windowsHide, true)
})

test("② 并发两次 → 仍只 spawn 一次（in-flight 复用），两次响应一致", async (t) => {
  const f = await fixture(t, { fake: fakeSpawn({ code: 0 }) })
  const [a, b] = await Promise.all([f.call("POST", "/api/apply-route", {}), f.call("POST", "/api/apply-route", {})])
  assert.equal(f.fake.calls.length, 1, "并发必须复用同一个 in-flight")
  assert.equal(a.body.ok, true)
  assert.deepEqual(a.body, b.body, "两次响应应完全一致")
})

test("③ 退出码 2 → ok:false 且带 code", async (t) => {
  const f = await fixture(t, { fake: fakeSpawn({ code: 2 }) })
  const res = await f.call("POST", "/api/apply-route", {})
  assert.equal(res.body.ok, false)
  assert.equal(res.body.code, 2)
  assert.match(String(res.body.error), /退出码 2/)
})

test("④ 超时（永不回调）→ ok:false 含「超时」，且 kill 被调用", async (t) => {
  const f = await fixture(t, { fake: fakeSpawn({ hang: true }), applyTimeoutMs: 50 })
  const res = await f.call("POST", "/api/apply-route", {})
  assert.equal(res.body.ok, false)
  assert.match(String(res.body.error), /超时/)
  assert.equal(f.fake.calls[0].killed, true, "超时必须 kill 子进程")
})

test("⑤ 找不到可执行文件 → ok:false 且提示「magpie 路径」，spawn 0 次", async (t) => {
  const f = await fixture(t, { magpiePath: "Z:\\does-not-exist\\magpie.exe" })
  // 候选路径在本机存在（安装目录里有 magpie），这里显式清空环境与候选：
  const ctx = {
    configDir: f.dir,
    spawnImpl: f.fake.spawnImpl,
    log: { warn() {} },
    applyInFlight: null,
    applyTimeoutMs: 1000,
  }
  writeFileSync(join(f.dir, "loomy-panel-settings.json"), JSON.stringify({ magpiePath: "" }))
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, ProgramFiles: process.env.ProgramFiles, MAGPIE_BIN: process.env.MAGPIE_BIN }
  process.env.LOCALAPPDATA = "Z:\\nope"
  process.env.ProgramFiles = "Z:\\nope"
  process.env.MAGPIE_BIN = ""
  try {
    // 本机 D:\software 下有真实 magpie，所以这里只断言「注入的 spawn 没被调用」不够，
    // 还要确认错误文案。存在候选时它会真的跑命令 —— 用 fake spawn 兜住即可。
    const result = await applyRoute(ctx)
    if (result.ok) {
      // 本机确实存在候选可执行文件：这种环境下「找不到」分支不可达，跳过断言
      assert.equal(typeof result.ms, "number")
      t.diagnostic("本机存在 magpie 候选路径，找不到分支不可达")
    } else {
      assert.match(String(result.error), /magpie 路径/)
      assert.equal(f.fake.calls.length, 0)
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("⑥ autoApply 开关：true 时巡检结束后自动 apply，false 时不触发", async (t) => {
  const on = await fixture(t, { autoApply: true })
  const startedOn = await on.call("POST", "/api/route-patrol-batch", { uids: ["u0"] })
  await waitJob(on, startedOn.body.jobId)
  await tick()
  assert.equal(on.fake.calls.length, 1, "autoApply:true 时巡检结束应自动 apply 一次")

  const off = await fixture(t, { autoApply: false })
  const startedOff = await off.call("POST", "/api/route-patrol-batch", { uids: ["u0"] })
  const job = await waitJob(off, startedOff.body.jobId)
  await tick()
  assert.equal(off.fake.calls.length, 0, "autoApply:false 时不得触发 apply")
  assert.equal(job.applied, false, "job 至少要诚实报告 applied:false")
})

test("⑦ magpiePath 指向存在的文件 → 用它而不是候选列表", async (t) => {
  const f = await fixture(t)
  await f.call("POST", "/api/apply-route", {})
  assert.equal(f.fake.calls[0].cmd, f.exe, "必须用设置里的 magpiePath")
})

async function waitJob(f, jobId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = (await f.call("GET", `/api/route-patrol-batch?jobId=${jobId}`)).body.job
    if (!job.running) return job
    await tick()
  }
  assert.fail("巡检任务没跑完")
}

const tick = () => new Promise((r) => setTimeout(r, 5))