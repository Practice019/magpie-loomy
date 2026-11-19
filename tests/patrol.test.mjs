import { test } from "node:test"
import assert from "node:assert/strict"

import { DS41_MODEL_ID } from "../src/route.mjs"
import { patrolAccount, patrolMany } from "../src/patrol.mjs"

const BASE = "https://loomyad.xunfei.cn/api/v1"
const SESSION = "s".repeat(32)
const NOW = 1_700_000_000_000
const AT = NOW - 60_000

function envelope(list) {
  return { code: "000000", desc: "success", data: { list } }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * 免费巡检用的假上游：只该被请求 /models 与 /points/records。
 *
 * chat 端点故意也接住并计数 —— 测试用它钉死「巡检绝不发 chat」。
 */
function upstream({
  catalog = [DS41_MODEL_ID],
  catalogStatus = 200,
  catalogBody = null,
  ledgerPages = [[]],
  ledgerStatus = 200,
  balance = {},
  balanceBody = null,
} = {}) {
  /** @type {{catalog: any[], ledger: any[], chat: any[]}} */
  const calls = { catalog: [], ledger: [], chat: [] }
  let recordReads = 0

  const fetchImpl = async (url, init) => {
    const href = String(url)
    if (href.endsWith("/models")) {
      calls.catalog.push({ url: href, init })
      if (catalogBody !== null) return jsonResponse(catalogBody, catalogStatus)
      if (catalogStatus !== 200) return jsonResponse({ code: "FAIL" }, catalogStatus)
      return jsonResponse({ data: catalog })
    }
    if (href.includes("/points/records")) {
      calls.ledger.push({ url: href, init })
      // pageSize=1 读的是余额；pageSize=10 读的是记录。两者是同一份账本数据。
      if (/pageSize=1$/.test(href)) {
        if (balanceBody !== null) return jsonResponse(balanceBody, ledgerStatus)
        return jsonResponse(envelope([], balance), ledgerStatus)
      }
      const page = ledgerPages[Math.min(recordReads, ledgerPages.length - 1)] ?? []
      recordReads += 1
      return jsonResponse(envelope(page), ledgerStatus)
    }
    if (href.endsWith("/chat/completions")) {
      calls.chat.push({ url: href, init })
      return jsonResponse({ created: 1, model: DS41_MODEL_ID, choices: [{ message: { content: "" } }] })
    }
    throw new Error(`unexpected request: ${href}`)
  }

  fetchImpl.calls = calls
  return fetchImpl
}

const trafficFor = (model) => [{ model, at: AT }]

test("目录 401 → expired，0 次账本、0 次 chat", async () => {
  const fetchImpl = upstream({ catalogStatus: 401 })

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: trafficFor(DS41_MODEL_ID),
  })

  assert.equal(r.verdict, "expired")
  assert.equal(r.reason, "session-expired")
  assert.equal(r.servedModel, "（登录已失效）")
  assert.equal(fetchImpl.calls.ledger.length, 0)
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("目录只有 spark → routed / catalog-missing-ds41，0 次 chat", async () => {
  const fetchImpl = upstream({ catalog: ["spark-x2.6-low", "spark-x2.6-4b"] })

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: trafficFor(DS41_MODEL_ID),
  })

  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "catalog-missing-ds41")
  assert.match(r.servedModel, /spark-x2\.6-low/)
  assert.equal(fetchImpl.calls.ledger.length, 0)
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("账本最新记 spark-x2.6-low → routed / ledger-spark（即使 traffic 为空，硬证据优先）", async () => {
  const fetchImpl = upstream({
    ledgerPages: [[{ createdAt: Math.floor(AT / 1000), modelName: "spark-x2.6-low", ledgerId: "L-1" }]],
  })

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: [],
  })

  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-spark")
  assert.equal(r.servedModel, "spark-x2.6-low")
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("账本最新记 deepseek-v4-flash-1017 → clean / ledger-deepseek", async () => {
  const fetchImpl = upstream({
    ledgerPages: [[{ createdAt: Math.floor(AT / 1000), modelName: "deepseek-v4-flash-1017", ledgerId: "L-2" }]],
  })

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: trafficFor(DS41_MODEL_ID),
  })

  assert.equal(r.verdict, "clean")
  assert.equal(r.reason, "ledger-deepseek")
  assert.equal(r.servedModel, "deepseek-v4-flash-1017")
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("账本最新记 GLM-5.3-Flash → routed / ledger-other-family", async () => {
  const fetchImpl = upstream({
    ledgerPages: [[{ createdAt: Math.floor(AT / 1000), modelName: "GLM-5.3-Flash", ledgerId: "L-3" }]],
  })

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: [],
  })

  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-other-family")
  assert.equal(r.servedModel, "GLM-5.3-Flash")
})

test("真实流量请求 DS4.1，账本记 spark-x2.6-low → 由账本硬证据判 routed / ledger-spark", async () => {
  const fetchImpl = upstream({
    ledgerPages: [[{ createdAt: Math.floor(AT / 1000), modelName: "spark-x2.6-low", ledgerId: "L-1" }]],
  })

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: trafficFor(DS41_MODEL_ID),
  })

  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-spark", "账本记录优先于 traffic 窗口对账")
  assert.equal(r.servedModel, "spark-x2.6-low")
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("账本空 + traffic 请求 DS4.1 + 账本仍无对应记录 → keep（不清白也不定罪）", async () => {
  const fetchImpl = upstream({ ledgerPages: [[]] })

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: trafficFor(DS41_MODEL_ID),
  })

  assert.equal(r.keep, true)
  assert.equal("verdict" in r, false)
})

test("账本空 + 没有 traffic → keep，不改 verdict", async () => {
  const fetchImpl = upstream()

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: [],
  })

  assert.deepEqual(r, { keep: true, catalogOkAt: NOW, trafficChecked: 0 })
  assert.equal("verdict" in r, false)
  // 余额 1 次 + 账本记录 1 次（硬证据那步），没有为 traffic 再读。
  assert.equal(fetchImpl.calls.ledger.length, 2)
})

test("账本读记录 429 → keep，不判死", async () => {
  const fetchImpl = async (url, init) => {
    const href = String(url)
    if (href.endsWith("/models")) return jsonResponse({ data: [{ id: DS41_MODEL_ID }] })
    if (/pageSize=1$/.test(href)) return jsonResponse(envelope([], { availableBalance: 34900 }))
    if (href.includes("/points/records")) return jsonResponse({ code: "FAIL" }, 429)
    throw new Error(`unexpected request: ${href}`)
  }

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: trafficFor(DS41_MODEL_ID),
  })

  assert.equal(r.keep, true)
  assert.equal(r.rateLimited, true)
  assert.equal("verdict" in r, false)
})

test("目录 500 → keep，不判", async () => {
  const fetchImpl = upstream({ catalogStatus: 500 })

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: trafficFor(DS41_MODEL_ID),
  })

  assert.deepEqual(r, { keep: true, catalogOkAt: 0 })
  assert.equal("verdict" in r, false)
  assert.equal(fetchImpl.calls.ledger.length, 0)
})

test("traffic 3 条但账本都找不到对应记录 → keep", async () => {
  const fetchImpl = upstream({ ledgerPages: [[]] })

  const r = await patrolAccount({
    baseUrl: BASE,
    session: SESSION,
    uid: "u1",
    configDir: "",
    fetchImpl,
    now: NOW,
    traffic: [
      { model: DS41_MODEL_ID, at: AT },
      { model: DS41_MODEL_ID, at: AT - 10_000 },
      { model: "GLM-5.3-Flash", at: AT - 20_000 },
    ],
  })

  assert.equal(r.keep, true)
  assert.equal("verdict" in r, false)
  assert.equal(fetchImpl.calls.ledger.length, 5, "余额 1 + 硬证据 1 + 每条流量各 1 次")
})

test("全流程 0 次 chat/completions", async () => {
  const scenarios = [
    upstream({ catalogStatus: 401 }),
    upstream({ catalog: ["spark-x2.6-low"] }),
    upstream({ ledgerPages: [[{ createdAt: Math.floor(AT / 1000), modelName: "spark-x2.6-low" }]] }),
    upstream({ ledgerPages: [[{ createdAt: Math.floor(AT / 1000), modelName: "deepseek-v4-flash-1017" }]] }),
    upstream({ catalogStatus: 500 }),
  ]

  for (const fetchImpl of scenarios) {
    await patrolAccount({
      baseUrl: BASE,
      session: SESSION,
      uid: "u1",
      configDir: "",
      fetchImpl,
      now: NOW,
      traffic: trafficFor(DS41_MODEL_ID),
    })
    assert.equal(fetchImpl.calls.chat.length, 0, "巡检绝不能发 chat")
  }
})

test("patrolMany：单账号失败不影响其它，返回 checked/kept/failed 计数", async () => {
  const fetchImpl = async (url, init) => {
    const href = String(url)
    if (href.endsWith("/models")) {
      const token = init.headers.get("token")
      if (token === "expired-session") return jsonResponse({ code: "FAIL" }, 401)
      return jsonResponse({ data: [{ id: DS41_MODEL_ID }] })
    }
    if (href.includes("/points/records")) return jsonResponse(envelope([]))
    throw new Error(`unexpected request: ${href}`)
  }

  const out = await patrolMany({
    accounts: [
      { uid: "u-expired", session: "expired-session" },
      { uid: "u-keep", session: SESSION },
    ],
    concurrency: 2,
    gapMs: 0,
    baseUrl: BASE,
    fetchImpl,
    now: NOW,
    sleep: async () => {},
  })

  assert.equal(out.checked, 1, "expired 算一次有结论的检测")
  assert.equal(out.kept, 1, "目录完好但没有流量 → keep")
  assert.equal(out.failed, 0)
  assert.equal(out.results["u-expired"].verdict, "expired")
  assert.equal(out.results["u-keep"].keep, true)
})
