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
import { signInVerdict, applySignInHeader } from "../upstream-facts.mjs"
import { recordTraffic as recordTrafficDefault } from "../traffic.mjs"

/** 生图端点路径片段（用来判断该不该补 token 头）。 */
const IMAGE_PATH_HINT = "/images/generations"

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
     * 只改两处，其余原样交给宿主。
     *
     * @param {string|URL} input
     * @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    async function fetch(input, init = {}) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input)
      const headers = new Headers(init.headers)

      /** @type {RequestInit} */
      const next = { ...init, headers }

      // ── 只读观察（不阻止任何请求）──
      // routed 账号真的被请求到了就记一行；无论如何继续往下走。
      await noteIfRouted(init.body)

      // 对话请求的真实流量证据（`void`：绝不 await，绝不拖慢请求）
      if (!url.includes(IMAGE_PATH_HINT)) noteTraffic(init.body)

      if (url.includes(IMAGE_PATH_HINT)) {
        // 生图端点实测**两个头都认**，且官方客户端也是两个都发。
        // Authorization 由宿主按 apiKey 装好了，这里补 token。
        headers.set("token", session)
        // 生图请求体是 {model,prompt,n,size,response_format}，没有 stream 字段，
        // 硬套 prepareBody 只会把 body 弄坏 —— 原样发。
      } else if (typeof init.body === "string" || init.body == null) {
        // 对话：强制 stream=true + 按模型裁剪 max_tokens
        next.body = prepareBody(init.body)
      }

      const resp = await doFetch(url, next)

      // ── 只做一件事：把「这次失败是不是登录问题」如实告诉宿主 ──
      //
      // magpie 的默认判据是「401 → 标记账号需要重新登录」。而本上游有三种
      // 完全不同的失败形状，其中两种**不是**登录问题（模型不可用、内容拦截）。
      // 标错的代价是把一个健康账号打成「需要重新登录」，用户会去删一个好好的号。
      //
      // ⚠ 上游的业务失败也可能是 HTTP 200（`{"code":"100002","desc":"缺少 token"}`），
      // 所以 200 也要看正文。
      if (!resp.ok || resp.status === 200) {
        const verdict = await peekVerdict(resp)
        if (verdict) {
          const headers2 = new Headers(resp.headers)
          applySignInHeader(headers2, verdict)
          return new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers: headers2,
          })
        }
      }
      return resp
    }

    return {
      baseURL: undefined, // 用 provider.api（config 里已声明）
      apiKey: session,
      headers: {},
      fetch,
    }
  }
}

/**
 * 偷看响应正文的前若干字节，判断登录态语义。
 *
 * ⚠ 用的是 `resp.clone()` —— 原响应体必须原样交回宿主，绝不能因为
 * 我们看了一眼就把流吃掉。
 *
 * @param {Response} resp
 * @returns {Promise<"expired"|"kept"|null>}
 */
async function peekVerdict(resp) {
  try {
    const text = await resp.clone().text()
    return signInVerdict(resp.status, text.slice(0, 4096))
  } catch {
    // 流已被读 / 不是文本：不表态，交给宿主默认判据
    return null
  }
}
