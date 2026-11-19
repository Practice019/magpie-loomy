// patrol.mjs 免费巡检 —— 只读目录与账本，**绝不发 chat、绝不扣积分**。
//
// # 为什么需要一条「免费」的巡检
//
// `probeRoute` 的每次判定都要发一次 chat（扣 1 积分），所以只能按需跑
// （登录后一次、用户手动点一次）。但「健康 → 被上游改路由」是随时可能发生的，
// 靠手动检测会漏。
//
// 两个免费信号足够抓出这种转变：
//
//	① GET /models           目录里 DS4.1 消失 / session 失效 / 账号停用
//	② GET /points/records   账本 modelName 与最近的**真实请求**不同族
//
// 第二条用「真实流量」而不是「探测请求」：不花积分，而且流量本身就是账号
// 正在被使用的证据。traffic 由 `src/traffic.mjs`（另一条任务线）记录，
// 本文件通过动态 import 取；模块还没落地时降级为「没有流量 → keep」。
//
// # keep 是什么
//
// 巡检的默认动作是**不动**：读不到目录、没有流量、流量都对不上账本，都不该
// 改判定。只有拿到确定证据（expired / 目录缺 DS4.1 / traffic-mismatch /
// traffic-match）才返回 verdict。`{keep:true}` 表示「这次没结论，保留原状态」。
//
// # 账本读取并发
//
// 复用 `route.mjs` 导出的 `readLedgerRecords` —— 它内部走同一个
// `MAX_LEDGER_CONCURRENCY = 2` 信号量。批量巡检因此不会把多副本账本打得更旧。

import {
  DS41_MODEL_ID,
  classifyLedgerModel,
  inspectBalance,
  inspectCatalog,
  readLatestLedgerRecord,
  readLedgerRecords,
} from "./route.mjs"

/** 流量回溯窗口：只看最近 7 天的真实请求。 */
const TRAFFIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** 一次巡检最多核对几条流量（每条一次账本读，再多只是白花时间）。 */
const MAX_TRAFFIC_SAMPLES = 5

/** 账本记录与流量时间的允许区间（秒）：前 5s / 后 300s。 */
const LEDGER_MATCH_BEFORE_SEC = 5
const LEDGER_MATCH_AFTER_SEC = 300

/** 认得出的模型族。用来判断「请求的模型」与「账本实际模型」是否同族。 */
const MODEL_FAMILIES = Object.freeze(["deepseek", "glm", "qwen", "spark"])

/** `src/traffic.mjs` 的加载结果（成功才缓存；T-02 落盘后无需重启进程）。 */
let trafficModule

/**
 * 对一个账号做免费巡检。**绝不发 chat、绝不扣积分。**
 *
 * @param {object} opts
 * @param {string} opts.baseUrl 模型代理基址（含 `/api/v1`）
 * @param {string} opts.session 登录 session
 * @param {string|number} opts.uid 账号键（traffic 用它索引）
 * @param {string} [opts.configDir] traffic 状态目录
 * @param {typeof fetch} [opts.fetchImpl] 注入的 fetch（测试用）
 * @param {number} [opts.now] 当前时间（毫秒；测试注入固定时钟）
 * @param {Array<{model: string, at: number}>} [opts.traffic] 注入流量（测试用；省略则读 traffic.mjs）
 * @returns {Promise<{verdict?: "routed"|"clean"|"expired"|"exhausted"|"unknown", reason?: string,
 *   servedModel?: string, checkedAt?: number, catalogOkAt?: number,
 *   trafficChecked?: number, keep?: true, rateLimited?: true, error?: string}>}
 */
export async function patrolAccount({
  baseUrl,
  session,
  uid,
  configDir,
  fetchImpl,
  now = Date.now(),
  traffic,
} = {}) {
  if (!session) return { error: "缺少 session" }

  // ── ① 目录：免费且能判死 ------------------------------------------------
  const catalog = await inspectCatalog({ baseUrl, session, fetchImpl })

  if (catalog.status === "expired") {
    return {
      verdict: "expired",
      reason: catalog.reason,
      servedModel: catalog.reason === "account-disabled" ? "（账号已停用）" : "（登录已失效）",
      checkedAt: now,
      catalogOkAt: now,
    }
  }

  if (catalog.status === "unavailable") {
    // 读不到目录 ≠ 账号有问题：keep，并记 catalogOkAt=0 让上层知道这次没读到。
    // ⚠ 429 单独标出来：面板要能说「检测被限流，稍后重试」，而不是
    //   「这个号有问题」。已判定的结论照旧保留（keep 语义本身就是「不覆盖」）。
    // 只在真是 429 时才带该字段 —— 多一个 `rateLimited: false` 会让下游
    // 误以为「这次查过、结论是不限流」。
    if (catalog.rateLimited === true) return { keep: true, catalogOkAt: 0, rateLimited: true }
    return { keep: true, catalogOkAt: 0 }
  }

  if (!catalog.ids.some((id) => String(id).trim().toLowerCase() === DS41_MODEL_ID.toLowerCase())) {
    return {
      verdict: "routed",
      reason: "catalog-missing-ds41",
      servedModel: catalog.ids.join(", ") || "（目录里没有对话模型）",
      checkedAt: now,
      catalogOkAt: now,
    }
  }

  // ── ② 余额（免费）：先于流量对账 ---------------------------
  //
  // 0 余额的号即使目录完好、账本记录正常也不该派活：它会让 magpie 选中 →
  // 402 `insufficient_quota` → 换号，用户体感是「慢」。余额是免费字段，
  // 放在流量对账之前，省掉后面的账本读。
  //
  // 判定规则与 `probeRoute` 完全同源（都走 `inspectBalance`）。
  const balance = await inspectBalance({ baseUrl, session, fetchImpl })
  if (balance.expired) {
    return {
      verdict: "expired",
      reason: balance.expired,
      servedModel: balance.expired === "account-disabled" ? "（账号已停用）" : "（登录已失效）",
      checkedAt: now,
      catalogOkAt: now,
    }
  }
  if (balance.known && balance.available <= 0) {
    return {
      verdict: "exhausted",
      reason: "no-quota",
      servedModel: "（积分不足）",
      checkedAt: now,
      catalogOkAt: now,
    }
  }

  // ── ③ 账本硬证据：最新一条 modelName（优先于流量比对） ─────────────────
  //
  // 账本本身就是直接答案：该号最近一次真实调用的 `modelName` 是什么。
  // 这比「traffic 时间戳 ↔ 账本时间戳」对账硬得多 —— 用户直接用客户端
  // 测试时不会产生 traffic，但对账本照样有记录。实测号 16532460196：
  // 15 次直测全部记成 spark-x2.6-low，旧实现却因为没有 traffic 命中判 clean。
  //
  // 只有「账本一条记录都没有」时才继续走 traffic 窗口比对，不要跳过它。
  let latest
  try {
    latest = await readLatestLedgerRecord({ baseUrl, session, fetchImpl, reads: 1 })
  } catch (e) {
    // 限流（429）：这条链路的证据不完整 → keep，别把限流判成账号问题。
    if (e?.rateLimited) return { keep: true, catalogOkAt: now, rateLimited: true }
    const why = errorText(e)
    const disabled =
      /100003/.test(why) &&
      ["停用", "禁用", "封禁", "已关闭"].some((marker) => why.includes(marker))
    if (disabled) {
      return {
        verdict: "expired",
        reason: "account-disabled",
        servedModel: "（账号已停用）",
        checkedAt: now,
        catalogOkAt: now,
      }
    }
    if (/100003/.test(why) || /100002/.test(why) || /登录已失效/.test(why)) {
      return {
        verdict: "expired",
        reason: "session-expired",
        servedModel: "（登录已失效）",
        checkedAt: now,
        catalogOkAt: now,
      }
    }
    // 其它失败（含 5xx / 网络）：读不到 ≠ 没有记录，保留原结论。
    return { keep: true, catalogOkAt: now }
  }

  if (latest.record) {
    const decision = classifyLedgerModel(latest.record.modelName)
    if (decision) {
      const createdAt = Number(latest.record.createdAt)
      return {
        verdict: decision.verdict,
        reason: decision.reason,
        servedModel: decision.servedModel,
        checkedAt: now,
        catalogOkAt: now,
        ledgerId: String(latest.record.ledgerId ?? ""),
        ledgerAgeSec: Number.isFinite(createdAt) ? Math.max(0, now / 1000 - createdAt) : 0,
      }
    }
  }

  // ── ④ 真实流量：账本没有记录时，用 traffic 窗口对账 -------------------
  const samples = await loadTrafficSamples({ configDir, uid, now, traffic })
  if (samples.length === 0) {
    return { keep: true, catalogOkAt: now, trafficChecked: 0 }
  }

  /** @type {any|null} */
  let mismatch = null
  /** @type {any|null} */
  let match = null
  let checked = 0
  // 账本读取被限流（429）：这条链路的证据就不完整，上层应当 keep
  let rateLimited = false

  for (const sample of samples) {
    if (!sample || !sample.model) continue
    const atMs = toMillis(sample.at)
    if (!Number.isFinite(atMs)) continue

    checked += 1
    const atSec = atMs / 1000

    /** @type {any[]} */
    let records
    try {
      records = await readLedgerRecords({ baseUrl, session, fetchImpl })
    } catch (e) {
      // 账本偶发失败 / 限流（429）：这条跳过，不当成「对不上」。
      // 限流时上层也应当 keep —— 记下来，别让一次限流把 clean 判成别的东西。
      if (e?.rateLimited) rateLimited = true
      continue
    }

    const candidates = records
      .filter((r) => {
        const createdAt = Number(r?.createdAt)
        return (
          Number.isFinite(createdAt) &&
          createdAt >= atSec - LEDGER_MATCH_BEFORE_SEC &&
          createdAt <= atSec + LEDGER_MATCH_AFTER_SEC
        )
      })
      .sort(
        (a, b) =>
          Math.abs(Number(a.createdAt) - atSec) - Math.abs(Number(b.createdAt) - atSec),
      )
    if (candidates.length === 0) continue

    const record = candidates[0]
    const relation = sameFamily(sample.model, record?.modelName)
    if (relation === false) {
      mismatch = record
      break // 已经拿到「被换模型」的硬证据，不用再看更早的流量
    }
    if (relation === true && !match) match = record
  }

  if (mismatch) {
    return {
      verdict: "routed",
      reason: "traffic-mismatch",
      servedModel: String(mismatch.modelName ?? "").trim(),
      checkedAt: now,
      catalogOkAt: now,
      trafficChecked: checked,
    }
  }
  if (match) {
    return {
      verdict: "clean",
      reason: "traffic-match",
      servedModel: String(match.modelName ?? "").trim(),
      checkedAt: now,
      catalogOkAt: now,
      trafficChecked: checked,
    }
  }
  // 全部对不上：不降级、不升级，只保留「目录这次是好的」。
  // ⚠ 但若中途吃过 429，这次的「没对上」很可能只是限流导致的抽样缺失，
  //   必须如实带上 rateLimited，让面板说「稍后重试」而不是「换个号吧」。
  if (rateLimited) return { keep: true, catalogOkAt: now, trafficChecked: checked, rateLimited: true }
  return { keep: true, catalogOkAt: now, trafficChecked: checked }
}

/**
 * 批量巡检入口。
 *
 * 并发与节流由调用方决定：`concurrency` 是同时跑几个账号，`gapMs` 是相邻两次
 * 启动的最小间隔（账本接口很娇气，别一口气全打过去）。
 *
 * @param {object} opts
 * @param {Array<{uid: string|number, session: string}>} opts.accounts
 * @param {number} [opts.concurrency] 默认 2
 * @param {number} [opts.gapMs] 相邻启动间隔，默认 300ms
 * @param {string} opts.baseUrl
 * @param {string} [opts.configDir]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.now]
 * @param {Record<string, Array<{model: string, at: number}>>} [opts.trafficByUid] 测试/嵌入用
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{results: Record<string, any>, checked: number, kept: number,
 *   failed: number}>}
 */
export async function patrolMany({
  accounts = [],
  concurrency = 2,
  gapMs = 300,
  baseUrl,
  configDir,
  fetchImpl,
  now = Date.now(),
  trafficByUid,
  sleep = defaultSleep,
} = {}) {
  /** @type {Record<string, any>} */
  const results = {}
  const workers = Math.max(1, Math.min(Math.floor(Number(concurrency) || 2), Math.max(1, accounts.length)))
  const gap = Math.max(0, Number(gapMs) || 0)

  let cursor = 0
  let lastStart = 0

  async function worker() {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= accounts.length) return
      const account = accounts[index]

      // 相邻启动之间保持 gapMs：账本读取再多并发也只会读到更旧的副本。
      const waitMs = gap - (Date.now() - lastStart)
      if (waitMs > 0) await sleep(waitMs)
      lastStart = Date.now()

      try {
        results[String(account.uid)] = await patrolAccount({
          baseUrl,
          session: account.session,
          uid: account.uid,
          configDir,
          fetchImpl,
          now,
          traffic: trafficByUid?.[String(account.uid)],
        })
      } catch (e) {
        // 单账号失败不影响其它账号。
        results[String(account.uid)] = { error: errorText(e) }
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()))

  let checked = 0
  let kept = 0
  let failed = 0
  for (const entry of Object.values(results)) {
    if (entry?.error) failed += 1
    else if (entry?.keep) kept += 1
    else if (entry?.verdict) checked += 1
  }
  return { results, checked, kept, failed }
}

// ── 内部 ────────────────────────────────────────────────────────────────

/**
 * 取该账号最近的流量样本（最多 5 条、7 天内）。
 *
 * `traffic` 显式传入时直接用（测试/嵌入）；否则动态 import `src/traffic.mjs`。
 * 模块缺失 / 读取失败都当「没有流量」——keep，不猜。
 *
 * @param {{configDir?: string, uid?: string|number, now: number,
 *   traffic?: Array<{model: string, at: number}>}} opts
 * @returns {Promise<Array<{model: string, at: number}>>}
 */
async function loadTrafficSamples({ configDir, uid, now, traffic }) {
  /** @type {any[]} */
  let rows = []
  if (Array.isArray(traffic)) {
    rows = traffic
  } else {
    const mod = await loadTrafficModule()
    if (!mod || typeof mod.readTraffic !== "function") return []
    try {
      rows = mod.readTraffic(configDir, uid)
    } catch {
      return []
    }
  }
  if (!Array.isArray(rows)) return []

  const minAt = now - TRAFFIC_WINDOW_MS
  return rows
    .map((row) => ({ model: String(row?.model ?? ""), at: toMillis(row?.at) }))
    .filter((row) => row.model && Number.isFinite(row.at) && row.at >= minAt && row.at <= now + 5 * 60 * 1000)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_TRAFFIC_SAMPLES)
}

/** 取 `src/traffic.mjs`（成功才缓存；缺失时每次重试，T-02 落盘后自动生效）。 */
async function loadTrafficModule() {
  if (trafficModule !== undefined) return trafficModule
  try {
    trafficModule = await import("./traffic.mjs")
  } catch {
    return null
  }
  return trafficModule
}

/**
 * 时间戳归一化：traffic 约定是毫秒，但早期实现可能写秒（< 1e12）。
 *
 * @param {unknown} value
 * @returns {number}
 */
function toMillis(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return NaN
  return n < 1e12 ? n * 1000 : n
}

/** 模型名 → 族（前缀）。认不出返回空串。 */
function familyOf(model) {
  const low = String(model ?? "").trim().toLowerCase()
  if (!low) return ""
  return MODEL_FAMILIES.find((family) => low.startsWith(family)) ?? ""
}

/**
 * 两个模型是否同族。
 *
 * @returns {boolean|null} true 同族 / false 不同族 / null 认不出（不猜）
 */
function sameFamily(requested, served) {
  const a = familyOf(requested)
  const b = familyOf(served)
  if (!a || !b) return null
  return a === b
}

/** 默认 sleep。 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把任意错误压成一段短文本；session 不在这里出现（上游错误体里也没有）。 */
function errorText(e) {
  return String(e?.message ?? e ?? "未知错误").replace(/\s+/g, " ").trim().slice(0, 200)
}
