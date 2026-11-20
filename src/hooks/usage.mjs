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
//
// # T-38 只删了一件事：by-turn 那条判定来源
//
// 原来「这一轮落在哪个模型」要靠 by-turn 回查（发一次计费 chat + 轮询账本），
// 现在不用了：SSE 每个 chunk 自带 `model`，loader 旁路读取即可
// （`src/hooks/loader.mjs` 的 `noteServedModel`）。**额度读取本身保持原样**：
// 用户明确要求「usage 这些也不要改」。

import { fetchPointsSnapshot, fetchTasks } from "../points.mjs"
import { usageFromPoints, tasksSummary, QUOTA_PREFIX, STOP_PREFIX, NOTE_PREFIX } from "../usage.mjs"
import { readLocalPoints, defaultClientStoreDir } from "../client-store.mjs"
import { accountKeys, accountRoute, cooldownOf } from "./loader.mjs"

/**
 * 构建 `auth.usage` 钩子。
 *
 * @param {{baseUrl: string, fetchImpl?: typeof fetch, clientStoreDir?: string, log?: object,
 *   configDir?: string, routeStore?: any, now?: () => number}} opts
 *   `configDir` / `routeStore`：读「这个账号是不是被上游限制了」。
 * @returns {(getAuth: () => Promise<any>) => Promise<object>}
 */
export function makeUsageHook(opts = {}) {
  const baseUrl = opts.baseUrl
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
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
   * # ⚠ 只在**判定变化那一刻**加一次
   *
   * 每次都加会让宿主反复重读模型列表（性能灾难）。所以这里维护一份进程内
   * 的 `uid → 上次输出的 verdict`，只有变化时才发光一次。
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
   * 积分网关的「登录失效」业务码（实测，来自 magpie 运行日志）。
   *
   *	[loomy] 积分网关查额度失败，尝试本机缓存: GET /points/records 返回 100003
   *	[loomy] …                                    GET /points/records 返回 100002: 登录已失效
   *
   * 这两个码属于**登录问题**，不属于「网关抖了一下」。把它们当普通错误回落
   * 本机缓存，就会捧出一份**正常的旧额度** —— magpie 据此认为号还活着
   * （用户看到的「27 个可用」里就有它们），界面上也看不出任何异常。
   */
  const SESSION_DEAD_CODES = ["100002", "100003"]
  const SESSION_DEAD_TEXT = ["登录已失效", "缺少 token"]

  /**
   * 这个错误是不是「session 死了」。
   *
   * 判据是**错误正文里的业务码**（网关的业务失败也是 HTTP 200，所以只能看
   * 正文）。⚠ 网络错误 / 超时 / 5xx **不在此列**：把网络抖动当成登录失效，
   * 会把一批健康账号打成「需要重登」。
   *
   * @param {any} err
   * @returns {boolean}
   */
  function isSessionDead(err) {
    const msg = String(err?.message ?? err ?? "")
    if (SESSION_DEAD_CODES.some((c) => msg.includes(c))) return true
    return SESSION_DEAD_TEXT.some((t) => msg.includes(t))
  }

  /**
   * 登录失效时的返回形状：**故意**占用 `error`。
   *
   * AGENTS.md 坑 #17 说 `error` 会整块替换窗口显示 —— 那正是这里想要的：
   * 号都过期了，捧一份旧额度出来才是误导。但 `error` 里必须写清是**登录**问题，
   * 否则用户会以为插件坏了（"查额度失败" 和 "请重新登录" 是两种心情）。
   *
   * @returns {{error: string, signIn: string, windows: never[]}}
   */
  function expiredResult() {
    return { error: "登录已失效（session 过期，请在插件里重新登录）", signIn: SIGN_IN_EXPIRED, windows: [] }
  }

  /**
   * 给「被限制 / 登录失效」的账号插一条**纯展示**的说明窗。
   *
   * # 为什么是 `aside: true`，而**不是** `used: 100`
   *
   * 「别把请求派给我」这件事已经由 `src/hooks/models.mjs` 承担：routed /
   * expired 账号的 `provider.models` 返回**空目录** ⇒ 这个号没有该模型 ⇒
   * magpie 天生不派活，且不产生任何错误、不触发换号、不触发禁用。
   *
   * 既然排除已经成立，再报 100% 额度就是**多此一举且有害**：卡片会显示
   * 「剩余 0」，用户以为这个号没额度了（真机上就是这么被误读的）。
   *
   * `aside: true` 的语义正好吻合：`allowanceOf` 会整条跳过这种窗口 ——
   * 不参与路由排序，只作为卡片上的说明文字（`display`）。
   *
   * # 两种结论，两种表达
   *
   *	routed   → 说明窗「说明 · 上游限制」；**不带** `signIn`
   *	           （改路由不是登录问题，带 `signIn` 会把号误标成过期）
   *	expired  → 说明窗「说明 · 登录失效」+ 顶层 `signIn: "expired"`
   *
   * # ⚠ 三条不要碰的东西
   *
   *	① **不要补 `used`**：一旦带上 `used`，它就会进额度排序；想靠它「打满额度」
   *	   就等于伪造「这个号没额度了」。
   *	② **不要加 `amount` / `limit`**：会被算成真额度占比，显示成奇怪百分比。
   *	③ 顶层**绝不**为本说明写 `error`（AGENTS.md 坑 #17）—— 唯一的例外是
   *	   登录失效那一条 `signIn=expired`（它写的是登录问题本身，不是附加信息）。
   *
   * 没有判定（模块缺失 / 凭证里一个键都没有 / 判定不是 routed/expired）时
   * **原样返回**：多一条窗口就等于给所有账号一起贴了标签。
   *
   * @param {any} result usageFromPoints 的产出（或错误形状）
   * @param {any} auth
   * @param {{available?: number, availableKnown?: boolean, permanent?: number,
   *   permanentKnown?: boolean, daily?: number, dailyKnown?: boolean}} [points]
   *   账本快照（**只有面板刷新那条路**才会传；`auth.usage` 读缓存时不传 —— 
   *   缓存里已经是算好的窗口，再拿它反推「余额为 0」等于二次解释）。
   * @returns {Promise<any>}
   */
  /**
   * 余额够不够跑一次请求（用于**路由**，不是展示）。
   *
   * # 为什么这件事不能等 patrol 的判定
   *
   * 真机：账号调上游直接 402「团队积分余额不足」，而 magpie 的 `quotas.json`
   * 里这个号的 `windows = null`（一条额度都没有）→ 路由把「没有任何额度窗口
   * 的号」当成可用 → 派活 → 402 → 换号 → 又慢又乱。
   *
   * 路由**只看 `windows[].used`**。所以余额为 0 时必须自己报一条满额窗口，
   * 而不是指望状态文件先把它判成 `exhausted`。
   *
   * # 三态
   *
   *	已知有余额  → `known && total > 0`  → 不动
   *	已知为 0    → `known && total <= 0` → 报满额
   *	真的不知道  → `known === false`     → 不动（不把未知说成 0）
   *
   * @param {any} points `fetchPointsSnapshot` 的产出（或本机缓存换算的那个对象）
   * @returns {{known: boolean, total: number}}
   */
  function budgetOf(points) {
    const avail = points?.available
    // `availableKnown: false` = 调用方明说「这个数不可信」（本机缓存缺 balance）
    const availableExplicit =
      points?.availableKnown !== false && avail !== null && avail !== undefined && Number.isFinite(Number(avail))
    const bothKnown = points?.permanentKnown === true && points?.dailyKnown === true
    if (availableExplicit) return { known: true, total: Number(avail) }
    if (bothKnown) return { known: true, total: (Number(points.permanent) || 0) + (Number(points.daily) || 0) }
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
   *	routed     aside 说明窗「说明 · 上游限制」；**不带** `signIn`
   *	expired    aside 说明窗「说明 · 登录失效」+ 顶层 `signIn: "expired"`
   *	exhausted  aside 说明窗「说明 · 余额为零」+ 停用窗「停用 · 积分不足」；**不带** `signIn`
   *
   * 另外**不论判定如何**，只要账本显示余额 <= 0 就补那条满额窗口（真实请求
   * 会 402，拦它的唯一手段就是让路由看到满额）。两条触发条件合并成一条窗口，
   * 绝不出现两个「积分不足」。
   *
   * @param {any} result usageFromPoints 的产出（或错误形状）
   * @param {any} auth
   * @param {any} [points] 账本快照（**只有面板刷新那条路**会传；`auth.usage`
   *   读缓存时不存在 —— 那时 `budgetOf` 走「真的不知道 → 不动」那一档）
   * @returns {Promise<any>}
   */
  async function withRouteWindow(result, auth, points) {
    // 网关错误形状交给调用方处理（登录失效那边有自己的判据），这里不碰
    if (!result || result.error !== undefined) return result
    if (!Array.isArray(result.windows)) return result

    const keys = accountKeys(auth)
    // ⚠ 必须用 accountKeys()（身份优先、显示名兜底）：状态文件按 uid 落盘，
    // 只查一个键会永远 miss —— 那正是「窗口插不出来」的那次线上故障。
    const hit = keys.length > 0 ? await accountRoute(configDir, keys, { routeStore: storeOpt }) : null
    const verdict = hit?.entry?.verdict
    const key = hit?.key ?? keys[0] ?? "?"

    const { known, total } = budgetOf(points)
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
      // 真机痛点：`provider.models` 是列表缓存 —— 判定翻成 routed 之后要等下一次
      // 重拉列表才不派活，中间仍会把请求给它。`auth.usage` 每次读都生效，所以这里
      // 补一条 `used:100` 的满额窗：下一次读 usage，路由就跳过这个号。
      //
      // ⚠ 不是 aside（aside 会被 allowanceOf 整条跳过）；也不要 amount/limit
      //   （那会被反算成百分比）。说明窗照旧保留，用于卡片上解释原因。
      // ⚠ 这条是 loomy **唯一**让路由跳过该号的手段 —— 绝不能被改成 aside。
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
    // 既不能永久跳过（那等于把好号封了），也不能什么都不做（宿主会立刻重试，
    // 限流雪上加霜）。所以给一条**带 `resetsAt`** 的满额窗：magpie 到期自动恢复。
    //
    // ⚠ 必须 `used:100` 且**不带** `aside`（aside 会被 allowanceOf 整条跳过）。
    // ⚠ 冷却记录在 loader 进程内存里，到期即失效 —— 不需要外部清理。
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
    // ⚠ 这是本文件唯一「主动触发现有数据之外的东西」的地方，理由见
    // `SIGN_IN_KEPT` 的注释。三条纪律：
    //
    //	① 只在**变化那一刻**加一次（否则宿主反复重读，性能灾难）
    //	② `expired` 优先：它要用户重登，语义不同，不能用 kept 糊过去
    //	③ 窗口本身**不依赖**宿主是否重读 —— 新判定必须立刻生效
    // 进程**首次**给某个号出结论时也要发光一次：宿主此刻还没读过这个号的
    // models（或读的还是「导入时的旧列表」），正是需要重读的时候。
    // 进程重启后基线为空 —— 这时 magpie 本来就会重新列表，多发光一次也无害。
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
      // 没有需要补的窗口时也要把 kept 带出去（判定从 clean → 「无判定」、
      // 或变化但不需要说明窗的情形）
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
      return await withRouteWindow(usageFromPoints(points), auth, points)
    } catch (e) {
      log.warn?.(`loomy: 积分网关查额度失败，尝试本机缓存: ${e?.message ?? e}`)

      // ── ⚠ 登录失效**不能**回落缓存 ──
      //
      // 100002 / 100003 是网关在说「这个 session 死了」，不是「网关抖了一下」。
      // 回落到本机缓存会捧出一份**正常的旧额度**，于是 magpie 认为号还活着、
      // 界面上也看不出异常（真机就是这样：用户看到「27 个可用」里混着死号）。
      // 这里故意占用 `error`（AGENTS.md 坑 #17）：号都过期了，「只剩一句话」
      // 才是正确表达；但话里必须写清是**登录**问题。
      if (isSessionDead(e)) {
        try {
          log.warn?.("loomy: 积分网关说 session 已失效，标记 signIn=expired（不回落缓存）")
        } catch {
          /* 日志失败不是业务失败 */
        }
        return expiredResult()
      }
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
      const points = {
        available: cached.balanceKnown ? cached.balance : 0,
        // ⚠ 缓存里没有 balance 时，那个 0 是**占位**不是事实：标出来，
        // 否则 budgetOf 会把「未知」当成「余额为 0」→ 误报满额。
        availableKnown: cached.balanceKnown,
        daily: cached.dailyBalance,
        dailyKnown: cached.dailyKnown,
        permanent: cached.balance,
        permanentKnown: cached.balanceKnown,
      }
      const result = usageFromPoints(points, { source: "cache", updatedAt: cached.updatedAt })
      return await withRouteWindow(result, auth, points)
    } catch (e) {
      return { error: `查额度失败: ${e?.message ?? e}` }
    }
  }
}

