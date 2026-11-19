// route.mjs 单账号一次性判定「这个账号还能不能派活」——**纯只读，0 积分**。
//
// # 为什么彻底不发 chat 了
//
// 早期版本的判定要用一次 chat 换账本记录（`max_tokens: 1`，每次扣 1 积分）。
// 产品最终决定：检测一律只读。好处是**检测从「每次 1 积分」变成「0 积分」**，
// 可以随时全量跑；代价是**没有任何账本记录的新号无法判定** → `unknown`，
// 等它被真实使用产生记录后自动可判（配合 `traffic` / `patrol`）。
//
// # 只读判定链（顺序即优先级）
//
//	① GET /models（token 头，15s）
//	   ├─ 401/403、100002/100003、过期字样  → expired（session-expired / account-disabled）
//	   ├─ 有目录但无 DS4.1                  → routed（catalog-missing-ds41）
//	   ├─ 目录完好                          → ②
//	   └─ 读不到（5xx/网络）                → ②（**不判**：无法证明「没有」不等于「没有」）
//	② GET /points/records（token 头，预检 1 次 + 复查 2 次，间隔 1s/3s）
//	   ├─ code 100002/100003                → expired（同上）
//	   ├─ availableBalance <= 0             → exhausted（no-quota）
//	   ├─ 有 modelName 记录
//	   │    ├─ spark* / 非 deepseek 族       → routed（ledger-spark / ledger-other-family）
//	   │    └─ deepseek*                    → clean（ledger-deepseek）
//	   └─ 没有任何 modelName 记录            → unknown（no-ledger-records）
//
// 「其它族为什么也算 routed」：请求的是 DS4.1，账本却记到 GLM / Qwen / MiMo……
// 这本身就是「请求被换成了别家的模型」，与 spark 同性质，账号同样不可信。
//
// # 账本为什么读 3 次
//
// 账本是**多副本缓存**：并发高时读到的副本更旧（实测同一个健康号单独跑 clean、
// 批量跑 unknown）。所以取「能看到的最新那条（createdAt 最大）」——预检 1 次
// + 复查 2 次足以覆盖副本漂移；再多只是白等。
//
// # 与 patrol.mjs 的关系
//
// patrol 是「批量免费巡检」，probeRoute 是「单账号一次性判定」。**判定规则只有
// 一份**：两者都调 `evaluateReadOnly()`。不要各写一份 —— 规则漂移过一次
// （自述直测 vs 账本）已经够贵。
//
// ⚠ 会静默出错的坑：业务失败也是 HTTP 200（AGENTS.md 坑 #1），判据必须看 code；
// `reason` 收敛为 8 个固定值：session-expired / account-disabled /
// catalog-missing-ds41 / no-quota / ledger-spark / ledger-other-family /
// ledger-deepseek / no-ledger-records。

import { MODELS_PATH, OK_CODE } from "./constants.mjs"
import { modelsAuth } from "./auth-headers.mjs"
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

/**
 * 单账号一次性判定（只读）。
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
} = {}) {
  if (!session) throw new RouteProbeError("loomy: 缺少 session，无法探测路由")

  const verdict = await evaluateReadOnly({
    baseUrl,
    session,
    fetchImpl,
    ledgerReads,
    ledgerIntervalMs,
    sleep,
  })

  return {
    ...verdict,
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

  // ── ③ 账本最新记录（取 createdAt 最大的一条） ─────────────────────────
  /** @type {any|null} */
  let record = null
  let sawReply = false

  for (let i = 0; i < reads; i++) {
    // 预检立刻读，之后才等间隔。
    if (i > 0) await wait(interval)

    /** @type {any[]} */
    let list
    try {
      list = await readLedgerPage({ baseUrl: root, session, fetchImpl: doFetch })
      sawReply = true
    } catch {
      continue
    }

    const first = Array.isArray(list) ? list[0] : null
    const at = Number(first?.createdAt)
    if (!first || !Number.isFinite(at)) continue
    if (!record || at > Number(record.createdAt)) record = first
  }

  const ledgerModelName = String(record?.modelName ?? "").trim()
  const lowered = ledgerModelName.toLowerCase()
  const ledgerId = String(record?.ledgerId ?? "")

  if (ledgerModelName) {
    const evidence = { ledgerModelName, catalog: catalogEvidence }
    if (lowered.startsWith("spark")) {
      return result({
        verdict: "routed",
        reason: "ledger-spark",
        servedModel: ledgerModelName,
        createdAt: Number(record.createdAt),
        ledgerId,
        ledgerAgeSec: ledgerAge(checkedAt, record.createdAt),
        evidence,
      })
    }
    if (lowered.startsWith("deepseek")) {
      return result({
        verdict: "clean",
        reason: "ledger-deepseek",
        servedModel: ledgerModelName,
        createdAt: Number(record.createdAt),
        ledgerId,
        ledgerAgeSec: ledgerAge(checkedAt, record.createdAt),
        evidence,
      })
    }
    // 请求 DS4.1 却记到别家（glm / qwen / mimo…）= 请求被换模型，账号不可信。
    return result({
      verdict: "routed",
      reason: "ledger-other-family",
      servedModel: ledgerModelName,
      createdAt: Number(record.createdAt),
      ledgerId,
      ledgerAgeSec: ledgerAge(checkedAt, record.createdAt),
      evidence,
    })
  }

  // 目录可读、余额也够，但账本一条像样的记录都没有：
  //   · 账本一次都没读通 → keep（读不到 ≠ 没有记录）
  //   · 读通了但确实空 → no-ledger-records（新号，等真实流量）
  if (!sawReply) {
    return result({ keep: true, reason: "no-ledger-records", evidence: { ledgerModelName: "", catalog: catalogEvidence } })
  }
  return result({
    verdict: "unknown",
    reason: "no-ledger-records",
    evidence: { ledgerModelName: "", catalog: catalogEvidence },
  })
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
 *   reason: "session-expired"|"account-disabled"|""}>}
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
 * @param {{baseUrl: string, session: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{status: "expired"|"ok"|"unavailable", ids: string[],
 *   reason: "session-expired"|"account-disabled"|""}>}
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