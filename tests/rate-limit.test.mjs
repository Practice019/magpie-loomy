// rate-limit.test.mjs **429 = 瞬时限流，不是封号**。
//
// # 真机实测（同一账号，全客户端头，间隔 1s × 10 次）
//
//	状态码序列：200,429,200,429,429,200,200,429,200,200     （4 次 429）
//	之后 /models 仍返回 DeepSeek-V4.1-Flash               —— 账号完全可用
//
// 用户体感「用一会儿号就被禁」的真相是：我们把 429 当失败 → magpie 反复重试
// → 叠加巡检把它误判成 routed → 号被排除掉。
//
// # 所以三处必须改
//
//	A) 判定侧（route / patrol）：429 ⇒ `keep:true, rateLimited:true`，绝不产出 routed/expired
//	B) 转发侧（loader）：429 原样透传，不重试、不改头、不打 warn
//	C) 冷却（loader → usage）：429 后 60 秒内给这个号一条**带 resetsAt** 的
//	   满额窗，让 magpie 短暂避开它，到期自动恢复（**不是**长期封禁）

import { test } from "node:test"
import assert from "node:assert/strict"

import { inspectCatalog, readLedgerRecords } from "../src/route.mjs"
import { patrolAccount } from "../src/patrol.mjs"
import { makeLoaderHook, cooldownOf } from "../src/hooks/loader.mjs"
import { makeUsageHook } from "../src/hooks/usage.mjs"

const SESSION = "s".repeat(32)
const UID = "260911173523492332"
const ACCOUNT_ID = "150****3411"
const BASE = "https://loomyad.xunfei.cn/api/v1"
const CHAT_URL = `${BASE}/chat/completions`

/** 一个总是回 429 的上游（带可选 Retry-After）。 */
function upstream429(retryAfter) {
  /** @type {any[]} */
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const headers = { "content-type": "application/json" }
    if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter)
    return new Response(JSON.stringify({ error: { type: "rate_limited" } }), { status: 429, headers })
  }
  return { calls, fetchImpl }
}

// ── A) 判定：429 不许产出 routed / expired ─────────────────────────────

test("route.readLedgerRecords：账本 429 → 报 rateLimited（不是普通网络错误）", async () => {
  const up = upstream429()

  // 429 在 pointsCall 里会被当成 HTTP 失败；关键是不能被上层当成「账号有问题」
  let err = null
  try {
    await readLedgerRecords({ baseUrl: BASE, session: SESSION, fetchImpl: up.fetchImpl })
  } catch (e) {
    err = e
  }
  assert.ok(err, "读取失败时仍要抛（调用方靠它 keep），但错误必须标明是限流")
  assert.equal(err.rateLimited, true, `错误对象要带 rateLimited 标记，实际: ${String(err?.message)}`)
})

test("route.inspectCatalog：目录 429 → rateLimited，**不**判 expired / unavailable", async () => {
  const up = upstream429()
  const r = await inspectCatalog({ baseUrl: BASE, session: SESSION, fetchImpl: up.fetchImpl })

  assert.equal(r.rateLimited, true)
  assert.notEqual(r.status, "expired", "429 不是凭证死了")
  assert.notEqual(r.status, "ok", "没读到目录就不能说 ok")
})

test("patrol：429 → keep:true + rateLimited，不覆盖已有 clean", async () => {
  const up = upstream429()
  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: UID,
    fetchImpl: up.fetchImpl,
    traffic: [],
  })

  assert.equal(r.keep, true, "限流时唯一正确的结论是「这次没测清，保留原状态」")
  assert.equal(r.rateLimited, true, "要让面板/上层知道是限流而非账号问题")
  assert.equal(r.verdict, undefined, "绝不能在 429 时产出 routed/expired")
})

// ── B) 转发：429 原样透传，不自愈 ──────────────────────────────────────

function loadWith({ fetchImpl, configDir = "", now }) {
  const hook = makeLoaderHook({
    configDir,
    routeStore: null,
    fetchImpl,
    recordTraffic: () => ({ ok: true }),
    now,
    log: { warn: () => {} },
  })
  return hook(async () => ({ type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }))
}

const BODY = JSON.stringify({ model: "DeepSeek-V4.1-Flash", messages: [] })

test("loader：429 原样返回给宿主（状态码 / body 一个字不改，不重试）", async () => {
  const up = upstream429()
  const loader = await loadWith({ fetchImpl: up.fetchImpl })

  const resp = await loader.fetch(CHAT_URL, { method: "POST", body: BODY })

  assert.equal(resp.status, 429)
  assert.match(await resp.text(), /rate_limited/)
  assert.equal(up.calls.length, 1, "不许自己重试：重试只会把限流恶化成封禁")
})

// ── C) 冷却：短暂避开，到期自动恢复 ────────────────────────────────────

test("loader：429 后记录冷却（同号再 429 会刷新时间）", async () => {
  const up = upstream429(30)
  let clock = Date.now()
  const loader = await loadWith({ fetchImpl: up.fetchImpl, configDir: "", now: () => clock })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  const first = cooldownOf(UID, clock)
  assert.ok(first, "429 必须在内存里留下冷却记录")
  assert.equal(first.until - clock, 30_000, "Retry-After: 30 ⇒ 冷却 30 秒")

  clock += 5_000
  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  const second = cooldownOf(UID, clock)
  assert.equal(second.until, clock + 30_000, "再吃一次 429 要把冷却刷到新的时刻")
})

test("loader：Retry-After 缺失时用默认 60 秒", async () => {
  const up = upstream429()
  const clock = Date.now()
  const loader = await loadWith({ fetchImpl: up.fetchImpl, configDir: "", now: () => clock })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  assert.equal(cooldownOf(UID, clock).until - clock, 60_000)
})

// ── usage：冷却期内报「限流冷却」，到期消失 ────────────────────────────

function fakePoints() {
  return async () =>
    new Response(
      JSON.stringify({ code: "000000", desc: "ok", data: { balance: 25000, dailyBalance: 1434, availableBalance: 26434 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
}

/**
 * 直接拿到 usage 的**返回对象**（加载 hook + 调一次）。
 *
 * 冷却窗口是 loader 写进**进程内存**的，所以这里必须与 loader 在同一进程内
 * 调 usage，并共用同一个 `now` 时钟 —— 才能验证「到期即消失」。
 *
 * @param {() => number} [now]
 * @returns {Promise<any>}
 */
async function callUsage(now = () => Date.now()) {
  const hook = makeUsageHook({
    baseUrl: BASE,
    configDir: "",
    routeStore: null,
    fetchImpl: fakePoints(),
    now,
    log: { warn() {} },
  })
  return hook(async () => ({ type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }))
}

test("usage：冷却期内出现「限流冷却」满额窗（used:100、非 aside、带 resetsAt）", async () => {
  const up = upstream429(45)
  const now = Date.now()
  const loader = await loadWith({ fetchImpl: up.fetchImpl, configDir: "", now: () => now })
  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })

  const u = await callUsage(() => now)
  const cool = (u.windows ?? []).find((w) => String(w?.name ?? "").includes("限流冷却"))

  assert.ok(cool, `冷却期内要有这条窗口，实际: ${JSON.stringify(u.windows)}`)
  assert.equal(cool.used, 100, "满额才会被路由跳过")
  assert.equal(cool.aside, undefined, "aside 会被 allowanceOf 跳过 —— 那就白报了")
  assert.equal(cool.limit, undefined)
  assert.equal(cool.amount, undefined)
  const resetsAt = Date.parse(String(cool.resetsAt))
  assert.ok(Number.isFinite(resetsAt), `resetsAt 必须是 ISO 字符串，实际: ${cool.resetsAt}`)
  assert.ok(resetsAt - now > 40_000 && resetsAt - now <= 45_000, `应在 45 秒内到期，实际差 ${resetsAt - now}ms`)
})

test("usage：冷却过期后该窗口自动消失（不需要外部清理）", async () => {
  const up = upstream429(1)
  let clock = Date.now()
  const loader = await loadWith({ fetchImpl: up.fetchImpl, configDir: "", now: () => clock })
  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })

  // 把时钟推到冷却之后
  clock += 1_100

  const u = await callUsage(() => clock)
  assert.equal(
    (u.windows ?? []).filter((w) => String(w?.name ?? "").includes("限流冷却")).length,
    0,
    "到期就该恢复派活，不能永久跳过",
  )
})
