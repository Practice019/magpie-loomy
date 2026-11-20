// loader.mjs 请求接管 —— 本插件**唯一**碰请求路径的地方。
//
// # 只做三件事
//
//	① baseURL：告诉宿主请求发去哪（含 /api/v1）
//	② apiKey ：宿主会按 npm 自动加成 `Authorization: Bearer <key>`
//	③ fetch  ：只改两处 —— 生图补一个 `token` 头、对话改写 body
//
// 其余的（流式分帧、背压、abort、故障转移、协议转换）**全部由 magpie 做**，
// 本文件一行都不碰。这是「寄生」的实质：上游知识留在插件，传输留在宿主。
//
// # 为什么 apiKey 就是 session
//
// `@ai-sdk/openai-compatible` 的 `sdkHeaders` 会给 apiKey 加
// `Authorization: Bearer <key>` —— 这正是 /chat/completions 要的形态。
// 而 /models 走的是 `token:` 那条轨，那条请求**不经过 loader.fetch**
// （由 provider.models 自己发），所以这里不用管它。

import { prepareBody, modelOf } from "../prepare-body.mjs"
import { signInVerdict, applySignInHeader, SIGN_IN_HEADER } from "../upstream-facts.mjs"
import { chatHeaders, sessionAffinity } from "../auth-headers.mjs"
import { buildClientBody } from "../client-body.mjs"
import { CLIENT_BODY_TEMPLATE } from "../client-body-template.mjs"
import { DEFAULT_LOOMY_VERSION, CLIENT_USER_AGENT, CLIENT_ACCEPT_ENCODING, DEFAULT_BASE_URL, DEFAULT_BODY_MODE } from "../constants.mjs"
import { recordTraffic as recordTrafficDefault } from "../traffic.mjs"

/** 生图端点路径片段（用来判断该不该补 token 头）。 */
const IMAGE_PATH_HINT = "/images/generations"

/**
 * 按 `bodyMode` 改写对话请求体。
 *
 * # 四种模式（默认 `client-body`）
 *
 *	passthrough   调用方根本不会走到这里（loader 直接原样发）
 *	default       `prepareBody`：只补 stream=true + stream_options
 *	client-body   **以抓包的完整客户端 body 为底**：只换 model 与调用方 messages
 *	              （调用方的 system 追加在客户端 system 之后，不丢弃）
 *	client-shape  按字段补：缺 tools/max_tokens/reasoning_effort/system 才补，
 *	              已有就不覆盖（旧行为，保留兼容）
 *
 * 解析失败一律退回 `prepareBody`：body 不是我们能理解的 JSON 时，别把它弄坏。
 *
 * @param {string|Uint8Array|null|undefined} body
 * @param {string} mode
 * @returns {string|Uint8Array|null|undefined}
 */
function rewriteBody(body, mode) {
  if (mode === "client-body" && (body == null || typeof body === "string")) {
    if (body == null) {
      // 没有 body（极少数调用方）：仍给一次客户端形态
      return JSON.stringify(buildClientBody({ messages: [{ role: "user", content: "ping" }] }))
    }
    /** @type {any} */
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      return prepareBody(body)
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return prepareBody(body)
    return JSON.stringify(buildClientBody({ model: parsed.model, messages: parsed.messages }))
  }

  if (mode === "client-shape" && (body == null || typeof body === "string")) {
    if (body == null) return body
    /** @type {any} */
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      return prepareBody(body)
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return prepareBody(body)

    const t = CLIENT_BODY_TEMPLATE
    /** @type {any} */
    const out = {
      ...parsed,
      max_tokens: parsed.max_tokens ?? t.max_tokens,
      reasoning_effort: parsed.reasoning_effort ?? t.reasoning_effort,
      tools: parsed.tools ?? t.tools,
      tool_choice: parsed.tool_choice ?? t.tool_choice,
      stream: true,
    }
    if (out.stream_options === undefined || out.stream_options === null) out.stream_options = { include_usage: true }
    const sys = (t.messages ?? []).find((m) => m?.role === "system")
    const history = Array.isArray(out.messages) ? out.messages : []
    if (sys && !history.some((m) => m?.role === "system")) out.messages = [sys, ...history]
    return JSON.stringify(out)
  }

  return prepareBody(body)
}

// ─────────────────────────────────────────────────────────────────────────
// 「被限制账号」的**只读**观察 —— 本文件**永不阻止请求**
// ─────────────────────────────────────────────────────────────────────────
//
// # 事实
//
// 上游对某些账号会把**整号**的 chat 模型（DeepSeek-V4.1-Flash、GLM-5.3-Flash、
// qwen3.8-flash、deepseek-v4-flash-1017…）全都落到 `spark-x2.6-low`。
// `/models` 与 chat 响应都看不出来：用户付了 2× 的倍率，拿到的是另一个模型。
// 判定由 `src/route-store.mjs` 落盘，`verdict` 只有 clean / routed / unknown。
//
// # ⚠⚠ 为什么这里**曾经**有一道 503 闸门，又被撤掉了（真机事故）
//
// 上一版对 routed 账号的任何 chat 请求直接回 503，想让 magpie 换号。
// 后果：magpie 把 5xx 当成**账号故障信号** —— 每次选中这个号就吃一次 503，
// 于是一批号被标记失败 / 禁用，用户侧看到「一直在试别的号、可用只剩 90 多」。
// **一个插件不应该用错误码去表达「别选我」。**
//
// 现在「别选我」的表达在 `src/hooks/models.mjs`：routed 账号返回**空目录**。
// magpie 的 `plugin-providers.json` 里每个账号有自己的 `models` 数组，路由只
// 在这份列表里选模型 —— 目录空 ⇒ 天生不派活，**不产生任何错误、不触发换号、
// 不触发禁用**。（实测：184 个号里 90 个上游只下发 spark 两个模型，
// magpie 就从来不会给它们派 DS4.1。）
//
// 所以本文件对判定的用法只剩**日志**：真的收到了请求就记一行，方便排障。
// 行为上一律透传 —— 不改状态码、不改正文、不短路。
//
// # 为什么判定要靠「动态 import + 降级」
//
// `src/route-store.mjs` 可能还不存在 / 以后会被重命名。模块缺失时行为必须
// 等同「一条判定都没有」：不记录、不报错。所以这里绝不写静态 import ——
// 那会让整个插件在文件缺失时加载失败。

// ─────────────────────────────────────────────────────────────────────────
// 429 冷却（进程内，不落盘）
// ─────────────────────────────────────────────────────────────────────────
//
// # 为什么需要它
//
// magpie 路由只看 `windows[].used`。429 时既不封号（不该 `used:100` 永久跳过），
// 又确实该**短暂避开**这个号（否则宿主立刻重试，限流雪上加霜）。
// 所以 `auth.usage` 在冷却期内给一条**带 `resetsAt`** 的满额窗：
// 到期 magpie 自动恢复，不需要任何外部清理。
//
// ⚠ 记录只在内存：进程重启后冷却自然消失（那时宿主也会重新列表）。

/** 默认冷却时长（毫秒）：429 后这个号先别派活。 */
export const RATE_LIMIT_COOLDOWN_MS = 60_000

/** uid → 冷却截止时刻（epoch 毫秒）。 */
const cooldowns = new Map()

/**
 * 把 `Retry-After` 头解成毫秒。
 *
 * 两种合法形态：秒数（`30`）与 HTTP 日期。认不出返回 0（调用方用默认值）。
 *
 * @param {string|null|undefined} raw
 * @returns {number}
 */
export function retryAfterMs(raw) {
  const v = String(raw ?? "").trim()
  if (!v) return 0
  if (/^\d+$/.test(v)) return Number(v) * 1000
  const at = Date.parse(v)
  if (!Number.isFinite(at)) return 0
  const diff = at - Date.now()
  return diff > 0 ? diff : 0
}

/**
 * 读某个账号的冷却状态。
 *
 * @param {string} uid
 * @param {number} [now] 当前时刻（毫秒；测试注入）
 * @returns {{until: number, at: number}|null} 已过期返回 null
 */
export function cooldownOf(uid, now = Date.now()) {
  const key = String(uid ?? "").trim()
  if (!key) return null
  const hit = cooldowns.get(key)
  if (!hit) return null
  if (hit.until <= now) {
    // 到期即清：不需要定时器，也没有跨进程的垃圾
    cooldowns.delete(key)
    return null
  }
  return hit
}

/**
 * 记录一次 429（同号再次命中就刷新到新的截止时刻）。
 *
 * @param {string} uid
 * @param {string|null} retryAfter `Retry-After` 原值
 * @param {number} [now] 当前时刻（毫秒；测试注入）
 * @returns {number} 本次冷却多少毫秒（0 = 没有 uid，没记）
 */
export function noteRateLimited(uid, retryAfter, now = Date.now()) {
  const key = String(uid ?? "").trim()
  if (!key) return 0
  const ms = retryAfterMs(retryAfter) || RATE_LIMIT_COOLDOWN_MS
  cooldowns.set(key, { until: now + ms, at: now })
  return ms
}

/** 清空冷却表（测试隔离用；生产不需要）。 */
export function resetCooldowns() {
  cooldowns.clear()
}

/**
 * 凭证里**所有**可能当路由键的值，身份优先、显示名兜底，去重且非空。
 *
 * # ⚠ 顺序是有实测依据的，不是风格
 *
 *	① `auth.uid` / `auth.metadata.uid` —— **身份**。状态文件就是用它写的：
 *	   面板 `/api/route-check` 与登录后自动探测都走 `meta.uid ?? v.uid ??
 *	   deriveUID(session)`（见 `server.mjs`），落盘的是 uid。
 *	② `auth.accountId` —— **显示名**（这里是打码手机号 `150****3411`）。
 *	   可重名、可改、重登会变，所以只作兜底。
 *
 * 曾经的写法是「accountId 优先」，结果：文件里存 uid、钩子查 accountId ⇒
 * 永远 miss ⇒ usage 不插窗口、loader 不拦截，**整个功能静默失效**。
 * `plugin-auth.json` 里 `accountId` / `uid` / `metadata.uid` 三个键同时存在，
 * 所以「按顺序全试一遍」才是唯一安全的读法。
 *
 * @param {any} auth
 * @returns {string[]}
 */
export function accountKeys(auth) {
  /** @type {string[]} */
  const out = []
  for (const raw of [auth?.uid, auth?.metadata?.uid, auth?.accountId, auth?.metadata?.userId]) {
    if (raw === null || raw === undefined) continue
    const v = String(raw).trim()
    // 空串要跳过：`??` 只认 null/undefined，一个 "" 会把后面的真身份挡住
    if (!v || out.includes(v)) continue
    out.push(v)
  }
  return out
}

/**
 * 首选路由键（= `accountKeys()[0]`，取不到返回空串）。
 *
 * 只是给「我就要一个键」的场合用的薄包装；查判定请用 `accountKeys()`，
 * 单键查询会漏掉兜底路径。
 *
 * @param {any} auth
 * @returns {string}
 */
export function accountUid(auth) {
  return accountKeys(auth)[0] ?? ""
}

/** `src/route-store.mjs` 的加载结果（模块级缓存；**失败不缓存**）。 */
let routeModule

/**
 * 取 `src/route-store.mjs` 模块；不存在时返回 null。
 *
 * 缓存的是**成功**：失败那一支每次都重试，这样 T-01 把文件落盘后不必重启
 * 整个插件进程就能生效。
 *
 * `opts.routeStore` 是给测试注入用的缝（传 `null` = 模块缺失）。
 *
 * @param {{routeStore?: any}} [opts]
 * @returns {Promise<any|null>}
 */
async function loadRouteStore(opts = {}) {
  if (opts.routeStore !== undefined) return opts.routeStore
  if (routeModule !== undefined) return routeModule
  try {
    routeModule = await import("../route-store.mjs")
  } catch {
    return null
  }
  return routeModule
}

/**
 * 读该账号的路由判定。
 *
 * # 为什么要接受**键数组**
 *
 * 状态文件的键是身份（uid），凭证里还有显示名（accountId）。两者不是同一个
 * 值，只查一个就会 miss —— 那正是上一版的线上故障：功能做完，静默不生效。
 * 所以按 `accountKeys()` 的顺序逐个查，**第一个非 null 就用**。
 *
 * # 返回形状
 *
 *	{ entry, key } —— key 是命中的那一个键，排障时能一眼看出命中的是
 *	                 身份还是显示名（调用方把它写进日志）。
 *	null           —— 没有任何键命中 / 模块缺失 / 没有 configDir。
 *
 * 实现上先读一次整表（`readRouteState`）再按 key 查，避免每个键读一遍文件；
 * 真模块若只提供了 `getAccountRoute`，则退化为逐键调用它。
 *
 * @param {string} configDir
 * @param {string|string[]} keys `accountKeys()` 的结果（也接受单个键）
 * @param {{routeStore?: any}} [opts]
 * @returns {Promise<{entry: any, key: string}|null>}
 */
export async function accountRoute(configDir, keys, opts = {}) {
  const dir = String(configDir ?? "").trim()
  const list = (Array.isArray(keys) ? keys : [keys])
    .map((k) => (k === null || k === undefined ? "" : String(k).trim()))
    .filter((k, i, arr) => k !== "" && arr.indexOf(k) === i)
  // 没有 configDir 就没有状态文件（routeStatePath("") === ""）—— 不必问
  if (!dir || list.length === 0) return null

  const store = await loadRouteStore(opts)
  if (!store) return null

  /** 整表读一次（读失败 = 当作没有判定，不抛）。 */
  const readTable = () => {
    if (typeof store.readRouteState !== "function") return null
    try {
      const state = store.readRouteState(dir)
      // `ok:false` = 读失败（文件损坏 / 无权限 / 没有 configDir）
      if (!state || state.ok === false) return null
      return state.data && typeof state.data === "object" ? state.data : null
    } catch {
      return null
    }
  }

  const table = readTable()

  for (const key of list) {
    if (table && Object.prototype.hasOwnProperty.call(table, key)) {
      const v = table[key]
      if (v && typeof v === "object" && !Array.isArray(v)) return { entry: v, key }
    }
    // 只剩 `getAccountRoute` 这条接口可用时兜底（每次调用都会读一次文件）
    if (typeof store.getAccountRoute === "function") {
      try {
        const entry = store.getAccountRoute(dir, key)
        if (entry && typeof entry === "object" && !Array.isArray(entry)) return { entry, key }
      } catch {
        // 判定是好东西但不是必需品：读不出来时放行，让上游如实报错。
      }
    }
  }
  return null
}

/**
 * 构建 `auth.loader` 钩子。
 *
 * @param {{configDir?: string, log?: {warn?: Function}, fetchImpl?: typeof fetch, routeStore?: any,
 *   recordTraffic?: Function}} [opts]
 *   `configDir`：magpie 的配置目录（路由判定文件与流量证据都在那里）。
 *   `fetchImpl`：仅测试注入；生产用 `globalThis.fetch`。
 *   `routeStore`：仅测试注入（见 `loadRouteStore`）。
 *   `recordTraffic`：仅测试注入（生产用 `src/traffic.mjs` 的写入器）。
 *   无参调用**仍然可用** —— 没有 configDir 时闸门与记录天然不生效。
 * @returns {(getAuth: () => Promise<any>, provider: any) => Promise<object>}
 */
export function makeLoaderHook(opts = {}) {
  const configDir = String(opts?.configDir ?? "").trim()
  const log = opts?.log ?? console
  const doFetch = opts?.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const storeOpt = opts?.routeStore
  // 流量证据的写入器：生产是 `src/traffic.mjs`；测试注入假实现（否则真写盘）。
  const record = typeof opts?.recordTraffic === "function" ? opts.recordTraffic : recordTrafficDefault
  // 发出去的 `loomy-version`：默认照客户端当前版本，可被 options 覆盖
  const loomyVersion = String(opts?.loomyVersion ?? "").trim() || DEFAULT_LOOMY_VERSION
  // 发出去的 UA：客户端是 Electron，默认那串 Chromium UA；Node 默认是 undici
  const userAgent = String(opts?.userAgent ?? "").trim() || CLIENT_USER_AGENT
  // 时钟：冷却窗口是「逻辑时间」上的判断，测试注入固定时钟即可
  const now = typeof opts?.now === "function" ? opts.now : () => Date.now()
  // TurnId 生成器：仅测试注入。默认 `msg-<uuid>`（抓包实证：客户端 MsgId 与
  // TurnId 就是同一个 `msg-<uuid>`，不是 `turn_*`）。
  // ⚠ **只用于出站头**（客户端指纹）。曾经它还兼做「拿它回查 by-turn」的锚点，
  // 那条链路已整段删除：响应体每个 chunk 自带 `model` 字段，不必再问一次上游。
  const genTurnId = typeof opts?.turnId === "function" ? opts.turnId : () => `msg-${globalThis.crypto.randomUUID()}`
  /**
   * body 改写模式（默认 `DEFAULT_BODY_MODE = "passthrough"`，用户明确要求原样发）：
   *
   *	"default"      — 走 `prepareBody`（stream=true + stream_options）
   *	"passthrough"  — **完全不动 body**（逐字节原样发出，连 stream 都不加）
   *
   * ⚠ passthrough 下若调用方 body 没有 `stream:true`，magpie 网关拿不到流式响应，
   *   非流式转码可能失败。需要改写时在插件选项里填 `"bodyMode": "default"`。
   */
  const bodyMode = String(opts?.bodyMode ?? "").trim() || DEFAULT_BODY_MODE

  /** 日志绝不能把请求搞崩。 */
  const warn = (m) => {
    try {
      log?.warn?.(m)
    } catch {
      /* 日志失败不是业务失败 */
    }
  }

  return async function loader(getAuth) {
    const auth = await getAuth()
    if (!auth?.type || !auth?.access) {
      // 未登录：返回空对象，宿主会用自己的默认（拿不到 key 时请求自然失败）
      return {}
    }

    /**
     * routed 账号真的被请求到了：记一行日志。**只记录，不改变行为。**
     *
     * 为什么必须有它：目录置空后 magpie 本不该派活过来；如果还收到请求，
     * 说明目录那条路没生效（或别的入口绕过了目录）—— 这是唯一的诊断信号。
     * 所以这里绝不 return、绝不改 `init`、绝不合成响应。
     *
     * @param {string|Uint8Array|null|undefined} body
     */
    async function noteIfRouted(body) {
      if (typeof body !== "string" || body.length === 0) return
      const model = modelOf(body)
      if (!model) return

      const keys = accountKeys(auth)
      // 一个键都没有就没有可查的判定 —— 放行，也不打扰日志。
      if (keys.length === 0) return

      try {
        const hit = await accountRoute(configDir, keys, { routeStore: storeOpt })
        const verdict = hit?.entry?.verdict
        if (verdict === "expired") {
          // 登录失效也不在这里拦：这里的唯一职责是记录。真正的处置是
          // `provider.models` 置空 + `auth.usage` 的 signIn=expired。
          warn(`loomy: 账号 ${hit.key} 登录已失效，但仍收到了 ${model} 请求`)
          return
        }
        if (verdict === "exhausted") {
          // 余额不足同样不是错误码能表达的：`auth.usage` 报满额让路由跳过它。
          warn(`loomy: 账号 ${hit.key} 积分不足（上游 402），但仍收到了 ${model} 请求`)
          return
        }
        if (verdict !== "routed") return
        const served = String(hit.entry?.servedModel ?? "").trim() || "上游其它模型"
        warn(`loomy: 账号 ${hit.key} 已被上游限制（全部模型实际由 ${served} 服务），但仍收到了 ${model} 请求`)
      } catch {
        // 观察失败不是业务失败：判定的价值不足以让一次请求变形。
      }
    }

    /** @type {string} */
    const session = auth.access

    /**
     * 记录「这次真实请求是谁、要了什么模型、什么时候」 —— **旁路证据**。
     *
     * # 为什么值得记
     *
     * 判断「号有没有被换模型」最贵的一步是发一次计费 chat + 轮询账本。
     * 而真实请求本来就发生了：把出站模型记下来，巡检侧再去读账本比对，
     * 就能**免费**得到「这次实际落在哪个模型上」。代价是闲置号没有证据。
     *
     * # ⚠ 三条不许
     *
     *	① **不许 await**：`void`。写一次文件的延迟不该出现在一次对话请求上。
     *	② **不许影响请求**：同步异常与 Promise 拒绝都吞掉（`recordTraffic`
     *	   自己已是永不抛，这里再兜一层 —— 注入的实现未必守规矩）。
     *	③ **不许记生图**：只关心对话路由（生图模型各自独立，没有改路由的说法）。
     *
     * 没有 configDir / 没有 uid / 解析不出 model ⇒ 静默跳过。
     *
     * @param {string|Uint8Array|null|undefined} body
     */
    function noteTraffic(body) {
      if (typeof body !== "string" || body.length === 0) return
      const model = modelOf(body)
      if (!model) return

      const uid = accountUid(auth)
      if (!uid || !configDir) return

      try {
        void Promise.resolve(record(configDir, uid, { model, at: Date.now() })).catch(() => {})
      } catch {
        // 旁路证据的失败不是业务失败
      }
    }

    /**
     * 把「这次实际由谁服务」记进账号指针 —— **旁路**，永不阻塞、永不改响应。
     *
     * # 为什么现在读响应体就够（取代了原来那条 by-turn 回查）
     *
     * 实测（真机，stream:true）：上游 SSE 的**每一个 chunk** 都自带真实模型名：
     *
     *	data: {"object":"chat.completion.chunk","model":"deepseek-v4-flash-1017",…}
     *
     * 所以「这一轮落在哪个模型」根本不必再去 `/points/by-turn` 问一次：那是
     * 一次额外的上游请求（每个 200 一次 + 重试），而响应体已经把答案送到手边。
     *
     * # 和「期望模型」是两件事
     *
     *	期望 model = 请求 body 里的 `model`（= 插件 `provider.models` 声明的 id，
     *	             magpie 卡片上显示的就是它）
     *	实际 model = 响应 chunk 里的 `model`
     *
     * 二者不一致 = 上游偷偷换了模型（付 2× 拿 spark）。这正是要抓的东西。
     *
     * # ⚠ 读法（这是本文件最危险的一段代码，改之前先读完）
     *
     * `Response.clone()` **绝不能用**：它与原响应共享底层流，读到 EOF 会压平
     * 时间轴（T-28 真机事故）。所以用 `body.tee()`：
     *
     *	[a, b] = stream.tee()
     *	 → 宿主读 `a`
     *	 → 我们只读 `b`，拿到首个 model 就 `cancel()`
     *
     * # ⚠⚠ 为什么必须返回**箭头闭包**而不是普通函数（真机回归一次）
     *
     * tee 是「把一条流拆成两条，谁先拉谁就带动缓冲区」。第一版直接把 `a` 塞回
     * `resp.body`（`defineProperty`），看似没变，实际造出两个问题：
     *
     *	① `Response.text()/json()` 读的是**内部槽**而不是 `body` 访问器 ——
     *	   原对象一旦被 tee 过，`text()` 立刻抛 `Body is unusable`。宿主（magpie）
     *	   恰恰会调 `text()` / `json()`，于是每一次普通对话都变成失败响应。
     *	② 我们这支读者的拉取节奏会**决定** `a` 何时被填 —— 观察分支不读，
     *	   `a` 就一直等（因为 tee 的缓冲上限把底层流顶住）。
     *
     * 正确做法：返回一个**自己 new 出来的 Response**（`new Response(a, …)` 的读法
     * 是「从 a 拉」，不存在内部槽问题），并且**主动把 `a` 泵给它的输出**：
     * 这样我们这支读者永远有数据可读，而宿主那支完全按上游节奏前进。
     *
     * @param {Response} resp 上游原始响应（**已在被宿主读取**的那个）
     * @param {{requested: string, uid: string}} input
     * @returns {Response|null} 需要替换时返回新响应；不需要观察时返回 null
     */
    function teeServedModel(resp, { requested, uid }) {
      try {
        if (!configDir || !uid || !requested) return null
        if (Number(resp?.status) !== 200) return null
        if (!isStreamResponse(resp)) return null
        const stream = resp.body
        if (!stream || typeof stream.tee !== "function") return null

        // ⚠ tee 必须在宿主开始读**之前**调（本函数就在 fetch 返回前同步调用）。
        const [forHost, forPeek] = stream.tee()

        void watchFirstModel(forPeek)
          .then((served) => {
            if (!served) return
            return applyServedModel({ configDir, uid, requested, served, routeStore: storeOpt, log: { warn }, now })
          })
          .catch(() => {})

        return ResponseWithTeedBody(resp, forHost)
      } catch {
        // 旁路证据失败绝不能影响响应：调用方继续用原 resp
        return null
      }
    }

    /**
     * 只改两处，其余原样交给宿主。
     *
     * @param {string|URL} input
     * @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    async function fetch(input, init = {}) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input)
      const headers = new Headers(init.headers)

      /** 这一次对话请求的**期望模型**（出站 body 里的 model）—— 旁路观察用。 */
      let requestedModel = ""
      const callUid = accountUid(auth)

      /** @type {RequestInit} */
      const next = { ...init, headers }

      // ── 只读观察（不阻止任何请求）──
      // routed 账号真的被请求到了就记一行；无论如何继续往下走。
      await noteIfRouted(init.body)

      // 对话请求的真实流量证据（`void`：绝不 await，绝不拖慢请求）
      if (!url.includes(IMAGE_PATH_HINT)) noteTraffic(init.body)

      // ── 客户端指纹：UA（两条链路都补）──
      //
      // 客户端是 Electron，默认发 Chromium UA；我们走 Node，默认是 `undici`/空 ——
      // 这是最显眼的「不是客户端」痕迹。宿主/调用方设了就不覆盖。
      if (!headers.has("user-agent")) headers.set("User-Agent", userAgent)

      if (url.includes(IMAGE_PATH_HINT)) {
        // 生图端点实测**两个头都认**，且官方客户端也是两个都发。
        // Authorization 由宿主按 apiKey 装好了，这里补 token。
        // ⚠ 生图**不**带 traceparent / purpose / Accept-Encoding：客户端生图链路
        //   自己发那一套，把两条链路的指纹混在一起反而可疑。
        headers.set("token", session)
        // 生图请求体是 {model,prompt,n,size,usage,response_format}，没有 stream，
        // 硬套 prepareBody 只会把 body 弄坏 —— 原样发。
      } else {
        // 对话：补齐与**客户端 1:1** 的完整头组（抓包实证），再改写 body。
        //
        // 客户端的三条形态（缺一条就「不像客户端」）：
        //	① ChatId: chat-<uuid>；MsgId 与 TurnId **同一个值** msg-<uuid>
        //	② X-Session-Affinity: ses_<20位>，**按 uid 稳定**（不是随机）
        //	③ Accept: */* 、Accept-Encoding 含 zstd
        const uid = accountUid(auth)
        const existingTurn = String(headers.get("turnid") ?? "").trim()
        // 调用方给了 turnId 就沿用它，且 msgId 与它同值（客户端就是这么发的）
        const turn = existingTurn || genTurnId()
        const chatId = String(headers.get("chatid") ?? "").trim() || `chat-${globalThis.crypto.randomUUID()}`
        const msgId = String(headers.get("msgid") ?? "").trim() || turn

        chatHeaders(headers, { session }, {
          version: loomyVersion,
          chatId,
          msgId,
          turnId: turn,
          invokeOrigin: "user",
          sessionAffinity: uid ? sessionAffinity(uid) : "",
        })
        if (!headers.has("accept-encoding")) headers.set("Accept-Encoding", CLIENT_ACCEPT_ENCODING)
        // 「期望模型」= 调用方（magpie）要的那个 —— 与响应体里的实际模型比对用
        requestedModel = modelOf(typeof init.body === "string" ? init.body : "")
        // ── body 改写（四种模式，见 constants 的 DEFAULT_BODY_MODE）──
        //
        //	passthrough  完全不动（逐字节原样，「我就是要原始的 BODY」）
        //	default      只补 stream=true + stream_options
        //	client-body  **以抓包的完整客户端 body 为底**（默认；用户要「伪装成客户端」）
        //	client-shape 按字段补（旧实现，保留兼容）
        if (bodyMode !== "passthrough" && (typeof init.body === "string" || init.body == null)) {
          next.body = rewriteBody(init.body, bodyMode)
        }
      }

      const resp = await doFetch(url, next)

      /** @type {Response} 交给宿主的响应（默认就是上游那个） */
      let out = resp

      // ── 实际服务模型（旁路读取，绝不改行为）──
      //
      // 只在 200、对话接口、**且响应真的是流**时才看：
      //	· 429/5xx 那一轮根本没有「实际服务模型」可言；
      //	· 非流式 JSON（`application/json`）由下面的 sign-in peek **整读**，
      //	  提前 tee 会把那一次整读变成「Body has already been read」——
      //	  而这类响应的正文本来就带 `model`，不需要再观察。
      //
      // ⚠ 必须在**返回给宿主之前**同步调用（tee 要在宿主开始读流之前发生）。
      if (!url.includes(IMAGE_PATH_HINT) && requestedModel) {
        const teed = teeServedModel(resp, { requested: requestedModel, uid: callUid })
        if (teed) out = teed
      }

      // ── 429 = 瞬时限流，**不是封号** ──
      //
      // 真机实测：同一账号连打 10 次，状态码序列 200,429,200,429,429,200,200,429,200,200，
      // 之后 /models 仍返回 DS4.1 —— 账号完全可用。用户体感「用一会儿就被禁」的
      // 真相是我们把 429 当成失败：宿主反复重试 → 限流恶化 → 巡检误判成 routed。
      //
      // 所以这里只做两件**不改变响应**的事：
      //	① 记一条内存冷却（同号下次 429 会刷新），供 `auth.usage` 短暂避开这个号
      //	② 什么都不改：状态码 / body / header 原样交回宿主，不重试、不合成
      if (resp.status === 429) {
        noteRateLimited(accountUid(auth), resp.headers.get("retry-after"), now())
      }

      // ── 只做一件事：把「这次失败是不是登录问题」如实告诉宿主 ──
      //
      // magpie 的默认判据是「401 → 标记账号需要重新登录」。而本上游有三种
      // 完全不同的失败形状，其中两种**不是**登录问题（模型不可用、内容拦截）。
      // 标错的代价是把一个健康账号打成「需要重新登录」，用户会去删一个好好的号。
      //
      // ⚠ 上游的业务失败也可能是 HTTP 200（`{"code":"100002","desc":"缺少 token"}`），
      // 所以 200 也要看正文 —— **但只看有界的 JSON**。
      //
      // # 为什么 200 + 流式**绝不能** peek（真机事故，T-28）
      //
      // 上一版无条件 `!resp.ok || resp.status === 200` → 所有 200 都 peek，
      // 而 peek 当时是 `clone().text()` 读到 EOF。`resp.clone()` 与原响应共享底层
      // 流：clone 读到 EOF ⇒ 原分支的 chunk 被全部缓冲、在宿主开始读时一次性放出
      // ⇒ 首 token 与末 token 的到达时间差 ≈ 0 ⇒ magpie 的 decode_ms / decode_tps
      // 全算不出来（实测：loomy 所有账号 decode 均速为空，其它上游正常；ttft 不受
      // 影响，因为首字节到达时间仍然真实）。
      //
      // 现在两道闸：① 只有「非 2xx」或「200 + application/json」才值得看正文；
      //             ② 看就**整读**（JSON 有界、非流），绝不 cancel（见 peekVerdict）。
      const contentType = resp.headers.get("content-type") ?? ""
      const looksJson = /application\/json/i.test(contentType)
      // 200 要看正文的唯一正当理由：上游把业务失败塞进 200（本上游已知
      // `{"code":"100002"}`）。那类响应 Content-Type 是 application/json
      // （Content-Length 有界、非流式）；流式（text/event-stream）的 200 **绝不能碰**。
      const worthPeeking = !resp.ok || (resp.status === 200 && looksJson)
      if (worthPeeking) {
        const verdict = await peekVerdict(resp)
        if (verdict) {
          const headers2 = new Headers(resp.headers)
          applySignInHeader(headers2, verdict)
          return new Response(out.body, {
            status: out.status,
            statusText: out.statusText,
            headers: headers2,
          })
        }
      }
      return out
    }

    return {
      baseURL: undefined, // 用 provider.api（config 里已声明）
      apiKey: session,
      headers: {},
      fetch,
    }
  }
}

/** 判断登录态时最多看多少字节正文（够认出错误 JSON / 一句话文案即可）。 */
export const PEEK_LIMIT_BYTES = 4096

/**
 * 这个响应是不是**流**（`text/event-stream`，或没声明类型但有 body）。
 *
 * # 为什么这条判据很重要（T-38 真机回归）
 *
 * 旁路观察首块模型要用 `body.tee()`。而同一个 200 如果 Content-Type 是
 * `application/json`，下面的 sign-in peek 会**整读**它 —— tee 之后 `resp.body`
 * 指向我们换上的那一支，`resp.clone().text()` 立刻抛
 * `Body is unusable: Body has already been read`，于是**每一次普通 JSON 对话
 * 都变成了登录失效的错误响应**（真机表现为整批请求 401 式失败）。
 *
 * 所以两条路必须互斥：
 *
 *	流（text/event-stream / 未声明类型） → 旁路观察首块，**绝不 clone**
 *	JSON                                 → sign-in peek 整读，**绝不 tee**
 *
 * @param {Response} resp
 * @returns {boolean}
 */
export function isStreamResponse(resp) {
  if (!resp) return false
  const type = String(resp.headers?.get?.("content-type") ?? "").toLowerCase()
  if (type.includes("text/event-stream")) return true
  // 没写 Content-Type 但有正文：按流处理（当成 SSE 读首块是安全的，读到即停）
  if (!type && resp.body) return true
  return false
}

// ─────────────────────────────────────────────────────────────────────────
// 「实际由哪个模型服务」的旁路观察 —— 只读、限量、绝不 cancel 原流
// ─────────────────────────────────────────────────────────────────────────
//
// # 事实（真机实测，stream:true）
//
//	POST /api/v1/chat/completions  →  text/event-stream
//	data: {"object":"chat.completion.chunk","model":"deepseek-v4-flash-1017",
//	       "choices":[{"delta":{"reasoning_content":"The"}}]}
//
// **每个 chunk 都带 `model`**，就是这一轮真实服务我们的模型。所以「上游有没有
// 偷偷换模型」不必再另打一次 `/points/by-turn` —— 响应体已经把答案送到手边。
//
// # 两条红线（与 T-28 / T-29 的教训同源）
//
//	① **绝不 `Response.clone()`**：clone 出来的两支共享同一条底层流，读到 EOF
//	   会把 chunk 全缓冲、压平时间轴 ⇒ magpie 的 decode_ms 变成空值。
//	② **绝不 `reader.cancel()`**：取消会连坐到上游 source。
//
// 安全做法是 `body.tee()`：第二支是**独立的** ReadableStream，读到首个带 model
// 的 chunk 就 `stop()`（只结束它自己），宿主那一支完全不受影响。

/** 观察首块模型时最多缓冲多少字节（SSE 的首个 data 行远小于它）。 */
export const MODEL_PEEK_LIMIT_BYTES = 4096

/** 观察首块模型最多等多久（毫秒）——超时静默放弃，绝不拖住任何东西。 */
export const MODEL_PEEK_TIMEOUT_MS = 10_000

/**
 * 从一段 SSE 文本里取出**第一个** `data:` 的 JSON 的 `model` 字段。
 *
 * 非 JSON（`[DONE]`、心跳、空行）一律跳过。返回空串表示「这一段里还没有」。
 *
 * @param {string} text
 * @returns {string}
 */
export function extractFirstModel(text) {
  const s = String(text ?? "")
  if (!s) return ""
  for (const line of s.split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw.startsWith("data:")) continue
    const payload = raw.slice("data:".length).trim()
    if (!payload || payload === "[DONE]" || payload.startsWith("{")) {
      if (!payload.startsWith("{")) continue
      try {
        /** @type {any} */
        const obj = JSON.parse(payload)
        const model = String(obj?.model ?? "").trim()
        if (model) return model
      } catch {
        // 半截 JSON：还没读全，继续攒
      }
      continue
    }
    // `data: openai/gpt-x`（纯文本形态）：认它也是一种证据
    return payload
  }
  return ""
}

/**
 * 读流的前若干字节，返回首个带 `model` 的值。
 *
 * 读到即停（`reader.cancel()` 只作用于 tee 出来的**第二支**，与原流无关）。
 * 超时 / 字节上限 / 流结束 / 任何异常 → 返回空串，一行日志都不写。
 *
 * @param {ReadableStream<Uint8Array>} stream tee 出来的观察分支
 * @param {{limitBytes?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<string>}
 */
export async function watchFirstModel(stream, opts = {}) {
  const limit = Number(opts.limitBytes) > 0 ? Number(opts.limitBytes) : MODEL_PEEK_LIMIT_BYTES
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : MODEL_PEEK_TIMEOUT_MS
  if (!stream || typeof stream.getReader !== "function") return ""

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0

  /** 只结束观察分支：`cancel` 在这里是安全的（它不是 clone 共享的那条流）。 */
  const stop = () => {
    try {
      reader.cancel().catch(() => {})
    } catch {
      /* 观察分支的收尾失败不影响任何东西 */
    }
  }

  let timer = 0
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("__timeout__"), timeoutMs)
    timer.unref?.()
  })

  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timeout])
      if (next === "__timeout__") {
        stop()
        return ""
      }
      if (!next || next.done) break
      text += decoder.decode(next.value ?? new Uint8Array(0), { stream: true })
      bytes += next.value?.byteLength ?? 0
      const found = extractFirstModel(text)
      if (found) {
        stop()
        return found
      }
      if (bytes >= limit) {
        stop()
        return ""
      }
    }
    const tail = decoder.decode()
    return extractFirstModel(text + tail)
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 用 tee 出来的**宿主那一支**拼一个可正常读取的 Response，并把它泵起来。
 *
 * # 为什么不直接在原对象上改 `body`
 *
 * `Response` 的 `text()` / `json()` / `arrayBuffer()` 读的是**内部槽**（`[[body]]`），
 * 不是 `body` 访问器。所以 `Object.defineProperty(resp, "body", …)` 只是把访问器
 * 换了，内部槽仍然指向那条**已经被 tee 过**的流 —— 一次 `resp.text()` 就抛
 * `Body is unusable: Body has already been read`（真机：每次普通 JSON 对话都失败）。
 *
 * `new Response(stream, …)` 的读法是从 `stream` 拉，没有这个耦合。
 *
 * # 为什么还要「泵」
 *
 * `tee` 的两支共享一个缓冲区；谁先拉得多，另一支就积压。我们的观察分支只读到
 * 首个 model 就停（之后不拉），若不主动把 `a` 泵给新响应的输出，`a` 迟早会因为
 * 缓冲上限把底层流顶住，**上游节奏被我们拖慢** ⇒ 时间轴失真。
 *
 * 泵是零拷贝的（`enqueue(chunk)` 直接转发原始 `Uint8Array`），只是把「拉」与
 * 「给」两件事解耦。
 *
 * @param {Response} resp 原响应（状态码 / 头从这里抄）
 * @param {ReadableStream<Uint8Array>} stream 宿主要读的那一支
 * @returns {Response}
 */
export function ResponseWithTeedBody(resp, stream) {
  const source = stream.pipeThrough(new TransformStream())
  return new Response(source, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  })
}

/**
 * 把响应对象的正文换成另一条流（**已弃用，仅保留给旧调用方**）。
 *
 * ⚠ 它会把 `text()` / `json()` 弄坏（见 `ResponseWithTeedBody` 的解释）。
 * 新代码一律用 `ResponseWithTeedBody`；这里只做一次性的兼容包装。
 *
 * @deprecated
 * @param {Response} resp
 * @param {ReadableStream<Uint8Array>} body
 * @returns {Response}
 */
export function replaceResponseBody(resp, body) {
  return ResponseWithTeedBody(resp, body)
}

/**
 * 把「实际服务模型」落到账号指针上（`route-state` 的**旁路**）。
 *
 * # 落盘规则
 *
 *	实际 == 期望                → 清掉 routed 标记（干净）
 *	实际 != 期望（都在已知族内） → 记 routed + `served-model-mismatch`
 *	族认不出 / 读不到 store     → **什么都不写**（半个证据不封号）
 *
 * ⚠ 只写 `servedModel` / `verdict` / `checkedAt` 这三个字段，**不覆盖**已有的
 *   `catalogOkAt`（那是巡检的时间戳）。写失败只记日志。
 *
 * @param {{configDir: string, uid: string, requested: string, served: string,
 *   routeStore?: any, log?: {warn?: Function}, now?: () => number}} opts
 * @returns {Promise<void>}
 */
export async function applyServedModel(opts) {
  const { configDir, uid, requested, served } = opts
  const warn = (m) => {
    try {
      opts.log?.warn?.(m)
    } catch {
      /* 日志失败不是业务失败 */
    }
  }
  try {
    const store = await loadRouteStore({ routeStore: opts.routeStore })
    if (typeof store?.writeRouteState !== "function") return

    const same = String(requested).trim().toLowerCase() === String(served).trim().toLowerCase()
    const family = (name) => {
      const low = String(name ?? "").trim().toLowerCase()
      if (low.startsWith("deepseek")) return "deepseek"
      if (low.startsWith("spark")) return "spark"
      if (low.startsWith("glm")) return "glm"
      if (low.startsWith("qwen")) return "qwen"
      return ""
    }
    const asked = family(requested)
    const got = family(served)
    // 族认不出就不下结论（认错族会把好号判死）
    if (!asked || !got) return

    const prior = typeof store.getAccountRoute === "function" ? store.getAccountRoute(configDir, uid) : null
    const verdict = same ? "clean" : "routed"
    if (verdict === "routed") {
      warn(`loomy: 账号 ${uid} 请求 ${requested}，响应体里实际由 ${served} 服务（记录，不做拦截）`)
    }
    store.writeRouteState(configDir, uid, {
      ...(prior && typeof prior === "object" ? prior : {}),
      verdict,
      reason: same ? "served-model-match" : "served-model-mismatch",
      servedModel: served,
      requested,
      checkedAt: typeof opts.now === "function" ? opts.now() : Date.now(),
    })
  } catch {
    // 旁路观察的落盘失败不影响任何请求
  }
}

/**
 * 看响应正文，判断「这次失败是不是登录问题」。
 *
 * # 为什么**整读**是对的，而「限量读 + cancel」是错的（T-29 真机事故）
 *
 * 上一版用 `resp.clone().body.getReader()` 读满 4 KB 再 `reader.cancel()`。
 * `Response.clone()` 的两个分支**共享同一条底层流**：取消 clone 分支的
 * reader 会波及**原分支**（上游 source 被 cancel），原响应从此再也产不出
 * 数据 —— magpie 读流永远等不到结束，测试直接 15s 超时。
 *
 * 能走到这里的前提（调用点那两道闸，见 loader 里的 `worthPeeking`）：
 * **非 2xx** 或 **200 + application/json**。这两类响应都有 `Content-Length`、
 * 体积小、**不是流**，所以整读永远是安全的。真正不能碰的是
 * `text/event-stream` 的 200 —— 那种情况**一次都不 clone**。
 *
 * # 两条红线
 *
 *	1. `text/event-stream` 的 200：**一次都不 clone**（clone 读 EOF 会压平
 *	   时间轴，cancel 会连坐原流）
 *	2. 一旦 clone，就**只能整读，不能 cancel**（cancel 会连带取消原分支）
 *
 * @param {Response} resp
 * @returns {Promise<"expired"|"kept"|null>}
 */
export async function peekVerdict(resp) {
  const status = Number(resp?.status ?? 0)

  // ① 401/403：只看状态码，不碰流
  if (status === 401 || status === 403) {
    const hinted = String(resp?.headers?.get?.(SIGN_IN_HEADER) ?? "").trim().toLowerCase()
    if (hinted === "expired" || hinted === "kept") return hinted
    return "expired"
  }
  // ② 5xx：账号级失败，状态码已说明一切
  if (status >= 500) return "kept"

  // ③ 其余（只可能是 JSON / 错误体）：整读。JSON 有界，且不是流。
  //    ⚠ 绝不要用 clone().body.getReader() + cancel：取消会波及原分支，
  //    让原响应产不出数据（真机表现为 magpie 读流永远等不到结束）。
  let text = ""
  try {
    text = await resp.clone().text()
  } catch {
    // 流已被读过 / 不是文本：不表态，交给宿主默认判据
    return null
  }
  return signInVerdict(status, text.slice(0, PEEK_LIMIT_BYTES))
}
