// importer.mjs `auth.import` —— 从**文件**批量导入账号。
//
// # 这是 magpie 自己的钩子（OpenCode 会忽略）
//
// 用户点了供应商编辑页里的「从文件导入账号…」，magpie 会弹出文件选择器，
// 把每个文件的**文本内容**交给这个钩子：
//
//	auth.import(texts, { signal }) → 一组登录结果
//
// 每个结果与一次正常登录的产出**同形**（`{type:"success", access, …}`
// 或 `{type:"failed", error}`），magpie 按登录的方式把它保存成账号 ——
// 「加一个账号」或「覆盖它本来就是的那个账号」。
//
// 好处是：**面板里不用再做一套导入 UI**，magpie 原生支持，而且导入的账号
// 与手工登录的账号走同一条落盘路径（不存在两套格式）。
//
// # 为什么要宽容解析
//
// Loomy 的账号 JSON 在实际使用里有好几种形态（用户从不同工具导出的）：
//
//	[{"phone","userid","session","nickname"}]   数组
//	{"phone","session"}                          单个对象
//	{…}\n{…}\n{…}                               每行一个（NDJSON）
//	[{"auth":{"session":"…"}}]                   嵌套包装
//	"session 字符串本身"                          最裸的形态
//
// 全部认。解析不出 session 的条目**逐条**报 failed，不影响其它条目 ——
// 一条坏数据不该让整次导入失败。
//
// # 与面板那条导入的关系
//
// 面板（`server.mjs` 的 `/api/import`）保留，用于「机器之间搬账号」这种
// 需要**写入 magpie 配置**的场景；而用户日常「从文件导入」走这里，
// 是 magpie 官方入口。两条路最终都落到同一份凭证形态。

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { parseCredential, looksLikeSession, shortUID } from "./credential.mjs"
import { PROVIDER, DEFAULT_BASE_URL } from "./constants.mjs"

/**
 * 给界面显示的一句话：要选什么文件。
 *
 * ⚠ 最多 300 字节（magpie 会截断），所以写短。
 */
export const IMPORT_FROM = "Loomy 账号 JSON（含 session 字段）"

/** 多语言版本的同一句话。 */
export const IMPORT_FROMS = {
  zh: "Loomy 账号 JSON（含 session 字段）",
  "zh-TW": "Loomy 帳號 JSON（含 session 欄位）",
  en: "a Loomy account JSON (with a session field)",
}

/**
 * 从一段文本里抽出所有候选账号对象。
 *
 * 按顺序尝试四种形态，**取第一个能解析出东西的**（不合并，避免同一份
 * 数据被解析两次）。
 *
 * @param {string} text
 * @returns {{ items: any[], shapes: string }}
 */
export function extractItems(text) {
  const raw = String(text ?? "").trim()
  if (!raw) return { items: [], shapes: "empty" }

  // ① 整段是合法 JSON（数组或单个对象）
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return { items: v, shapes: "json-array" }
    if (v && typeof v === "object") {
      // 有些导出会包一层：{"accounts":[...]} / {"data":[...]} / {"list":[...]}
      for (const key of ["accounts", "data", "list", "items"]) {
        if (Array.isArray(v[key])) return { items: v[key], shapes: `json-object.${key}` }
      }
      return { items: [v], shapes: "json-object" }
    }
    // 裸字符串：它自己可能就是 session
    if (typeof v === "string") return { items: [{ session: v }], shapes: "json-string" }
  } catch {
    // 不是整段 JSON，往下试
  }

  // ② 每行一个 JSON（NDJSON）
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const perLine = []
  let parsedAny = false
  for (const line of lines) {
    try {
      const v = JSON.parse(line)
      if (Array.isArray(v)) perLine.push(...v)
      else perLine.push(v)
      parsedAny = true
    } catch {
      // 这一行不是 JSON：可能是裸 session，兜到 ③ 一起处理
    }
  }
  if (parsedAny) return { items: perLine, shapes: "ndjson" }

  // ③ 整段就是一串 session（每行一个 32 位 hex）
  const bare = lines.filter((l) => looksLikeSession(l))
  if (bare.length > 0) return { items: bare.map((session) => ({ session })), shapes: "bare-sessions" }

  // ④ 文本里散落着 session（从截图/日志里抠出来的情形）
  const found = raw.match(/\b[0-9a-f]{32}\b/g) ?? []
  if (found.length > 0) {
    return { items: [...new Set(found)].map((session) => ({ session })), shapes: "scattered-sessions" }
  }

  return { items: [], shapes: "unrecognised" }
}

/**
 * 把一条原始条目转成「登录成功」结果。
 *
 * ⚠ 返回值必须与 `authorize/callback` 的产出**同形** —— magpie 按登录的
 * 方式保存它。用 `access` 而不是 `key`：实测 `type:"api"` 的凭证 magpie
 * 不会调 `auth.usage`，账号卡会显示「未登录」（见 AGENTS.md 坑 #2）。
 *
 * @param {any} item
 * @param {object} [opts]
 * @param {(session: string) => Promise<void>} [opts.verify] 可选：验证 session
 * @returns {Promise<object>}
 */
export async function toSignInResult(item, opts = {}) {
  /** @type {any} */
  let source = item

  // 解掉常见的嵌套包装：{"auth":{...}} / {"account":{...}} / {"credential":{...}}
  if (source && typeof source === "object" && !source.session) {
    for (const key of ["auth", "account", "credential", "data"]) {
      const inner = source[key]
      if (inner && typeof inner === "object" && inner.session) {
        source = inner
        break
      }
    }
  }

  let cred
  try {
    cred = parseCredential(source)
  } catch (e) {
    return { type: "failed", error: String(e?.message ?? e) }
  }

  // 可选：验证一次（能被 /models 认下才收）。
  // 失败**不阻断** —— 上游可能只是这一刻不通，而凭证本身是对的。
  if (opts.verify) {
    try {
      await opts.verify(cred.session)
    } catch (e) {
      return { type: "failed", error: `session 不可用：${e?.message ?? e}`, accountId: cred.nickname }
    }
  }

  return {
    type: "success",
    access: cred.session,
    // 本上游没有 refresh token（session 不过期）。
    refresh: "",
    // 0 = 不会过期、不要续期。
    expires: 0,
    accountId: cred.nickname || shortUID(cred.uid),
    uid: cred.uid,
    metadata: {
      uid: cred.uid,
      nickname: cred.realNickname || cred.nickname,
      phone: cred.phone,
      userId: cred.userId,
      loggedInAt: cred.loggedInAt,
    },
  }
}

/** magpie 一次最多收 100 条（`IMPORT_MOST`，见其 host.js）。 */
export const IMPORT_MOST = 100

/** 后台探测：并发上限（与面板批量检测同口径，真机踩过限流）。 */
export const IMPORT_PROBE_CONCURRENCY = 2
/** 后台探测：相邻两次**启动**的最小间隔（节流，不是纯并发上限）。 */
export const IMPORT_PROBE_GAP_MS = 300
/** 后台探测：连续这么多次限流/失败就熔断，后面的号一次都不打。 */
export const IMPORT_PROBE_BREAKER = 3

/**
 * 读 magpie 的 `plugin-auth.json`，取出 loomy 账号的 `{uid, session}`。
 *
 * # 为什么要读这个文件（钻实现细节，但必须）
 *
 * 「已导入过的不要再返回」只能从宿主侧的事实得知 —— 用户在 magpie 里已有的
 * 账号就是权威答案。格式不在插件契约里（见 `server.mjs` 的同款说明），所以：
 * 读失败一律当「没有账号」，绝不让导入报错。
 *
 * ⚠ 键有两种形态：`loomy` 与 `loomy#<id>`（多账号）。只认这两种，
 * 别的 provider 的账号不该影响我们的去重。
 *
 * @param {string} configDir
 * @returns {{uids: Set<string>, sessions: Set<string>}}
 */
export function readExistingAccounts(configDir) {
  /** @type {Set<string>} */
  const uids = new Set()
  /** @type {Set<string>} */
  const sessions = new Set()

  const dir = String(configDir ?? "").trim()
  if (!dir) return { uids, sessions }
  const file = join(dir, "plugin-auth.json")
  if (!existsSync(file)) return { uids, sessions }

  /** @type {any} */
  let all
  try {
    all = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return { uids, sessions }
  }

  for (const [key, value] of Object.entries(all ?? {})) {
    if (key !== PROVIDER && !key.startsWith(PROVIDER + "#")) continue
    const v = /** @type {any} */ (value)
    // 两种形态都认：oauth 的 access，以及早期写法的 api/key
    const session = String(v?.access ?? v?.key ?? "").trim()
    if (session) sessions.add(session)
    const uid = String(v?.metadata?.uid ?? v?.uid ?? "").trim()
    if (uid) uids.add(uid)
  }
  return { uids, sessions }
}

/**
 * `mapLimit` 风格的后台任务池：并发 + 节流 + 熔断。
 *
 * 三个参数都是真机换来的（与面板 `runRouteBatch` 同一套）：
 *
 *	① 并发 ≤ `IMPORT_PROBE_CONCURRENCY`：一次探测 = 一次真实计费调用
 *	② 相邻两次**启动**至少隔 `gapMs`：上游对密集启动会限流
 *	③ 连续 `breaker` 次限流/失败 → 立刻停手，后面的号**一次都不打**
 *
 * @param {Array<() => Promise<any>>} tasks
 * @param {{concurrency: number, gapMs: number, breaker: number}} opts
 * @returns {Promise<void>}
 */
async function runPool(tasks, opts) {
  const limit = Math.max(1, opts.concurrency)
  let cursor = 0
  let stop = false
  let nextStartAt = 0
  let consecutiveFailures = 0

  /**
   * 时钟可注入：节流是「逻辑时间」上的性质，用假时钟就能在不真的等 300ms×N
   * 的前提下验证（测试文件因此从 200 秒降到秒级）。
   *
   * 默认实现里的 `sleep` 必须 `unref`：本节是**后台**任务（`void` 进来的），
   * 挂着真实计时器会让 Node 进程为它多活一段 —— 真机上是「关掉 magpie 后
   * 插件进程迟迟不退」。
   */
  const now = typeof opts.clock?.now === "function" ? opts.clock.now : () => Date.now()
  const sleep =
    typeof opts.clock?.sleep === "function"
      ? opts.clock.sleep
      : (ms) =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, ms)
            timer.unref?.()
          })

  const gate = async () => {
    const at = Math.max(now(), nextStartAt)
    nextStartAt = at + opts.gapMs
    const wait = at - now()
    if (wait > 0) await sleep(wait)
    // 返回**闸门分配**的启动时刻：日志/测试都以它为准。若让调用方自己再读
    // 一次 `now()`，并发 2 时两次启动会读到同一个时刻（假时钟下尤其明显）。
    return at
  }

  const worker = async () => {
    for (;;) {
      if (stop) return
      const index = cursor++
      if (index >= tasks.length) return
      const startedAt = await gate()
      // ⚠ 放闸后必须**再判一次**：同一批的另一个 worker 可能刚触发熔断。
      //   熔断判据只数「已失败」的次数（`consecutiveFailures`）。理论上在飞的
      //   探测可能让启动次数比 breaker 多一点（并发 2 ⇒ 最多 +1），但生产里
      //   相邻启动间隔 300ms，失败早在下一次放闸前就被记下，不会漏。
      if (stop) return
      // 仅测试/排障注入：把闸门分配的启动时刻报出去（生产不传）。
      opts.onStart?.(startedAt, index)
      try {
        await tasks[index]()
        consecutiveFailures = 0
      } catch (e) {
        // 只有「限流 / 没发出去 / 连结论都没拿到」才算熔断计数：一个号被上游
        // 判定为内容问题（参数错误）不该让整批停产。
        if (isBreakerFailure(e)) consecutiveFailures += 1
        else consecutiveFailures = 0
        if (consecutiveFailures >= opts.breaker) stop = true
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
}

/**
 * 这个错误该不该算进熔断计数。
 *
 * 包含三类，都是「继续打下去只会更糟」：
 *
 *	① 限流（429 / rate limit / 发送失败）
 *	② 探测抛错（网络不通、模块缺失）
 *	③ `probe-unknown` —— 探测跑完了但没有结论。连续几次都这样，说明上游
 *	   这一刻不可用；继续给几百个号各烧一次 6 秒的账本轮询毫无意义
 *	   （真机上 117 个号会变成好几分钟的后台负载）。
 */
function isBreakerFailure(e) {
  return /429|rate.?limit|too many|throttl|限流|发送失败|probe-unknown/i.test(String(e?.message ?? e ?? ""))
}

/**
 * 构建 `auth.import` 钩子。
 *
 * @param {{verify?: (session: string) => Promise<void>, configDir?: string,
 *   probe?: (input: {session: string, uid: string}) => Promise<any>,
 *   writeState?: (configDir: string, uid: string, entry: any) => any,
 *   baseUrl?: string, gapMs?: number, settleMs?: number, log?: {warn: Function},
 *   clock?: {now: () => number, sleep: (ms: number) => Promise<void>}}} [opts]
 *   `configDir`：用来读「已导入过的账号」做去重，并给后台探测落盘。
 *   `baseUrl`：后台探测要用的模型代理基址（不传则探测拿不到上游地址）。
 *   `probe` / `writeState`：仅测试注入；生产走动态 import 的
 *   `src/route.mjs` / `src/route-store.mjs`。
 *   `clock`：仅测试注入的假时钟（节流是逻辑时间上的性质，不必真的等）。
 * @returns {{
 *   import: (texts: string[], ctx?: {signal?: AbortSignal}) => Promise<object[]>,
 *   importFrom: string,
 *   importFroms: Record<string, string>,
 * }}
 */
export function makeImportHook(opts = {}) {
  const configDir = String(opts.configDir ?? "").trim()
  const baseUrl = String(opts.baseUrl ?? "").trim() || DEFAULT_BASE_URL
  const gapMs = Number.isFinite(opts.gapMs) ? Number(opts.gapMs) : IMPORT_PROBE_GAP_MS
  const log = opts.log ?? console

  return {
    importFrom: IMPORT_FROM,
    importFroms: IMPORT_FROMS,

    /**
     * @param {string[]} texts 用户选中的每个文件的文本
     * @param {{signal?: AbortSignal}} [ctx]
     * @returns {Promise<object[]>} 一组登录结果（与 authorize 的产出同形）
     */
    async import(texts, ctx = {}) {
      const list = Array.isArray(texts) ? texts.filter((t) => typeof t === "string" && t.trim()) : []
      if (list.length === 0) return []

      // ── ① 先把自己的文件全部摊平（一次最多 IMPORT_MOST，但**计数要真实**）──
      //
      // ⚠ 旧实现在循环里直接 `slice(0, 100)`，被切掉的部分不报错、不提示 ——
      // 用户导 117 条，17 条永远进不来（再导一次还是切前 100 条）。
      // 现在改成：摊平 → 去重 → 截断时**追加一条 failed 说明**。
      /** @type {string[]} */
      const items = []
      for (const text of list) {
        if (ctx.signal?.aborted) break
        const parsed = extractItems(text)
        for (const item of parsed.items) items.push(item)
      }

      // ── ② 去重：已经在 magpie 里的账号不要再返回 ──
      //
      // 这是「分两次导完」的前提：用户第二次选同一个文件时，前 100 个会被跳过。
      // 判据是 uid **或** session —— 同一个号可能以不同 uid 形态出现
      // （`userid` / 派生的 uid），但 session 只有一个。
      const existing = readExistingAccounts(configDir)
      const seenUid = new Set(existing.uids)
      const seenSession = new Set(existing.sessions)

      /** @type {object[]} */
      const fresh = []
      let duplicates = 0
      for (const item of items) {
        if (ctx.signal?.aborted) break
        const result = await toSignInResult(item, { verify: opts.verify })
        if (result.type === "success") {
          const session = String(result.access ?? "")
          const uid = String(result.uid ?? "")
          if ((session && seenSession.has(session)) || (uid && seenUid.has(uid))) {
            duplicates += 1
            continue
          }
          if (session) seenSession.add(session)
          if (uid) seenUid.add(uid)
        }
        fresh.push(result)
      }

      // 一条都没解析出来：给一条 failed 说明原因，而不是静默返回空数组。
      // 静默的空结果在界面上表现为「点了导入，什么都没发生」。
      if (items.length === 0 && fresh.length === 0) {
        return [{ type: "failed", error: `没从文件里认出账号（要含 session 字段的 JSON；provider=${PROVIDER}）` }]
      }
      // 全都在池子里了：如实说「没有新账号」，而不是返回空数组让人以为坏了。
      if (fresh.length === 0) {
        return [{ type: "failed", error: `这 ${duplicates} 个账号都已经在 magpie 里了，没有新的要导入` }]
      }

      // ── ③ 截断必须**说清**（magpie 单次只收 IMPORT_MOST 条）──
      const accepted = fresh.slice(0, IMPORT_MOST)
      const leftover = fresh.length - accepted.length

      /** @type {object[]} */
      const results = accepted
      if (leftover > 0) {
        results.push({
          type: "failed",
          error:
            `本文件共 ${fresh.length} 条，已导入 ${accepted.length} 条；` +
            `还有 ${leftover} 条超出 magpie 单次 ${IMPORT_MOST} 条上限，` +
            `请再次选择同一文件继续导入（已导入的会被自动跳过）`,
        })
      }

      // ── ④ 后台探测（fire-and-forget，绝不 await）──
      //
      // 不探测的后果（真机）：新号不在 route-state 里 ⇒ `provider.models`
      // 判 unknown ⇒ 给完整目录 ⇒ magpie 立刻派活过去，而它们可能是受限号。
      // 但探测要发**计费**请求，绝不能让 magpie 的导入等它。
      void probeImported(accepted, {
        configDir,
        probe: opts.probe,
        writeState: opts.writeState,
        gapMs,
        settleMs: opts.settleMs,
        onStart: opts.onStart,
        clock: opts.clock,
        log,
      })

      return results
    },
  }
}

/**
 * 导入成功后，在后台给每个新号跑一次路由探测并落盘。
 *
 * ⚠ 本函数**只被 `void` 调用**：它慢、它失败、它烧积分，都和导入本身无关。
 *
 * 落盘规则与面板完全一致（`server.mjs` 的 `probeAccountRoute`）：
 * `clean` / `routed` / `expired` 覆盖；`unknown` **不落盘** ——
 * 否则一次上游抖动就会把上一次的有效结论抹成「未检测」。
 *
 * @param {object[]} results 已经通过的去重后结果
 * @param {{configDir: string, probe?: Function, writeState?: Function, gapMs: number,
 *   settleMs?: number, log: object}} opts
 * @returns {Promise<void>}
 */
async function probeImported(results, opts) {
  // 测试用的「让后台任务跑完」的钩子：不指定就不存在这个 setTimeout
  if (Number.isFinite(opts.settleMs)) await new Promise((r) => setTimeout(r, Number(opts.settleMs)))

  /** @type {Array<{session: string, uid: string}>} */
  const targets = []
  for (const r of results ?? []) {
    if (r?.type !== "success") continue
    const session = String(r.access ?? "").trim()
    if (!session) continue
    targets.push({ session, uid: String(r.uid ?? "").trim() })
  }
  if (targets.length === 0) return

  /**
   * 生产路径：动态 import，模块缺失就静默跳过（并行开发期也要能导号）。
   *
   * ⚠ 只在**没有注入探测**时才 import。测试注入的是假 probe —— 若仍然去
   * import 真的 `route.mjs`，后台任务会对着网络闸跑真探测（一跑几分钟、
   * 每个号都超时），测试文件也因此跑不完。
   */
  let mods = null
  if (typeof opts.probe !== "function") {
    const [probe, store] = await Promise.all([
      import("./route.mjs").catch(() => null),
      import("./route-store.mjs").catch(() => null),
    ])
    if (typeof probe?.probeRoute !== "function") return
    mods = { probeRoute: probe.probeRoute, writeRouteState: store?.writeRouteState }
  }
  const probeFn = opts.probe ?? (async (input) => mods.probeRoute({ baseUrl, session: input.session }))
  const writeFn = "writeState" in opts ? opts.writeState : mods?.writeRouteState

  const tasks = targets.map((t) => async () => {
    // ⚠ 不再 try/catch 后原样 rethrow（那一段什么都没做）；错误统一交给
    // runPool 的熔断计数判断。
    const entry = await probeFn({ session: t.session, uid: t.uid })
    if (!entry || typeof entry !== "object") throw new Error("probe-unknown: 探测没有返回结论")
    // `unknown` = 这次没测清。不落盘（否则一次上游抖动会把上一次的有效结论
    // 抹成「未检测」），但**算一次熔断计数** —— 否则几百个号会各烧一次
    // 6 秒的账本轮询（真机 117 个号 = 好几分钟的后台负载）。
    if (entry.verdict === "unknown") throw new Error("probe-unknown: 这次没测清")
    if (!opts.configDir || !t.uid) {
      opts.log?.warn?.("loomy: 缺少 configDir / uid，导入后的路由结论无法落盘")
      return
    }
    await writeFn?.(opts.configDir, t.uid, entry)
  })

  await runPool(tasks, {
    concurrency: IMPORT_PROBE_CONCURRENCY,
    gapMs: opts.gapMs,
    breaker: IMPORT_PROBE_BREAKER,
    clock: opts.clock,
    onStart: opts.onStart,
  })
}



