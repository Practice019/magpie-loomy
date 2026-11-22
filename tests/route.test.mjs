// route.test.mjs 路由检测：发一次真实 chat 读实际模型（账本分支仍保留给 patrol）。
//
// # 两层行为
//
//  · probeRoute：①② 免费前置（目录 / 余额）命中就直接返回、不发 chat；
//                否则发一次与真实调用同头同体的 chat，读响应 SSE 的 model 分类。
//  · evaluateReadOnly（不传 probeChat）：只读账本分支，给不愿花积分的巡检用。
//
// 断言分三组：免费前置（chat 0）、chat 判定（chat 1）、只读账本分支（chat 0）。

import { test } from "node:test"
import assert from "node:assert/strict"

import { DS41_MODEL_ID, probeRoute, evaluateReadOnly } from "../src/route.mjs"

const BASE = "https://loomyad.xunfei.cn/api/v1"
const SESSION = "s".repeat(32)
const CHAT_CREATED = 1_700_000_200
const PROBE_PROMPT = "不要思考，只回复一个hi"

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** 造一条带 model 的 SSE；model 为空则造一条没有 model 的 chunk（模拟读不到）。 */
function sseResponse(model) {
  const chunk = { object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] }
  if (model) chunk.model = model
  const text = "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n"
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

function envelope(list, balance = {}) {
  return { code: "000000", desc: "success", data: { list, ...balance } }
}

function upstream({
  catalog = [DS41_MODEL_ID],
  catalogShape = "data",
  catalogStatus = 200,
  catalogBody = null,
  pages = [envelope([], { availableBalance: 34900 })],
  ledgerStatus = 200,
  chatModel = "deepseek-v4-flash-1017",
  chatStatus = 200,
} = {}) {
  const calls = { catalog: [], ledger: [], chat: [] }
  let ledgerReads = 0

  const fetchImpl = async (url, init) => {
    const href = String(url)
    if (href.endsWith("/models")) {
      calls.catalog.push({ url: href, init })
      if (catalogBody !== null) return jsonResponse(catalogBody, catalogStatus)
      if (catalogStatus !== 200) return jsonResponse({ code: "FAIL" }, catalogStatus)
      return jsonResponse(catalogShape === "models" ? { models: catalog } : { data: catalog })
    }
    if (href.includes("/points/records")) {
      calls.ledger.push({ url: href, init })
      const page = pages[Math.min(ledgerReads, pages.length - 1)] ?? envelope([], {})
      ledgerReads += 1
      return jsonResponse(page, ledgerStatus)
    }
    if (href.endsWith("/chat/completions")) {
      calls.chat.push({ url: href, init })
      if (chatStatus !== 200) return jsonResponse({ code: "FAIL" }, chatStatus)
      return sseResponse(chatModel)
    }
    throw new Error("unexpected request: " + href)
  }

  fetchImpl.calls = calls
  return fetchImpl
}

const fakeSleep = async () => {}
const RICH = { availableBalance: 34900 }
const readOnly = (fetchImpl) => evaluateReadOnly({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

// ── 组 1：免费前置（命中就不发 chat）─────────────────────────────────────

test("目录 401 → expired（chat 0、账本 0）", async () => {
  const fetchImpl = upstream({ catalogStatus: 401 })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "expired")
  assert.equal(r.reason, "session-expired")
  assert.equal(r.servedModel, "（登录已失效）")
  assert.equal(fetchImpl.calls.chat.length, 0)
  assert.equal(fetchImpl.calls.ledger.length, 0)
})

test("目录 100003 + 账号已被停用 → expired / account-disabled（chat 0）", async () => {
  const fetchImpl = upstream({ catalogBody: { code: "100003", desc: "账号已被停用" } })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "expired")
  assert.equal(r.reason, "account-disabled")
  assert.equal(r.servedModel, "（账号已停用）")
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("目录无 DS4.1 → routed / catalog-missing-ds41（chat 0、账本 0）", async () => {
  const fetchImpl = upstream({ catalog: ["spark-x2.6-low", "spark-x2.6-4b"] })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "catalog-missing-ds41")
  assert.equal(fetchImpl.calls.chat.length, 0)
  assert.equal(fetchImpl.calls.ledger.length, 0)
})

test("余额 0 → exhausted / no-quota（chat 0、不读记录）", async () => {
  const fetchImpl = upstream({ pages: [envelope([], { availableBalance: 0 })] })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "exhausted")
  assert.equal(r.reason, "no-quota")
  assert.equal(fetchImpl.calls.chat.length, 0)
  assert.equal(fetchImpl.calls.ledger.filter((c) => c.url.includes("pageSize=10")).length, 0)
})

test("balance + dailyBalance 都为 0 → exhausted", async () => {
  const fetchImpl = upstream({ pages: [envelope([], { balance: 0, dailyBalance: 0 })] })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "exhausted")
  assert.equal(r.reason, "no-quota")
})

test("账本业务码 100003 → expired（余额步骤识别登录失效）", async () => {
  const businessFail = async (url) => {
    const href = String(url)
    if (href.endsWith("/models")) return jsonResponse({ data: [{ id: DS41_MODEL_ID }] })
    if (href.includes("/points/records")) return jsonResponse({ code: "100003", desc: "登录已失效" })
    throw new Error("unexpected request: " + href)
  }
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl: businessFail, sleep: fakeSleep })
  assert.equal(r.verdict, "expired")
  assert.equal(r.reason, "session-expired")
})

// ── 组 2：chat 判定（发一次真实 chat 读 model）─────────────────────────

test("chat 实际 spark-x2.6-low → routed / ledger-spark", async () => {
  const fetchImpl = upstream({ chatModel: "spark-x2.6-low" })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-spark")
  assert.equal(r.servedModel, "spark-x2.6-low")
  assert.equal(r.evidence.ledgerModelName, "spark-x2.6-low")
  assert.equal(fetchImpl.calls.chat.length, 1)
})

test("chat 实际 deepseek-v4-flash-1017 → clean / ledger-deepseek", async () => {
  const fetchImpl = upstream({ chatModel: "deepseek-v4-flash-1017" })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "clean")
  assert.equal(r.reason, "ledger-deepseek")
  assert.equal(r.servedModel, "deepseek-v4-flash-1017")
  assert.equal(fetchImpl.calls.chat.length, 1)
})

test("chat 被换到 GLM → routed / ledger-other-family", async () => {
  const fetchImpl = upstream({ chatModel: "GLM-5.3-Flash" })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-other-family")
  assert.equal(r.servedModel, "GLM-5.3-Flash")
})

test("chat 响应读不到 model → unknown / 不误判（chat 1）", async () => {
  const fetchImpl = upstream({ chatModel: null })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "unknown")
  assert.equal(r.reason, "no-ledger-records")
  assert.equal(r.servedModel, "")
  assert.equal(fetchImpl.calls.chat.length, 1)
})

test("chat 非 200 → unknown / 不误判（chat 1）", async () => {
  const fetchImpl = upstream({ chatStatus: 500 })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "unknown")
  assert.equal(fetchImpl.calls.chat.length, 1)
})

test("余额缺失 → 继续发 chat 判定", async () => {
  const fetchImpl = upstream({ pages: [envelope([], {})], chatModel: "spark-x2.6-low" })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-spark")
  assert.equal(fetchImpl.calls.chat.length, 1)
})

test("chat 请求：与真实调用同头同体，探针文案固定", async () => {
  const fetchImpl = upstream({ chatModel: "deepseek-v4-flash-1017" })
  await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  const call = fetchImpl.calls.chat[0]
  assert.equal(call.init.method, "POST")
  assert.match(String(call.url), /\/chat\/completions$/)
  const body = JSON.parse(call.init.body)
  assert.equal(body.model, DS41_MODEL_ID)
  assert.equal(body.stream, true)
  const last = body.messages[body.messages.length - 1]
  assert.equal(last.role, "user")
  assert.equal(last.content, PROBE_PROMPT)
  const h = new Headers(call.init.headers)
  assert.equal(h.get("Authorization"), "Bearer " + SESSION)
  assert.equal(h.get("token"), SESSION)
  assert.ok(h.get("traceparent"))
  assert.notEqual(h.get("loomy-version"), null)
  assert.ok(h.get("user-agent"))
})

// ── 组 3：只读账本分支（evaluateReadOnly 不传 probeChat，给 patrol）──────

test("只读分支：账本空 → keep / no-ledger-records（chat 0）", async () => {
  const fetchImpl = upstream({ pages: [envelope([], RICH)] })
  const r = await readOnly(fetchImpl)
  assert.equal(r.verdict, "unknown")
  assert.equal(r.reason, "no-ledger-records")
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("只读分支：账本 spark → routed / ledger-spark", async () => {
  const fetchImpl = upstream({ pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "spark-x2.6-low", ledgerId: "L-1" }], RICH)] })
  const r = await readOnly(fetchImpl)
  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-spark")
  assert.equal(r.servedModel, "spark-x2.6-low")
  assert.equal(r.ledgerId, "L-1")
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("只读分支：账本 deepseek → clean / ledger-deepseek", async () => {
  const fetchImpl = upstream({ pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "deepseek-v4-flash-1017", ledgerId: "L-2" }], RICH)] })
  const r = await readOnly(fetchImpl)
  assert.equal(r.verdict, "clean")
  assert.equal(r.reason, "ledger-deepseek")
})

test("只读分支：账本 GLM → routed / ledger-other-family", async () => {
  const fetchImpl = upstream({ pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "GLM-5.3-Flash", ledgerId: "L-3" }], RICH)] })
  const r = await readOnly(fetchImpl)
  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-other-family")
})

test("只读分支：余额 1 次 + 记录 3 次（预检 1 + 复查 2），账本走 token 头", async () => {
  const fetchImpl = upstream({ pages: [envelope([], RICH)] })
  await readOnly(fetchImpl)
  const recordReads = fetchImpl.calls.ledger.filter((c) => /pageSize=10$/.test(c.url))
  const balanceReads = fetchImpl.calls.ledger.filter((c) => /pageSize=1$/.test(c.url))
  assert.equal(recordReads.length, 3)
  assert.ok(balanceReads.length >= 1 && balanceReads.length <= 3)
  for (const call of fetchImpl.calls.ledger) {
    assert.equal(call.init.headers.get("token"), SESSION)
    assert.equal(call.init.headers.get("Authorization"), null)
  }
})

test("只读分支：复查之间用假 sleep（2 个间隔）", async () => {
  const waits = []
  const fetchImpl = upstream({ pages: [envelope([], RICH)] })
  await evaluateReadOnly({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: async (ms) => { waits.push(ms) } })
  assert.equal(waits.length, 2)
})

test("只读分支：三次读取取 createdAt 最大的那条", async () => {
  const fetchImpl = upstream({
    pages: [
      envelope([{ createdAt: 1_795_050_006, modelName: "deepseek-v4-flash-1017", ledgerId: "L-old" }], RICH),
      envelope([{ createdAt: 1_795_050_344, modelName: "spark-x2.6-low", ledgerId: "L-new" }], RICH),
      envelope([{ createdAt: 1_795_050_091, modelName: "deepseek-v4-flash-1017", ledgerId: "L-mid" }], RICH),
    ],
  })
  const r = await readOnly(fetchImpl)
  assert.equal(r.servedModel, "spark-x2.6-low")
  assert.equal(r.ledgerId, "L-new")
  assert.equal(r.verdict, "routed")
})

test("只读分支：目录 500 → 继续按账本判", async () => {
  const fetchImpl = upstream({ catalogStatus: 500, pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "spark-x2.6-low", ledgerId: "L-1" }], RICH)] })
  const r = await readOnly(fetchImpl)
  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-spark")
  assert.deepEqual(r.evidence.catalog, [])
})

test("目录解析：{models} 与 {data} 都认", async () => {
  const viaModels = upstream({ catalogShape: "models", catalog: ["spark-x2.6-low", DS41_MODEL_ID], chatModel: "deepseek-v4-flash-1017" })
  const r1 = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl: viaModels, sleep: fakeSleep })
  assert.equal(r1.verdict, "clean")
  const viaData = upstream({ catalogShape: "data", catalog: ["spark-x2.6-low"] })
  const r2 = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl: viaData, sleep: fakeSleep })
  assert.equal(r2.reason, "catalog-missing-ds41")
})

test("目录 id 大小写不敏感（deepseek-v4.1-flash 也算有）", async () => {
  const fetchImpl = upstream({ catalog: ["spark-x2.6-low", "deepseek-v4.1-flash"], chatModel: "deepseek-v4-flash-1017" })
  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
  assert.equal(r.verdict, "clean")
})

test("只读分支：ledgerAgeSec 早 120 秒约 120；未来时间戳归零", async () => {
  const nowSec = Math.floor(Date.now() / 1000)
  const past = upstream({ pages: [envelope([{ createdAt: nowSec - 120, modelName: "spark-x2.6-low", ledgerId: "L-p" }], RICH)] })
  const r1 = await readOnly(past)
  assert.ok(r1.ledgerAgeSec >= 118 && r1.ledgerAgeSec <= 125, "实际 " + r1.ledgerAgeSec)
  const future = upstream({ pages: [envelope([{ createdAt: nowSec + 600, modelName: "spark-x2.6-low", ledgerId: "L-f" }], RICH)] })
  const r2 = await readOnly(future)
  assert.equal(r2.ledgerAgeSec, 0)
})
