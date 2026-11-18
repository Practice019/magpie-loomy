// usage.mjs 把 Loomy 的两个积分账本映射成 magpie 的额度窗口。
//
// # 上游有两个并行的账本（实测）
//
//	balance           总余额   —— **不随自然日重置**（邀请/活动/充值累积）
//	dailyBalance      每日额度 —— 服务端按自然日**自动重置**为 5000
//	availableBalance  可用总额 —— balance + 当日剩余（实际能花的那部分）
//
// # 映射决定与理由
//
// magpie 的 `windows[]` 有两个消费方：**进度条**与**路由排序**。
// 而 `used` 是路由输入（缺了会被归一成 0 = 「满额」，把一个耗尽的账号
// 顶到队首），所以哪些窗口该有 `used`、哪些该 `aside`，必须说清。
//
//	① 「每日赠送」   has `used`，参与路由
//	   理由：这是**会过期**的额度。当日赠送用光后请求会改烧永久积分，
//	   而「到期前用完」正是 magpie 路由想要的输入。它是唯一有天然上限
//	   （每日重置值）的账本，所以百分比算得出来。
//
//	② 「永久积分」   aside: true，不参与路由
//	   理由：它没有上限（邀请/充值累积，可以到几万），算不出有意义的百分比。
//	   而 `aside: true` 的语义正是「用光也不影响账号使用」——
//	   这里取的是它的弱化含义：**不影响路由判断**，但仍要展示在卡片上
//	   让用户知道还剩多少。硬塞一个假上限会造出「永远剩余 100%」的假进度条
//	   （市场现有插件被诟病的点）。
//
// # 为什么不用 availableBalance 作路由输入
//
// 它 = 永久 + 每日，没有独立上限 ⇒ 同样算不出百分比。
// 而「每日赠送」才是那个**有周期、会归零**的量，路由要的正是它。

import { TASK_DEFS } from "./points.mjs"

/**
 * 每日赠送的额度上限（服务端按自然日重置到的那个值）。
 *
 * ⚠ 这是**实测观测值**（09-12 → 09-14 整天没开客户端，再打开仍是满额 5000），
 * 不是配置项。上游改了这个数时，这里要跟着改 —— 所以它是常量而不是魔法数。
 */
export const DAILY_RESET_AMOUNT = 5000

/**
 * 北京时间「明天零点」的时刻（毫秒）。
 *
 * ⚠ 必须是**北京时间**而不是本地时区、也不是 UTC：
 * magpie 自己按北京日调度签到，本上游的每日额度也是按自然日重置的。
 * 用一个本地时区的午夜会让「什么时候刷新」在用户机器上漂移。
 *
 * 北京时间固定 UTC+8，无夏令时 —— 所以直接按偏移算，不用时区库。
 *
 * @param {number} [now] 毫秒时间戳
 * @returns {number}
 */
export function nextBeijingMidnight(now = Date.now()) {
  const OFFSET_MS = 8 * 3600_000
  const beijing = now + OFFSET_MS
  const DAY = 86400_000
  const startOfDay = Math.floor(beijing / DAY) * DAY
  return startOfDay + DAY - OFFSET_MS
}

/**
 * 把一份积分快照映射成 magpie 的 `auth.usage` 返回值。
 *
 * # ⚠ 绝不能顺手塞 `error`
 *
 * magpie 的契约是 `error?: string // 替代 windows 显示` —— 只要 `error`
 * 非空，**整个额度区就被那一句话替换掉**，窗口全部不显示。
 *
 * 所以：`error` 只用来表达「真的查不到额度」，任何附加信息
 * （任务进度、数据来源说明）都不能占用它。想表达来源就写进窗口的 `name`。
 *
 * @param {{available: number, daily: number, dailyKnown: boolean,
 *   permanent: number, permanentKnown: boolean}} points
 * @param {{now?: number, source?: "live"|"cache", updatedAt?: string}} [opts]
 *   `source: "cache"` 时在窗口名后加「(缓存)」，让用户知道这份数字可能过期，
 *   **而不是**把窗口藏掉换成一句话。
 * @returns {object} magpie 的 usage 对象
 */
export function usageFromPoints(points, opts = {}) {
  const now = opts.now ?? Date.now()
  const cached = opts.source === "cache"
  const suffix = cached ? " · 缓存" : ""
  /** @type {any[]} */
  const windows = []

  // ① 每日赠送 —— 参与路由
  if (points.dailyKnown) {
    const remaining = Math.max(0, Number(points.daily) || 0)
    const used =
      DAILY_RESET_AMOUNT > 0
        ? Math.min(100, Math.max(0, ((DAILY_RESET_AMOUNT - remaining) / DAILY_RESET_AMOUNT) * 100))
        : 0
    windows.push({
      name: "每日赠送" + suffix,
      used,
      resetsAt: nextBeijingMidnight(now),
      span: 86400,
      display: `${formatNumber(remaining)} / ${formatNumber(DAILY_RESET_AMOUNT)} 积分`,
      amount: remaining,
      limit: DAILY_RESET_AMOUNT,
      unit: "积分",
      // 剩余额度会在每日重置时作废 —— 让 magpie 的「到期前用完」有输入。
      runsOutAt: nextBeijingMidnight(now),
      runsOut: remaining,
    })
  }

  // ② 永久积分 —— 不参与路由（没有上限，算不出百分比）
  if (points.permanentKnown) {
    windows.push({
      name: "永久积分" + suffix,
      display: `${formatNumber(points.permanent)} 积分`,
      amount: Number(points.permanent) || 0,
      unit: "积分",
      aside: true,
    })
  }

  // ③ 可用总额（永久 + 每日）—— 也是 aside，只用于展示「实际能花多少」
  if (points.available !== undefined && points.available !== null) {
    windows.push({
      name: "可用总额" + suffix,
      display: `${formatNumber(points.available)} 积分`,
      amount: Number(points.available) || 0,
      unit: "积分",
      aside: true,
    })
  }

  // 缓存数据：把「截至什么时候」写进窗口名，而不是塞 error
  if (cached && opts.updatedAt && windows.length > 0) {
    windows[windows.length - 1].name += `（截至 ${shortTime(opts.updatedAt)}）`
  }

  return { windows }
}

/** 千分位（只是让卡片好读，不参与任何判据）。 */
function formatNumber(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return "—"
  return v.toLocaleString("zh-CN")
}

/** 把 ISO8601 压成 `MM-DD HH:mm`（窗口名里放不下完整的）。 */
function shortTime(iso) {
  const s = String(iso ?? "")
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s)
  if (!m) return s.slice(0, 16)
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

/**
 * 把一组任务状态汇总成一句给卡片看的话。
 *
 * @param {Record<string, boolean>} tasks
 * @returns {{done: number, total: number, points: number, text: string}}
 */
export function tasksSummary(tasks) {
  const map = tasks ?? {}
  let done = 0
  let points = 0
  for (const def of TASK_DEFS) {
    if (map[def.key]) {
      done += 1
      points += def.points
    }
  }
  const total = TASK_DEFS.reduce((s, d) => s + d.points, 0)
  return {
    done,
    total: TASK_DEFS.length,
    points,
    text: `新手任务 ${done}/${TASK_DEFS.length} · 已得 ${formatNumber(points)}/${formatNumber(total)} 积分`,
  }
}
