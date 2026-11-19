// byturn.mjs 「这一轮由哪个模型服务」的**唯一权威判据**：by-turn 回执。
//
// # 真机验证过的链路
//
//	POST /chat/completions 带 TurnId: turn_probe_8083
//	→ GET /points/by-turn?turnId=turn_probe_8083        （鉴权头 `token:`）
//	→ {"data":{"turnId":"…","purpose":"chat.message","found":true,
//	           "points_consumed":1,"ledger_count":1,
//	           "modelName":"spark-x2.6-low","firstCreatedAt":…,"lastCreatedAt":…}}
//
// # 为什么它取代了其它判据
//
//	目录   会**谎报**（有 DS4.1 却路由到 spark）
//	账本   只能按时间窗口猜「这条记录是不是那个请求的」
//	by-turn 把「这一个请求」和「它实际扣费的模型」**精确对上** —— 参数名就是
//	        `turnId`（不是 chatId，写错一个字段名等于整块功能没做）。
//
// # 两条时序事实
//
//	① 账本有延迟：`found:false` 是常态，必须重试（客户端自己也这么做）
//	② 重试要**递增间隔**：1.5s / 3s / 4.5s / 6s。定频猛打只会把账本网关
//	   打成 429，反而更查不到。
//
// # 只有明确的族才下结论
//
// `spark*` ⇒ 被换模型（routed）；`deepseek*` ⇒ 正常（clean）。
// 其它（glm / qwen / 空）⇒ **null**：认不出就不下结论，别拿半个证据去封号。

import { buildClientBody } from "./client-body.mjs"

/** by-turn 路径（相对模型代理基址）。鉴权头：`token`。 */
export const BY_TURN_PATH = "/points/by-turn"

/** 默认重试次数（首次之外的额外次数）。 */
export const BY_TURN_RETRIES = 4

/** 默认首次等待间隔（毫秒）；之后按 `n × intervalMs` 递增。 */
export const BY_TURN_INTERVAL_MS = 1500

/**
 * 生成一个 TurnId：`turn_<16 hex>`。
 *
 * ⚠ 长度远小于客户端上限（256），但**必须每轮不同**：复用同一个 id 会把两轮
 * 的账本记录混在一起，得到的是「上一轮的模型」。
 *
 * @param {string} [prefix] 前缀（默认 `turn`；巡检可用 `turn_probe` 区分来源）
 * @returns {string}
 */
export function newTurnId(prefix = "turn") {
  const buf = new Uint8Array(8)
  globalThis.crypto.getRandomValues(buf)
  let hex = ""
  for (const b of buf) hex += b.toString(16).padStart(2, "0")
  return `${String(prefix || "turn")}_${hex}`
}

/** 默认 sleep（`unref`：本模块只跑在后台路径上，不该拖住进程退出）。 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 查一轮的 by-turn 回执。
 *
 * # 返回形状（永不抛）
 *
 *	{ found: true,  modelName: "spark-x2.6-low", pointsConsumed: 1, code: "000000", reason: "" }
 *	{ found: false, modelName: "", pointsConsumed: 0, code: "…", reason: "not-found" | "http-500" | … }
 *
 * `found:false` 时按 `intervalMs` **递增**重试（第 n 次等 n × intervalMs）。
 * 失败（HTTP / 网络）也重试，最后一次仍失败就如实返回原因 —— 调用方据此
 * **绝不改状态**。
 *
 * @param {{baseUrl: string, session: string, turnId: string, fetchImpl?: typeof fetch,
 *   retries?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>}} opts
 * @returns {Promise<{found: boolean, modelName: string, pointsConsumed: number,
 *   code: string, reason: string}>}
 */
export async function fetchTurnResult({
  baseUrl,
  session,
  turnId,
  fetchImpl,
  retries = BY_TURN_RETRIES,
  intervalMs = BY_TURN_INTERVAL_MS,
  sleep,
} = {}) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const wait = typeof sleep === "function" ? sleep : defaultSleep
  const root = String(baseUrl ?? "").replace(/\/+$/, "")
  const id = String(turnId ?? "").trim()

  const failed = (reason, code = "") => ({ found: false, modelName: "", pointsConsumed: 0, code, reason })

  if (!root || !id || !session) return failed("missing-input")

  const url = `${root}${BY_TURN_PATH}?turnId=${encodeURIComponent(id)}`
  const attempts = Math.max(0, Math.floor(Number(retries) || 0)) + 1

  let last = failed("not-found")
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // 首次不等待；之后第 n 次等 n × intervalMs（1.5 / 3 / 4.5 / 6 秒）
    if (attempt > 0 && intervalMs > 0) await wait(attempt * intervalMs)

    try {
      const headers = new Headers({ Accept: "application/json" })
      // ⚠ 与 /models 同一条轨：`token`，不是 Authorization
      headers.set("token", session)
      const resp = await doFetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) })
      if (!resp.ok) {
        last = failed(`http-${resp.status}`, String(resp.status))
        continue
      }
      /** @type {any} */
      const body = await resp.json().catch(() => null)
      const data = body?.data ?? body ?? {}
      const found = data?.found === true
      if (!found) {
        last = failed("not-found", String(body?.code ?? ""))
        continue
      }
      return {
        found: true,
        modelName: String(data?.modelName ?? "").trim(),
        pointsConsumed: Number(data?.points_consumed ?? 0) || 0,
        code: String(body?.code ?? "000000"),
        reason: "",
      }
    } catch (e) {
      last = failed(String(e?.message ?? e ?? "failed").slice(0, 120), "")
    }
  }
  return last
}

/**
 * 按 by-turn 的模型名判定这一轮。
 *
 * ⚠ 只认两个族：
 *	spark*    ⇒ routed（被换模型）
 *	deepseek* ⇒ clean （正常）
 * 其它（glm / qwen / 空）⇒ null：**认不出就不下结论**。
 *
 * @param {string} modelName
 * @returns {{verdict: "routed"|"clean", reason: string}|null}
 */
export function classifyByTurn(modelName) {
  const name = String(modelName ?? "").trim().toLowerCase()
  if (!name) return null
  if (name.startsWith("spark")) return { verdict: "routed", reason: "by-turn-spark" }
  if (name.startsWith("deepseek")) return { verdict: "clean", reason: "by-turn-deepseek" }
  return null
}

/**
 * 一次「带 TurnId 的最小请求 + by-turn 回查」的完整检测（面板用）。
 *
 * # 为什么面板要走这条
 *
 * 目录能谎报、账本只能猜时间窗 —— 只有 by-turn 能说清「这一轮到底由谁服务」。
 * 所以面板的「检测」发的是一条**真实请求**（扣 1 积分），然后按 TurnId 精确回查。
 *
 * ⚠ 这是**付费**操作（1 次 chat），与巡检（免费）不是一回事。
 *
 * # 返回值
 *
 *	{ verdict: "routed"|"clean", reason, servedModel, checkedAt, requested }  —— 有结论
 *	{ verdict: "unknown", reason }                                            —— 没测清（调用方 keep）
 *
 * @param {{baseUrl: string, session: string, fetchImpl?: typeof fetch,
 *   model?: string, turnId?: string, retries?: number, intervalMs?: number,
 *   sleep?: (ms: number) => Promise<void>, timeoutMs?: number}} opts
 * @returns {Promise<{verdict: "routed"|"clean"|"unknown", reason: string,
 *   servedModel?: string, checkedAt?: number, requested?: string}>}
 */
export async function probeByTurn({
  baseUrl,
  session,
  fetchImpl,
  model = "deepseek-v4-flash-1017",
  turnId,
  retries = BY_TURN_RETRIES,
  intervalMs = BY_TURN_INTERVAL_MS,
  sleep,
  timeoutMs = 120_000,
} = {}) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const root = String(baseUrl ?? "").replace(/\/+$/, "")
  if (!root || !session) return { verdict: "unknown", reason: "missing-input" }

  const id = String(turnId ?? "").trim() || newTurnId("turn_probe")

  /** 请求头：与真实请求同一套鉴权 + TurnId 锚点。 */
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" })
  headers.set("Authorization", `Bearer ${session}`)
  headers.set("token", session)
  headers.set("TurnId", id)

  try {
    const resp = await doFetch(`${root}/chat/completions`, {
      method: "POST",
      headers,
      // ⚠ 探测必须与**真实请求同形**：直接用抓包的完整客户端 body 当底
      // （客户端 system + 全套 tools + 32000 + high + stream）。实证：简化 body
      // 第 4 次就降级，客户端形态 10/10 正常 —— 用最小 body 探测会得出
      // 「代表不了真实使用」的错误结论。
      body: JSON.stringify(buildClientBody({ messages: [{ role: "user", content: "ping" }] })),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) return { verdict: "unknown", reason: `chat-${resp.status}`, requested: model }
  } catch (e) {
    return { verdict: "unknown", reason: `chat-${String(e?.message ?? e).slice(0, 80)}`, requested: model }
  }

  const result = await fetchTurnResult({ baseUrl: root, session, turnId: id, fetchImpl: doFetch, retries, intervalMs, sleep })
  if (!result.found) return { verdict: "unknown", reason: `by-turn-${result.reason || "not-found"}`, requested: model }

  const classified = classifyByTurn(result.modelName)
  if (!classified) {
    // 认不出的族不判：宁可 unknown 让上层 keep，也不拿半个证据封号
    return { verdict: "unknown", reason: "by-turn-unknown-family", servedModel: result.modelName, requested: model }
  }
  return {
    verdict: classified.verdict,
    reason: classified.reason,
    servedModel: result.modelName,
    requested: model,
    checkedAt: Date.now(),
  }
}