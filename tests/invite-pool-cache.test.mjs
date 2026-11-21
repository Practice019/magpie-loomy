// invite-pool-cache.test.mjs —— T-52：「汇总」= **纯本地计算**，零上游。
//
// 用户的现场（原话）：「有没有绑过？不应该本地也有吗？绑定状态那里不是写了吗？这些都是本地的呀。」
//
// `~/.config/magpie/loomy-invite-cache.json` 里每条账号记录都已经有四个字段：
//   {codes:[{code,usedCount,maxUses,status}], activation:{activated,applied}, at, error}
// 也就是说「码池」和「绑定状态」**本来就都在本地**，汇总一次上游都不该打。
//
// # 这一集在钉什么
//
//	① 汇总全程**零 fetch**（注入计数器：`invitation-codes` 与 `points/activation` 都是 0）
//	② 码池算术读 `cache.codes[uid].codes`：`left = maxUses - usedCount`、
//	   `maxUses: 0` = 不限次、`status: "exhausted"` 不计、`usedCount == maxUses` 不计
//	③ 未绑列表读 `cache.codes[uid].activation.activated`，**健康与否都算**
//	   （积分归「码的持有者」：A 绑 B 的码 ⇒ B 拿 5000，健康未绑号也是可用被邀请者）
//	④ 缺 `activation` 的号 → 跳过 + `warnings` 里一句话，**不算失败**；
//	   只有显式 `refreshMissing: true` 才补拉（这时才允许出现上游请求）
//	⑤ `GET /api/invite/pool` 返回 `source === "cache"` 且 `missing` 数字正确
//
// ⚠ 一个字节的真实网络都不发：`fetchImpl` 是桩；`tests/helpers/network-guard.mjs` 再兜一层。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer } from "../server.mjs"

const POOL_FILE = "loomy-invite-pool.json"
const INVITE_FILE = "loomy-invite-cache.json"

const session = (i) => String.fromCharCode(97 + i).repeat(32)

/**
 * 面板服务 + 假上游（计数器是这一集的主角：`calls` 必须一直是 0）。
 *
 * @param {import("node:test").TestContext} t
 * @param {{ verdicts: Record<string, string>, options?: object }} cfg
 */
async function fixture(t, cfg) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-pool-cache-test-"))
  const tokens = new Map()
  const auth = {}
  let i = 0
  for (const uid of Object.keys(cfg.verdicts)) {
    const token = session(i)
    tokens.set(uid, token)
    auth[`loomy#${i}`] = { access: token, accountId: `138****000${i}`, metadata: { uid, nickname: `号${uid}`, phone: `138****000${i}` } }
    i += 1
  }
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))

  const routeData = {}
  for (const [uid, verdict] of Object.entries(cfg.verdicts)) routeData[uid] = { verdict, reason: verdict === "clean" ? "ledger-deepseek" : "mock", checkedAt: 1 }
  const routeModules = {
    probeRoute: async () => ({ verdict: "clean", checkedAt: 1 }),
    readRouteState: () => ({ ok: true, data: routeData }),
    writeRouteState: () => ({ ok: true }),
    getAccountRoute: (_dir, uid) => routeData[uid] ?? null,
  }

  /** @type {{path: string, token: string, method: string}[]} */
  const calls = []
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://mock.invalid/api/v1",
    log: { warn() {} },
    routeModules,
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname.replace("/api/v1", "")
      const token = init?.headers?.get ? init.headers.get("token") : init?.headers?.token
      calls.push({ path, token, method: init?.method ?? "GET" })
      if (path === "/invitation-codes") {
        const uid = [...tokens].find(([, tk]) => tk === token)?.[0]
        return Response.json({ code: "000000", data: { list: [{ inviteCode: `LIVE-${uid}`, usedCount: 0, maxUses: 6, status: "active" }] } })
      }
      if (path === "/points/activation") {
        const uid = [...tokens].find(([, tk]) => tk === token)?.[0]
        return Response.json({ code: "000000", data: { activated: false, applied: "", live: uid } })
      }
      return Response.json({ code: "000000", data: {} })
    },
    ...cfg.options,
  })
  t.after(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => {
        let parsed
        try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const readJson = (name) => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null
  const codesCalls = () => calls.filter((c) => c.path === "/invitation-codes")
  const activationCalls = () => calls.filter((c) => c.path === "/points/activation" && c.method === "GET")
  return { dir, call, calls, tokens, readJson, codesCalls, activationCalls }
}

/**
 * 预置「邀请」页缓存（形状与真实文件一致，见 `src/points.mjs` 的 `fetchInvitationCodes`）。
 *
 * @param {{dir: string}} f
 * @param {Record<string, {codes?: any[], activation?: any, at?: number}>} entries
 */
function seedInviteCache(f, entries, updatedAt = 1795053000000) {
  const codes = {}
  for (const [uid, e] of Object.entries(entries)) {
    codes[uid] = { codes: e.codes ?? [], activation: e.activation, at: e.at ?? 1795052900000, error: "" }
  }
  writeFileSync(join(f.dir, INVITE_FILE), JSON.stringify({ updatedAt, codes }))
  return updatedAt
}

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

// ── ① 核心：汇总全程零 fetch ────────────────────────────────────────────

test("① 汇总全程零 fetch：invitation-codes = 0，points/activation = 0（数字全部来自本地缓存）", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", h2: "clean", r1: "routed", r2: "routed", e1: "expired", x1: "exhausted" } })
  seedInviteCache(f, {
    h1: { codes: [{ code: "KUNBE5", usedCount: 6, maxUses: 6, status: "exhausted" }, { code: "H1AAA", usedCount: 1, maxUses: 6, status: "active" }], activation: { activated: true, applied: "ZZZ111" } },
    h2: { codes: [{ code: "H2BBB", usedCount: 0, maxUses: 3, status: "active" }], activation: { activated: true } },
    r1: { codes: [], activation: { activated: false } },
    r2: { codes: [], activation: { activated: true, applied: "V5GZ3M" } },
    e1: { codes: [], activation: { activated: false } },
    x1: { codes: [], activation: { activated: false } },
  })

  const started = await f.call("POST", "/api/invite/pool/scan", {})
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  const job = await waitJob(f, "/api/invite/pool/scan", started.body.jobId)

  // 这张计数表就是验收证据
  t.diagnostic(`请求计数表 —— invitation-codes: ${f.codesCalls().length} / points/activation: ${f.activationCalls().length} / 总请求: ${f.calls.length}`)
  assert.equal(f.codesCalls().length, 0, "汇总不得向上游取码（码池本来就在本地）")
  assert.equal(f.activationCalls().length, 0, "汇总不得向上游查绑定状态（绑定状态本来就在本地）")
  assert.equal(f.calls.length, 0, "汇总必须零上游请求")
  assert.equal(job.total, 6)
  assert.equal(job.done, 6)
  assert.equal(job.failCount, 0)
  assert.equal(job.source, "cache")

  // 码池与未绑列表都按缓存算出来了
  const pool = f.readJson(POOL_FILE)
  assert.deepEqual(pool.codes.map((c) => c.code), ["H1AAA", "H2BBB"], "只有健康码的可用码进池")
  assert.deepEqual(pool.unbound.map((u) => [u.uid, u.verdict]), [["r1", "routed"], ["x1", "exhausted"]], "只有非健康 + 明确未绑的号进池")
})

// ── ② 码池算术（全部读 cache.codes[uid].codes）─────────────────────────

test("② left 由缓存算出：maxUses 0 = 不限次、exhausted 不计、usedCount==maxUses 不计", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean" } })
  seedInviteCache(f, {
    h1: {
      codes: [
        { code: "INF999", usedCount: 99, maxUses: 0, status: "active" },
        { code: "OLD111", usedCount: 6, maxUses: 6, status: "exhausted" },
        { code: "MIS222", usedCount: 6, maxUses: 6, status: "active" },
        { code: "MID333", usedCount: 2, maxUses: 6, status: "active" },
      ],
      activation: { activated: true },
    },
  })
  const started = await f.call("POST", "/api/invite/pool/scan", {})
  await waitJob(f, "/api/invite/pool/scan", started.body.jobId)

  const pool = f.readJson(POOL_FILE)
  const byCode = Object.fromEntries(pool.codes.map((c) => [c.code, c]))
  assert.deepEqual(pool.codes.map((c) => c.code), ["INF999", "MID333"], "耗尽 / 已满的码不进池")
  assert.equal(byCode.INF999.unlimited, true)
  assert.ok(byCode.INF999.left >= 1 && Number.isFinite(byCode.INF999.left), "不限次的码 left 必须 ≥1 且有限")
  assert.equal(byCode.MID333.left, 4, "left = maxUses - usedCount = 6 - 2")
  assert.equal(byCode.MID333.usedCount, 2)
  assert.equal(byCode.MID333.maxUses, 6)
  assert.equal(f.calls.length, 0)
})

// ── ③ 未绑列表（读 cache.codes[uid].activation.activated）──────────────
//
// ⚠ 未绑号**不限健康与否**（用户裁定 A）：积分归「码的持有者」，不是「谁去绑」。
//    A（健康）绑 B（健康）的码 ⇒ B 拿 5000，所以健康的未绑号也是可用被邀请者。

test("③ 未绑列表来自 activation.activated：false 的号都进（**含健康号**）；已绑 / expired 不进", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", r1: "routed", r2: "routed", e1: "expired" } })
  seedInviteCache(f, {
    h1: { codes: [{ code: "AAA111", usedCount: 0, maxUses: 1, status: "active" }], activation: { activated: false } },
    r1: { codes: [], activation: { activated: false } },
    r2: { codes: [], activation: { activated: true, applied: "V5GZ3M" } },
    e1: { codes: [], activation: { activated: false } },
  })
  const started = await f.call("POST", "/api/invite/pool/scan", {})
  const job = await waitJob(f, "/api/invite/pool/scan", started.body.jobId)

  const pool = f.readJson(POOL_FILE)
  assert.deepEqual(
    pool.unbound.map((u) => [u.uid, u.verdict]),
    [["h1", "clean"], ["r1", "routed"]],
    "健康的未绑号（h1）也要进；r2 已绑、e1 号已死 → 不进",
  )
  assert.equal(job.results.r1.activation, false)
  assert.equal(job.results.r2.activation, true)
  assert.equal(job.results.h1.activation, false, "健康号的绑定状态照样要读")
  assert.equal(f.calls.length, 0, "全程零上游")
})

// ── ④ 缺数据：跳过 + warnings，默认不补拉；开关打开才补 ────────────────

test("④ 缺 activation 的号 → warnings 一句话、不算失败；refreshMissing 才补拉（且补拉后不再缺）", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", r1: "routed", r2: "routed" } })
  seedInviteCache(f, {
    h1: { codes: [{ code: "AAA111", usedCount: 0, maxUses: 1, status: "active" }], activation: { activated: true } },
    r1: { codes: [], activation: { activated: false } },
    // r2 只有码、没有 activation（真实环境里约 19 个号是这样的）
    r2: { codes: [] },
  })

  const started = await f.call("POST", "/api/invite/pool/scan", {})
  const job = await waitJob(f, "/api/invite/pool/scan", started.body.jobId)

  assert.equal(f.calls.length, 0, "默认绝不补拉：缺数据也不打上游")
  assert.equal(job.failCount, 0, "缺数据不是失败")
  assert.equal(job.okCount, 3)
  assert.equal(job.done, 3)
  assert.equal(job.missing, 1, "只有 r2 缺数据")
  assert.equal(job.warnings.length, 1)
  assert.match(job.warnings[0], /r2/, "warnings 必须指得出是哪个号")
  assert.match(job.warnings[0], /缺绑定状态.*邀请.*页读一次/)
  assert.equal(job.results.r2.ok, true)
  assert.equal(job.results.r2.missing, true)
  assert.equal(job.results.r2.activation, null, "读不到的绑定状态就是 null（不猜）")
  assert.deepEqual(f.readJson(POOL_FILE).unbound.map((u) => u.uid), ["r1"], "缺数据的号不会因为缺数据而被当成未绑")

  // 开关打开：只对缺的那个号补拉一次
  const before = f.calls.length
  const again = await f.call("POST", "/api/invite/pool/scan", { refreshMissing: true })
  const job2 = await waitJob(f, "/api/invite/pool/scan", again.body.jobId)
  const added = f.calls.slice(before)
  assert.equal(added.length, 1, `refreshMissing 只补缺的那一个号，实际 ${added.length} 次：${JSON.stringify(added)}`)
  assert.equal(added[0].path, "/points/activation")
  assert.equal(job2.missing, 0, "补拉之后不再缺")
  assert.deepEqual(job2.warnings, [])
  assert.equal(job2.source, "cache+live", "补拉过的来源要标出来")
  const cached = f.readJson(INVITE_FILE).codes.r2
  assert.equal(cached.activation.activated, false, "补拉结果要写回缓存（下次又回到零上游）")
  assert.deepEqual(f.readJson(POOL_FILE).unbound.map((u) => u.uid), ["r1", "r2"])
})

// ── ⑤ 返回结构：source / cacheAt / missing ─────────────────────────────

test("⑤ GET /api/invite/pool 返回 source:'cache'、cacheAt=缓存时间、missing 与实际缺数据的号数一致", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", h2: "clean", r1: "routed" } })
  const updatedAt = seedInviteCache(f, {
    h1: { codes: [{ code: "AAA111", usedCount: 0, maxUses: 1, status: "active" }], activation: { activated: true } },
    // h2 是健康码但缓存里没有 codes → 缺「码」；r1 有 activation
    h2: { codes: [], activation: { activated: true } },
    r1: { codes: [], activation: { activated: false } },
  })
  // 让 h2 的 codes 真的缺（undefined 与空数组在汇总里等价，这里构造"没有这个字段"的形态）
  const raw = JSON.parse(readFileSync(join(f.dir, INVITE_FILE), "utf8"))
  delete raw.codes.h2.codes
  writeFileSync(join(f.dir, INVITE_FILE), JSON.stringify(raw))

  const started = await f.call("POST", "/api/invite/pool/scan", {})
  const job = await waitJob(f, "/api/invite/pool/scan", started.body.jobId)
  assert.equal(job.missing, 1, "h2 缺邀请码缓存 = 1 个号缺数据")
  assert.match(job.warnings[0], /h2.*缺邀请码缓存/)

  const res = await f.call("GET", "/api/invite/pool")
  assert.equal(res.status, 200)
  assert.equal(res.body.source, "cache", "码池来源必须是本地缓存")
  assert.equal(res.body.cacheAt, updatedAt, "cacheAt 是 loomy-invite-cache.json 的 updatedAt")
  assert.equal(res.body.missing, 1)
  assert.equal(res.body.warnings.length, 1)
  assert.deepEqual(res.body.codes.map((c) => c.code), ["AAA111"], "缺码的号不贡献码，但不影响别的号")
  assert.deepEqual(res.body.unbound.map((u) => u.uid), ["r1"])
  assert.deepEqual(res.body.totals, { poolLeft: 1, unboundCount: 1 })
  assert.equal(f.calls.length, 0, "整个流程零上游")
})

// ── ⑥ 健康未绑号也进 unbound（用户裁定 A）→ 可配对 = min(码池, 未绑) ──

test("⑥ 健康且未绑的号进 unbound，可配对 = min(poolLeft, unbound.length)", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", h2: "clean", h3: "clean", r1: "routed" } })
  seedInviteCache(f, {
    // 供码的健康号（自己已绑，只出码）
    h1: { codes: [{ code: "BIG666", usedCount: 0, maxUses: 6, status: "active" }], activation: { activated: true } },
    // 两个健康但**没绑过**的号：它们必须能当被邀请者（A 绑 B 的码 ⇒ B 拿 5000）
    h2: { codes: [], activation: { activated: false } },
    h3: { codes: [], activation: { activated: false } },
    // 非健康的未绑号：同样要进
    r1: { codes: [], activation: { activated: false } },
  })

  const started = await f.call("POST", "/api/invite/pool/scan", {})
  await waitJob(f, "/api/invite/pool/scan", started.body.jobId)
  assert.equal(f.calls.length, 0, "汇总仍然零上游")

  const pool = f.readJson(POOL_FILE)
  assert.deepEqual(
    pool.unbound.map((u) => [u.uid, u.verdict]),
    [["h2", "clean"], ["h3", "clean"], ["r1", "routed"]],
    "健康未绑号（h2/h3）必须进 unbound，不再被「供码方」规则排除",
  )

  const res = await f.call("GET", "/api/invite/pool")
  assert.deepEqual(res.body.totals, { poolLeft: 6, unboundCount: 3 })

  // 可配对 = min(码池, 未绑)：干跑一个上游请求都不发
  const dry = await f.call("POST", "/api/invite/assign", { dryRun: true })
  assert.equal(dry.status, 200)
  assert.equal(dry.body.total, Math.min(res.body.totals.poolLeft, res.body.totals.unboundCount))
  assert.equal(dry.body.total, 3)
  assert.deepEqual(dry.body.pairs.map((p) => p.uid), ["h2", "h3", "r1"], "三个未绑号都能配到码")
  assert.equal(f.calls.length, 0, "干跑也不打上游")
})
