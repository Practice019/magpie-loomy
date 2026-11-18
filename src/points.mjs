// points.mjs Loomy 的**积分 / 任务 / 邀请码**接口。
//
// # 为什么这一个文件要自己发请求
//
// magpie 的 `loader.fetch` 只接管**模型请求**（chat / images）。积分网关
// （`/api/v1/points|onboarding|invitation-codes`）走的是另一条路：
// 宿主永远不会替我们调它，而额度、新手任务、邀请码全在这上面。
//
// 所以这里用最朴素的 `fetch` —— 不建客户端类、不做重试、不读流式：
// 这些接口都是「一来一回的短 JSON」，重试与故障转移由调用点决定。
//
// # 鉴权：只有 `token: <session>`
//
// 实测这个网关不认 Authorization（与 /models 同一条轨）。
//
// # 业务错误也是 HTTP 200
//
// 回执统一是 `{"code":"000000","desc":"...","data":{...}}`。
// 判据必须看 `code`，不能看状态码 —— 与模型代理的「200 + 缺少 token」同源。

import { POINTS_PREFIX, OK_CODE } from "./constants.mjs"
import { pointsAuth } from "./auth-headers.mjs"

export class PointsError extends Error {}

/**
 * 新手任务注册表：任务 key → 奖励积分。
 *
 * 来自客户端 `electron/onboarding-service.js` 的 TASK_POINTS，共 10000 分。
 * 顺序**就是界面上的顺序**（先聊天、再选技能…），所以用数组而不是对象 ——
 * 对象遍历顺序随机会让每次刷新按钮顺序都变。
 */
export const TASK_DEFS = Object.freeze([
  { key: "first_message", label: "首次对话", points: 500 },
  { key: "pick_skill", label: "选择技能", points: 1000 },
  { key: "generate_ppt", label: "生成 PPT", points: 1500 },
  { key: "set_schedule", label: "设置日程", points: 1000 },
  { key: "install_skill", label: "安装技能", points: 1500 },
  { key: "configure_remote", label: "配置远程", points: 1000 },
  { key: "create_soul", label: "创建人格", points: 1500 },
  { key: "share_soul", label: "分享人格", points: 2000 },
])

/** 取某任务的奖励分；未知 key 返回 0（照做，不报错）。 */
export function taskPointsOf(key) {
  const found = TASK_DEFS.find((d) => d.key === key)
  return found ? found.points : 0
}

/**
 * 积分网关的根：把模型代理基址的 `/api/v1` 去掉。
 *
 * 为什么从 baseUrl 推导而不是再开一个配置项：两者实测就是同一个 host，
 * 多一个配置项就多一个「配了 A 忘了配 B」的分叉面。
 *
 * @param {string} baseUrl 模型代理基址（含 /api/v1）
 * @returns {string}
 */
export function pointsRoot(baseUrl) {
  return String(baseUrl ?? "").replace(/\/+$/, "").replace(/\/api\/v1$/, "")
}

/**
 * 发一次积分网关请求并解出 `data`。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl   模型代理基址
 * @param {{session: string}} opts.auth
 * @param {string} opts.method
 * @param {string} opts.path      相对 `/api/v1`
 * @param {unknown} [opts.body]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<any>} `data` 段
 */
export async function pointsCall({ baseUrl, auth, method, path, body, fetchImpl, signal }) {
  if (!auth?.session) throw new Error("loomy: 缺少 session（积分接口的唯一鉴权材料）")

  const headers = new Headers({ Accept: "application/json" })
  pointsAuth(headers, auth)

  /** @type {RequestInit} */
  const init = { method, headers }
  const timeout = AbortSignal.timeout(30_000)
  init.signal = signal ? AbortSignal.any([signal, timeout]) : timeout
  if (body !== undefined) {
    headers.set("Content-Type", "application/json")
    init.body = JSON.stringify(body)
  }

  const url = pointsRoot(baseUrl) + POINTS_PREFIX + path
  const doFetch = fetchImpl ?? globalThis.fetch
  const endpoint = path.split("?")[0]
  const location = `${method} ${endpoint}`
  let resp
  let text
  try {
    resp = await doFetch(url, init)
    text = await resp.text()
  } catch {
    const reason = init.signal.aborted ? (timeout.aborted ? "请求超时（30秒）" : "请求已取消") : "网络请求失败"
    throw new PointsError(`loomy: ${location} ${reason}`)
  }
  if (!resp.ok) throw new PointsError(`loomy: ${location} HTTP ${resp.status}`)
  let env
  try {
    env = JSON.parse(text)
  } catch {
    throw new PointsError(`loomy: ${location} 回执不是合法 JSON（HTTP ${resp.status}）`)
  }
  const code = String(env?.code ?? "")
  if (code !== OK_CODE) {
    const safeCode = /^[a-zA-Z0-9_-]{1,24}$/.test(code) && !code.includes(auth.session) ? code : "未知"
    const description = ["登录已失效", "邀请码无效", "邀请码已用完", "账号已激活"].find((s) => String(env?.desc ?? "").includes(s))
    throw new PointsError(`loomy: ${location} 返回 ${safeCode}${description ? ": " + description : ""}`)
  }
  return env?.data
}

// ── 额度 ────────────────────────────────────────────────────────────────

/**
 * 查三个账本，并如实报告**哪几项真的拿到了**。
 *
 * # 为什么要带 presence（而不是只回三个数字）
 *
 * 「免费额度」那一列的判据是**三态**：没查到 / 确实是 0 / 大于 0。
 * 只回数字的话「字段缺失」会被读成 0 —— 界面显示「免费额度已用完」，
 * 而真相是「这次没读到」，用户会据此以为账号正在烧永久积分。
 * 这是**把未知说成确定的零**。
 *
 * # 三个字段的含义（实测 2026-09-15）
 *
 *	balance           25000   总余额（邀请/充值累积，**不含**每日赠送）
 *	dailyBalance      1434    每日剩余（当天还能花多少，次日重置）
 *	availableBalance  26434   **可用总额度** = balance + 当日剩余
 *
 * 流水里的 balanceBefore/balanceAfter 走的正是 availableBalance，
 * 所以「实际还能花多少」必须用它，不能用 balance。
 *
 * @returns {Promise<{available: number, daily: number, dailyKnown: boolean,
 *   permanent: number, permanentKnown: boolean}>}
 */
export async function fetchPointsSnapshot(opts) {
  const data = await pointsCall({
    ...opts,
    method: "GET",
    path: "/points/records?pageNo=1&pageSize=1",
  })

  // 优先看有 balance 的那一层；两层都试。
  for (const raw of [data, nestedData(data)]) {
    if (raw == null || typeof raw !== "object") continue
    const hasBalance = raw.balance !== undefined && raw.balance !== null
    const hasAvailable = raw.availableBalance !== undefined && raw.availableBalance !== null
    if (!hasBalance && !hasAvailable) continue

    const out = { available: 0, daily: 0, dailyKnown: false, permanent: 0, permanentKnown: false }
    // 可用总额度优先；这是用户要求展示的那个数。
    out.available = hasAvailable ? Number(raw.availableBalance) : Number(raw.balance)
    if (raw.dailyBalance !== undefined && raw.dailyBalance !== null) {
      out.daily = Number(raw.dailyBalance)
      out.dailyKnown = true
    }
    if (hasBalance) {
      out.permanent = Number(raw.balance)
      out.permanentKnown = true
    }
    if (![out.available, out.daily, out.permanent].every(Number.isFinite)) {
      throw new PointsError("loomy: GET /points/records 积分账本数值无效")
    }
    return out
  }
  throw new PointsError("loomy: GET /points/records 积分账本回执里没有 balance/availableBalance 字段")
}

// ── 新手任务 ────────────────────────────────────────────────────────────

/**
 * 查该账号的新手任务完成状态（key → 是否已完成）。
 *
 * # 回执的真实形态（2026-11-18 实测）
 *
 *	{"code":"000000","data":{
 *	   "tasks":{"configure_remote":true,"create_soul":true,"first_message":true,
 *	            "generate_ppt":true,"install_skill":true,"pick_skill":true,
 *	            "set_schedule":true,"share_soul":true},
 *	   "earned":10000,"total":10000}}
 *
 * ⚠ `tasks` 是**对象（key → 布尔）**，不是数组。只认数组会把「8 项全完成」
 * 解析成 `{}`，于是界面把已完成的账号显示成 0/8 —— 看起来像功能没做。
 *
 * 为了兼容其它形态，数组（`[{key,done}]` / `["key"]` / `{tasks:[…]}`）
 * 也一并认。
 *
 * @returns {Promise<Record<string, boolean>>}
 */
export async function fetchTasks(opts) {
  const data = await pointsCall({ ...opts, method: "GET", path: "/onboarding/tasks" })

  /** @type {Record<string, boolean>} */
  const out = {}
  const bag = data?.tasks ?? data?.list ?? data?.items ?? data

  // ① 对象形态：{ key: true }
  if (bag && typeof bag === "object" && !Array.isArray(bag)) {
    for (const [key, v] of Object.entries(bag)) {
      // ⚠ 只收布尔值。同级的 `earned` / `total` 是数字，不能被当成任务状态。
      if (typeof v === "boolean") out[key] = v
    }
    if (Object.keys(out).length > 0) return out
  }

  // ② 数组形态：[{key, done}] / ["key"]
  if (!bag || typeof bag !== "object") throw new PointsError("loomy: GET /onboarding/tasks 任务状态未知")
  const list = Array.isArray(bag) ? bag : []
  for (const item of list) {
    if (typeof item === "string") {
      out[item] = true
      continue
    }
    const key = String(item?.key ?? item?.taskKey ?? "").trim()
    if (!key) continue
    const done = item?.done ?? item?.completed ?? item?.finished
    if (typeof done === "boolean") out[key] = done
  }
  return out
}

/**
 * 完成一个新手任务（上报进度）。
 *
 * @returns {Promise<{ok: boolean, points: number}>}
 */
export async function completeTask(opts, key) {
  const data = await pointsCall({
    ...opts,
    method: "POST",
    path: "/onboarding/tasks/complete",
    body: { key },
  })
  const points = Number(data?.points ?? data?.reward ?? 0)
  return { ok: true, points: Number.isFinite(points) ? points : 0 }
}

// ── 邀请码 ──────────────────────────────────────────────────────────────

/**
 * 查邀请码激活状态。
 *
 * @returns {Promise<{activated: boolean, applied: string}>}
 */
export async function fetchActivation(opts) {
  const data = await pointsCall({ ...opts, method: "GET", path: "/points/activation" })
  const activated = data?.activated ?? data?.isActivated
  if (typeof activated !== "boolean") throw new PointsError("loomy: GET /points/activation 激活状态未知")
  return {
    activated,
    applied: String(data?.inviteCode ?? data?.code ?? ""),
  }
}

/**
 * 绑定一个邀请码。
 *
 * @param {object} opts
 * @param {string} code
 */
export async function bindInvite(opts, code) {
  await pointsCall({
    ...opts,
    method: "POST",
    path: "/points/activation",
    body: { inviteCode: String(code ?? "").trim() },
  })
}

/**
 * 首登初始化（新号的积分账号引导）。
 *
 * # 为什么需要它（源项目里「最后一个账号的邀请码没有显示」的根因）
 *
 * 客户端**每次登录后**会自动调这个端点：服务端下发注册奖励（实测
 * registerReward=5000）并**生成 5 个邀请码**。而通过第三方网关导入/添加的
 * 账号跳过了这一步 —— 表现就是 `invitation-codes` 返回空列表，
 * 注册奖励也没到账。
 *
 * 实测：对空账号调用本端点后，invitation-codes 立刻返回 5 个 active 码，
 * balance 补上注册奖励。服务端有 `alreadyProcessed` 幂等保护，
 * 重复调用不会重复发奖 —— 所以「每次登录都补一次」是安全的。
 *
 * ⚠ 不带邀请码调用（inviteCode 留空）：这里是「补初始化」不是「绑定」。
 */
export async function firstLogin(opts) {
  return pointsCall({
    ...opts,
    method: "POST",
    path: "/points/first-login",
    body: { deviceId: randomUUID() },
  })
}

/**
 * 查本账号**生成的**邀请码列表。
 *
 * # 字段名来自实测（这里踩过一个坑）
 *
 * 回执实测：`{"data":{"list":[{"inviteCode":"E3HRN8","usedCount":1,
 * "maxUses":1,"status":"exhausted"}, …]}}`
 *
 * 字段是 **`inviteCode`**，不是 `code`。第一版只认 `code`，于是
 * 「我生成的码」那一列**永远是空的** —— 而接口明明返回了 5 个。
 * 一个字段名猜错 = 整块功能看起来没做，且没有任何报错。
 *
 * 现在两个都认（`inviteCode` 优先），并把**状态**一起带出来：
 * `status`/`usedCount`/`maxUses` 让界面能区分「还能用」与「已用完」。
 *
 * @returns {Promise<Array<{code: string, usedCount: number, maxUses: number, status: string}>>}
 */
export async function fetchInvitationCodes(opts) {
  const data = await pointsCall({ ...opts, method: "GET", path: "/invitation-codes" })

  // 形状兼容三种（实测是第一种）：
  //	{"list":[…]}
  //	{"data":{"list":[…]}}
  //	[…] 或 ["ABC123"]
  /** @type {any[]} */
  let list = []
  if (Array.isArray(data)) list = data
  else if (Array.isArray(data?.list)) list = data.list
  else if (Array.isArray(data?.data?.list)) list = data.data.list

  const out = []
  for (const item of list) {
    // 元素可能是纯字符串，也可能是对象。
    if (typeof item === "string") {
      const code = item.trim()
      if (code) out.push({ code, usedCount: 0, maxUses: 1, status: "active" })
      continue
    }
    if (!item || typeof item !== "object") continue
    const code = String(item.inviteCode ?? item.code ?? "").trim()
    if (!code) continue

    // ⚠ `maxUses` 缺失与 `maxUses: 0` 是两件事：
    //   缺失 = 不知道上限（按 1 显示是保守的）；
    //   0    = 不限次数（某些活动码就是这个语义）。
    //   用 `?? 1` 会把 0 吞成 1，于是不限次的码被误标成「已用完」。
    const rawMax = item.maxUses
    const maxUses = rawMax === undefined || rawMax === null ? 1 : Number(rawMax) || 0

    out.push({
      code,
      usedCount: Number(item.usedCount ?? 0) || 0,
      maxUses,
      status: String(item.status ?? ""),
    })
  }
  return out
}

// ── 内部 ────────────────────────────────────────────────────────────────

/** 取 `{"data":{…}}` 里那一层；没有就返回 null。 */
function nestedData(raw) {
  if (!raw || typeof raw !== "object") return null
  const d = raw.data
  return d && typeof d === "object" ? d : null
}

/** 把一段可能很长的正文压成一行短摘要。 */
function summarize(raw, max = 200) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim()
  if (!s) return "(空)"
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max).join("") + "…"
}

/** 生成 v4 形式的 UUID（客户端用 crypto.randomUUID()）。 */
export function randomUUID() {
  return globalThis.crypto.randomUUID()
}
