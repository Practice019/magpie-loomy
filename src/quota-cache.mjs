// quota-cache.mjs `auth.usage` 的唯一数据源 —— **只读本地，零上游**。
//
// # 这一刀在治什么（真机事故）
//
// 旧实现里 `auth.usage` 每个账号都打一次积分网关：
//
//	POST/GET /points/records × 301 个号 —— 全部挤在 magpie 启动的那一瞬间
//
// 日志实证（`%LOCALAPPDATA%\magpie\logs\app.log`，启动后 3 分钟）：
// 额度相关警告 723 条、`points/records` 失败 70 条、登录已失效 82 次。用户在
// `app.log` 里看到的「掉号」就是这么来的 —— 上游风控把逐个遍历识别成扫描。
//
// 用户的原话：「你是说 Loomy 每次都会遍历这 300 多个号，然后去打上游吗？
// 一定不可以这样。你想办法限制它。想办法把这个关掉，不要让它自动打。」
//
// 所以现在的分工是**单向**的：
//
//	auth.usage（宿主每次渲染卡片都调）  →  只读本文件        （零上游）
//	面板「刷新额度」按钮（用户点）      →  写本文件 → usage 下一轮读到
//
// ⚠ `auth.usage` 里**不得出现任何 fetch**。这条由 `tests/quota-cache.test.mjs`
//   的位置 ④ 钉死（301 个账号连续调用，注入的 fetch 计数器必须 === 0）。
//
// # 缓存文件形状（`<configDir>/loomy-usage-cache.json`）
//
//	{
//	  updatedAt: 1795053000000,
//	  accounts: {
//	    "<uid>": {
//	      at: 1795053000000,          // 这条记录什么时候读回来的（毫秒）
//	      windows: [ … ],             // 当时算好的 magpie 窗口数组（**原样**回给宿主）
//	      plan: "free" | "pro",       // 上游套餐（只做展示，不参与任何判断）
//	      permanent: 25000,           // 永久积分
//	      limited: false              // 上游是否限制了这个号（只做展示）
//	    }
//	  }
//	}
//
// # 为什么存**已经算好的 windows**，而不是只存三个数字
//
// 三个数字（balance / dailyBalance / availableBalance）要靠 `usageFromPoints`
// 再算一遍，等于每次渲染都把映射规则重跑一遍；而映射规则（哪个窗口有 `used`、
// 哪个是 `aside`、`resetsAt` 怎么算）是**当时的时刻**决定的。存算好的窗口，
// 宿主拿到的就是「上次读数那一刻的真实刻画」，不会因为「现在几点」而变形。
//
// ⚠ 但「额度读于多久前」这条说明是**现在**算的（它是新鲜度，不是额度本身）。

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { NOTE_PREFIX } from "./usage.mjs"

/** 缓存文件名（与 `loomy-accounts-cache.json` 等并列，落在 configDir 下）。 */
export const USAGE_CACHE_FILE = "loomy-usage-cache.json"

/** 「还没有额度」那条说明窗的名字（**固定**，不带时间戳 —— 否则卡片每次改名）。 */
export const UNREAD_NOTE = `${NOTE_PREFIX}额度未读`

/** 「额度读于多久前」那条说明窗的**名字**（时间只进 `display`，T-37）。 */
export const AGE_NOTE = `${NOTE_PREFIX}额度读于`

/** 「这个数是推算出来的」那条说明窗的名字（接在额度窗后面）。 */
export const PROJECTION_NOTE = `${NOTE_PREFIX}额度推算`

/**
 * 读整张缓存表（缺文件 / 损坏 / 形状不对 → 空表，**绝不抛**）。
 *
 * 缓存损坏不该让账号卡一片空白：空表会退化成「额度未读，点刷新额度读取」，
 * 而那正是用户能看懂、也能自己修的状态。
 *
 * @param {string} configDir
 * @returns {{updatedAt: number, accounts: Record<string, any>}}
 */
export function readUsageCache(configDir) {
  const dir = String(configDir ?? "").trim()
  const empty = { updatedAt: 0, accounts: /** @type {Record<string, any>} */ ({}) }
  if (!dir) return empty
  const path = join(dir, USAGE_CACHE_FILE)
  if (!existsSync(path)) return empty
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return empty
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty
  const table = parsed.accounts
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    return { updatedAt: Number(parsed.updatedAt) || 0, accounts: {} }
  }
  /** @type {Record<string, any>} */
  const accounts = {}
  for (const [uid, entry] of Object.entries(table)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) accounts[uid] = entry
  }
  return { updatedAt: Number(parsed.updatedAt) || 0, accounts }
}

/**
 * 取某个账号的缓存记录（按 `accountKeys()` 的顺序逐个试，身份优先）。
 *
 * # 为什么接受**键数组**
 *
 * `plugin-auth.json` 里 `uid` / `metadata.uid` / `accountId` 三键同时存在，
 * 而缓存按 uid 落盘。只查一个键就会永远 miss —— 那正是「窗口插不出来」的那次
 * 线上故障（见 `src/hooks/loader.mjs` 的 `accountKeys()` 注释）。
 *
 * @param {{updatedAt: number, accounts: Record<string, any>}} cache
 * @param {string[]} keys
 * @returns {{entry: any, key: string}|null}
 */
export function usageEntryFor(cache, keys) {
  for (const raw of Array.isArray(keys) ? keys : [keys]) {
    const key = raw === null || raw === undefined ? "" : String(raw).trim()
    if (!key) continue
    const entry = cache?.accounts?.[key]
    if (entry && typeof entry === "object" && Array.isArray(entry.windows)) return { entry, key }
  }
  return null
}

/**
 * 「多久以前」的人话（用于 `说明 · 额度读于 …` 的 `display`）。
 *
 * 判据是**单调**的：刚读 → 分钟 → 小时 → 天。不做「刚刚」这类模糊词以外的花样，
 * 因为这条文字是用户判断「该不该点刷新额度」的唯一依据。
 *
 * @param {number} at 读数时刻（毫秒）
 * @param {number} [now] 当前时刻（毫秒；测试注入）
 * @returns {string}
 */
export function ageText(at, now = Date.now()) {
  const ms = Number(now) - Number(at)
  if (!Number.isFinite(ms) || ms < 0) return "刚刚"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

/**
 * 由缓存记录拼出 `auth.usage` 的返回值 —— **纯本地，零上游**。
 *
 * # 三条形态
 *
 *	有缓存   → 原样回 `windows` + 追加一条 `aside` 说明窗（`说明 · 额度读于 …`）
 *	没有缓存 → 只回一条 `aside` 说明窗（`说明 · 额度未读`），**不发请求**
 *	两者都**绝不**写 `error`
 *
 * `error` 的语义在 magpie 里是「整块替换额度区」（见 `usageFromPoints` 的注释），
 * 而「还没读过」不是错误 —— 它是正常初始状态，用户点一下按钮就有了。
 *
 * @param {any} entry 缓存记录（`null` = 没有）
 * @param {{now?: number}} [opts]
 * @returns {{windows: any[]}}
 */
export function usageFromCache(entry, opts = {}) {
  const now = typeof opts.now === "number" ? opts.now : Date.now()
  const windows = Array.isArray(entry?.windows) ? entry.windows.map((w) => ({ ...w })) : []

  if (!entry) {
    return {
      windows: [
        {
          name: UNREAD_NOTE,
          aside: true,
          display: "点面板「刷新额度」读取（本插件不会自动打上游）",
        },
      ],
    }
  }

  // ── 推算：基准读数 − 累计消耗（T-57）──
  //
  // 上游每次对话都回 `points_consumed` 但不回余额，所以这里把**主额度窗**
  // 的 balance 换成推算值，并在 display 里写明「推算」+ 基准时间。
  // 这样额度列不用手动刷新也是活的，且**一个额外请求都不发**。
  //
  // ⚠ 只改**第一条非 aside 的额度窗**（卡片上的主额度），别动 aside 明细：
  //   永久积分 / 受限积分那些是上游的原始读数，改了就对不上了。
  const left = projectedBalance(entry)
  if (left !== null) {
    const i = windows.findIndex((w) => w && w.aside !== true && typeof w.balance === "number")
    if (i >= 0) {
      const note = projectionText(entry, now)
      windows[i] = {
        ...windows[i],
        balance: left,
        display: `${trimNum(left)} 积分`,
      }
      windows.splice(i + 1, 0, { name: PROJECTION_NOTE, aside: true, display: note })
    }
  }

  // ⚠ 说明窗追加在**末尾**：前面的额度窗顺序（每日赠送 / 永久积分 / 可用总额）
  //   是卡片上的既有布局，说明只是补一句「什么时候读的」。
  return {
    windows: [
      ...windows,
      {
        name: AGE_NOTE,
        aside: true,
        display: `${ageText(entry.at, now)} · 点面板「刷新额度」更新`,
      },
    ],
  }
}

/**
 * 把「刚读回来的账本」整理成缓存记录（面板刷新写盘用）。
 * # 为什么要存 `plan` / `permanent` / `limited`
 *
 * 它们不参与任何判断，只是让面板「额度」列在**不发请求**时也能显示套餐与
 * 永久积分 —— 否则用户每次打开面板都只能看到「未读」。
 * ⚠ 这里的 `permanent` 与 `windows` 里那条 `说明 · 永久积分` 是**同一份数据
 *   的两种表达**（一个给机器、一个给卡片），不要用其中一个去「反推」另一个。
 *
 * @param {{windows: any[], plan?: string, permanent?: number, limited?: boolean,
 *   at?: number}} input
 * @returns {{at: number, windows: any[], plan: string, permanent: number, limited: boolean}}
 */
export function usageCacheEntry(input) {
  const at = Number(input?.at) > 0 ? Number(input.at) : Date.now()
  const windows = Array.isArray(input?.windows) ? input.windows : []
  const permanent = Number(input?.permanent)
  return {
    at,
    windows,
    plan: String(input?.plan ?? ""),
    permanent: Number.isFinite(permanent) ? permanent : 0,
    limited: input?.limited === true,
  }
}

/**
 * 这条缓存记录里**可计入路由**的窗口（给 `auth.usage` 的既有判定逻辑复用）。
 *
 * `auth.usage` 现在不再自己算额度，但「routed / expired / 429 冷却 / 余额为 0」
 * 这几条**必须继续生效**（它们是路由跳过的唯一手段，见 `withRouteWindow`）。
 * 所以缓存里那些 `used: 100` 的停用窗要能被原样带出来 —— 这里只是把
 * 「哪些算额度窗」这件事收成一处判据，避免调用点各写一份。
 *
 * @param {any[]} windows
 * @returns {any[]}
 */
export function countableWindows(windows) {
  return (Array.isArray(windows) ? windows : []).filter(
    (w) => w && typeof w === "object" && w.aside !== true,
  )
}

// ── 消耗记账与推算（T-57）────────────────────────────────────────────────
//
// # 为什么需要它
//
// 上游每次对话的响应里都带 `usage.points_consumed`（实测：流式与流式都有），
// 但**从不带余额**。所以余额只能：
//
//	基准读数（用户点「刷新额度」那一刻的真实余额）
//	  − 之后累计的 points_consumed
//	  = 当前推算余额
//
// 这样额度列不用再手动刷新，也**一个额外请求都不发**。
//
// # 为什么 5000 才校准
//
// 签到、邀请奖励这些不经过对话，推算必然慢慢偏离。但校准要打上游 ——
// 用户要的是「请求非常非常少」，所以阈值定在 5000 积分（约等于
// 一个号全部额度）。到了阈值只在卡片上提示「建议校准」，
// **绝不自动发请求**（自动发请求正是之前掉号的原因）。

/** 累计消耗到这个数就标记「建议校准」。用户定的 5000。 */
export const CALIBRATE_AFTER_POINTS = 5000

/** 从 `usage.points_consumed` 里取一个非负整数；认不出就 0。 */
export function pointsFromUsage(usage) {
  const n = Number(usage?.points_consumed)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/**
 * 推算一个账号当前的余额：`baseline - consumed`，**下限 0**。
 *
 * 没有 `baseline`（从没读过真实余额）⇒ `null`，调用方继续显示「未读」。
 *
 * @param {{baseline?: number, consumed?: number}} entry
 * @returns {number|null}
 */
export function projectedBalance(entry) {
  const base = Number(entry?.baseline)
  if (!Number.isFinite(base) || base < 0) return null
  const used = Number(entry?.consumed)
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0
  return Math.max(0, base - safeUsed)
}

/** 推算值是否已经该校准了（累计消耗 ≥ 阈值）。 */
export function needsCalibration(entry, threshold = CALIBRATE_AFTER_POINTS) {
  const used = Number(entry?.consumed)
  if (!Number.isFinite(used) || used <= 0) return false
  return used >= threshold
}

/**
 * 把一条「推算说明」拼成人话：`推算：基准 15:42 − 已消耗 12.5`。
 *
 * 刻意写「推算」两个字：这个数不是上游给的，签到/邀请变化它看不出来。
 */
export function projectionText(entry, now = Date.now()) {
  const left = projectedBalance(entry)
  if (left === null) return ""
  const used = Number(entry?.consumed) || 0
  const stamp = (() => {
    const at = Number(entry?.calibratedAt ?? entry?.at)
    if (!Number.isFinite(at) || at <= 0) return ""
    const d = new Date(at)
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  })()
  const tail = needsCalibration(entry) ? "，已超 5000，建议校准" : ""
  return `推算：基准${stamp ? " " + stamp : ""} 读数 − 已消耗 ${trimNum(used)}${tail}`
}

/** 12.5 而不是 12.500000001：只留两位并去掉尾巴零。 */
function trimNum(n) {
  const v = Math.round(Number(n) * 100) / 100
  return Number.isInteger(v) ? String(v) : String(v)
}