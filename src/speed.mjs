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
// # 行级物理过滤（第一道闸门，T-63）
//
//	能算出速率（out>0 && flow_ms>0） && flow_ms >= MIN_FLOW_MS && 单行速率 <= MAX_ROW_SPEED
//
// 三条都是**物理判据**，不是「经验阈值」：
//
//	· out>0 && flow_ms>0   数学必要条件（分母为零算不出速率）
//	· flow_ms >= 20 ms     20 ms 内解不出有意义的内容
//	· 速率 <= 1000 tok/s    真实解码峰值 300–500 tok/s，1000 已是保守上限
//
// # 为什么必须加这道过滤（实测 2026-11-22，7d 全量）
//
// `rows=100` 翻页取到 **1473 行**，其中 out>0 && flow_ms>0 的 **1273 行**、**101 个账号**：
//
//	magpie 的 usage/requests 里有 `flow_ms = 1` 的行：
//	  {"providerAccount":"13151743953","out":129,"flow_ms":1,"status":200}  → 129 000 tok/s
//
// 这**不是「短请求」**，是 magpie 记成了 1 ms —— 物理上不可能。
//
// 污染机制：A 是 `sum(out)/sum(flow_ms)`，异常行只往分子加 out、分母加 1 ms
// （≈ 不变）⇒ A 被大幅抬高 ⇒ B（中位数）被抬高 ⇒ 判定线 `B × 0.7` 抬高
// ⇒ **真实 100 tok/s 的正常号被判 slow 误杀**。
//
// 同一份数据，原 vs 清洗后（B，tok/s）：
//
//	deepseek-v4-flash-1017   B(原)=262.9   B(清洗)=124.7    ← 差 2.1 倍
//	DeepSeek-V4.1-Flash      B(原)=48000   B(清洗)=56.2     ← 差 850 倍
//	auto                     B(原)=168.3   B(清洗)=168.3    ← 无污染的行，不受影响
//
// 阈值也从 87.3 抬到 184（flash 的 B×0.7），而真实 100 tok/s 的号正好落在中间 ⇒ 被误杀。
//
// **含异常行的账号：78 / 101** —— 绝大多数账号都被污染，所以不能只靠 B 的中位数/上限兜底，
// 必须在**行级**先把这些行剔掉。三个典型污染样本：
//
//	13151743953  n=2  anom=2   A=79333  →  清洗后：无有效行（⇒ unknown）
//	17032663282  n=22 anom=4   A=206.7  →  清洗后：160.4
//	16540499742  n=22 anom=3   A=236.0  →  清洗后：205.0
//
// 单次 `lastSpeed` 被污染的例子（危害最大 —— 直接判这一个号）：
//
//	16582482173  calls=42  avg=117.3（完全正常）  但 lastSpeed=19985
//
// ⇒ 所以 `lastSpeed` **必须是「最近一条可信行」**，不是「最近一条行」。
//
// # 行级过滤与 `B_MAX` 的分工
//
//	第一道：`usableRow`  —— 该行的数据本身物理上不成立，直接不进任何 sum/sum 与 lastSpeed
//	第二道：`B_MAX`      —— 万一还有别的异常形态漏过行级判据、把中位数抬高，整模型作废
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
// # 刻意**不加**的门槛
//
// `MIN_TOKENS` / `MIN_CALLS` 之类的样本量门槛：实测 loomy 的真实请求里没有 out<8 的样本
// （可算速率的最小 out=44、最低 17.3 tok/s），magpie 自己已经把 out=0 的排除在速度表外。
// 多一道样本量门槛只会把真实样本误杀。行级过滤的三条都是**物理不可能**才拦，同理。

/**
 * 解码耗时下限（ms）：**20 ms 内解不出有意义的内容**。
 *
 * magpie 的 `usage/requests` 里有 `flow_ms = 1` 的行（实测 `out=129, flow_ms=1`
 * ⇒ 129 000 tok/s）。这是**计时粒度错误**，不是「短请求」—— 物理上不可能。
 *
 * 实测依据（2026-11-22，7d 全量 `rows=100` 翻页取到 1473 行、有效 1273 行、101 个账号）：
 *
 *	含异常行的账号：78 / 101          ← 绝大多数账号被污染
 *	flash   B(原)=262.9 → B(清洗)=124.7
 *	V4.1    B(原)=48000 → B(清洗)=56.2
 *	auto    B(原)=168.3 → B(清洗)=168.3（无污染，不受影响）
 *
 * 后果：判定线 `B×0.7` 从 87.3 被抬到 184 ⇒ 真实 100 tok/s 的正常号被判 slow 误杀。
 *
 * 所以这批行**不进** `sum(out)/sum(flow_ms)`，也不许当 `lastSpeed`。
 */
export const MIN_FLOW_MS = 20

/**
 * 单行速率的物理上限（tok/s）：真实解码峰值 300–500 tok/s，1000 已是保守上限。
 *
 * 与 {@link MIN_FLOW_MS} 互补：`flow_ms` 未缺失但也没小到 1 ms（比如 5 ms 出 4000 token）
 * 时，靠这条把「速率本身不可能」的行挡掉。边界**包含**（恰 1000 仍可信）。
 */
export const MAX_ROW_SPEED = 1000

/**
 * 判定阈值：最近一次速率 < B × SLOW_RATIO ⇒ slow。
 */
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
 * B 的**物理上限**（tok/s）：真实解码峰值约 300–500 tok/s —— **第二道保险**。
 *
 * # 分工
 *
 *	第一道：{@link usableRow} —— 行级过滤（`flow_ms >= 20` 且 `单行速率 <= 1000`）。
 *	         实测污染的账号是 78/101，靠中位数挡不住，必须在行级剔掉。
 *	第二道：`B_MAX`          —— 万一还有别的异常形态漏过行级判据、把中位数抬到
 *	         物理不可能的量级，就整模型作废：`b = null` ⇒ 全员 `unknown` ⇒ 一个都不跳过
 *	         （`MIN_FAST` 那条路径自然也就不触发）。
 *
 * 宁可少让位，也不许按错误的基准错踢。
 *
 * # 实测依据（2026-11-22，7d 全量 1473 行）
 *
 *	deepseek-v4-flash-1017   B(原)=262.9   B(清洗)=124.7
 *	DeepSeek-V4.1-Flash      B(原)=48000   B(清洗)=56.2    ← 曾被这条上限整个挡掉
 *
 * 加了行级过滤之后 `DeepSeek-V4.1-Flash` 的 B 回到 56.2，正常参与判定；
 * `B_MAX` 则继续守着「哪天冒出别的异常形态」这一种情况。
 * 阈值取在 1000：真实速率够不到，污染样本远高于它。边界是**包含**的
 * （`B === B_MAX` 仍参与判定），只有真正越过才算无参考。
 */
export const B_MAX = 1000

/** 一天的毫秒数（`STALE_DAYS` 的单位）。 */
const DAY_MS = 86_400_000

/**
 * 一个中位数是否**能当基准**（第二道闸门，见 {@link B_MAX}）。
 *
 * 第一道是 {@link usableRow}（行级）：把 `flow_ms=1` 的行剔掉之后，`A = Σout/Σ秒`
 * 本质上是「逐行速率的耗时加权均值」⇒ 每行都不超过 `MAX_ROW_SPEED` 时 A 也不可能
 * 超过它 ⇒ **正常路径上 B 已经到不了 1000 以上**。这个守卫留给两种例外：
 *
 *	· 缓存里存着旧版本（或人手改过）写进来的越界 b
 *	· 以后出现别的、行级判据没覆盖到的异常形态
 *
 * 越界 ⇒ 返回 `null`（= 这个模型没有可用基准）⇒ 全员 `unknown` ⇒ 一个都不跳过。
 *
 * @param {any} raw
 * @returns {number|null}
 */
export function usableB(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return n <= B_MAX ? n : null
}

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
 * 这一行是否**可信**（可以进 `sum/sum` 与 `lastSpeed`）。
 *
 * 三条判据，全是「物理上不成立才拦」：
 *
 *	① 状态正常（{@link statusOk}：499 取消的耗时不是模型吐字）
 *	② `flow_ms >= MIN_FLOW_MS`（20 ms 内解不出有意义的内容；magpie 有 flow_ms=1 的行）
 *	③ 单行速率 `<= MAX_ROW_SPEED`（真实峰值 300–500 tok/s，1000 已是保守上限）
 *
 * 实测（2026-11-22，7d 全量 1473 行 / 101 账号）：**78 个账号含这种异常行**，
 * 它只会把 A 抬高 ⇒ B 抬高 ⇒ 判定线抬高 ⇒ 正常号被误判 slow。所以宁可这行不算，
 * 也不要让它进任何分母/分子 —— 全部行都不可信的账号 ⇒ `lastSpeed = null` ⇒ `unknown`
 * （面板显示 `—`，不跳过），**宁可 null 也不给虚假值**。
 *
 * @param {any} row usage/requests 的一行
 * @returns {boolean}
 */
export function usableRow(row) {
  if (!statusOk(row)) return false
  const flow = Number(row?.flow_ms)
  if (!Number.isFinite(flow) || flow < MIN_FLOW_MS) return false
  const speed = speedOfRow(row)
  if (speed === null) return false
  return speed <= MAX_ROW_SPEED
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
 * **只算可信行**（{@link usableRow}）。实测 `out=129, flow_ms=1` 这种行只往分子
 * 加分母不变：混进去会让 A 从 100 变成 229（再往下就是 B 与判定线一起虚高）。
 *
 * @param {any[]} rows 同一 (账号, 模型) 的行
 * @returns {number|null} 没有可信行 ⇒ null（**不是 0**）
 */
export function accountAverage(rows) {
  let tokens = 0
  let seconds = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!usableRow(row)) continue
    tokens += Number(row.out)
    seconds += Number(row.flow_ms) / 1000
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
 *	① 没有最近记录（`lastRow` 为 null；含「全部行都不可信」）
 *	② 最近记录早于 `STALE_DAYS`（超过 3 天没新数据 = 不知道现在怎么样）
 *	③ `b` 为 null（这个模型还没有中位数：只有一个号或全都算不出）
 *
 * 吃原始行时也要过 {@link usableRow}：`flow_ms=1` 的行不许当场算出 129000 tok/s。
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
    : usableRow(lastRow) ? speedOfRow(lastRow) : null
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
 * ⚠ `b` 里**只放能当基准的模型**：中位数越过 {@link B_MAX} 的模型**不会出现**，
 * 它在 `accounts` 里的条目一律是 `unknown`。行级过滤（{@link usableRow}）是第一道闸门，
 * `B_MAX` 是第二道 —— 所以「`b` 里没有这个模型」是正常结论，不是漏算。
 *
 * 键是 `模型|账号`（账号 = 行里的 `providerAccount`，见 models.mjs 的对齐说明）。
 * 模型 id 直接用行里的 `model` —— 实测它就是上游目录的 id
 * （`deepseek-v4-flash-1017` / `DeepSeek-V4.1-Flash`），与 `provider.models` 的键同源。
 *
 * # `calls`
 *
 * 参与计算的行数（**只数可信行**，见 {@link usableRow}），也就是 `avgSpeed` 的样本量。
 * 被过滤掉的行不计入 —— 否则面板上的「调用次数」会包含取消掉的请求与 `flow_ms=1` 的脏行。
 * 「全部行都不可信」⇒ `calls = 0`、`lastSpeed = null`、`avgSpeed = null` ⇒ `verdict = unknown`
 * （面板显示 `—`，不跳过一个号）。
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
    // 行级物理过滤是**第一道**闸门：`flow_ms=1` 的行既不算 A，也不许当 lastSpeed。
    // 实测 101 个账号里 78 个含这种行 —— 不过滤就会把 B 与判定线一起抬起来误杀正常号。
    const usable = group.rows.filter(usableRow)
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
      // 「最近一条**可信**行」，不是「最近一条行」：最近那条若恰好是 1 ms 脏行，
      // 取它会把 lastSpeed 算成 19985 这种值（实测 16582482173 就是这样）。
      lastSpeed: lastRow ? speedOfRow(lastRow) : null,
      lastAt,
      avgSpeed: accountAverage(group.rows),
      calls: usable.length,
    })
  }

  // B：每个模型下所有账号 A 的中位数。**算不出 A 的账号不参与**
  // （把它们当 0 会把中位数整体拉低，于是所有正常号都被判成 normal）。
  //
  // ⚠ 这里的 A 已经只来自可信行（`usableRow`，第一道）。`B_MAX` 是**第二道**保险：
  //   万一还漏了别的异常形态把中位数抬到物理不可能的量级，越过上限 ⇒
  //   「这个模型没有可用基准」（**不出现在 b 里**）⇒ 所有账号 `classify` 拿到 null
  //   ⇒ 全员 unknown ⇒ 一个都不跳过。
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
    // 第二道闸门：`usableB` 只放行 <= B_MAX 的中位数（边界包含）
    const usable = usableB(median(list))
    if (usable !== null) b[model] = usable
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
