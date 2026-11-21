// invite-cache-bound.test.mjs —— T-56：**绑定结果必须写回「邀请」页缓存**。
//
// # 用户报的真 bug（日志原样）
//
//   15:43:12  [分配] 分配完成：成功 82，失败 0
//   15:43:23  [分配] 开始汇总码池：301 个账号（只读「邀请」页缓存，零上游）
//   15:43:24  [分配] 码池汇总完成：301/301 ... → **又显示 82 次可用**
//
// 根因：`runAssign` 绑定成功后只写了 `loomy-activation-cache.json` 与
// `loomy-invite-pool.json`，而「汇总」读的是 `loomy-invite-cache.json` 的
// `codes[ownerUid].codes[]`（`left = maxUses - usedCount`）—— 那份缓存一枚码都没动过。
//
// # 这一集在钉什么
//
//	① 核心回归：2 个码（各 left=1）+ 2 个未绑号 → assign → **再汇总，poolLeft === 0**
//	② 码的 `usedCount` 0 → 1；`maxUses: 1` 的码 `status` 变 `exhausted`
//	③ `maxUses: 0`（不限次）：usedCount +1，但 `status` 仍是 `active`
//	④ 被绑号在邀请缓存里的 `activation.activated === true` 且 `applied === code`
//	⑤ 写缓存失败（只读目录模拟）→ 绑定仍是 `bound`，job 不因此失败
//	⑥ `planInviteAssignments` 产出的 pair 里含 `ownerUid`（能定位码的持有者）
//
// ⚠ 真实网络一个字节都不发：`fetchImpl` 是桩；`tests/helpers/network-guard.mjs` 再兜一层。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer, planInviteAssignments } from "../server.mjs"

const POOL_FILE = "loomy-invite-pool.json"
const INVITE_FILE = "loomy-invite-cache.json"

const session = (i) => String.fromCharCode(97 + i).repeat(32)

/**
 * 面板服务 + 假上游。
 *
 * @param {import("node:test").TestContext} t
 * @param {{ verdicts?: Record<string, string>, bind?: (token: string, code: string) => any, options?: object }} [cfg]
 */
async function fixture(t, cfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-bound-cache-test-"))
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
      const body = init?.body ? JSON.parse(init.body) : null
      calls.push({ path, token, body, method: init?.method ?? "GET" })
      if (path === "/points/activation" && init?.method === "POST") {
        return cfg.bind ? cfg.bind(token, body?.inviteCode) : Response.json({ code: "000000", data: { code: "000000", activated: true, inviterReward: 5000 } })
      }
      if (path === "/invitation-codes") return Response.json({ code: "000000", data: { list: [] } })
      if (path === "/points/activation") return Response.json({ code: "000000", data: { activated: false } })
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
        /** @type {any} */
        let parsed
        try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on("error", reject)
    // ⚠ 执行器**不能有返回值**：`req.end()` 返回 socket，node:test 会把"回调式的测试体
    //    返回了 Promise"判成失败（`passed a callback but also returned a Promise`）。
    if (body === undefined) req.end()
    else req.end(JSON.stringify(body))
  })
  const readJson = (name) => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null
  const binds = () => calls.filter((c) => c.path === "/points/activation" && c.method === "POST")
  return { dir, call, calls, readJson, binds, tokenOf: (uid) => tokens.get(uid) }
}

/** 「邀请」页缓存的真实形状（见 `src/points.mjs` 的 `fetchInvitationCodes` 写出端）。 */
function seedInviteCache(f, entries, updatedAt = 1795053000000) {
  /** @type {Record<string, any>} */
  const codes = {}
  for (const [uid, e] of Object.entries(entries)) {
    codes[uid] = { codes: e.codes ?? [], activation: e.activation, at: e.at ?? 1795052900000, error: "" }
  }
  writeFileSync(join(f.dir, INVITE_FILE), JSON.stringify({ updatedAt, codes }))
}

/** 造一份池（跳过 scan，直接测分配）。 */
function seedPool(f, codes, unbound, at = 1795052000000) {
  writeFileSync(join(f.dir, POOL_FILE), JSON.stringify({ at, codes, unbound }))
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

/** 读「汇总」看到的数字（只读池缓存，零上游）。 */
async function readTotals(f) {
  const res = await f.call("GET", "/api/invite/pool")
  assert.equal(res.status, 200)
  return res.body.totals
}

/**
 * 权限收尾（同步函数：`t.after` 里不许返回 Promise）。
 *
 * ⚠ chmod 在 Windows 上只翻只读位、且对**目录**基本无效，所以本用例真正的
 *    "写不进去"靠的是 Windows 的「目标只读 ⇒ rename 覆盖失败」；POSIX 上
 *    `rename` 不看目标文件权限，所以两边都布置（文件 0444 + 目录 0555）。
 */
function restoreWritable(dir, dirMode, file) {
  try { chmodSync(dir, dirMode) } catch {}
  try { chmodSync(file, 0o600) } catch {}
}

// ── ① 核心回归：绑完再汇总，poolLeft 必须归零 ───────────────────────────

test("① 分配 2 对 → 再汇总：poolLeft 必须从 2 变 0（不再冒出可用次数）", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", h2: "clean", u1: "routed", u2: "routed" } })
  // 两个健康码各出一枚 left=1 的码；u1/u2 未绑
  seedInviteCache(f, {
    h1: { codes: [{ code: "AAA111", usedCount: 0, maxUses: 1, status: "active" }], activation: { activated: true } },
    h2: { codes: [{ code: "BBB222", usedCount: 0, maxUses: 1, status: "active" }], activation: { activated: true } },
    u1: { codes: [], activation: { activated: false } },
    u2: { codes: [], activation: { activated: false } },
  })

  // 第一次汇总：码池 2，未绑 2
  let started = await f.call("POST", "/api/invite/pool/scan", {})
  await waitJob(f, "/api/invite/pool/scan", started.body.jobId)
  const before = await readTotals(f)
  assert.equal(before.poolLeft, 2, "初始码池应当是 2")
  assert.equal(before.unboundCount, 2)

  // 分配：两个都真绑
  const binding = await f.call("POST", "/api/invite/assign", {})
  assert.equal(binding.status, 200)
  const job = await waitJob(f, "/api/invite/assign", binding.body.jobId)
  assert.equal(job.okCount, 2, `两个号都要绑成功：${JSON.stringify(job.results)}`)
  assert.equal(job.failCount, 0)
  assert.equal(f.binds().length, 2)

  // 第二次汇总：**零上游**，并且 poolLeft 归零
  const upstreamBefore = f.calls.length
  started = await f.call("POST", "/api/invite/pool/scan", {})
  const scan2 = await waitJob(f, "/api/invite/pool/scan", started.body.jobId)
  assert.equal(f.calls.length, upstreamBefore, "汇总仍是零上游")
  assert.equal(scan2.source, "cache")

  const after = await readTotals(f)
  t.diagnostic(`①②③④ poolLeft before / after = ${before.poolLeft} / ${after.poolLeft}`)
  assert.equal(after.poolLeft, 0, `绑完两枚 left=1 的码之后，码池必须归零（实际 ${after.poolLeft}）`)
  assert.equal(after.unboundCount, 0, "绑过的号不能再算未绑")

  // 再点一次「开始分配」也不该再建任务（没有可配对的）
  const again = await f.call("POST", "/api/invite/assign", {})
  assert.equal(again.body.jobId, "", "码池与未绑都空了就不该再建分配任务")
})

// ── ② usedCount +1，maxUses:1 的码变 exhausted ──────────────────────────

test("② 绑定成功后：邀请缓存里码的 usedCount 0→1，maxUses:1 的码 status 变 exhausted", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", u1: "routed" } })
  seedInviteCache(f, {
    h1: { codes: [{ code: "ONE111", usedCount: 0, maxUses: 1, status: "active" }], activation: { activated: true } },
    u1: { codes: [], activation: { activated: false } },
  })
  await f.call("POST", "/api/invite/pool/scan", {}).then((r) => waitJob(f, "/api/invite/pool/scan", r.body.jobId))

  const binding = await f.call("POST", "/api/invite/assign", {})
  const job = await waitJob(f, "/api/invite/assign", binding.body.jobId)
  assert.equal(job.results.u1.status, "bound")

  const code = f.readJson(INVITE_FILE).codes.h1.codes.find((c) => c.code === "ONE111")
  assert.ok(code, "码必须还在缓存里（只改 usedCount/status，不删）")
  assert.equal(code.usedCount, 1, "usedCount 必须 += 1")
  assert.equal(code.maxUses, 1, "maxUses 不变")
  assert.equal(code.status, "exhausted", "usedCount >= maxUses ⇒ exhausted")
})

// ── ③ maxUses: 0 = 不限次数：只加 usedCount，status 不变 ────────────────

test("③ maxUses:0（不限次数）的码：usedCount +1，但 status 仍是 active", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", u1: "routed", u2: "routed" } })
  seedInviteCache(f, {
    h1: { codes: [{ code: "INF999", usedCount: 7, maxUses: 0, status: "active" }], activation: { activated: true } },
    u1: { codes: [], activation: { activated: false } },
    u2: { codes: [], activation: { activated: false } },
  })
  await f.call("POST", "/api/invite/pool/scan", {}).then((r) => waitJob(f, "/api/invite/pool/scan", r.body.jobId))

  const binding = await f.call("POST", "/api/invite/assign", {})
  const job = await waitJob(f, "/api/invite/assign", binding.body.jobId)
  assert.equal(job.okCount, 2, `不限次的码要给两个号都绑上：${JSON.stringify(job.results)}`)

  const code = f.readJson(INVITE_FILE).codes.h1.codes.find((c) => c.code === "INF999")
  assert.equal(code.usedCount, 9, "绑两次 ⇒ usedCount 7 → 9")
  assert.equal(code.maxUses, 0)
  assert.equal(code.status, "active", "不限次数（maxUses:0）的码永远不该被判 exhausted")

  // 汇总之后它仍可用（唯一一枚，变成 unlimited:true）
  const totals = await readTotals(f)
  assert.ok(totals.poolLeft >= 1, "不限次的码必须仍然可用")
})

// ── ④ 被绑号的 activation 写回邀请缓存 ─────────────────────────────────

test("④ 被绑号在邀请缓存里 activation.activated=true 且 applied === 用掉的码", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", u1: "routed" } })
  seedInviteCache(f, {
    h1: { codes: [{ code: "ABC888", usedCount: 0, maxUses: 6, status: "active" }], activation: { activated: true } },
    u1: { codes: [], activation: { activated: false } },
  })
  await f.call("POST", "/api/invite/pool/scan", {}).then((r) => waitJob(f, "/api/invite/pool/scan", r.body.jobId))

  const binding = await f.call("POST", "/api/invite/assign", {})
  await waitJob(f, "/api/invite/assign", binding.body.jobId)

  const entry = f.readJson(INVITE_FILE).codes.u1
  assert.ok(entry, "被绑号那条记录必须还在（不能整条被抹掉）")
  assert.equal(entry.activation.activated, true, "激活状态要写进邀请缓存（汇总只看这一份）")
  assert.equal(entry.activation.applied, "ABC888", "applied 必须是他用掉的那枚码")
})

// ── ⑤ 写缓存失败不能把绑定判失败 ────────────────────────────────────────

test("⑤ 邀请缓存写不进去（只读文件）→ 绑定仍是 bound，job 不因此失败", async (t) => {
  const f = await fixture(t, { verdicts: { h1: "clean", u1: "routed" } })
  seedInviteCache(f, {
    h1: { codes: [{ code: "RO9999", usedCount: 0, maxUses: 6, status: "active" }], activation: { activated: true } },
    u1: { codes: [], activation: { activated: false } },
  })
  await f.call("POST", "/api/invite/pool/scan", {}).then((r) => waitJob(f, "/api/invite/pool/scan", r.body.jobId))

  // ⚠ `t.after` 必须交出同步收尾：箭头函数体（不是 `{ return ... }`），否则 node:test
  //    会判定"既给回调又返回 Promise"，把用例打成假的失败。
  const dirMode = statSync(f.dir).mode
  // 在 POSIX 上 rename 不看目标文件权限（看目录权限），所以两边都布置：
  //   ① 目标文件只读（Windows 生效）② 目录去掉写位（POSIX 生效，rename 会 EACCES）
  const file = join(f.dir, INVITE_FILE)
  const before = readFileSync(file, "utf8")
  let readOnly = true
  try {
    chmodSync(file, 0o444)
    chmodSync(f.dir, 0o555)
    if (process.platform !== "win32") readOnly = (statSync(f.dir).mode & 0o200) === 0
  } catch (e) {
    readOnly = false
    t.diagnostic(`只读模拟失败（跳过严格判定）：${e?.message ?? e}`)
  }
  t.after(() => { restoreWritable(f.dir, dirMode, file) })

  let job
  try {
    const binding = await f.call("POST", "/api/invite/assign", {})
    assert.equal(binding.status, 200)
    job = await waitJob(f, "/api/invite/assign", binding.body.jobId)
  } finally {
    try { chmodSync(f.dir, dirMode) } catch {}
    try { chmodSync(file, 0o600) } catch {}
  }

  assert.equal(job.results.u1.status, "bound", `上游已经绑成功，写缓存失败不能改判：${JSON.stringify(job.results.u1)}`)
  assert.equal(job.okCount, 1)
  assert.equal(job.failCount, 0, "job 不能因为本地写盘失败而记失败")
  assert.equal(job.running, false)
  // 缓存内容没被写坏（原子写：失败就保持原样，不留半截文件）。
  // ⚠ 只在**真的只读**时严格断言"一字不动"；Windows 上 chmod 对目录无效，
  //    写入可能其实成功了 —— 那也不是 bug，所以这里只记录事实。
  const after = readFileSync(file, "utf8")
  if (readOnly && after === before) {
    t.diagnostic("⑤ 只读目录模拟生效：缓存一字未动（写盘失败被吞掉，绑定仍是 bound）")
  } else {
    t.diagnostic(`⑤ 只读模拟未生效（Windows chmod 对目录无效）：缓存被更新，绑定仍是 bound`)
    assert.equal(after.includes("RO9999"), true, "即使这次写成功了，缓存也必须仍是合法 JSON 且没丢码")
  }
  t.diagnostic(`⑤ 只读模拟后绑定结果：${job.results.u1.status}`)
})

// ── ⑥ pair 里必须带 ownerUid ────────────────────────────────────────────

test("⑥ planInviteAssignments 产出的 pair 含 ownerUid / ownerKey（能定位码的持有者）", () => {
  const pairs = planInviteAssignments({
    codes: [
      { code: "AAA111", ownerKey: "loomy", ownerUid: "h1", ownerName: "号h1", maxUses: 3, usedCount: 0, left: 3, status: "active", unlimited: false },
      { code: "INF999", ownerKey: "loomy#2", ownerUid: "h2", ownerName: "号h2", maxUses: 0, usedCount: 5, left: 1, status: "active", unlimited: true },
    ],
    unbound: [
      { key: "u1", uid: "u1", verdict: "routed" },
      { key: "u2", uid: "u2", verdict: "routed" },
      { key: "u3", uid: "u3", verdict: "routed" },
      { key: "u4", uid: "u4", verdict: "routed" },
    ],
  }, null)
  assert.equal(pairs.length, 4)
  for (const p of pairs) assert.ok(p.ownerUid, `pair 缺 ownerUid：${JSON.stringify(p)}`)
  // 有限次的码先用（AAA111 有 3 次 → 前 3 对），不存在 ownerUid 解不出的 pair
  assert.deepEqual(pairs.map((p) => [p.uid, p.code, p.ownerUid]), [
    ["u1", "AAA111", "h1"],
    ["u2", "AAA111", "h1"],
    ["u3", "AAA111", "h1"],
    ["u4", "INF999", "h2"],
  ])
  assert.equal(pairs[0].ownerKey, "loomy")
})