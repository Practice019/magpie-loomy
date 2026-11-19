// byturn.test.mjs 「这一轮到底由哪个模型服务」—— 唯一权威判据。
//
// # 真机验证过的链路
//
//	POST /chat/completions 带 TurnId: turn_probe_8083
//	→ GET /points/by-turn?turnId=turn_probe_8083   （token 头）
//	→ {"data":{"turnId":"…","purpose":"chat.message","found":true,"points_consumed":1,
//	           "ledger_count":1,"modelName":"spark-x2.6-low",…}}
//
// `modelName` 就是**该轮实际服务的模型**；`found:false` 说明账本还没落（有延迟，
// 要重试）。参数名必须是 `turnId`（不是 chatId）。
//
// # 为什么它是「唯一」判据
//
// 目录能谎报（有 DS4.1 却路由到 spark）、账本只能事后猜时间窗口；
// 只有 by-turn 能把「这一个请求」和「它实际扣费/服务的模型」精确对上。
//
// # 三条纪律
//
//	① 查询是**旁路**：`void`，绝不让它拖慢或破坏对话请求
//	② 查不到（found:false / 500 / 超时）**绝不改状态** —— 不能因为没查到就把号判死
//	③ 只有 spark* / deepseek* 这种明确族才下结论；其它（含空）→ null

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { newTurnId, fetchTurnResult, classifyByTurn, probeByTurn } from "../src/byturn.mjs"
import { makeLoaderHook } from "../src/hooks/loader.mjs"
import { readRouteState } from "../src/route-store.mjs"

const SESSION = "s".repeat(32)
const UID = "260911173523492332"
const ACCOUNT_ID = "150****3411"
const BASE = "https://loomyad.xunfei.cn/api/v1"
const CHAT_URL = `${BASE}/chat/completions`

// ── A) 纯函数 ──────────────────────────────────────────────────────────

test("newTurnId() 形如 turn_<16hex>，且每次不同", () => {
  const a = newTurnId()
  const b = newTurnId()
  assert.match(a, /^turn_[0-9a-f]{16}$/)
  assert.match(b, /^turn_[0-9a-f]{16}$/)
  assert.notEqual(a, b, "每轮一个新 id —— 复用就把两轮混成一轮了")
})

test("classifyByTurn：spark → routed，deepseek → clean，其它 → null", () => {
  assert.deepEqual(classifyByTurn("spark-x2.6-low"), { verdict: "routed", reason: "by-turn-spark" })
  assert.deepEqual(classifyByTurn("SPARK-X"), { verdict: "routed", reason: "by-turn-spark" })
  assert.deepEqual(classifyByTurn("deepseek-v4-flash-1017"), { verdict: "clean", reason: "by-turn-deepseek" })
  assert.equal(classifyByTurn("glm-5.3-flash"), null, "其它族不判（认不出就不下结论）")
  assert.equal(classifyByTurn(""), null)
  assert.equal(classifyByTurn(null), null)
})

test("fetchTurnResult：found 时给出模型与扣费点数（参数名必须是 turnId）", async () => {
  /** @type {string[]} */
  const urls = []
  const fetchImpl = async (url, init) => {
    urls.push(String(url))
    assert.equal(new Headers(init.headers).get("token"), SESSION, "by-turn 走 token 那条轨")
    return Response.json({
      data: { turnId: "turn_abc", purpose: "chat.message", found: true, points_consumed: 1, ledger_count: 1, modelName: "spark-x2.6-low" },
    })
  }

  const r = await fetchTurnResult({ baseUrl: BASE, session: SESSION, turnId: "turn_abc", fetchImpl })

  assert.equal(r.found, true)
  assert.equal(r.modelName, "spark-x2.6-low")
  assert.equal(r.pointsConsumed, 1)
  assert.match(urls[0], /\/points\/by-turn\?turnId=turn_abc/)
})

test("fetchTurnResult：found:false 会按递增间隔重试，最终仍 false 就如实返回", async () => {
  let calls = 0
  /** @type {number[]} */
  const sleeps = []
  const fetchImpl = async () => {
    calls += 1
    return Response.json({ data: { found: false } })
  }

  const r = await fetchTurnResult({
    baseUrl: BASE,
    session: SESSION,
    turnId: "turn_x",
    fetchImpl,
    retries: 4,
    intervalMs: 1500,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })

  assert.equal(r.found, false)
  assert.equal(calls, 5, "首次 + 4 次重试")
  assert.deepEqual(sleeps, [1500, 3000, 4500, 6000], "间隔应是 1.5/3/4.5/6 秒（线性递增）")
})

test("fetchTurnResult：HTTP 500 / 网络错误不抛出，返回 found:false + code", async () => {
  const bad = async () => new Response("boom", { status: 500 })
  const r = await fetchTurnResult({ baseUrl: BASE, session: SESSION, turnId: "turn_x", fetchImpl: bad, retries: 1, intervalMs: 0, sleep: async () => {} })
  assert.equal(r.found, false)
  assert.match(String(r.code || r.reason), /500|HTTP|http/i)

  const net = async () => {
    throw new Error("ECONNRESET")
  }
  const r2 = await fetchTurnResult({ baseUrl: BASE, session: SESSION, turnId: "turn_x", fetchImpl: net, retries: 1, intervalMs: 0, sleep: async () => {} })
  assert.equal(r2.found, false)
  assert.ok(String(r2.reason).length > 0)
})

// ── B) loader 集成 ─────────────────────────────────────────────────────

/** 造一个假上游：chat 200 + by-turn 由 `byTurn` 决定。 */
async function harness({ byTurn, configDir, turnHeader }) {
  /** @type {Array<{url: string, init: any}>} */
  const calls = []
  const chatFetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return Response.json({ choices: [{ message: { content: "pong" } }] })
  }
  const byTurnFetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return byTurn ? byTurn() : Response.json({ data: { found: false } })
  }
  const hook = makeLoaderHook({
    configDir,
    baseUrl: BASE,
    fetchImpl: chatFetch,
    byTurnFetch,
    byTurnRetries: 1,
    byTurnIntervalMs: 0,
    byTurnSleep: async () => {},
    recordTraffic: () => ({ ok: true }),
    log: { warn() {} },
    ...(turnHeader ? { turnId: () => turnHeader } : {}),
  })
  return { calls, loader: await hook(async () => ({ type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID })) }
}

const BODY = JSON.stringify({ model: "DeepSeek-V4.1-Flash", messages: [] })
const settle = () => new Promise((r) => setTimeout(r, 80))

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-byturn-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("loader：对话请求带上生成的 TurnId 头；已存在时不覆盖", async (t) => {
  const dir = tempDir(t)
  const { calls, loader } = await harness({ configDir: dir })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  const chats = () => calls.filter((c) => c.url.includes("/chat/completions"))
  const h1 = new Headers(chats()[0].init.headers)
  // 抓包实证（第十五轮）：loader 生成的 TurnId 是 `msg-<uuid>`（与 MsgId 同值）；
  // `turn_*` 只用于面板的 `probeByTurn`。
  assert.match(String(h1.get("turnid")), /^msg-[0-9a-f-]{36}$/i)

  const fixed = "turn_0123456789abcdef"
  await loader.fetch(CHAT_URL, { method: "POST", body: BODY, headers: { TurnId: fixed } })
  assert.equal(new Headers(chats()[1].init.headers).get("turnid"), fixed, "调用方给的 TurnId 不许覆盖")
  assert.equal(new Headers(chats()[1].init.headers).get("msgid"), fixed, "MsgId 跟随调用方给的 TurnId")
})

test("loader：200 之后触发一次 by-turn 查询（chat 1 次 + by-turn 1 次）", async (t) => {
  const dir = tempDir(t)
  const { calls, loader } = await harness({ configDir: dir, byTurn: () => Response.json({ data: { found: true, modelName: "x" } }) })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  await settle()

  const byTurnCalls = calls.filter((c) => c.url.includes("/points/by-turn"))
  assert.equal(calls.filter((c) => c.url.includes("/chat/completions")).length, 1)
  assert.equal(byTurnCalls.length, 1, "一个请求对应一次 by-turn 核对")
  // ⚠ 用的是**这次请求的** TurnId，不是别的
  assert.match(byTurnCalls[0].url, /turnId=msg-/)
})

test("loader：by-turn 返回 spark → 该 uid 被刻成 routed / by-turn-spark", async (t) => {
  const dir = tempDir(t)
  const { loader } = await harness({
    configDir: dir,
    byTurn: () => Response.json({ data: { found: true, modelName: "spark-x2.6-low", points_consumed: 1 } }),
  })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  await settle()

  const entry = readRouteState(dir).data[UID]
  assert.ok(entry, `应当写盘，实际: ${JSON.stringify(readRouteState(dir))}`)
  assert.equal(entry.verdict, "routed")
  assert.equal(entry.reason, "by-turn-spark")
  assert.equal(entry.servedModel, "spark-x2.6-low")
  assert.equal(typeof entry.checkedAt, "number")
})

test("loader：by-turn 返回 deepseek → clean / by-turn-deepseek", async (t) => {
  const dir = tempDir(t)
  const { loader } = await harness({
    configDir: dir,
    byTurn: () => Response.json({ data: { found: true, modelName: "deepseek-v4-flash-1017" } }),
  })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  await settle()

  const entry = readRouteState(dir).data[UID]
  assert.equal(entry.verdict, "clean")
  assert.equal(entry.reason, "by-turn-deepseek")
})

test("loader：found:false 重试到底仍 false → **不改状态**，只 warn", async (t) => {
  const dir = tempDir(t)
  /** @type {string[]} */
  const logs = []
  const hook = makeLoaderHook({
    configDir: dir,
    baseUrl: BASE,
    fetchImpl: async () => Response.json({ choices: [] }),
    byTurnFetch: async () => Response.json({ data: { found: false } }),
    byTurnRetries: 2,
    byTurnIntervalMs: 0,
    byTurnSleep: async () => {},
    recordTraffic: () => ({ ok: true }),
    log: { warn: (m) => logs.push(String(m)) },
  })
  const loader = await hook(async () => ({ type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }))

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  await settle()

  assert.deepEqual(readRouteState(dir).data, {}, "查不到 ≠ 判死：状态文件必须保持空")
  assert.ok(logs.some((m) => m.includes("by-turn")), `要有 warn 线索，实际: ${logs.join(" | ")}`)
})

test("loader：by-turn 查询失败（500）→ 同样不改状态", async (t) => {
  const dir = tempDir(t)
  const { loader } = await harness({ configDir: dir, byTurn: () => new Response("boom", { status: 500 }) })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  await settle()

  assert.deepEqual(readRouteState(dir).data, {})
})

test("loader：by-turn 查询不阻塞响应（注入永不 resolve 的查询）", async (t) => {
  const dir = tempDir(t)
  const { loader } = await harness({
    configDir: dir,
    byTurn: () => new Promise(() => {}),
  })

  const started = Date.now()
  const resp = await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  const took = Date.now() - started

  assert.equal(resp.status, 200)
  assert.ok(took < 100, `响应不该等 by-turn，实际耗时 ${took}ms`)
})

// ── 面板用的一次性检测（C）────────────────────────────────────────────

test("probeByTurn：发最小请求（带 TurnId）→ by-turn → 给出 routed/clean", async () => {
  /** @type {Array<{url: string, init: any}>} */
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes("/chat/completions")) {
      assert.match(String(new Headers(init.headers).get("turnid")), /^turn_probe_[0-9a-f]{16}$/)
      return Response.json({ choices: [{ message: { content: "pong" } }] })
    }
    return Response.json({ data: { found: true, modelName: "spark-x2.6-low", points_consumed: 1 } })
  }

  const r = await probeByTurn({ baseUrl: BASE, session: SESSION, fetchImpl })

  assert.equal(calls.length, 2, "一次 chat + 一次 by-turn")
  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "by-turn-spark")
  assert.equal(r.servedModel, "spark-x2.6-low")
  assert.equal(r.requested, "deepseek-v4-flash-1017", "默认用客户端模板里的模型（抓包实证）")
})

test("probeByTurn：by-turn 查不到 → unknown（上层据此 keep，不写盘）", async () => {
  const fetchImpl = async (url) =>
    String(url).includes("/chat/completions")
      ? Response.json({ choices: [] })
      : Response.json({ data: { found: false } })

  const r = await probeByTurn({ baseUrl: BASE, session: SESSION, fetchImpl, retries: 1, intervalMs: 0, sleep: async () => {} })

  assert.equal(r.verdict, "unknown")
  assert.match(String(r.reason), /by-turn/)
})