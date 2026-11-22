// speed.mjs 速率分档 —— **纯计算，零请求、零文件**。
//
// # 数据从哪来（用户拍板的唯一来源）
//
//	magpie 自己记的逐次请求：`GET http://<gateway>/v1/magpie/usage/requests`
//
// 一行一次真实调用，含 `out`（输出 token）、`flow_ms`（**首字之后的**流动耗时）、
// `providerAccount`、`model`、`status`。所以速率不需要我们自己去打上游测 ——
// 那是「用真实 session 打真上游」，会耗积分、会触发风控（见 models-cache.mjs 的掉号事故）。
//
// 真实样本（2026-11-22 实测）：
//
//	{"provider":"loomy","providerAccount":"16540492083",
//	 "model":"deepseek-v4-flash-1017","out":2067,"flow_ms":17118,
//	 "ttft_ms":12744,"status":200}
//
// # 口径（三条，缺一条就会算错）
//
//	单次速率 = out / (flow_ms / 1000)              单位 tok/s
//	A（账号级）= Σout / Σ(秒)                      **不是**「每次速率再平均」
//	B（模型级）= 同一模型下所有账号 A 的**中位数**
//
// # 为什么 A 必须是 sum/sum
//
// 「每次速率再平均」会给每一次调用相同的权重：一段 20 秒的慢请求与一段 1 秒的
// 快请求权重一样。sum/sum 是 token 加权的真实吞吐（这也是上游账本的算法）。
//
// # 为什么 B 取中位数而不是平均
//
// 同一个模型下 52 个号（实测 loomy/deepseek-v4-flash-1017）里个别号的 A 会离群
// （刚被限速、刚好在跑长上下文）。平均值会被一两个离群号拉偏，中位数不会。
//
// # 为什么判定看**最近一次**，而不是平均
//
// 突发限速是阶跃的：20 次 130 tok/s 之后突然掉到 25 tok/s，**平均值**仍然是
// ≈125（落在正常区间），而用户体感已经是「这个号废了」。所以：
//
//	最近一次速率 < B × SLOW_RATIO ⇒ slow
//
// `tests/speed.test.mjs` 里有一条专门钉这个差别的用例（20×130 + 1×25）。
//
// # 唯一必要的过滤
//
//	out > 0 && flow_ms > 0 && 状态正常
//
// 这是**数学必要条件**（分母为零算不出速率），不是「经验阈值」。**刻意不加**
// `MIN_TOKENS` / `MIN_CALLS` 之类的门槛：实测 loomy 的真实请求里没有 out<8 的样本
// （可算速率的最小 out=44、最低 17.3 tok/s），magpie 自己已经把 out=0 的排除在
// 速度表外。多一道门槛只会把真实样本误杀。
//
// # 实测：`flow_ms` 极小值的那批行 —— **知道它，且（当前）决定不加下限**
//
// 现网 1000 行样本里有 28 行的速率 > 2000 tok/s，最大的离谱值来自 `flow_ms` 只有
// 1 ms 的行：
//
//	{"providerAccount":"13151743953","out":94, "flow_ms":1,"status":200}  → 94,000 tok/s
//	{"providerAccount":"16533926250","out":2,  "flow_ms":1,"status":200}  → 2,000 tok/s
//
// 也就是说 `flow_ms` 不是「模型吐字耗时」的干净度量：短回复被上游整块下发时，
// 这个窗口会小到 1 ms，速率就爆表。
//
// **为什么仍然不加 `flow_ms` 下限**：
//
//	① 对**单行**判定，偏差方向只有一个 —— 虚高。它绝不可能把一个快号单独算成慢号。
//	② 用户拍板的口径就是「`out>0 && flow_ms>0` 是唯一必要过滤」；每加一条下限都是
//	   一个以后说不清来源的魔数。
//
// ⚠ 后果：该号「最后一次调用恰好是这种 1 ms 行」时会被算成 normal 而不是它的真实速度
//   （方向是虚高，留号，不会误踢）。
//
// # ⚠⚠ 但 B 的稳健性是**有条件的**（别把 ① 推广成「B 永远没事」）
//
// 中位数只挡得住**少数**离群值。当某个模型里这种 1 ms 行占了半数以上时，B 本身
// 就被污染了 —— 这不是理论：2026-11-22 用 7d 全量（1456 行）算出来
//
//	deepseek-v4-flash-1017  96 个号，B = 252.6   ← 正常（参考值 ≈126–250，量级对）
//	DeepSeek-V4.1-Flash     34 个号，B = 48000   ← **被劫持**：其中 16 个号的 A > 2000
//
// B 被抬高后阈值也跟着抬高（48000×0.7），于是「最后一次是正常速度」的号被判 slow。
// 目前的兜底只有 `MIN_FAST`：一个模型**所有**号都 slow 时谁也不让位（模型照旧全部
// 上报）；但只要还有 1 个 normal，被判 slow 的那些号就会**丢掉这个模型** ——
// 实测那天 DeepSeek-V4.1-Flash 上有 4 个号属于这种情况（14 normal / 4 slow / 16 unknown）。
//
// 想彻底修掉，最小的口子是给 B 加一条**物理上限**（真实解码速率峰值约 300–500 tok/s，
// `B > B_MAX` 时视为无参考 ⇒ 该模型全员 unknown ⇒ 不跳过），这样不用改任何行级
// 过滤、也不用动这里已经拍板的口径。**用户已批准并落地**（见下面的 `B_MAX`）。

/** 判定阈值：最近一次速率 < B × SLOW_RATIO ⇒ slow。 */
export const SLOW_RATIO = 0.7

/** 超过这么多天没有新记录 ⇒ unknown（自动回到候选，不被旧结论钉死）。 */
export const STALE_DAYS = 3

/**
 * 该模型下至少还有几个**非 slow**账号，才把慢号的这个模型摘掉。
 *
 * 1 = 「还有别人能接活就让位」；全都慢就谁也不许让（否则这个模型整体消失）。
 */
export const MIN_FAST = 1

/**
 * B 的**物理上限**（tok/s）：真实解码峰值约 300–500 tok/s。
 *
 * 中位数越过这个量级，说明这个模型的样本被 `flow_ms` ≈ 1ms 的行**污染**了 ——
 * 它反映的是 magpie 侧的计时粒度，不是模型速度。此时 B 不能当基准：
 * 按「最近一次 < B × 0.7」去判，会让一批**实际上正常**的号被判 slow 并丢掉整个模型。
 *
 * `b = null` ⇒ 该模型所有账号 `classify` 返回 `unknown` ⇒ **一个都不跳过**
 * （`MIN_FAST` 那条路径自然也就不触发）。宁可少让位，也不许按错误的基准错踢。
 *
 * # 实测依据（2026-11-22，7d 全量 1456 行）
 *
 *	deepseek-v4-flash-1017   96 个号   B = 252.6    正常（参考值 ≈126–250，量级一致）
 *	DeepSeek-V4.1-Flash      34 个号   B = 48000    **被劫持**：其中 16 个号的 A > 2000
 *
 * 同一份数据里 `deepseek-v4-flash-1017` 的 B 落在正常区间，正是「有污染 / 没污染」
 * 两条路径的对照 —— 这也是为什么阈值取在 1000：真实速率够不到，污染样本远高于它。
 * 边界是**包含**的（`B === B_MAX` 仍参与判定），只有真正越过才算无参考。
 */
export const B_MAX = 1000

/** 一天的毫秒数（`STALE_DAYS` 的单位）。 */
const DAY_MS = 86_400_000

/**
 * 单次请求的速率（tok/s）；算不出来返回 `null`（**不是 0**）。
 *
 * `null` 与 `0` 的区别很重要：`0` 会被当成「极慢」从而判成 slow，
 * 而「算不出来」应该让结论退回 unknown。
 *
 * @param {any} row usage/requests 的一行
 * @returns {number|null}
 */
export function speedOfRow(row) {
  const out = Number(row?.out)
  const flow = Number(row?.flow_ms)
  // ⚠ 用 `> 0` 而不是 `>= 0`：分母为零的两个方向（flow_ms=0）与分子为零
  //   （out=0，实测 100 条里有 5 条，都是被取消的请求）都属于「算不出」。
  if (!Number.isFinite(out) || out <= 0) return null
  if (!Number.isFinite(flow) || flow <= 0) return null
  const speed = out / (flow / 1000)
  return Number.isFinite(speed) && speed > 0 ? speed : null
}

/**
 * 这一行是否「状态正常」（可以进速度表）。
 *
 * 实测同一份数据里有 `status: 499`（agent 取消）的行：它带 `out`/`flow_ms`，
 * 但耗时是「用户点了停止」而不是模型吐字，算进速率会把结果拉偏。
 *
 * 判据：
 *
 *	字段缺失 / 空串          → 正常（老数据可能没有这个字段，不该整表作废）
 *	非数值（"ok" 之类）      → 正常（认不出就不敢判坏）
 *	200–299                  → 正常
 *	其它（0 / 4xx / 5xx）    → 不正常
 *
 * @param {any} row
 * @returns {boolean}
 */
export function statusOk(row) {
  const raw = row?.status
  if (raw === undefined || raw === null || raw === "") return true
  const n = Number(raw)
  if (!Number.isFinite(n)) return true
  return n >= 200 && n < 300
}

/**
 * 行的时间戳（毫秒）。认 `t`（RFC3339）与 `at` / `ts`（毫秒数）。
 *
 * 认不出返回 `null` —— 调用方据此把这行排除在「最近一次」的比较之外，
 * 但**不影响** A 的计算（A 只看 out 与 flow_ms）。
 *
 * @param {any} row
 * @returns {number|null}
 */
export function rowTimeMs(row) {
  for (const raw of [row?.t, row?.at, row?.ts]) {
    if (raw === undefined || raw === null || raw === "") continue
    if (typeof raw === "number" && Number.isFinite(raw)) return raw
    const parsed = Date.parse(String(raw))
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * 中位数。偶数取中间两个的平均，空数组（或全是非数值）返回 `null`。
 *
 * @param {any[]} nums
 * @returns {number|null}
 */
export function median(nums) {
  const list = (Array.isArray(nums) ? nums : []).filter((n) => typeof n === "number" && Number.isFinite(n))
  if (list.length === 0) return null
  const sorted = [...list].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 一组请求的账号级速率 A = Σout / Σ(秒)。
 *
 * @param {any[]} rows 同一 (账号, 模型) 的行
 * @returns {number|null} 没有可算的行 ⇒ null（**不是 0**）
 */
export function accountAverage(rows) {
  let tokens = 0
  let seconds = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!statusOk(row)) continue
    const out = Number(row?.out)
    const flow = Number(row?.flow_ms)
    if (!Number.isFinite(out) || out <= 0) continue
    if (!Number.isFinite(flow) || flow <= 0) continue
    tokens += out
    seconds += flow / 1000
  }
  if (!(seconds > 0)) return null
  return tokens / seconds
}

/**
 * 分档：`"normal"` / `"slow"` / `"unknown"`。
 *
 * # 入参两种形态都吃
 *
 *	原始行        `{out, flow_ms, t}`                —— 现算速率与时间
 *	归一后的条目  `{lastSpeed, lastAt}`              —— 直接用（buildSpeedTable 的产物）
 *
 * # unknown 的三种来源（都必须退回候选，绝不当成「慢」）
 *
 *	① 没有最近记录（`lastRow` 为 null）
 *	② 最近记录早于 `STALE_DAYS`（超过 3 天没新数据 = 不知道现在怎么样）
 *	③ `b` 为 null（这个模型还没有中位数：只有一个号或全都算不出）
 *
 * @param {any} lastRow 该 (账号, 模型) 的**最近一次**可用请求
 * @param {number|null} b 该模型的中位数 B
 * @param {number} now 当前时刻（毫秒；测试注入）
 * @returns {"normal"|"slow"|"unknown"}
 */
export function classify(lastRow, b, now) {
  const current = Number.isFinite(Number(b)) && Number(b) > 0 ? Number(b) : null
  if (!lastRow || current === null) return "unknown"

  const speed = Number.isFinite(Number(lastRow.lastSpeed)) && lastRow.lastSpeed !== null
    ? Number(lastRow.lastSpeed)
    : speedOfRow(lastRow)
  if (speed === null || !Number.isFinite(speed)) return "unknown"

  const rawAt = Number.isFinite(Number(lastRow.lastAt)) && lastRow.lastAt !== null
    ? Number(lastRow.lastAt)
    : rowTimeMs(lastRow)
  if (!Number.isFinite(rawAt) || rawAt <= 0) return "unknown"

  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  // 时钟漂移（记录比 now 还新）不算过期：`? :` 而不是 `abs()`
  if (nowMs - rawAt > STALE_DAYS * DAY_MS) return "unknown"

  return speed >= current * SLOW_RATIO ? "normal" : "slow"
}

/**
 * 由一行行 usage/requests 构建整张速度表。
 *
 * # 返回形状
 *
 *	{
 *	  updatedAt: <毫秒>,
 *	  b:         { <model>: <中位数 tok/s> },
 *	  accounts:  {
 *	    "<model>|<account>": { model, account, lastSpeed, lastAt, avgSpeed, calls, verdict }
 *	  }
 *	}
 *
 * ⚠ `b` 里**只放能当基准的模型**：中位数越过 {@link B_MAX} 的模型（样本被
 * `flow_ms≈1ms` 的行污染）**不会出现**，它在 `accounts` 里的条目一律是 `unknown`。
 * 所以「`b` 里没有这个模型」是正常结论，不是漏算。
 *
 * 键是 `模型|账号`（账号 = 行里的 `providerAccount`，见 models.mjs 的对齐说明）。
 * 模型 id 直接用行里的 `model` —— 实测它就是上游目录的 id
 * （`deepseek-v4-flash-1017` / `DeepSeek-V4.1-Flash`），与 `provider.models` 的键同源。
 *
 * # `calls`
 *
 * 参与计算的行数（`out>0 && flow_ms>0 && 状态正常`），也就是 `avgSpeed` 的样本量。
 * 被过滤掉的行不计入 —— 否则面板上的「调用次数」会包含取消掉的请求。
 *
 * @param {any[]} rows
 * @param {{now?: number}} [opts]
 * @returns {{updatedAt: number, b: Record<string, number>, accounts: Record<string, {
 *   model: string, account: string, lastSpeed: number|null, lastAt: number,
 *   avgSpeed: number|null, calls: number, verdict: "normal"|"slow"|"unknown"}>}}
 */
export function buildSpeedTable(rows, opts = {}) {
  const now = Number.isFinite(Number(opts?.now)) ? Number(opts.now) : Date.now()

  /** @type {Map<string, {model: string, account: string, rows: any[]}>} */
  const groups = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const model = String(row?.model ?? "").trim()
    const account = String(row?.providerAccount ?? row?.account ?? "").trim()
    // 缺模型或缺账号的行无法归组：宁可少一个样本，也不要把它算到谁头上
    if (!model || !account) continue
    const key = `${model}|${account}`
    const hit = groups.get(key)
    if (hit) hit.rows.push(row)
    else groups.set(key, { model, account, rows: [row] })
  }

  /** @type {Array<{model: string, account: string, lastSpeed: number|null, lastAt: number, avgSpeed: number|null, calls: number}>} */
  const entries = []
  for (const group of groups.values()) {
    const usable = group.rows.filter((row) => statusOk(row) && speedOfRow(row) !== null)
    let lastRow = null
    let lastAt = 0
    for (const row of usable) {
      const time = rowTimeMs(row)
      if (time === null) continue
      if (!lastRow || time >= lastAt) {
        lastRow = row
        lastAt = time
      }
    }
    entries.push({
      model: group.model,
      account: group.account,
      lastSpeed: speedOfRow(lastRow),
      lastAt,
      avgSpeed: accountAverage(group.rows),
      calls: usable.length,
    })
  }

  // B：每个模型下所有账号 A 的中位数。**算不出 A 的账号不参与**
  // （把它们当 0 会把中位数整体拉低，于是所有正常号都被判成 normal）。
  //
  // ⚠ 算完之后还要过一道 `B_MAX`（见常量注释）：中位数只挡得住**少数**离群值，
  //   当某个模型里 `flow_ms≈1ms` 的行过半时，B 本身会被抬到 48000 这种量级。
  //   越过上限 ⇒ 当作「这个模型没有可用基准」（**不出现在 b 里**）⇒ 所有账号
  //   `classify` 拿到 null ⇒ 全员 unknown ⇒ 一个都不跳过。
  /** @type {Map<string, number[]>} */
  const perModel = new Map()
  for (const entry of entries) {
    if (entry.avgSpeed === null) continue
    const list = perModel.get(entry.model)
    if (list) list.push(entry.avgSpeed)
    else perModel.set(entry.model, [entry.avgSpeed])
  }
  /** @type {Record<string, number>} */
  const b = {}
  for (const [model, list] of perModel) {
    const raw = median(list)
    // 边界包含：恰好在 B_MAX 上仍然算有效基准
    if (raw !== null && raw <= B_MAX) b[model] = raw
  }

  /** @type {Record<string, any>} */
  const accounts = {}
  for (const entry of entries) {
    accounts[`${entry.model}|${entry.account}`] = {
      ...entry,
      verdict: classify({ lastSpeed: entry.lastSpeed, lastAt: entry.lastAt }, b[entry.model] ?? null, now),
    }
  }

  return { updatedAt: now, b, accounts }
}
