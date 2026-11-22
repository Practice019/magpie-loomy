// rate-gate.mjs 进程级的上游调用令牌桶 —— **防止意外爆发**，不是替用户限速。
//
// # 它为什么存在
//
// 用户的原话是「Loomy 每次启动都会遍历 300 多个号去打上游，一定不可以这样」。
// 治本的那一刀在 `src/hooks/usage.mjs`（`auth.usage` 零上游，只读缓存）。
// 但「usage 不打了」不等于「以后不会有别的路径打」：面板、签到、任务、
// 未来新增的钩子都能发上游请求。所以再补一道**进程级总闸**：
//
//	真实用户动作（面板刷新额度 / 刷新任务 / 绑定邀请码 / 路由检测）→ 先过闸
//	`auth.usage` 读缓存                                            → 不消耗令牌
//
// # ⚠ 它**不是**并发上限，容量跟着设置走
//
// 用户明确要求：「并发你不需要限制，就是用户想在设置里面调多少就调多少」。
// 所以 `capacity` 默认取自面板设置 `balanceConcurrency`（默认 20），
// **不写死 3**、**不写死 6**：用户把并发调到 15，闸的容量也应该是 15，
// 否则闸就成了偷偷截断用户输入的上限。它的作用是「防意外爆发」（比如某个
// 新代码路径循环里连打 300 次），而不是给正常用量设上限。
//
// # 补桶语义：**按窗口补满**，不是「每个间隔补 1 个」
//
// 这里曾经写成「每 `refillMs` 补 1 个令牌」。那是错的 —— 容量 20、间隔 500ms 时
// 持续速率被压到 2 次/秒，于是「用户设了 20 并发、刷 300 个号」要跑 150 秒，
// 闸变成了**比用户设置更严的限速器**，正好违背「并发随用户调」这条要求。
//
// 现在的语义是：每过一个 `refillMs` 窗口，令牌**补满到容量**。于是
//
//	· 一波突发（≤ 容量）立刻放行 = 用户设的并发
//	· 持续吞吐 ≈ 容量 / 窗口 = 用户配置能承受的量级，闸不会成为瓶颈
//	· 真正异常的「循环里连打几百次」仍会被摊平（每个窗口最多 容量 个）
//
// 这仍然是一个可观测、可等待的闸，只是它**永远不会比用户设置更严**。
//
// # 可观测
//
// `waiting` 暴露到 `/api/hello` 的 `gate: { waiting, capacity }`：
// 排障时一眼看出「是不是闸在排队，还是上游本身慢」。
// ⚠ `waiting` 只统计**当前真的在排队**的 acquire 数；计数必须精确归零，
// 否则诊断字段会永远漂着（见 `release()` 的 finally）。

/** 默认容量 = 面板设置 `balanceConcurrency` 的默认值（见 server.mjs）。 */
export const RATE_GATE_CAPACITY = 20

/** 默认补充间隔（毫秒）：每这么久补 1 个令牌。 */
export const RATE_GATE_REFILL_MS = 500

/**
 * 造一个令牌桶。
 *
 * @param {{capacity?: number, refillMs?: number, now?: () => number,
 *   setTimeoutImpl?: Function}} [opts]
 *   `capacity` 容量（≤0 或非整数时回落默认值）；
 *   `refillMs`  每补 1 个令牌的间隔（0 / 负数时回落默认值，**不允许**「无限令牌」）；
 *   `now` / `setTimeoutImpl` 仅测试注入。
 * @returns {{acquire: () => Promise<void>, waiting: () => number, capacity: () => number,
 *   refillMs: () => number, snapshot: () => {waiting: number, capacity: number}}}
 */
export function makeRateGate(opts = {}) {
  const cap = Number.isInteger(opts.capacity) && opts.capacity > 0 ? opts.capacity : RATE_GATE_CAPACITY
  const refillMs = Number(opts.refillMs) > 0 ? Number(opts.refillMs) : RATE_GATE_REFILL_MS
  const now = typeof opts.now === "function" ? opts.now : () => Date.now()
  const setTimer = typeof opts.setTimeoutImpl === "function" ? opts.setTimeoutImpl : setTimeout

  /** 当前可用令牌数（启动时给满）。 */
  let tokens = cap
  /** 连续补桶：`<= now` 就累加（按经过的时间折算，不是定时器心跳）。 */
  let lastRefill = now()
  /** 正在排队的 acquire 数（诊断用）。 */
  let waiting = 0
  /** 是否有补桶定时器在跑（同一时刻最多一个）。 */
  let timerOn = false
  /** 排队中的唤醒器（FIFO）。 */
  const queues = []

  /** 按经过时间补令牌：每过一个窗口就**补满**（上限 = 容量）。 */
  function refill() {
    const at = now()
    if (at - lastRefill < refillMs) return
    // 窗口语义：一个窗口最多放行 `cap` 个。不按「每间隔 +1」累加 —— 那会把
    // 持续速率压到 1/refillMs，等于替用户限速（见文件头的说明）。
    lastRefill = at
    tokens = cap
  }

  /**
   * 补桶节拍器：只在**有人排队**时跑，队列空了就停（不留空转定时器）。
   *
   * 每个节拍先补桶，然后把可用令牌**连续发放**（一次 tick 发多个）——
   * 否则 300 个号的队列会按「每 tick 一个」爬行。
   *
   * 定时器**不能 unref**：它一响就要唤醒正在等待的 acquire()，那个 Promise
   * 只有靠这个定时器才能 resolve。unref 之后，Linux/Node 在没有其它活动句柄
   * 时事件循环会提前结束，等待者永远等不到放行（cancelledByParent，见
   * magpie-officeace/docs/internals.md 的同款事故）。定时器只在有人排队时
   * 存在、队列空即 `return` 停止，不会把进程永久吊住 —— 所以 ref 是安全的。
   */
  function ensureTimer() {
    if (timerOn || waiting === 0) return
    timerOn = true
    const tick = () => {
      refill()
      while (tokens >= 1 && waiting > 0) {
        const next = queues.shift()
        if (!next) break
        waiting -= 1
        tokens -= 1
        next()
      }
      if (waiting === 0) {
        timerOn = false
        return
      }
      // 节拍取 `refillMs` 与 25ms 的较小值：窗口还没到也要醒来看看，
      // 保证「窗口一到就立刻放行」，不会因为定时器粒度多等一个窗口。
      setTimer(tick, Math.min(refillMs, 25))
    }
    setTimer(tick, Math.min(refillMs, 25))
  }

  /**
   * 取一个令牌；没有就排队等。
   *
   * 返回的 Promise 只在**拿到令牌之后**才 resolve ⇒ 调用方拿到就代表「可以发请求了」。
   * 队列长度在 `waiting()` 里可见。
   *
   * @returns {Promise<void>}
   */
  function acquire() {
    refill()
    if (tokens >= 1 && waiting === 0) {
      // 先到先得：没人排队时立刻放行
      tokens -= 1
      return Promise.resolve()
    }
    waiting += 1
    const promise = new Promise((resolve) => {
      queues.push(() => resolve())
    })
    ensureTimer()
    return promise
  }

  return {
    acquire,
    waiting: () => waiting,
    capacity: () => cap,
    refillMs: () => refillMs,
    snapshot: () => ({ waiting, capacity: cap }),
  }
}

/**
 * 进程级单例：**整个面板服务**共用一个桶。
 *
 * # 为什么是单例而不是每个 job 一个
 *
 * 「防止意外爆发」针对的是**进程**，不是某个 job。三个刷新任务并发跑时，
 * 若每个 job 各自一个容量 20 的桶，实际同时飞出去的就是 60 个。
 * 单例才真的封顶。
 *
 * # 容量为何要能跟着设置变
 *
 * 用户在设置里把并发调到 15，闸的容量也得是 15（否则就是偷偷限速）。
 * `configure()` 只改参数，**不丢队列**：正在排队的调用继续等，只是新参数生效。
 */
let sharedGate = null

/**
 * 取（或按新参数重建）进程级令牌桶。
 *
 * @param {{capacity?: number, refillMs?: number}} [opts]
 * @returns {ReturnType<typeof makeRateGate>}
 */
export function sharedRateGate(opts = {}) {
  const capacity = Number.isInteger(opts.capacity) && opts.capacity > 0 ? opts.capacity : RATE_GATE_CAPACITY
  const refillMs = Number(opts.refillMs) > 0 ? Number(opts.refillMs) : RATE_GATE_REFILL_MS
  if (!sharedGate) {
    sharedGate = makeRateGate({ capacity, refillMs })
    return sharedGate
  }
  // 容量 / 间隔没变就复用（保留已积累的令牌与排队状态）
  if (sharedGate.capacity() === capacity && sharedGate.refillMs() === refillMs) return sharedGate
  // ⚠ 参数变了才重建：**重建不等于放宽**，新容量就是新上限。
  //    这里刻意重建而不是原地改参：原地改容量要处理「已排队 + 令牌 > 新容量」的边界，
  //    代价大于收益；重建的代价只是攒下的令牌作废（下一波靠补桶）。
  sharedGate = makeRateGate({ capacity, refillMs })
  return sharedGate
}

/** 清空单例（测试隔离用；生产不需要）。 */
export function resetSharedRateGate() {
  sharedGate = null
}