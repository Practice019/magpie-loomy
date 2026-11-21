// invite-assign.test.mjs —— 「邀请码分配」（健康码出码 → 未绑号去绑 → 健康码拿积分）的回归集（T-50）。
//
// # 这一集在钉什么
//
//	① `GET /api/invite/pool` **只读缓存**：零上游（空缓存 / 有缓存 / 损坏缓存三态）
//	② `POST /api/invite/pool/scan` 只扫 `verdict === "clean"` 的号取码，
//	   未绑号一律查 `GET /points/activation`，**跳过 expired**（号已死）
//	③ 池的算术：`left = maxUses - usedCount`，`maxUses: 0` = 不限次数，
//	   `status === "exhausted"` 不计入池
//	④ `POST /api/invite/assign` 优先消耗 `left` 最大的码；`alreadyActivated` 算跳过
//	   不算失败；风控（429 / 100002 / 100003）**立即停整组**；相邻两次绑定 ≥ gapMs
//	⑤ 面板：`data-tab="assign"` + 三张数字卡；**打开页面不触发 scan/assign**
//
// ⚠ 这一集一个字节的真实网络都不会发：`fetchImpl` 全部是桩。
// ⚠ 「健康」只认 verdict（与 `src/route-store.mjs` 的 `getAccountRoute` 同口径）。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer } from "../server.mjs"

const POOL_FILE = "loomy-invite-pool.json"
const ACTIVATION_FILE = "loomy-activation-cache.json"

const session = (i) => String.fromCharCode(97 + i).repeat(32)

/**
 * 建一个面板服务 + 假上游。
 *
 * @param {import("node:test").TestContext} t
 * @param {{ verdicts?: Record<string, string>, codes?: Record<string, any[]>, activation?: Record<string, any>,
 *   bind?: (token: string, code: string) => any, delay?: number, options?: object }} [cfg]
 */
async function fixture(t, cfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-assign-test-"))
  const tokens = new Map()
  /** @type {Record<string, any>} */
  const auth = {}
  let i = 0
  for (const uid of Object.keys(cfg.verdicts ?? {})) {
    const token = session(i)
    tokens.set(uid, token)
    auth[`loomy#${i}`] = { access: token, accountId: `138****000${i}`, metadata: { uid, nickname: `号${uid}`, phone: `138****000${i}` } }
    i += 1
  }
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))

  /** @type {Record<string, any>} */
  const routeData = {}
  for (const [uid, verdict] of Object.entries(cfg.verdicts ?? {})) routeData[uid] = { verdict, reason: verdict === "clean" ? "ledger-deepseek" : "mock", checkedAt: 1 }
  const routeModules = {
    probeRoute: async () => ({ verdict: "clean", checkedAt: 1 }),
    readRouteState: () => ({ ok: true, data: routeData }),
    writeRouteState: () => ({ ok: true }),
    getAccountRoute: (_dir, uid) => routeData[uid] ?? null,
  }

  const calls = []
  const options = {
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://mock.invalid/api/v1",
    log: { warn() {} },
    routeModules,
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname.replace("/api/v1", "")
      const token = init?.headers?.get ? init.headers.get("token") : init?.headers?.token
      const body = init?.body ? JSON.parse(init.body) : null
      calls.push({ path, token, body, at: Date.now(), method: init?.method })
      if (cfg.delay) await new Promise((r) => setTimeout(r, cfg.delay))
      if (path === "/invitation-codes") {
        const uid = [...tokens].find(([, tk]) => tk === token)?.[0]
        return Response.json({ code: "000000", data: { list: structuredClone(cfg.codes?.[uid] ?? []) } })
      }
      if (path === "/points/activation" && (init?.method ?? "GET") === "GET") {
        const uid = [...tokens].find(([, tk]) => tk === token)?.[0]
        const state = cfg.activation?.[uid] ?? { activated: false }
        return Response.json({ code: "000000", data: structuredClone(state) })
      }
      if (path === "/points/activation" && init?.method === "POST") {
        return cfg.bind ? cfg.bind(token, body?.inviteCode) : Response.json({ code: "000000", data: { code: "000000", activated: true, inviterReward: 5000 } })
      }
      return Response.json({ code: "000000", data: {} })
    },
    ...cfg.options,
  }
  const server = await startServer(options)
  t.after(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => {
        /** @type {any} */
        let parsed
        try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const tokenOf = (uid) => tokens.get(uid)
  const readJson = (name) => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null
  const binds = () => calls.filter((c) => c.path === "/points/activation" && c.method === "POST")
  const getActivation = () => calls.filter((c) => c.path === "/points/activation" && (c.method ?? "GET") === "GET")
  const getCodes = () => calls.filter((c) => c.path === "/invitation-codes")
  return { dir, call, calls, tokenOf, readJson, binds, getActivation, getCodes }
}

/** 轮询到 job 结束（最多 20 秒）。 */
async function waitJob(f, path, jobId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await f.call("GET", `${path}?jobId=${encodeURIComponent(jobId)}`)
    assert.equal(res.status, 200, `${path} 进度查询失败：${JSON.stringify(res.body)}`)
    const job = res.body.job
    if (!job.running) return job
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail(`任务 ${jobId} 没跑完`)
}

const OK = (data = {}) => () => Response.json({ code: "000000", data })

// ── ① 池缓存只读 ────────────────────────────────────────────────────────

test("① GET /api/invite/pool 有缓存时原样返回，且**一个上游请求都不发**", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", u1: "routed" } })
  writeFileSync(join(f.dir, POOL_FILE), JSON.stringify({
    at: 1795052000000,
    codes: [{ code: "KUNBE5", ownerKey: "h1", ownerUid: "h1", maxUses: 6, usedCount: 2, left: 4, status: "active", at: 1 }],
    unbound: [{ key: "u1", uid: "u1", verdict: "routed", error: "", at: 1 }],
  }))
  const res = await f.call("GET", "/api/invite/pool")
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.at, 1795052000000)
  assert.deepEqual(res.body.codes.map((c) => [c.code, c.ownerKey, c.left]), [["KUNBE5", "h1", 4]])
  assert.deepEqual(res.body.unbound.map((u) => [u.key, u.verdict]), [["u1", "routed"]])
  assert.deepEqual(res.body.totals, { poolLeft: 4, unboundCount: 1 })
  assert.equal(f.calls.length, 0, "打开面板 / 读池缓存不得发上游请求")
})

test("② 无缓存（以及缓存损坏）时 GET /api/invite/pool 仍是 200 空结构，零上游", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean" } })
  const empty = await f.call("GET", "/api/invite/pool")
  assert.equal(empty.status, 200)
  assert.equal(empty.body.ok, true)
  assert.equal(empty.body.at, 0)
  assert.deepEqual(empty.body.codes, [])
  assert.deepEqual(empty.body.unbound, [])
  assert.deepEqual(empty.body.totals, { poolLeft: 0, unboundCount: 0 })

  writeFileSync(join(f.dir, POOL_FILE), "{broken")
  const broken = await f.call("GET", "/api/invite/pool")
  assert.equal(broken.status, 200, "损坏的缓存文件不能让面板整页报错")
  assert.deepEqual(broken.body.codes, [], "损坏 = 空缓存（它是缓存，重建比报错有用）")
  assert.equal(f.calls.length, 0)
})

// ── ② 扫描：只扫健康码；未绑号跳过 expired ──────────────────────────────

test("③ scan 只向 verdict==='clean' 的号取码：routed / expired / exhausted / 未检测一律不碰", async (t) => {
  const f = await fixture(t, {
    verdicts: { h1: "clean", h2: "clean", r1: "routed", e1: "expired", x1: "exhausted" },
    codes: { h1: [{ inviteCode: "AAA111", usedCount: 0, maxUses: 1, status: "active" }] },
    activation: { r1: { activated: false }, e1: { activated: false } },
  })
  const started = await f.call("POST", "/api/invite/pool/scan", {})
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  const job = await waitJob(f, "/api/invite/pool/scan", started.body.jobId)
  assert.equal(job.running, false)

  const codeTokens = f.getCodes().map((c) => c.token)
  assert.ok(codeTokens.length > 0, "健康码必须被扫到")
  assert.ok(codeTokens.includes(f.tokenOf("h1")) && codeTokens.includes(f.tokenOf("h2")), "clean 的号要取码")
  for (const uid of ["r1", "e1", "x1"]) {
    assert.ok(!codeTokens.includes(f.tokenOf(uid)), `${uid} 不是健康号，绝不能向它取码（用户明确「邀请者必须是健康的」）`)
  }
  // expired 的号连 activated 都不查（号已死，别浪费请求）
  // ⚠ 只对 expired 跳查：routed / exhausted 仍需查激活状态才能进 unbound（见 ③b）。
  const hitTokens = f.getActivation().map((c) => c.token)
  assert.ok(!hitTokens.includes(f.tokenOf("e1")), "e1 不该被查激活状态（号已死，别浪费请求）")
})

test("③b scan 把未绑号写进池：activated=false 进 unbound，已绑的不进；expired 不查 activation", async (t) => {
  const f = await fixture(t, {
    verdicts: { h1: "clean", r1: "routed", r2: "routed", e1: "expired" },
    codes: { h1: [{ inviteCode: "AAA111", usedCount: 0, maxUses: 1, status: "active" }] },
    activation: { r1: { activated: false }, r2: { activated: true, appliedInvitationCode: "V5GZ3M" }, e1: { activated: false } },
  })
  const started = await f.call("POST", "/api/invite/pool/scan", {})
  await waitJob(f, "/api/invite/pool/scan", started.body.jobId)
  const pool = f.readJson(POOL_FILE)
  assert.ok(pool, "扫描必须落盘 loomy-invite-pool.json")
  assert.deepEqual(pool.unbound.map((u) => [u.key, u.verdict]), [["r1", "routed"]], "只有明确未绑的号进池")
  // 已绑的号写进 activation 缓存，下次不再重复查
  const activation = f.readJson(ACTIVATION_FILE)
  assert.equal(activation.entries.r2.activated, true)
  assert.equal(activation.entries.r2.code, "V5GZ3M")
  assert.equal(activation.entries.r2.at > 0, true)

  // 再扫一次：已绑过的号**不重复扫**（activation 缓存命中就跳过）
  const before = f.getActivation().length
  const again = await f.call("POST", "/api/invite/pool/scan", {})
  await waitJob(f, "/api/invite/pool/scan", again.body.jobId)
  const tokens = f.getActivation().slice(before).map((c) => c.token)
  assert.ok(!tokens.includes(f.tokenOf("r2")), "已绑过的号不该再查 activation（缓存复活）")
})

// ── ③ 池的算术 ──────────────────────────────────────────────────────────

test("④ maxUses: 0 是**不限次数**，不会被算成 0 剩余", async (t) => {
  const f = await fixture(t, {
    verdicts: { h1: "clean" },
    codes: { h1: [{ inviteCode: "INF999", usedCount: 99, maxUses: 0, status: "active" }] },
  })
  const started = await f.call("POST", "/api/invite/pool/scan", {})
  await waitJob(f, "/api/invite/pool/scan", started.body.jobId)
  const pool = f.readJson(POOL_FILE)
  const code = pool.codes.find((c) => c.code === "INF999")
  assert.ok(code, "不限次数的码必须进池")
  assert.equal(code.unlimited, true)
  assert.equal(code.left >= 1, true, "left 必须 ≥ 1（不能是 0）")
  assert.equal(Number.isFinite(code.left), true, "left 必须是有限数，界面与配对才敢用")
  const read = await f.call("GET", "/api/invite/pool")
  assert.equal(read.body.totals.poolLeft > 0, true)
})

test("⑤ status:'exhausted' 的码不计入池；left = maxUses - usedCount", async (t) => {
  const f = await fixture(t, {
    verdicts: { h1: "clean" },
    codes: {
      h1: [
        { inviteCode: "OLD111", usedCount: 6, maxUses: 6, status: "exhausted" },
        { inviteCode: "MIS222", usedCount: 6, maxUses: 6, status: "active" },
        { inviteCode: "MID333", usedCount: 2, maxUses: 6, status: "active" },
      ],
    },
  })
  const started = await f.call("POST", "/api/invite/pool/scan", {})
  await waitJob(f, "/api/invite/pool/scan", started.body.jobId)
  const pool = f.readJson(POOL_FILE)
  const byCode = Object.fromEntries(pool.codes.map((c) => [c.code, c]))
  assert.equal(byCode.OLD111, undefined, "已耗尽（status）的码不进池")
  assert.equal(byCode.MIS222, undefined, "usedCount==maxUses 的码也不进池")
  assert.equal(byCode.MID333.left, 4, "left = maxUses - usedCount = 6 - 2")
  const read = await f.call("GET", "/api/invite/pool")
  assert.equal(read.body.totals.poolLeft, 4)
})

// ── ④ 分配 ──────────────────────────────────────────────────────────────

/** 造一份「已在缓存里」的池（跳过 scan，直接测分配）。 */
function seedPool(f, codes, unbound, at = 1795052000000) {
  writeFileSync(join(f.dir, POOL_FILE), JSON.stringify({ at, codes, unbound }))
}

test("⑥ assign 优先消耗 left 最大的码（让老号的大码先用完）", async (t) => {
  const f = await fixture(t, {
    verdicts: { u1: "routed", u2: "routed", u3: "routed" },
    codes: {},
  })
  seedPool(f, [
    { code: "SMALL1", ownerKey: "h1", ownerUid: "h1", maxUses: 6, usedCount: 5, left: 1, status: "active", at: 1 },
    { code: "BIG666", ownerKey: "h2", ownerUid: "h2", maxUses: 6, usedCount: 0, left: 6, status: "active", at: 1 },
    { code: "MID222", ownerKey: "h3", ownerUid: "h3", maxUses: 6, usedCount: 4, left: 2, status: "active", at: 1 },
  ], [
    { key: "u1", uid: "u1", verdict: "routed", at: 1 },
    { key: "u2", uid: "u2", verdict: "routed", at: 1 },
    { key: "u3", uid: "u3", verdict: "routed", at: 1 },
  ])
  const started = await f.call("POST", "/api/invite/assign", {})
  assert.equal(started.status, 200)
  const job = await waitJob(f, "/api/invite/assign", started.body.jobId)
  assert.equal(job.running, false)
  assert.deepEqual(f.binds().map((c) => c.body.inviteCode), ["BIG666", "BIG666", "BIG666"], "最大 left 的码先被消耗")
  assert.equal(job.done, 3)
  const pool = f.readJson(POOL_FILE)
  const big = pool.codes.find((c) => c.code === "BIG666")
  assert.equal(big.left, 3, "每绑一个号消耗该码 1 次")
  assert.equal(big.usedCount, 3, "usedCount 也要跟着涨")
})

test("⑦ assign 遇到 alreadyActivated → 标记跳过、继续下一个、不报失败", async (t) => {
  const f = await fixture(t, {
    verdicts: { u1: "routed", u2: "routed" },
    codes: {},
    bind: (token, code) => {
      // 第 1 个号返回「已激活」回执（真实形态见 docs/INVITE-REBIND.md）
      if (token === f.tokenOf("u1")) {
        return Response.json({ code: "000000", data: { activated: true, alreadyActivated: true, currentBalance: 35000, permanentBalance: 30000, inviteeReward: 0, inviterReward: 0, invitationCodes: [{ inviteCode: "KUNBE5", usedCount: 6, maxUses: 6, status: "exhausted" }] } })
      }
      return Response.json({ code: "000000", data: { activated: true, inviterReward: 5000 } })
    },
  })
  seedPool(f, [{ code: "AAA111", ownerKey: "h1", ownerUid: "h1", maxUses: 6, usedCount: 0, left: 6, status: "active", at: 1 }], [
    { key: "u1", uid: "u1", verdict: "routed", at: 1 },
    { key: "u2", uid: "u2", verdict: "routed", at: 1 },
  ])
  const started = await f.call("POST", "/api/invite/assign", {})
  const job = await waitJob(f, "/api/invite/assign", started.body.jobId)
  assert.equal(job.done, 2, "两个号都要有结果（一个跳过、一个成功）")
  assert.equal(job.skipCount, 1)
  assert.equal(job.failCount, 0, "alreadyActivated 不是失败")
  assert.equal(job.okCount, 1)
  assert.equal(job.stopped, "")
  assert.equal(job.results.u1.status, "already-activated")
  assert.equal(job.results.u2.status, "bound")
  assert.equal(f.binds().length, 2, "跳过后必须继续下一个")
  // 跳过不消耗次数
  const pool = f.readJson(POOL_FILE)
  assert.equal(pool.codes.find((c) => c.code === "AAA111").left, 5)
  // 已绑过 / 刚绑成功的号都从 unbound 里移出：再配一次就是重复绑定（也是 ⑨「再点不建任务」的前提）。
  assert.deepEqual(pool.unbound.map((u) => u.key), [])
})

test("⑧ assign 遇到风控 → 立即停止整组（剩余账号一次都不打）", async (t) => {
  const f = await fixture(t, {
    verdicts: { u1: "routed", u2: "routed", u3: "routed", u4: "routed" },
    codes: {},
    bind: () => Response.json({ code: "000000", data: { riskControl: true, activated: false } }),
  })
  seedPool(f, [{ code: "AAA111", ownerKey: "h1", ownerUid: "h1", maxUses: 0, usedCount: 0, left: 100, status: "active", at: 1 }], [
    { key: "u1", uid: "u1", verdict: "routed", at: 1 },
    { key: "u2", uid: "u2", verdict: "routed", at: 1 },
    { key: "u3", uid: "u3", verdict: "routed", at: 1 },
    { key: "u4", uid: "u4", verdict: "routed", at: 1 },
  ])
  const started = await f.call("POST", "/api/invite/assign", {})
  const job = await waitJob(f, "/api/invite/assign", started.body.jobId)
  assert.equal(job.stopped, "risk-control")
  assert.equal(job.running, false)
  assert.ok(job.done < 4, `风控后必须停下，实际打了 ${job.done} 个`)
  assert.ok(f.binds().length <= 2, `风控后不得继续打，实际 ${f.binds().length} 次（并发 1 时应当是 1 次）`)
})

test("⑨ assign 两次绑定启动间隔 ≥ gapMs（默认 300ms，实测启动时刻）", async (t) => {
  const f = await fixture(t, {
    verdicts: { u1: "routed", u2: "routed", u3: "routed", u4: "routed" },
    codes: {},
  })
  seedPool(f, [{ code: "AAA111", ownerKey: "h1", ownerUid: "h1", maxUses: 0, usedCount: 0, left: 100, status: "active", at: 1 }], [
    { key: "u1", uid: "u1", verdict: "routed", at: 1 },
    { key: "u2", uid: "u2", verdict: "routed", at: 1 },
    { key: "u3", uid: "u3", verdict: "routed", at: 1 },
    { key: "u4", uid: "u4", verdict: "routed", at: 1 },
  ])
  const GAP = 300
  const binding = await f.call("POST", "/api/invite/assign", {})
  assert.equal(binding.status, 200)
  const job = await waitJob(f, "/api/invite/assign", binding.body.jobId)
  assert.equal(job.done, 4)
  const starts = f.binds().map((c) => c.at)
  assert.equal(starts.length, 4)
  // ⚠ 断言**平均**启动间隔（与 refresh-jobs 的 ③ 同一口径）：并发跑整套测试时
  //    逐对比较会被机器的调度抖动打成假红，而平均间隔仍然只在「真的隔了 gapMs」
  //    时才成立。
  const avgGap = (starts.at(-1) - starts[0]) / (starts.length - 1)
  assert.ok(avgGap >= GAP - 30, `相邻两次绑定的平均间隔不足 ${GAP}ms：${avgGap.toFixed(0)}ms`)

  // 池里的号已经绑完了 → 再点「开始分配」既不打上游，也不建任务
  const before = f.binds().length
  const again = await f.call("POST", "/api/invite/assign", {})
  assert.equal(again.body.jobId, "", "没有可配对时不该建任务")
  assert.equal(f.binds().length, before, "没有可配对的号就不该再打上游")
})

// ── ⑤ 面板 ──────────────────────────────────────────────────────────────

test("⑩ index.html 含 data-tab=assign 与三张数字卡，且打开页面不触发 scan/assign", () => {
  const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")
  const js = readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")
  const css = readFileSync(new URL("../page/assets/style.css", import.meta.url), "utf8")

  assert.match(html, /data-tab="assign"/, "必须新增「邀请码分配」标签页")
  assert.match(html, /id="pane-assign"/)
  for (const id of ["stat-assign-pool", "stat-assign-unbound", "stat-assign-pairs"]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺数字卡 ${id}`)
  }
  for (const id of ["assign-scan", "assign-run", "assign-stop", "assign-codes", "assign-unbound"]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺控件 ${id}`)
  }
  // 危险提示必须在 HTML 里（用户看得见，不靠 JS 生成）
  assert.match(html, /不可撤销/, "「开始分配」旁边必须有「不可撤销」警示")

  // 打开页面（loadInitial）不得触发 scan/assign
  const load = js.slice(js.indexOf("async function loadInitial("), js.indexOf("\n}\n", js.indexOf("async function loadInitial(")))
  assert.ok(load.length > 0, "找不到 loadInitial")
  assert.ok(!/pool\/scan/.test(load), "loadInitial 不得触发 scan")
  assert.ok(!/invite\/assign/.test(load), "loadInitial 不得触发 assign")

  // 首屏只在**用户点开那个 tab** 之后读一次池缓存（零上游）
  const activate = js.slice(js.indexOf('$("#tab-assign")'), js.indexOf("// ── 邀请码分配 · 执行", js.indexOf('$("#tab-assign")')))
  assert.ok(activate.includes("/api/invite/pool"), "tab 打开后应读一次池缓存（只读，零上游）")
  assert.ok(!/pool\/scan/.test(activate) && !/invite\/assign/.test(activate), "tab 打开也不许自动扫描/分配")

  assert.match(css, /\.assign-stats/, "三张数字卡需要自己的栅格（不能复用到 .stats 的四列）")
})

// ── 其它 ────────────────────────────────────────────────────────────────

test("⑪ assign 没有可配对时立即返回 0 任务且零上游（拒绝空转）", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean" } })
  seedPool(f, [], [])
  const started = await f.call("POST", "/api/invite/assign", {})
  assert.equal(started.status, 200)
  assert.equal(started.body.total, 0)
  assert.equal(started.body.jobId, "")
  assert.equal(f.binds().length, 0)
})

void OK