// route.mjs 单账号一次性判定「这个账号还能不能派活」。
//
// # 发一次真实 chat，读响应里的实际模型
//
// 判定靠「这一轮实际由谁服务」：发一次与真实调用同头同体的 chat
// （完整客户端 body 模板，messages 换成一条探针「不要思考，只回复一个hi」，
// stream:true），从响应 SSE 每块的 data.model 直接读出实际模型再分类。
// 这条路与 loader 的旁路观察一致，不依赖账本副本，新号也能立即判定。
// 代价：每号 1 积分（换来即时、可信的判定）。
//
// # 判定链（顺序即优先级）
//
//	① GET /models（token 头，15s）   —— 免费前置否证
//	   ├─ 401/403、100002/100003、过期字样  → expired（session-expired / account-disabled）
//	   ├─ 有目录但无 DS4.1                  → routed（catalog-missing-ds41）
//	   ├─ 读不到（5xx/网络）                → 继续（不判：无法证明「没有」）
//	   └─ 目录完好                          → ②
//	② GET /points/records（token 头） —— 免费：availableBalance <= 0 → exhausted（no-quota）
//	③ 发真实 chat（POST /chat/completions）—— 读响应 model
//	   ├─ deepseek*                        → clean（ledger-deepseek）
//	   ├─ spark* / 非 deepseek 族           → routed（ledger-spark / ledger-other-family）
//	   └─ 读不到 model                      → unknown（保留原状态，不误判）
//
// # 账本分支仍在（调用方不传 probeChat 时）
//
// 不传 probeChat 的调用方（例如不愿花积分的巡检）走只读账本：读
// /points/records 里最新一条 modelName。账本是多副本缓存，并发高时读到的副本
// 更旧，所以预检 1 次 + 复查 2 次、取 createdAt 最大的一条。
//
// # 判定规则唯一
//
// classifyLedgerModel() 是唯一分类入口：chat 读到的 model 与账本的 modelName 都
// 走它。不要另写一份 —— 规则漂移过一次（自述直测 vs 账本）已经够贵。
//
// ⚠ 会静默出错的坑：业务失败也是 HTTP 200（AGENTS.md 坑 #1），判据必须看 code；
// reason 收敛为固定值：session-expired / account-disabled /
// catalog-missing-ds41 / no-quota / ledger-spark / ledger-other-family /
// ledger-deepseek / no-ledger-records.

import { MODELS_PATH, OK_CODE, CHAT_PATH, CLIENT_USER_AGENT, CLIENT_ACCEPT_ENCODING } from "./constants.mjs"
import { modelsAuth, chatHeaders } from "./auth-headers.mjs"
import { buildClientBody } from "./client-body.mjs"
import { pointsCall } from "./points.mjs"

/** 被探测的模型名。上游 ID 大小写混排，原样照抄。 */
export const DS41_MODEL_ID = "DeepSeek-V4.1-Flash"

/** 目录请求超时。目录只是「免费否证」：超时就当读失败，落到账本那一步。 */
const CATALOG_TIMEOUT_MS = 15_000

/**
 * 目录响应里出现这些字样 = session 已失效（作为**辅证**）。
 *
 * ⚠ 只在**已经用 `token:` 头**的前提下有意义。用 Authorization 拉目录也会
 * 得到「缺少 token」，那是头用错了，与过期无关 —— 本文件的目录请求永远走
 * token 头（模型目录的唯一正确鉴权轨）。
 */
const SESSION_EXPIRED_MARKERS = Object.freeze(["缺少 token", "登录已失效", "token 无效"])

/**
 * 上游表示「登录态有问题」的业务码（magpie 运行日志实测）。
 *
 *	100002  缺少 / 无效 token，desc 常带「登录已失效」
 *	100003  同一类登录问题（实测出现在积分网关）
 */
const SESSION_EXPIRED_CODES = Object.freeze(["100002", "100003"])

/**
 * `100003` 的 desc 里出现这些字样 = **账号被停用**，不是 session 过期。
 *
 * 实测：{"code":"100003","desc":"账号已被停用"} → 号本身废了；
 *       {"code":"100002","desc":"登录已失效"}   → 重登可恢复。
 * 两者 verdict 都是 expired，但 reason / servedModel 必须分开：给「账号已被
 * 停用」的用户看「请重新登录」是误导。
 */
const ACCOUNT_DISABLED_MARKERS = Object.freeze(["停用", "禁用", "封禁", "已关闭"])

/** 账本一页取多少条。只要 `list[0]`（副本里的最新一条），10 条够用。 */
const LEDGER_PAGE_SIZE = 10

/** 账本读取次数的下限（预检也算一次）。 */
const DEFAULT_LEDGER_READS = 3

/** 复查间隔（预检之后的两次复查各等这么久）。 */
const DEFAULT_LEDGER_INTERVAL_MS = 1000

/**
 * 同时进行的账本 HTTP 读取上限。
 *
 * 批量并发 6 时，6 个号同时打 `/points/records` 会让副本更旧/触发限流；
 * 这里做进程级令牌（不是只给批量路径用），单号检测同样受益。
 */
export const MAX_LEDGER_CONCURRENCY = 2

/** 认得出的模型族。用来判断「同族 / 不同族」。 */
const MODEL_FAMILIES = Object.freeze(["deepseek", "glm", "qwen", "spark"])

/**
 * 参数错误（缺少 session 这类编程错误）时抛的错。
 *
 * ⚠ 错误信息里绝不能出现 session —— 它会进日志与面板。
 */
class RouteProbeError extends Error {}

/** 探测请求里那条 user 消息（固定文案：只要模型回一句，省输出积分）。 */
const PROBE_CHAT_PROMPT = "不要思考，只回复一个hi"

/** 探测 chat 的超时（毫秒）。 */
const CHAT_PROBE_TIMEOUT_MS = 120_000

/** 读流时最多缓冲多少字节（SSE 首个 data 行远小于它）。 */
const CHAT_PROBE_PEEK_LIMIT = 64 * 1024

/**
 * 从一段 SSE 文本里取第一个 data: 行的 JSON 的 model 字段。
 * 非 JSON（[DONE]、心跳、空行）跳过；半截 JSON 也跳过（等下一块）。
 *
 * @param {string} text
 * @returns {string}
 */
function extractModelFromSse(text) {
  const s = String(text ?? "")
  if (!s) return ""
  for (const line of s.split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw.startsWith("data:")) continue
    const payload = raw.slice("data:".length).trim()
    if (!payload || payload === "[DONE]" || !payload.startsWith("{")) continue
    try {
      const obj = JSON.parse(payload)
      const model = String(obj?.model ?? "").trim()
      if (model) return model
    } catch {
      // 半截 JSON：还没读全，交给下一块
    }
  }
  return ""
}

/**
 * 发一次与真实调用同头同体的 chat，读响应 SSE 里的实际服务模型。
 *
 * 头：auth-headers.chatHeaders（Authorization + token + traceparent + loomy-version …）
 *     + UA / Accept-Encoding（与 loader 一致）。
 * 体：client-body.buildClientBody（完整客户端模板），messages 换成一条探针。
 * 失败（超时 / 非 200 / 读不到 model）一律返回空串，由调用方保留原状态。
 *
 * @param {{root: string, session: string, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 * @returns {Promise<string>} 实际 model；读不到返回空串
 */
async function probeChatModel({ root, session, fetchImpl, timeoutMs = CHAT_PROBE_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const headers = new Headers()
  headers.set("User-Agent", CLIENT_USER_AGENT)
  headers.set("Accept-Encoding", CLIENT_ACCEPT_ENCODING)
  chatHeaders(headers, { session })
  const body = JSON.stringify(
    buildClientBody({
      model: DS41_MODEL_ID,
      messages: [{ role: "user", content: PROBE_CHAT_PROMPT }],
    }),
  )

  let resp
  try {
    resp = await doFetch(String(root).replace(/\/+$/, "") + CHAT_PATH, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return ""
  }
  if (Number(resp?.status) !== 200) {
    try {
      await resp?.body?.cancel?.()
    } catch {
      // 忽略
    }
    return ""
  }

  const stream = resp.body
  if (!stream || typeof stream.getReader !== "function") {
    const text = await resp.text().catch(() => "")
    return extractModelFromSse(text)
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let bytes = 0
  let found = ""
  try {
    while (bytes < CHAT_PROBE_PEEK_LIMIT) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value?.byteLength ?? 0
      buf += decoder.decode(value, { stream: true })
      found = extractModelFromSse(buf)
      if (found) break
      if (buf.length > 32 * 1024) buf = buf.slice(-32 * 1024)
    }
  } catch {
    // 读流失败：当作没读到
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 忽略
    }
  }
  return found || extractModelFromSse(buf)
}

/**
 * 单账号一次性判定（发一次真实 chat 读实际模型）。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl 模型代理基址（含 `/api/v1`）
 * @param {string} opts.session 登录 session（全部请求走 `token:` 头）
 * @param {typeof fetch} [opts.fetchImpl] 注入的 fetch（测试用）
 * @param {number} [opts.ledgerReads] 账本读取次数（含预检），默认 3
 * @param {number} [opts.ledgerIntervalMs] 复查间隔，默认 1000
 * @param {(ms: number) => Promise<void>} [opts.sleep] 可注入的 sleep（测试用）
 * @returns {Promise<{verdict: "routed"|"clean"|"expired"|"exhausted"|"unknown",
 *   requested: string, servedModel: string, responseModel: string, createdAt: number,
 *   ledgerId: string, checkedAt: number, ledgerAgeSec: number, reason: string,
 *   evidence: {ledgerModelName: string, chatError: string, catalog: string[]}}>}
 */
export async function probeRoute({
  baseUrl,
  session,
  fetchImpl,
  ledgerReads = DEFAULT_LEDGER_READS,
  ledgerIntervalMs = DEFAULT_LEDGER_INTERVAL_MS,
  sleep,
  probeChatTimeoutMs,
} = {}) {
  if (!session) throw new RouteProbeError("loomy: 缺少 session，无法探测路由")
  const root = String(baseUrl ?? "").replace(/\/+$/, "")
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))

  const verdict = await evaluateReadOnly({
    baseUrl,
    session,
    fetchImpl,
    ledgerReads,
    ledgerIntervalMs,
    sleep,
    // ①② 免费前置先跑（目录 / 余额）；命中就直接返回，不发 chat。
    // 需要真正判定时才发一次真实 chat 读实际模型（与真实调用同头同体）。
    probeChat: () =>
      probeChatModel({ root, session, fetchImpl: doFetch, timeoutMs: probeChatTimeoutMs }),
  })

  // probeRoute 的契约里 verdict 永远存在；内部 keep（这次没结论）翻译成 unknown，
  // 但保留 reason（no-ledger-records）说明是「没读到 / 没有记录」，不是「判正常」。
  const keep = verdict.keep === true
  const { keep: _keep, ...rest } = verdict

  return {
    ...rest,
    verdict: keep ? "unknown" : verdict.verdict,
    requested: DS41_MODEL_ID,
    responseModel: "",
    // ⚠ 保留该字段恒为空：旧调用方/面板按它拼日志，删字段会让它们显示 undefined。
    evidence: { ...verdict.evidence, chatError: "" },
  }
}

/**
 * 只读判定的**唯一实现**（probeRoute 与 patrol 共用）。
 *
 * 返回的 `keep` 为 true 表示「这次没有结论」（目录读不到 / 账本读不到），
 * 调用方应保留原状态。probeRoute 会把 keep 翻译成 `unknown`。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.session
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.ledgerReads] 账本读取次数（含预检）
 * @param {number} [opts.ledgerIntervalMs] 复查间隔
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{verdict?: string, keep?: true, reason: string, servedModel: string,
 *   createdAt: number, ledgerId: string, checkedAt: number, ledgerAgeSec: number,
 *   evidence: {ledgerModelName: string, catalog: string[]}}>}
 */
export async function evaluateReadOnly({
  baseUrl,
  session,
  fetchImpl,
  ledgerReads = DEFAULT_LEDGER_READS,
  ledgerIntervalMs = DEFAULT_LEDGER_INTERVAL_MS,
  sleep,
  probeChat,
} = {}) {
  const root = String(baseUrl ?? "").replace(/\/+$/, "")
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const wait = typeof sleep === "function" ? sleep : defaultSleep
  const reads = Math.max(1, Math.floor(Number(ledgerReads) || DEFAULT_LEDGER_READS))
  const interval = Math.max(0, Number(ledgerIntervalMs) || 0)
  const checkedAt = Date.now()

  /** 统一的返回构造，避免几个分支各拼一份对象。 */
  const result = (over = {}) => ({
    servedModel: "",
    createdAt: 0,
    ledgerId: "",
    checkedAt,
    ledgerAgeSec: 0,
    evidence: { ledgerModelName: "", catalog: [] },
    ...over,
  })

  // ── ① 目录（免费否证） ────────────────────────────────────────────────
  const catalog = await readCatalog({ root, session, fetchImpl: doFetch })
  const catalogIds = catalog.status === "ok" ? catalog.ids : []
  const catalogEvidence = catalogIds.slice(0, 20)

  if (catalog.status === "expired") {
    const disabled = catalog.reason === "account-disabled"
    return result({
      verdict: "expired",
      reason: catalog.reason,
      servedModel: disabled ? "（账号已停用）" : "（登录已失效）",
    })
  }

  if (catalog.status === "ok" && !hasModel(catalogIds, DS41_MODEL_ID)) {
    return result({
      verdict: "routed",
      reason: "catalog-missing-ds41",
      // UI 要能显示「这个号到底有什么」，所以非空：空目录给一句人话。
      servedModel: catalogIds.join(", ") || "（目录里没有对话模型）",
      evidence: { ledgerModelName: "", catalog: catalogEvidence },
    })
  }

  // ── ② 余额（免费；0 余额的号即使目录完好也不该派活） ──────────────────
  const balance = await readBalance({ baseUrl: root, session, fetchImpl: doFetch })

  if (balance.expired) {
    return result({ verdict: "expired", reason: balance.expired })
  }
  if (balance.known && balance.available <= 0) {
    return result({
      verdict: "exhausted",
      reason: "no-quota",
      servedModel: "（积分不足）",
      evidence: { ledgerModelName: "", catalog: catalogEvidence },
    })
  }

  // ── ③ 真实 chat：读响应里的实际模型（调用方给了 probeChat 时走这条）──
  if (typeof probeChat === "function") {
    let served = ""
    try {
      served = String(await probeChat()).trim()
    } catch {
      served = ""
    }
    const cls = classifyLedgerModel(served)
    if (cls) {
      return result({
        verdict: cls.verdict,
        reason: cls.reason,
        servedModel: cls.servedModel,
        evidence: { ledgerModelName: served, catalog: catalogEvidence },
      })
    }
    // 没读到模型：不误判，交给调用方保留原状态。
    return result({
      keep: true,
      reason: "no-ledger-records",
      evidence: { ledgerModelName: served, catalog: catalogEvidence },
    })
  }

  // ── ③' 账本最新记录（未给 probeChat 时；取 createdAt 最大的一条）────────
  let ledger
  try {
    ledger = await readLatestLedgerRecord({
      baseUrl: root,
      session,
      fetchImpl: doFetch,
      reads,
      intervalMs: interval,
      sleep: wait,
    })
  } catch {
    // 账本一次都没读通：读不到 ≠ 没有记录，交给调用方保留原状态。
    return result({ keep: true, reason: "no-ledger-records", evidence: { ledgerModelName: "", catalog: catalogEvidence } })
  }

  const record = ledger.record
  const ledgerModelName = String(record?.modelName ?? "").trim()

  const verdict = ledgerModelName ? classifyLedgerModel(ledgerModelName) : null
  if (verdict) {
    return result({
      verdict: verdict.verdict,
      reason: verdict.reason,
      servedModel: verdict.servedModel,
      createdAt: Number(record?.createdAt) || 0,
      ledgerId: String(record?.ledgerId ?? ""),
      ledgerAgeSec: ledgerAge(checkedAt, record?.createdAt),
      evidence: { ledgerModelName, catalog: catalogEvidence },
    })
  }

  // 账本读通了但一条像样的记录都没有：新号，等真实流量（配合 traffic / patrol）。
  if (!ledger.sawReply) {
    return result({ keep: true, reason: "no-ledger-records", evidence: { ledgerModelName: "", catalog: catalogEvidence } })
  }
  return result({
    verdict: "unknown",
    reason: "no-ledger-records",
    evidence: { ledgerModelName: "", catalog: catalogEvidence },
  })
}

/**
 * 账本记录 → 判定（**唯一实现**，probeRoute / patrol 共用）。
 *
 * 「非 deepseek 族」为什么算 routed：请求的是 DS4.1，账本却记到 GLM / Qwen /
 * MiMo……，这本身就是「请求被换成了别家的模型」，与 spark 同性质。
 *
 * @param {string} modelName
 * @returns {{verdict: "routed"|"clean", reason: string, servedModel: string}|null}
 */
export function classifyLedgerModel(modelName) {
  const name = String(modelName ?? "").trim()
  if (!name) return null
  const low = name.toLowerCase()
  if (low.startsWith("spark")) return { verdict: "routed", reason: "ledger-spark", servedModel: name }
  if (low.startsWith("deepseek")) return { verdict: "clean", reason: "ledger-deepseek", servedModel: name }
  return { verdict: "routed", reason: "ledger-other-family", servedModel: name }
}

/**
 * 读账本最新记录（取 `createdAt` 最大的那条）。
 *
 * 每次读只取 `list[0]`（副本内最新在前）；多次读取是为了撞上更新的副本。
 * 全部读取失败时**抛错**（让调用方区分「读不到」与「确实空」）；读通但空
 * 返回 `{record:null, sawReply:true}`。
 *
 * @param {{baseUrl: string, session: string, fetchImpl?: typeof fetch,
 *   reads?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>}} opts
 * @returns {Promise<{record: any|null, sawReply: boolean}>}
 */
export async function readLatestLedgerRecord({
  baseUrl,
  session,
  fetchImpl,
  reads = 1,
  intervalMs = 0,
  sleep,
} = {}) {
  const root = String(baseUrl ?? "").replace(/\/+$/, "")
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const wait = typeof sleep === "function" ? sleep : defaultSleep
  const total = Math.max(1, Math.floor(Number(reads) || 1))
  const interval = Math.max(0, Number(intervalMs) || 0)

  /** @type {any|null} */
  let newest = null
  let sawReply = false
  /** @type {unknown} */
  let lastError = null

  for (let i = 0; i < total; i++) {
    if (i > 0) await wait(interval)

    /** @type {any[]} */
    let list
    try {
      list = await readLedgerPage({ baseUrl: root, session, fetchImpl: doFetch })
      sawReply = true
    } catch (e) {
      lastError = e
      continue
    }

    const first = Array.isArray(list) ? list[0] : null
    const at = Number(first?.createdAt)
    if (!first || !Number.isFinite(at)) continue
    if (!newest || at > Number(newest.createdAt)) newest = first
  }

  if (!newest && !sawReply && lastError) throw lastError
  return { record: newest, sawReply }
}

// ── 内部 ────────────────────────────────────────────────────────────────

/**
 * 读一次模型目录（`GET /models`，**只发 `token:` 头**）。
 *
 * 解析刻意宽容（`data[]` 或 `models[]`，条目取 `id`，纯字符串也认）——与
 * `src/hooks/models.mjs` 的目录解析同源。不能直接 import 那个文件：
 * 依赖方向是 `src/hooks/* → src/*`，反向会导致循环。
 *
 * @param {{root: string, session: string, fetchImpl: typeof fetch}} opts
 * @returns {Promise<{status: "expired"|"ok"|"unavailable", ids: string[],
 *   reason: "session-expired"|"account-disabled"|"", rateLimited?: true}>}
 */
async function readCatalog({ root, session, fetchImpl }) {
  const headers = new Headers({ Accept: "application/json" })
  // ⚠ 目录走 `token:` 那条轨，用 Authorization 会得到 HTTP 200 +
  // {"code":"100002"}（看起来像目录为空，不是鉴权错）。
  modelsAuth(headers, { session })

  /** @type {RequestInit} */
  const init = { method: "GET", headers, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) }

  let resp
  let text
  try {
    resp = await fetchImpl(root + MODELS_PATH, init)
    text = await resp.text()
  } catch {
    return { status: "unavailable", ids: [], reason: "" }
  }

  // 401/403 是明确的「凭证死了」。其它非 2xx（含 5xx）只是读不到目录。
  if (resp.status === 401 || resp.status === 403) {
    return { status: "expired", ids: [], reason: "session-expired" }
  }
  // ⚠ 429 = 瞬时限流，**不是**账号问题（真机实测：限流期间 /models 仍会说
  // 自己有 DS4.1）。单独标出来，让巡检「保留原结论」而不是判死。
  if (resp.status === 429) {
    return { status: "unavailable", ids: [], reason: "", rateLimited: true }
  }
  if (!resp.ok) return { status: "unavailable", ids: [], reason: "" }

  // 200 也可能是业务错误：先看过期字样（上游把「缺少 token / 登录已失效」
  // 也放在 HTTP 200 里）——这类字样只指向 session，不指向「账号停用」。
  if (SESSION_EXPIRED_MARKERS.some((marker) => text.includes(marker))) {
    return { status: "expired", ids: [], reason: "session-expired" }
  }

  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { status: "unavailable", ids: [], reason: "" }
  }

  // 业务码细分：100002 只可能是 session；100003 有两种语义，看 desc。
  const code = String(parsed?.code ?? "")
  if (SESSION_EXPIRED_CODES.includes(code)) {
    const desc = String(parsed?.desc ?? "")
    if (code === "100003" && ACCOUNT_DISABLED_MARKERS.some((marker) => desc.includes(marker))) {
      return { status: "expired", ids: [], reason: "account-disabled" }
    }
    // 100002；或 100003 且没有 desc / 其它文案：保守按「不可用」处理。
    return { status: "expired", ids: [], reason: "session-expired" }
  }
  // 其它非 000000 的业务错误：读不到目录，但**不是**过期判定依据。
  if (code && code !== OK_CODE) return { status: "unavailable", ids: [], reason: "" }

  const entries = Array.isArray(parsed?.data)
    ? parsed.data
    : Array.isArray(parsed?.models)
      ? parsed.models
      : null
  if (!entries) return { status: "unavailable", ids: [], reason: "" }

  /** @type {string[]} */
  const ids = []
  for (const entry of entries) {
    const id = String(typeof entry === "string" ? entry : (entry?.id ?? "")).trim()
    if (id) ids.push(id)
  }
  return { status: "ok", ids, reason: "" }
}

/**
 * 读一次账本回执的**顶部余额**（`data` 段）。
 *
 * 只用 `pageSize=1`：这次读的是余额，不是记录。
 *
 * @param {{baseUrl: string, session: string, fetchImpl: typeof fetch}} opts
 * @returns {Promise<{known: boolean, available: number, expired: string}>}
 */
async function readBalance({ baseUrl, session, fetchImpl }) {
  /** @type {any} */
  let body
  try {
    body = await withLedgerSlot(() =>
      pointsCall({
        baseUrl,
        auth: { session },
        method: "GET",
        path: "/points/records?pageNo=1&pageSize=1",
        fetchImpl,
      }),
    )
  } catch (e) {
    // 业务码错误（如 100002/100003）→ expired；其它失败只是「读不到余额」。
    //
    // ⚠ 100003 有两种语义，与目录侧同一条规则：desc 里出现「停用/禁用/封禁/
    // 已关闭」才是 account-disabled，其余（含「登录已失效」）都是 session 过期。
    const text = String(e?.message ?? "")
    const disabled = /100003/.test(text) && ACCOUNT_DISABLED_MARKERS.some((marker) => text.includes(marker))
    if (disabled) return { known: false, available: 0, expired: "account-disabled" }
    if (/100003/.test(text) || /100002/.test(text) || /登录已失效/.test(text)) {
      return { known: false, available: 0, expired: "session-expired" }
    }
    return { known: false, available: 0, expired: "" }
  }

  const rows = [body, body?.data].filter((x) => x && typeof x === "object")
  for (const row of rows) {
    const available = Number(row.availableBalance)
    if (row.availableBalance !== undefined && row.availableBalance !== null && Number.isFinite(available)) {
      return { known: true, available, expired: "" }
    }
    const balance = Number(row.balance)
    const daily = Number(row.dailyBalance)
    if (Number.isFinite(balance) && row.balance !== undefined && Number.isFinite(daily)) {
      return { known: true, available: balance + daily, expired: "" }
    }
  }
  // 字段缺失 = 不知道余额：**不判** exhausted（未知 ≠ 0）。
  return { known: false, available: 0, expired: "" }
}

/**
 * 目录里是否有这个模型 id（大小写不敏感、**全等**）。
 *
 * ⚠ 刻意不做别名 / 前缀匹配：`DeepSeek-V4.1-Flash` 与
 * `deepseek-v4-flash-1017` 是两个不同的 id；把它们的相似性当「有」会让
 * 一个其实被限制的号混过去。
 *
 * @param {string[]} ids
 * @param {string} modelId
 * @returns {boolean}
 */
function hasModel(ids, modelId) {
  const want = String(modelId ?? "").trim().toLowerCase()
  return ids.some((id) => String(id).trim().toLowerCase() === want)
}

/**
 * 读一页账本记录（走 `MAX_LEDGER_CONCURRENCY` 信号量）。
 *
 * 复用 `pointsCall`：它已经处理了「业务失败也是 HTTP 200，判据看 code」
 * 以及「错误信息不能带 session」。这里只负责把记录列表挖出来。
 *
 * @param {{baseUrl: string, session: string, fetchImpl: typeof fetch}} opts
 * @returns {Promise<any[]>}
 */
async function readLedgerPage({ baseUrl, session, fetchImpl }) {
  const data = await withLedgerSlot(() =>
    pointsCall({
      baseUrl,
      auth: { session },
      method: "GET",
      path: `/points/records?pageNo=1&pageSize=${LEDGER_PAGE_SIZE}`,
      fetchImpl,
    }),
  )

  // 实测：data.list。也认 data.data.list（多包一层时）与裸数组。
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  if (Array.isArray(data?.data?.list)) return data.data.list
  return []
}

/**
 * 账本读取的进程级信号量（上限 `MAX_LEDGER_CONCURRENCY`）。
 *
 * # 为什么是全局而不是「批量路径专用」
 *
 * 账本接口是多副本缓存，并发打到它身上只会读到更旧的副本、还可能被限流。
 * 把上限放在读取入口而不是批量 job 里，单号检测、面板批量、导入后自动探测
 * 全部自动受约束，不必每个调用方各写一遍。
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function withLedgerSlot(task) {
  while (ledgerInFlight >= MAX_LEDGER_CONCURRENCY) {
    // FIFO 等一个空位：先到先得，避免后来的插队。
    await new Promise((resolve) => ledgerWaiting.push(resolve))
  }
  ledgerInFlight += 1
  try {
    return await task()
  } finally {
    ledgerInFlight -= 1
    const next = ledgerWaiting.shift()
    if (next) next()
  }
}

/** 当前占用的账本读取槽位。 */
let ledgerInFlight = 0

/** 等槽位的队列（FIFO）。 */
const ledgerWaiting = []

/**
 * 模型名 → 族（前缀）。认不出返回空串。
 *
 * @param {string} model
 * @returns {string}
 */
export function modelFamilyOf(model) {
  const low = String(model ?? "").trim().toLowerCase()
  if (!low) return ""
  return MODEL_FAMILIES.find((family) => low.startsWith(family)) ?? ""
}

// ── 给 patrol.mjs 复用的只读入口 ───────────────────────────────────────
//
// 巡检绝不能发 chat，但它需要与探测**完全相同**的目录/session 判定与账本读取
// （包括 `MAX_LEDGER_CONCURRENCY` 信号量）。复制一份规则必然漂，所以把这些
// 只读路径导出。纯增量导出，不改 probeRoute 的签名。

/**
 * 目录巡检结果（与 `probeRoute` 同一套规则）。
 *
 * ⚠ `rateLimited: true` 表示**这次被限流**（429）。它是一条「没有结论」的
 * 信号，调用方必须 keep（保留上一次的判定），绝不能当成 expired/routed。
 *
 * @param {{baseUrl: string, session: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{status: "expired"|"ok"|"unavailable", ids: string[],
 *   reason: "session-expired"|"account-disabled"|"", rateLimited?: true}>}
 */
export async function inspectCatalog({ baseUrl, session, fetchImpl }) {
  const root = String(baseUrl ?? "").replace(/\/+$/, "")
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  return readCatalog({ root, session, fetchImpl: doFetch })
}

/**
 * 余额巡检结果（与 `probeRoute` 同一套规则）。
 *
 * @param {{baseUrl: string, session: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{known: boolean, available: number, expired: string}>}
 */
export async function inspectBalance({ baseUrl, session, fetchImpl }) {
  const root = String(baseUrl ?? "").replace(/\/+$/, "")
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  return readBalance({ baseUrl: root, session, fetchImpl: doFetch })
}

/**
 * 读一页账本记录（走 `MAX_LEDGER_CONCURRENCY` 信号量）。
 *
 * @param {{baseUrl: string, session: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<any[]>}
 */
export async function readLedgerRecords({ baseUrl, session, fetchImpl }) {
  const root = String(baseUrl ?? "").replace(/\/+$/, "")
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  return readLedgerPage({ baseUrl: root, session, fetchImpl: doFetch })
}

// ── 杂项 ────────────────────────────────────────────────────────────────

/**
 * 账本记录距今多少秒。
 *
 * `createdAt` 是 epoch 秒、`checkedAt` 是毫秒，所以先除以 1000。
 * 未来时间戳（时钟偏差 / 副本时间错乱）归零，不产生负年龄。
 *
 * @param {number} checkedAt epoch 毫秒
 * @param {unknown} createdAt epoch 秒
 * @returns {number}
 */
function ledgerAge(checkedAt, createdAt) {
  const at = Number(createdAt)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, checkedAt / 1000 - at)
}

/** 默认 sleep。 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}