// route.test.mjs 单账号只读判定（0 积分）。
//
// # 为什么这些用例都盯着 chat 计数
//
// 产品结论：**检测不发任何对话请求**，全部靠免费读取（目录 + 余额 + 账本）。
// 所以每个场景都顺手断言 `POST /chat/completions` 次数，末尾还有一条总断言：
// 任何一条判定链都不许重新引入 chat。真出现一次，不只多花 1 积分，还会
// 在账本里制造一条只属于探测自己的噪音记录。

import { test } from "node:test"
import assert from "node:assert/strict"

import { DS41_MODEL_ID, probeRoute } from "../src/route.mjs"

const BASE = "https://loomyad.xunfei.cn/api/v1"
const SESSION = "s".repeat(32)
const CHAT_CREATED = 1_700_000_200

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * 账本回执：既能带余额（顶部字段），也能带记录列表。
 *
 * `pageSize=1` 那次读的是余额，`pageSize=10` 那次读的是记录 —— 同一份数据，
 * 所以这里把两者合在一个 envelope 里。
 */
function envelope(list, balance = {}) {
  return { code: "000000", desc: "success", data: { list, ...balance } }
}

/**
 * 假上游：目录 + 账本，外加一个**只用来计数**的 chat 端点（正常流程永远不该被调到）。
 */
function upstream({
  catalog = [DS41_MODEL_ID],
  catalogShape = "data",
  catalogStatus = 200,
  catalogBody = null,
  pages = [envelope([], { availableBalance: 34900 })],
  ledgerStatus = 200,
} = {}) {
  /** @type {{catalog: any[], ledger: any[], chat: any[]}} */
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
      return jsonResponse({
        created: CHAT_CREATED,
        model: DS41_MODEL_ID,
        choices: [{ message: { content: "" } }],
      })
    }
    throw new Error(`unexpected request: ${href}`)
  }

  fetchImpl.calls = calls
  return fetchImpl
}

const fakeSleep = async () => {}

/** 给足余额，避免每个用例都要显式写一遍。 */
const RICH = { availableBalance: 34900 }

test("目录 401 → expired，chat 0 次", async () => {
  const fetchImpl = upstream({ catalogStatus: 401 })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "expired")
  assert.equal(r.reason, "session-expired")
  assert.equal(r.servedModel, "（登录已失效）")
  assert.equal(r.requested, DS41_MODEL_ID)
  assert.equal(fetchImpl.calls.chat.length, 0)
  assert.equal(fetchImpl.calls.ledger.length, 0, "登录已失效就不必再读账本")
})

test("目录 100003 + desc「账号已被停用」→ expired / account-disabled", async () => {
  const fetchImpl = upstream({ catalogBody: { code: "100003", desc: "账号已被停用" } })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "expired")
  assert.equal(r.reason, "account-disabled")
  assert.equal(r.servedModel, "（账号已停用）")
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("目录里没有 DS4.1 → routed / catalog-missing-ds41，chat 0、账本 0", async () => {
  const fetchImpl = upstream({ catalog: ["spark-x2.6-low", "spark-x2.6-4b"] })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "catalog-missing-ds41")
  assert.equal(r.servedModel, "spark-x2.6-low, spark-x2.6-4b")
  assert.deepEqual(r.evidence.catalog, ["spark-x2.6-low", "spark-x2.6-4b"])
  assert.equal(fetchImpl.calls.chat.length, 0)
  assert.equal(fetchImpl.calls.ledger.length, 0, "目录否证就够，不必读账本")
})

test("目录完好 + 账本 spark-x2.6-low → routed / ledger-spark", async () => {
  const fetchImpl = upstream({
    pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "spark-x2.6-low", ledgerId: "L-1" }], RICH)],
  })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-spark")
  assert.equal(r.servedModel, "spark-x2.6-low")
  assert.equal(r.ledgerId, "L-1")
  assert.equal(r.createdAt, CHAT_CREATED)
  assert.equal(r.evidence.ledgerModelName, "spark-x2.6-low")
  assert.equal(r.evidence.chatError, "", "chatError 恒为空（已不发 chat）")
  assert.equal("answer" in r.evidence, false, "自述链路已删除")
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("目录完好 + 账本 deepseek-v4-flash-1017 → clean / ledger-deepseek", async () => {
  const fetchImpl = upstream({
    pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "deepseek-v4-flash-1017", ledgerId: "L-2" }], RICH)],
  })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "clean")
  assert.equal(r.reason, "ledger-deepseek")
  assert.equal(r.servedModel, "deepseek-v4-flash-1017")
  assert.equal(fetchImpl.calls.chat.length, 0)
})

test("目录完好 + 账本 GLM-5.3-Flash → routed / ledger-other-family", async () => {
  const fetchImpl = upstream({
    pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "GLM-5.3-Flash", ledgerId: "L-3" }], RICH)],
  })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-other-family")
  assert.equal(r.servedModel, "GLM-5.3-Flash")
})

test("目录完好 + 账本空（3 次读都空）→ unknown / no-ledger-records，不猜", async () => {
  const fetchImpl = upstream({ pages: [envelope([], RICH)] })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "unknown")
  assert.equal(r.reason, "no-ledger-records")
  assert.equal(r.servedModel, "")
  assert.equal(fetchImpl.calls.chat.length, 0, "新号不能用 chat 换记录")
})

test("余额 0 → exhausted / no-quota，优先于账本 modelName 判定", async () => {
  const fetchImpl = upstream({
    pages: [
      envelope([{ createdAt: CHAT_CREATED, modelName: "deepseek-v4-flash-1017", ledgerId: "L-9" }], {
        availableBalance: 0,
      }),
    ],
  })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "exhausted")
  assert.equal(r.reason, "no-quota")
  assert.equal(r.servedModel, "（积分不足）")
  assert.equal(fetchImpl.calls.chat.length, 0)
  assert.equal(
    fetchImpl.calls.ledger.filter((c) => c.url.includes("pageSize=10")).length,
    0,
    "余额判死就该立刻停手，不再读记录",
  )
})

test("余额缺失 → 跳过余额判定，继续按账本记录判", async () => {
  const fetchImpl = upstream({
    pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "spark-x2.6-low", ledgerId: "L-4" }])],
  })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-spark")
})

test("balance + dailyBalance 也认（availableBalance 缺失时相加）", async () => {
  const fetchImpl = upstream({
    pages: [envelope([], { balance: 0, dailyBalance: 0 })],
  })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "exhausted")
  assert.equal(r.reason, "no-quota")
})

test("账本业务码 100003 → expired（余额步骤也要识别登录失效）", async () => {
  /** @type {any[]} */
  const ledgerCalls = []
  const businessFail = async (url, init) => {
    const href = String(url)
    if (href.endsWith("/models")) return jsonResponse({ data: [{ id: DS41_MODEL_ID }] })
    if (href.includes("/points/records")) {
      ledgerCalls.push({ url: href, init })
      return jsonResponse({ code: "100003", desc: "登录已失效" })
    }
    throw new Error(`unexpected request: ${href}`)
  }

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl: businessFail, sleep: fakeSleep })

  assert.equal(r.verdict, "expired")
  assert.equal(r.reason, "session-expired")
  assert.equal(ledgerCalls.length >= 1, true, "余额那一次读到了 100003")
})

test("账本读取次数：余额 1 次 + 记录 3 次（预检 1 + 复查 2）", async () => {
  const fetchImpl = upstream({ pages: [envelope([], RICH)] })

  await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  const recordReads = fetchImpl.calls.ledger.filter((c) => /pageSize=10$/.test(c.url))
  const balanceReads = fetchImpl.calls.ledger.filter((c) => /pageSize=1$/.test(c.url))
  assert.equal(recordReads.length, 3)
  // 余额那次可能是「数据里的余额」也可能是「多读一次确认」，实现是否复用同一页
  // 不影响判定，所以只要求至少 1 次、且不超过记录读取次数。
  assert.ok(balanceReads.length >= 1 && balanceReads.length <= 3, `余额读取 ${balanceReads.length} 次`)
  for (const call of fetchImpl.calls.ledger) {
    assert.equal(call.init.headers.get("token"), SESSION)
    assert.equal(call.init.headers.get("Authorization"), null)
  }
})

test("复查之间用假 sleep（2 个间隔），不真的等", async () => {
  const waits = []
  const fetchImpl = upstream({ pages: [envelope([], RICH)] })

  await probeRoute({
    baseUrl: BASE,
    session: SESSION,
    fetchImpl,
    sleep: async (ms) => {
      waits.push(ms)
    },
  })

  assert.equal(waits.length, 2, "3 次读取之间 2 个间隔")
  assert.ok(waits.every((ms) => ms > 0))
})

test("三次读取取 createdAt 最大的那条（副本漂移）", async () => {
  const fetchImpl = upstream({
    pages: [
      envelope([{ createdAt: 1_795_050_006, modelName: "deepseek-v4-flash-1017", ledgerId: "L-old" }], RICH),
      envelope([{ createdAt: 1_795_050_344, modelName: "spark-x2.6-low", ledgerId: "L-new" }], RICH),
      envelope([{ createdAt: 1_795_050_091, modelName: "deepseek-v4-flash-1017", ledgerId: "L-mid" }], RICH),
    ],
  })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.servedModel, "spark-x2.6-low")
  assert.equal(r.ledgerId, "L-new")
  assert.equal(r.verdict, "routed")
})

test("ledgerAgeSec：记录早 120 秒约等于 120；未来时间戳归零", async () => {
  const nowSec = Math.floor(Date.now() / 1000)

  const past = upstream({
    pages: [envelope([{ createdAt: nowSec - 120, modelName: "spark-x2.6-low", ledgerId: "L-p" }], RICH)],
  })
  const r1 = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl: past, sleep: fakeSleep })
  assert.ok(r1.ledgerAgeSec >= 118 && r1.ledgerAgeSec <= 125, `实际 ${r1.ledgerAgeSec}`)

  const future = upstream({
    pages: [envelope([{ createdAt: nowSec + 600, modelName: "spark-x2.6-low", ledgerId: "L-f" }], RICH)],
  })
  const r2 = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl: future, sleep: fakeSleep })
  assert.equal(r2.ledgerAgeSec, 0, "负年龄归零")
})

test("目录 500 不是过期 → 继续按账本判（不判 expired）", async () => {
  const fetchImpl = upstream({
    catalogStatus: 500,
    pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "spark-x2.6-low", ledgerId: "L-1" }], RICH)],
  })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "routed")
  assert.equal(r.reason, "ledger-spark")
  assert.deepEqual(r.evidence.catalog, [], "目录没读到就没有 catalog 证据")
})

test("目录解析：{models:[…]} 与 {data:[…]} 都认", async () => {
  const viaModels = upstream({
    catalogShape: "models",
    catalog: ["spark-x2.6-low", DS41_MODEL_ID],
    pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "deepseek-v4-flash-1017", ledgerId: "L-2" }], RICH)],
  })
  const r1 = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl: viaModels, sleep: fakeSleep })
  assert.equal(r1.verdict, "clean")

  const viaData = upstream({ catalogShape: "data", catalog: ["spark-x2.6-low"] })
  const r2 = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl: viaData, sleep: fakeSleep })
  assert.equal(r2.reason, "catalog-missing-ds41")
})

test("目录 id 大小写不敏感（deepseek-v4.1-flash 也算「有」）", async () => {
  const fetchImpl = upstream({
    catalog: ["spark-x2.6-low", "deepseek-v4.1-flash"],
    pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "deepseek-v4-flash-1017", ledgerId: "L-2" }], RICH)],
  })

  const r = await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })

  assert.equal(r.verdict, "clean")
})

test("总断言：所有场景的 chat/completions 调用数都为 0", async () => {
  const scenarios = [
    upstream({ catalogStatus: 401 }),
    upstream({ catalog: ["spark-x2.6-low"] }),
    upstream({ pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "spark-x2.6-low" }], RICH)] }),
    upstream({ pages: [envelope([{ createdAt: CHAT_CREATED, modelName: "deepseek-v4-flash-1017" }], RICH)] }),
    upstream({ pages: [envelope([], RICH)] }),
    upstream({ pages: [envelope([], { availableBalance: 0 })] }),
    upstream({ catalogStatus: 500 }),
  ]

  for (const fetchImpl of scenarios) {
    await probeRoute({ baseUrl: BASE, session: SESSION, fetchImpl, sleep: fakeSleep })
    assert.equal(fetchImpl.calls.chat.length, 0, "检测必须是 0 积分")
  }
})