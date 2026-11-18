// usage.mjs `auth.usage` 钩子 —— 额度卡片的数据源。
//
// # 顺序：先积分网关，失败才回落本机缓存
//
//	① 积分网关 `/points/records`   —— **按 session 逐个账号查**，权威
//	② 本机客户端 `loomy-points-summary` —— 只对本机登录的那一个账号有效
//
// 源项目修过一次「额度查询有问题」：第一版只读本机缓存，于是
// 「只有本机登录的那一个账号有值，池里其它号恒为空」+「网关自己的消耗
// 不会写回缓存」。积分网关直接能查，两个缺陷同时消失。
//
// 缓存只在网关请求失败时当兜底 —— 并且**如实标注它可能过期**。

import { fetchPointsSnapshot, fetchTasks } from "../points.mjs"
import { usageFromPoints, tasksSummary } from "../usage.mjs"
import { readLocalPoints, defaultClientStoreDir } from "../client-store.mjs"

/**
 * 构建 `auth.usage` 钩子。
 *
 * @param {{baseUrl: string, fetchImpl?: typeof fetch, clientStoreDir?: string, log?: object}} opts
 * @returns {(getAuth: () => Promise<any>) => Promise<object>}
 */
export function makeUsageHook(opts) {
  const baseUrl = opts.baseUrl
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = opts.log ?? console

  return async function usage(getAuth) {
    const auth = await getAuth()
    const session = auth?.access
    if (!session) return { error: "未登录" }

    // ── ① 积分网关（权威源）──
    //
    // ⚠⚠ 成功时必须**只返回 windows**，不能顺手塞 `error`。
    //
    // magpie 的契约：`error?: string // 替代 windows 显示`。也就是说
    // 只要 `error` 非空，**整个额度区就被替换成那一句话**，窗口全部不显示。
    //
    // 这里曾经把「新手任务 0/8」塞进 `error`，结果账号卡上的额度一片空白、
    // 用户以为「刷新获取不到信息」—— 而数据其实全在。
    // 任务进度属于「附加信息」，不是错误，不能占用 error 位。
    try {
      const points = await fetchPointsSnapshot({ baseUrl, auth: { session }, fetchImpl: doFetch })
      return usageFromPoints(points)
    } catch (e) {
      log.warn?.(`loomy: 积分网关查额度失败，尝试本机缓存: ${e?.message ?? e}`)
    }

    // ── ② 本机客户端缓存（兜底）──
    //
    // ⚠ 这里也不能拿 `error` 去说「这是缓存数据」：那会把刚读到的窗口一起藏掉。
    // 数据来源的可信度用窗口的 name 表达（见 usageFromPoints 的 source 参数）。
    try {
      const dir = opts.clientStoreDir ?? defaultClientStoreDir()
      const cached = dir ? readLocalPoints(dir) : null
      if (!cached || (!cached.balanceKnown && !cached.dailyKnown)) {
        return { error: "查不到额度（积分网关不可用，本机也没有客户端缓存）" }
      }
      return usageFromPoints(
        {
          available: cached.balanceKnown ? cached.balance : 0,
          daily: cached.dailyBalance,
          dailyKnown: cached.dailyKnown,
          permanent: cached.balance,
          permanentKnown: cached.balanceKnown,
        },
        { source: "cache", updatedAt: cached.updatedAt },
      )
    } catch (e) {
      return { error: `查额度失败: ${e?.message ?? e}` }
    }
  }
}
