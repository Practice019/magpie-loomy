// usage.mjs `auth.usage` 钩子 —— 额度卡片的数据源。
//
// # ⚠ 本文件**一个字节都不打上游**（T-54，用户明确要求）
//
// magpie 每次渲染账号卡都会调 `auth.usage`。旧实现里这里是：
//
//	const points = await fetchPointsSnapshot({ baseUrl, auth: { session }, fetchImpl: doFetch })
//
// 也就是**每个账号一次 `GET /points/records`**。301 个账号 = 301 次上游请求，
// 全挤在 magpie 启动的那一瞬间。日志实证（`%LOCALAPPDATA%\magpie\logs\app.log`，
// 启动后 3 分钟）：额度相关警告 723 条、`points/records` 失败 70 条、
// 登录已失效 82 次 —— 用户看到的「掉号」就是上游把这个遍历识别成扫描。
//
// 用户原话：「你是说 Loomy 每次都会遍历这 300 多个号，然后去打上游吗？一定
// 不可以这样。你想办法限制它。想办法把这个关掉，不要让它自动打。」
//
// 现在的分工（**单向**）：
//
//	auth.usage（本文件）          只读 `<configDir>/loomy-usage-cache.json`，零上游
//	面板「刷新额度」按钮（server.mjs） 用户点了才打上游，写回同一个文件
//
// 回归见 `tests/quota-cache.test.mjs`（301 个账号连续调用 ⇒ fetch 计数 === 0）。
//
// # 保留下来的判定（**不许删**）
//
// 读缓存 ≠ 放弃所有判断。下面这些仍然每次生效，它们是「路由跳过该号」的唯一手段：
//
//	routed        → 停用 · 上游改路由（used:100）+ 说明 · 上游限制（aside）
//	expired       → signIn:"expired" + 说明 · 登录失效（aside）
//	exhausted     → 停用 · 积分耗尽（used:100）+ 说明 · 余额为零（aside）
//	余额为 0       → 停用 · 积分耗尽（used:100）（缓存里的真实读数，不是猜的）
//	429 冷却       → 停用 · 限流冷却（used:100 + resetsAt，到期自动恢复）
//	判定变化       → signIn:"kept"（请宿主重读该号的模型列表）
//
// 这些判定的输入只有**本地文件**（路由状态 + 进程内冷却表 + 缓存读数），
// 所以它们既不消耗上游，也不受这次改动影响。

import { QUOTA_PREFIX, STOP_PREFIX, NOTE_PREFIX } from "../usage.mjs"
import { readUsageCache, usageEntryFor, usageFromCache } from "../quota-cache.mjs"
import { accountKeys, accountRoute, cooldownOf } from "./loader.mjs"

/**
 * 构建 `auth.usage` 钩子。
 *
 * @param {{configDir?: string, routeStore?: any, log?: object, now?: () => number}} opts
 *   `configDir`：缓存文件与路由状态都在这个目录下（**唯一的输入来源**）。
 *   `routeStore`：仅测试注入（见 loader 的 `loadRouteStore`）。
 *   ⚠ 刻意**不再接受** `baseUrl` / `fetchImpl` / `clientStoreDir`：
 *     这个钩子没有「发请求」这回事，留着那两个参数就是在暗示它可以打上游。
 *     （历史调用点传了也**无害**：多余字段被忽略，不会抛。）
 * @returns {(getAuth: () => Promise<any>) => Promise<object>}
 */
export function makeUsageHook(opts = {}) {
  const log = opts.log ?? console
  const configDir = String(opts.configDir ?? "").trim()
  const storeOpt = opts.routeStore
  // 冷却判断是「逻辑时间」上的事：测试注入固定时钟即可
  const now = typeof opts.now === "function" ? opts.now : () => Date.now()

  /**
   * magpie 原生的「该账号需要重新登录」字段。
   *
   * `internal/provider/plugin_usage.go` 认 `signIn: "expired"`（并据此
   * `notePluginLapseSince(401)`），账号在 UI 上会变成「登录已失效」。
   *
   * ⚠ 只能在**这个账号确实过期**时写。写在 clean / routed 的号身上等于造谣：
   * 一个健康的号会被标成需要重登，用户会去删一个好好的号。
   */
  const SIGN_IN_EXPIRED = "expired"

  /**
   * magpie 原生的「这个账号的缓存读取已失效」字段 —— 我们用它是 **best-effort** 触发器。
   *
   * # 我们要解决的问题（真机实测）
   *
   * `auth.usage` 判出 routed 之后，magpie **不会**重拉 `provider.models`：
   * `plugin-providers.json` 里那个号仍挂着 9 个模型，请求继续派过去，延迟
   * 11–27 秒（真 DeepSeek 号 0.8 秒）。而 `provider.models` 已经做到
   * routed/expired/exhausted ⇒ `{}` —— 所以**只要宿主重新调用一次 models，
   * 排除就生效**。
   *
   * # ⚠ 这条通道是 **best-effort**，不是权威通道
   *
   * **实测尚未确认**：`signIn: "kept"` 到底会不会让宿主重读该账号的 models，
   * 我们还没有可靠的观测证据（`kept` 的语义是「上次读取作废」，`plugin_usage.go`
   * 里它与 `refusedLists` / `forgetAccount()` 相邻，但触发了哪一条没有验证过）。
   *
   * 目前已确认有效的权威通道是**面板的「应用判定」**（T-03）：它跑
   * `magpie plugin list`，实测改判后 `order` 从 117 条变 116 条、该号退出
   * 路由池、立即生效。所以这里只是「顺手试一下，不成也没损失」。
   *
   * ⚠ 不要因为它看起来没生效就加重试 / 循环 / 轮询 —— 那是拿性能换一个
   * 不确定的信号，而权威通道已经存在。
   *
   * ⚠ 只在**判定变化那一刻**加一次：每次都加会让宿主反复重读模型列表（性能灾难）。
   * 所以这里维护一份进程内的 `uid → 上次输出的 verdict`，只有变化时才发光一次。
   */
  const SIGN_IN_KEPT = "kept"

  /**
   * 进程内「上次输出给宿主的 verdict」。
   *
   * 不落盘是刻意的：进程重启时 magpie 本来就会重新列表，此时基线为「未知」，
   * 首次调用不发光 —— 正好。
   *
   * key 用 `accountKeys()` 的第一个键（身份优先），与查判定同口径。
   *
   * @type {Map<string, string>}
   */
  const lastVerdict = new Map()

  /**
   * 余额够不够跑一次请求（用于**路由**，不是展示）。
   *
   * # 为什么这件事不能等 patrol 的判定
   *
   * 真机：账号调上游直接 402「团队积分余额不足」，而 magpie 的 `quotas.json`
   * 里这个号的 `windows = null`（一条额度都没有）→ 路由把「没有任何额度窗口
   * 的号」当成可用 → 派活 → 402 → 换号 → 又慢又乱。
   *
   * 路由**只看 `windows[].used`**。所以余额为 0 时必须自己报一条满额窗口。
   *
   * # 三态（缓存里没有点数时走「真的不知道 → 不动」）
   *
   *	已知有余额  → `known && total > 0`  → 不动
   *	已知为 0    → `known && total <= 0` → 报满额
   *	真的不知道  → `known === false`     → 不动（不把未知说成 0）
   *
   * ⚠ T-54 之后「余额」只来自缓存记录里的 `permanent` +「可用总额」窗口的
   *   `amount`（= 上次刷新额度那一刻的真实读数），**不再现查**。
   *
   * @param {any} entry 缓存记录
   * @returns {{known: boolean, total: number}}
   */
  function budgetOf(entry) {
    if (!entry) return { known: false, total: 0 }
    // 「可用总额」是上游给的实际能花的那部分（balance + 当日剩余）
    const available = (Array.isArray(entry.windows) ? entry.windows : []).find(
      (w) => w && typeof w === "object" && String(w.name ?? "").startsWith(`${NOTE_PREFIX}可用总额`),
    )
    const avail = Number(available?.amount)
    if (Number.isFinite(avail)) return { known: true, total: avail }
    const permanent = Number(entry.permanent)
    if (Number.isFinite(permanent)) return { known: true, total: permanent }
    return { known: false, total: 0 }
  }

  /**
   * 「停用 · 积分不足」的**满额窗口** —— 可计入路由的那一条。
   *
   * ⚠ 它和那些 `aside` 说明窗是两个东西：
   *   · `aside` 会被 `allowanceOf` 整条跳过（只用来给用户看原因）
   *   · 这条没有 aside、没有 amount/limit，`used:100` ⇒ 路由认为满额 ⇒ 跳过该号
   *
   * @returns {{name: string, used: number, display: string}}
   */
  function exhaustedWindow() {
    return { name: `${STOP_PREFIX}积分耗尽`, used: 100, display: "0 积分（充值后自动恢复）" }
  }

  /**
   * 给「被限制 / 登录失效 / 余额不足」的账号补窗口。
   *
   * # 三类结论，三种处置
   *
   *	routed     aside 说明窗「说明 · 上游限制」+ 停用窗「停用 · 上游改路由」；**不带** `signIn`
   *	expired    aside 说明窗「说明 · 登录失效」+ 顶层 `signIn: "expired"`
   *	exhausted  aside 说明窗「说明 · 余额为零」+ 停用窗「停用 · 积分不足」；**不带** `signIn`
   *
   * 另外**不论判定如何**，只要缓存读数显示余额 <= 0 就补那条满额窗口（真实请求
   * 会 402，拦它的唯一手段就是让路由看到满额）。两条触发条件合并成一条窗口，
   * 绝不出现两个「积分不足」。
   *
   * # ⚠ 四条不要碰的东西
   *
   *	① **不要补 `used`** 到说明窗：一旦带上 `used`，它就会进额度排序。
   *	② **不要加 `amount` / `limit`** 到停用窗：会被反算成百分比。
   *	③ 顶层**绝不**为说明写 `error`（AGENTS.md 坑 #17）。
   *	④ 停用窗（`停用 · 上游改路由`）**绝不能被改成 aside** —— 那是本插件
   *	   让路由跳过该号的**唯一**手段。
   *
   * @param {any} result `usageFromCache` 的产出
   * @param {any} auth
   * @param {any} entry 缓存记录（**唯一的余额来源**；`null` = 没有额度数据）
   * @returns {Promise<any>}
   */
  async function withRouteWindow(result, auth, entry) {
    if (!result || result.error !== undefined) return result
    if (!Array.isArray(result.windows)) return result

    const keys = accountKeys(auth)
    // ⚠ 必须用 accountKeys()（身份优先、显示名兜底）：状态文件按 uid 落盘，
    // 只查一个键会永远 miss —— 那正是「窗口插不出来」的那次线上故障。
    const hit = keys.length > 0 ? await accountRoute(configDir, keys, { routeStore: storeOpt }) : null
    const verdict = hit?.entry?.verdict
    const key = hit?.key ?? keys[0] ?? "?"

    const { known, total } = budgetOf(entry)
    const broke = known && total <= 0
    const isExhausted = verdict === "exhausted"

    /** @type {any[]} 可计入路由的窗口（排最前） */
    const head = []
    /** @type {any[]} 只给用户看的说明窗 */
    const notes = []

    if (verdict === "expired") {
      try {
        log?.warn?.(`loomy: 账号 ${key} 登录已失效（session 过期），额度卡片标记 signIn=expired`)
      } catch {
        /* 日志失败不是业务失败 */
      }
      notes.push({ name: `${NOTE_PREFIX}登录失效`, aside: true, display: "session 已过期，请重新登录" })
    } else if (verdict === "routed") {
      const served = String(hit?.entry?.servedModel ?? "").trim() || "上游其它模型"
      try {
        log?.warn?.(`loomy: 账号 ${key} 已被上游限制（全部模型实际由 ${served} 服务），额度卡片加一条说明`)
      } catch {
        /* 日志失败不是业务失败 */
      }
      // ⚠ 名字里**禁止**带易变数据（T-37）：上游换服务的模型名每次都可能变，
      //   拼进 name 会让窗口「改名抖动」。名字固定为 `说明 · 上游限制`，
      //   模型名只进 `display`。
      notes.push({ name: `${NOTE_PREFIX}上游限制`, aside: true, display: `全部模型实际由 ${served} 服务` })
      // ── **立刻停派**：可计入路由的满额窗 ──
      //
      // `provider.models` 是列表缓存 —— 判定翻成 routed 之后要等下一次重拉列表
      // 才不派活，中间仍会把请求给它。`auth.usage` 每次读都生效，所以这里补一条
      // `used:100` 的满额窗：下一次读 usage，路由就跳过这个号。
      //
      // ⚠ 不是 aside（aside 会被 allowanceOf 整条跳过）；也不要 amount/limit。
      head.push({ name: `${STOP_PREFIX}上游改路由`, used: 100, display: `实际由 ${served} 服务；换回后自动恢复` })
    } else if (isExhausted) {
      notes.push({ name: `${NOTE_PREFIX}余额为零`, aside: true, display: "团队积分余额不足，充值后自动恢复" })
    }

    // 满额窗口：余额为 0 **或** 判定为 exhausted（两者合并，只出一条）
    if (broke || isExhausted) {
      head.push(exhaustedWindow())
      if (broke) {
        try {
          log?.warn?.(`loomy: 账号 ${key} 余额为 0，已报满额窗口（路由将跳过）`)
        } catch {
          /* 日志失败不是业务失败 */
        }
      }
    }

    // ── 429 冷却：短暂避开，**到期自动恢复** ──
    //
    // 429 不是封号（真机实测：连打 10 次里 4 次 429，之后 /models 仍正常）。
    // 既不能永久跳过（那等于把好号封了），也不能什么都不做（宿主会立刻重试）。
    // 所以给一条**带 `resetsAt`** 的满额窗：magpie 到期自动恢复。
    //
    // ⚠ 必须 `used:100` 且**不带** `aside`。冷却记录在 loader 进程内存里，到期即失效。
    const cooling = cooldownOf(key, now())
    if (cooling) {
      const seconds = Math.max(1, Math.round((cooling.until - now()) / 1000))
      head.push({
        name: `${STOP_PREFIX}限流冷却`,
        used: 100,
        display: `上游限流，约 ${seconds} 秒后恢复`,
        resetsAt: new Date(cooling.until).toISOString(),
      })
      try {
        log?.warn?.(`loomy: 账号 ${key} 处于限流冷却（约 ${seconds}s），已报满额窗口（到期自动恢复）`)
      } catch {
        /* 日志失败不是业务失败 */
      }
    }

    // ── 判定变化 ⇒ 发光一次 `signIn: "kept"`，请宿主重读这个号的模型列表 ──
    //
    // 三条纪律：① 只在**变化那一刻**加一次（否则宿主反复重读，性能灾难）
    //			 ② `expired` 优先：它要用户重登，语义不同，不能用 kept 糊过去
    //			 ③ 窗口本身**不依赖**宿主是否重读 —— 新判定必须立刻生效
    const previous = lastVerdict.get(key)
    const relisted = previous !== verdict
    lastVerdict.set(key, verdict)
    if (relisted) {
      try {
        log?.warn?.(`loomy: 账号 ${key} 判定变化 ${previous ?? "(首次)"}→${verdict}，已请求宿主重读模型列表`)
      } catch {
        /* 日志失败不是业务失败 */
      }
    }

    if (head.length === 0 && notes.length === 0) {
      if (relisted && verdict !== "expired") return { ...result, signIn: SIGN_IN_KEPT }
      return result
    }

    /** @type {any} */
    const out = { ...result, windows: [...head, ...notes, ...result.windows] }
    if (verdict === "expired") {
      // `signIn` 只属于登录问题：routed / exhausted 写它会把号标成「需要重登」
      out.signIn = SIGN_IN_EXPIRED
    } else if (relisted) {
      out.signIn = SIGN_IN_KEPT
    }
    return out
  }

  return async function usage(getAuth) {
    const auth = await getAuth()
    const session = auth?.access
    if (!session) return { error: "未登录" }

    // ── 唯一的数据来源：本机缓存（零上游）──
    //
    // ⚠ 这里**没有** try/catch fetch：没有请求可失败。缓存读不出来时
    //   `readUsageCache` 已经退化成空表（→「额度未读」），不需要第二种表达。
    //
    // ⚠ 成功时**只返回 windows**，不顺手塞 `error`：magpie 的契约是
    //   `error?: string // 替代 windows 显示` —— 只要 `error` 非空，整个额度区
    //   就被替换成那一句话，窗口全部不显示（曾经就栽在这里）。
    const cache = readUsageCache(configDir)
    const found = usageEntryFor(cache, accountKeys(auth))
    const result = usageFromCache(found ? found.entry : null, { now: now() })
    return withRouteWindow(result, auth, found ? found.entry : null)
  }
}

// 供测试与排障引用的常量（与 `src/usage.mjs` 的三个前缀同口径）。
export { QUOTA_PREFIX, STOP_PREFIX, NOTE_PREFIX }