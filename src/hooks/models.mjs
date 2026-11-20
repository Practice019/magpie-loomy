// models.mjs 模型目录 —— 目录的**正源**。
//
// # 目录是 **provider 级**的，不是账号级的（这一条是 T-38 的核心修正）
//
// 曾经这里每个账号各拉一次 `/api/v1/models`，零缓存：
//
//	301 个账号 × 每次 magpie 重读模型列表 = 301 次请求；
//	开发者一天重启 8 次 ≈ 2400 次。
//
// 服务端判成**批量探测** ⇒ 风控 ⇒ session 失效（实测 19 个 expired，18 个是
// session-expired）。**掉号的根因就是我们自己打的这些请求。**
//
// 但模型列表对所有账号相同（是 provider 的属性），按账号问一遍毫无必要。
// 现在的读取顺序（也是用户的明确要求：「更新缓存我们控制不要自动」「不会过期」
// 「重启不要发请求」）：
//
//	① 「这个号不能接活」的判定（目录置空）—— 只读本地状态文件，零上游
//	   ⚠ **必须排在 ② 之前**：缓存命中会直接返回，判定写在它后面就永远轮不到
//	   （T-44 真机回归：210 个 routed 号被缓存里的旧目录填了回来）
//	② 文件缓存命中 → 直接返回，**绝不请求上游**（`src/models-cache.mjs`，无 TTL）
//	③ 未命中 → 整个 provider 只拉**一次**（模块级 in-flight 去重）
//	④ 拉成功 → 写缓存 → 返回
//	⑤ 拉失败 → 回退静态表，**不写缓存**（下次还能重试）
//
// # 为什么静态表只是冷启动兜底
//
// 实测上游**按账号权限下发不同模型集**（一个号 10 个、另一个号另一组）。
// 所以真正准确的目录必须来自一次真实的 `/models`；但**一次就够**，静态表负责
// 「还没拉过 / 拉失败 / 未登录」这三种情况，保证界面上不会一个模型都没有。
//
// # 失败时必须回退而不是抛空
//
// magpie 的契约：钩子失败 / 抛异常 / 返回空，宿主保留原有列表。
// 所以这里**主动返回静态表**并在失败时打日志 —— 比让宿主猜更可控。
//
// # 被上游限制的账号 → 返回**空目录**（这是「别选我」的唯一正确表达）
//
// magpie 的 `plugin-providers.json` 里每个账号都有自己的 `models` 数组，
// 路由只在这份列表里选模型。实测：184 个号里有 90 个上游只下发
// `spark-x2.6-low / spark-x2.6-4b`，magpie 就天生不会给它们派 DS4.1。
//
// 所以「这个号不要接活」用**目录**说，不用错误码说：
//
//	目录空 ⇒ 没有该模型 ⇒ 路由不派活 ⇒ 不产生失败、不触发换号、不触发禁用。
//
// 两种结论都置空：
//
//	routed   上游把整号改路由（付 2× 拿 spark），发出去是白付钱
//	expired  session 已过期，发出去只会 401，白耗一次换号
//
// ⚠ 注意 `expired` 的「正确 UI 表达」不在本文件，而在 `auth.usage` 的
// `signIn: "expired"`（magpie 原生字段，会把账号标成「登录已失效」）。
// 目录这里只是顺手把请求掐掉，避免白白打到失效的 session 上。
//
// ⚠ 没有判定（`unknown` / 根本没有记录）**仍然返回完整目录**，这是刻意的：
// 「未验证」不等于「不可用」。新导入的号在后台探测跑完前一律 unknown，若那时
// 就给空目录，用户会看到「刚导入就全不能用」。收敛策略是**先给目录 + 后台
// 探测尽快出结论**（`src/importer.mjs` 导入成功后 `void` 跑一次探测并落盘），
// 而不是先封后放。
//
// ⚠ 曾经反着做过两道：`loader` 回 503（magpie 把 5xx 当账号故障，一批号被
// 标记失败/禁用 —— 真机事故）、`usage` 报 `used:100`（卡片显示「剩余 0」，
// 用户以为号没额度了）。两条都已撤掉：**排除只能走目录**。
//
// ⚠ 已知风险（留给联调确认）：AGENTS/本文件里记着「钩子失败 / 抛异常 /
// **返回空**，宿主保留原有列表」。若 magpie 真把 `{}` 当成「这次没拉到」
// 而沿用旧列表，那空目录这条排除就会静默失效（症状是「照旧被路由」，
// 而不是「号被禁用」—— 比 503 安全得多）。届时改为给一个哨兵模型也不行，
// 必须由宿主侧确认空数组的语义。

import { PROVIDER, DEFAULT_BASE_URL, MODELS_PATH } from "../constants.mjs"
import { modelsAuth } from "./../auth-headers.mjs"
import { parseNameMultiplier } from "../multipliers.mjs"
import { availableModels, IMAGE_MODEL_IDS } from "../models.mjs"
import { readCachedModels, writeModelsCache } from "../models-cache.mjs"
// 路由判定的读取器官在 loader（它是 `accountKeys`/`accountRoute` 的所有者）。
// 依赖方向：hooks/models → hooks/loader → src/{prepare-body,upstream-facts}，
// 没有回边，也不会反向摸到 index.mjs。
import { accountKeys, accountRoute } from "./loader.mjs"

/** 拉目录的超时（一次目录请求不该占住太久）。 */
const CATALOG_TIMEOUT_MS = 15_000

/**
 * 模块级 in-flight 去重表：`baseUrl` → **正在飞**的 Promise<any[]>。
 *
 * # 为什么必须是**模块级**
 *
 * `provider.models` 是**每个账号调一次**的（magpie 的模型列表钩子）。301 个
 * 账号并发进来时，如果去重表挂在 hook 实例上那是 301 份；挂在模块上才是 1 份
 * ⇒ **整个 provider 只产生 1 次上游请求**。
 *
 * # ⚠ 它只在**在飞**那一刻有意义（真机回归过的坑）
 *
 * 第一版把它当永久缓存（成功之后也留着）。后果有两个，都很安静：
 *
 *	· **换号就串目录**：第二个账号（也可能是另一份配置 / 另一个插件实例）
 *	  进来时拿到的是上一个请求的 Promise ⇒ 目录属于别人；
 *	· 把「缓存」这个职责从**文件缓存**手里偷走了 —— 于是刷新文件的语义失效
 *	  （删了缓存文件也不生效，因为内存里还有一份），这与用户的
 *	  「更新缓存我们控制」直接冲突。
 *
 * 现在的约定：**Promise 一结束就从表里删掉**（成功、失败都删）。
 * 授权状态只存放在 `src/models-cache.mjs` 的文件里 —— 两个缓存源 = 两份真源。
 *
 * @type {Map<string, Promise<any[]>>}
 */
const inflight = new Map()

/** 仅供测试：清空 in-flight 表（同一进程内跨用例隔离）。 */
export function resetCatalogInflight() {
  inflight.clear()
}

/**
 * 「这条置空日志已经打过」的键集合（模块级，见 {@link logOnce}）。
 *
 * @type {Set<string>}
 */
const warned = new Set()

/** 仅供测试：清空日志节流表（同一进程内跨用例隔离）。 */
export function resetModelsWarned() {
  warned.clear()
}

/**
 * 同一进程内，同一条「置空原因 × 同一个账号」只打**一次**日志。
 *
 * # 为什么要节流
 *
 * `provider.models` 是**每读一次模型列表**就调一轮的（真机 301 个账号）。
 * 一条置空日志在每轮里重复 301 次，会把「谁被置空、为什么」彻底淹没 ——
 * 用户要的是「从日志判断」，不是一屏重复。
 *
 * 键是 `原因|账号`：换账号、换结论都会再打一条，所以信息不会丢。
 * 表是模块级的：**进程重启会重新打一遍**（这是想要的 —— 重启后排障人
 * 从零开始看日志）。
 *
 * @param {any} log
 * @param {string} kind `verdict` 或 `"routecheck-off"`
 * @param {string} [key] 命中的账号键
 * @param {string} message
 */
function logOnce(log, kind, key, message) {
  const id = `${kind}|${String(key ?? "")}`
  if (warned.has(id)) return
  warned.add(id)
  try {
    log.warn?.(message)
  } catch {
    /* 日志失败不是业务失败 */
  }
}

/**
 * 构建 `provider.models` 钩子。
 *
 * @param {{baseUrl?: string, fetchImpl?: typeof fetch, log?: {warn: Function},
 *   configDir?: string, routeStore?: any, routeCheck?: boolean}} [opts]
 *   `configDir` / `routeStore`：读「这个账号是不是被上游限制了」。
 *   `routeCheck`：界面开关 `routecheck`（默认 **开**）。关掉 = `routed` 不再置空目录，
 *   账号会继续被派活（付 2× 拿降级模型）。`expired` / `exhausted` **不受影响**——
 *   那两个不是"上游把号换掉了"，是"这个号自己坏了"，继续派活只会白刷 401/402。
 * @returns {(provider: any, ctx?: {auth?: any}) => Promise<Record<string, object>>}
 */
export function makeModelsHook(opts = {}) {
  const baseUrl = String(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = opts.log ?? console
  const configDir = String(opts.configDir ?? "").trim()
  const storeOpt = opts.routeStore
  const routeCheck = opts.routeCheck !== false

  return async function models(provider, ctx = {}) {
    const auth = ctx?.auth
    // 未登录：回静态表（否则界面上这个供应商一个模型都没有）
    if (!auth?.access) {
      return toMagpieModels(provider, staticEntries())
    }

    // ── ① 置空判定：这个号不该再收到任何请求（**排在缓存之前**）──
    //
    // ⚠ 顺序是这个功能的全部。`catalogOnce` 的第一步一旦命中
    // `<configDir>/loomy-models-cache.json` 就**直接返回**（用户要求「不会过期」
    // 「重启不要发请求」），判定若写在它后面就永远轮不到 —— 真机症状正是这样：
    // 210 个 routed 号带着缓存里的 9 个模型回到面板，可用号显示 281 而实际只有 71
    // （`expired` / `exhausted` 因为当时判定在前，没受影响）。
    //
    // 三种结论都置空：
    //	routed    —— 上游把整号改路由（付 2× 拿 spark），发出去也是白付钱
    //	expired   —— session 已过期，发出去只会 401，白耗一次换号
    //	exhausted —— 余额不足（402），发出去只会再 402
    // ⚠ 这里返回 `{}` 而不是「删掉某个模型」：整号坏（实测 GLM / qwen / 两个
    // deepseek 全部落到 spark-x2.6-low），只删一个模型等于让别的模型继续被换掉。
    // ⚠ `{}` 是 magpie 认的「该号无模型 ⇒ 路由跳过」，不是「这次没拉到」。
    const hit = await lookupRoute(auth, { configDir, routeStore: storeOpt })
    const verdict = hit?.entry?.verdict
    const served = String(hit?.entry?.servedModel ?? "").trim() || "上游其它模型"
    // `routecheck` 关掉时，只放过 `routed`（见 opts 注释）；仍在日志里留一句，
    // 否则"我明明关了开关，号还是被换了模型"这件事查起来没有线索。
    const routed = verdict === "routed"
    const blocking = verdict === "expired" || verdict === "exhausted" || (routed && routeCheck)
    if (routed && !blocking) {
      logOnce(
        log,
        "routecheck-off",
        hit.key,
        `loomy: 账号 ${hit.key} 已被上游改路由（全部模型实际由 ${served} 服务），` +
          `但界面开关 routecheck 已关闭 —— 目录照常列出，路由仍会派活`,
      )
    }
    if (blocking) {
      logOnce(
        log,
        verdict,
        hit.key,
        verdict === "expired"
          ? `loomy: 账号 ${hit.key} 登录已失效（session 过期），目录置空（不派活）`
          : verdict === "exhausted"
            ? `loomy: 账号 ${hit.key} 积分余额不足（上游 402），目录置空（不派活）`
            : `loomy: 账号 ${hit.key} 已被上游改路由（全部模型实际由 ${served} 服务），目录置空（不派活）`,
      )
      return {}
    }

    try {
      const live = await catalogOnce({
        baseUrl,
        configDir,
        session: auth.access,
        fetchImpl: doFetch,
        log,
      })
      if (!live || live.length === 0) return toMagpieModels(provider, staticEntries())
      return toMagpieModels(provider, live.map(withMultiplier))
    } catch (e) {
      // ⚠ 不抛：抛了宿主也只会保留旧列表，但日志里就没有线索了。
      log.warn?.(`loomy: 拉取实时模型目录失败，回退静态表: ${e?.message ?? e}`)
      return toMagpieModels(provider, staticEntries())
    }
  }
}

/**
 * 取一次目录：**先文件缓存、再上游**，全程最多一次上游请求。
 *
 * # 这是唯一允许打 `/models` 的地方（provider 级）
 *
 * 顺序与理由见本文件顶部。这里额外做两件事：
 *
 *	· 并发去重：`inflight` 挂在**模块级**，301 个账号同时进来只产 1 次请求
 *	  （表项在 Promise 结束时删掉 —— 它只表示「在飞」，缓存职责在文件里）；
 *	· 失败不写缓存：`fetchCatalog` 抛错时直接向上抛，缓存里不会留下半份数据
 *	  （否则一次网络抖动会被永久记住 —— 用户说的「不会过期」指的是**成功**的目录）。
 *
 * @param {{baseUrl: string, configDir: string, session: string,
 *   fetchImpl: typeof fetch, log?: {warn?: Function}, now?: () => number}} opts
 * @returns {Promise<any[]>}
 */
async function catalogOnce(opts) {
  const key = String(opts.baseUrl ?? "").trim().replace(/\/+$/, "")
  if (!key) throw new Error("baseUrl 为空")

  // ① 文件缓存命中 ⇒ 直接返回，**绝不请求上游**
  const cached = readCachedModels(opts.configDir, key)
  if (cached !== null) return cached

  // ② 未命中 ⇒ 同一个 baseUrl 的并发调用共享同一个 Promise（只打一次上游）
  const running = inflight.get(key)
  if (running) return running

  const task = (async () => {
    const list = await fetchCatalog({
      baseUrl: opts.baseUrl,
      session: opts.session,
      fetchImpl: opts.fetchImpl,
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    })
    // ③ 拉成功 ⇒ 写缓存。**空目录不写**：「一个都没给」极可能是这一刻的
    //    风控/抖动，写进去就永远不重试了（用户要的「不会过期」针对的是
    //    **成功**的目录）。没有 configDir 也不写（那是测试/无配置场景，
    //    不该在磁盘上制造垃圾目录）。
    if (Array.isArray(list) && list.length > 0 && opts.configDir) {
      const wrote = writeModelsCache(opts.configDir, key, list, {
        source: "live",
        ...(typeof opts.now === "function" ? { now: opts.now } : {}),
      })
      if (!wrote.ok) opts.log?.warn?.(`loomy: 模型目录缓存写入失败（不影响本次结果）: ${wrote.error}`)
    }
    return list
  })()

  inflight.set(key, task)
  try {
    return await task
  } catch (e) {
    // ④ 拉失败 ⇒ 缓存一个字都不写，直接向上抛（调用方回静态表）
    throw e
  } finally {
    // ⚠ 必须删：这个表只表示「此刻有人在飞」，不是缓存。
    //   留着的后果是「换一个账号拿到上一个账号的目录」（真机回归过）。
    if (inflight.get(key) === task) inflight.delete(key)
  }
}

/**
 * 读这个账号的路由判定（`{entry, key} | null`）。
 *
 * 没有 configDir / 没有可查的键 / 模块缺失 / 读失败 → 一律 null＝「没有判定」，
 * 调用方据此返回正常目录。**判定读不出来不能让目录变成空的**，否则一次文件
 * 权限问题就会让所有账号从界面上消失。
 *
 * @param {any} auth
 * @param {{configDir?: string, routeStore?: any}} opts
 * @returns {Promise<{entry: any, key: string}|null>}
 */
async function lookupRoute(auth, opts) {
  try {
    const keys = accountKeys(auth)
    if (keys.length === 0) return null
    return await accountRoute(opts.configDir, keys, { routeStore: opts.routeStore })
  } catch {
    return null
  }
}

/**
 * 拉一次上游的 `/models`。
 *
 * ⚠ 鉴权走 `token:` 那条轨（不是 Authorization）。
 *
 * @param {{baseUrl: string, session: string, fetchImpl: typeof fetch, signal?: AbortSignal}} opts
 * @returns {Promise<Array<{id: string, name: string, contextWindow: number, maxOutputTokens: number}>>}
 */
export async function fetchCatalog(opts) {
  const headers = new Headers({ Accept: "application/json" })
  modelsAuth(headers, { session: opts.session })

  /** @type {RequestInit} */
  const init = { method: "GET", headers }
  if (opts.signal) init.signal = opts.signal

  const resp = await opts.fetchImpl(opts.baseUrl + MODELS_PATH, init)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

  /** @type {any} */
  const parsed = await resp.json()

  // 上游有两种常见形态，两种都认是**刻意的宽容**：本函数的产出只用于更新
  // 目录，认不出来时回落到静态表即可，不会让功能失效。反过来，如果只认
  // 一种而猜错了，实时目录就永远是空的 —— 一个静默失效的路径比一个宽松的
  // 解析器糟糕得多。
  const entries = Array.isArray(parsed?.data)
    ? parsed.data
    : Array.isArray(parsed?.models)
      ? parsed.models
      : []

  const out = []
  for (const e of entries) {
    const id = String(e?.id ?? "").trim()
    if (!id) continue
    out.push({
      id,
      name: String(e?.name ?? ""),
      contextWindow: firstPositive(e?.context_window, e?.context_length),
      maxOutputTokens: firstPositive(e?.max_output_tokens, e?.max_tokens, e?.max_output_length),
      // ── 能力声明**原样带走**，映射只发生在 toMagpieModels ──
      //
      // 实测（2026-11-20，`GET /api/v1/models`）上游给的是：
      //
      //	{"id":"DeepSeek-V4.1-Flash",
      //	 "capabilities":{"reasoning":true,"vision":true,"function_calling":true,
      //	                 "input_modalities":["text","image"],"output_modalities":["text"]}}
      //
      // 这里**不解析**：拉目录与解释目录是两件事，解释只有一处
      // （{@link mapUpstreamCapabilities}），否则两边漂移时没人能发现。
      capabilities: e?.capabilities,
      // 个别条目把 vision 放在顶层（实测同一份响应里 `supportsImage: null` 与
      // `capabilities.vision` 并存），两个位置都认。
      supportsImage: e?.supportsImage,
    })
  }
  return out
}

/** 把实测快照转成同样的形状。 */
function staticEntries() {
  const list = availableModels().map((m) => ({
    id: m.id,
    name: m.name ?? "",
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    imageOnly: false,
  }))
  for (const id of IMAGE_MODEL_IDS) {
    if (list.some((m) => m.id === id)) {
      const hit = list.find((m) => m.id === id)
      hit.imageOnly = true
      continue
    }
    list.push({ id, name: "", contextWindow: 0, maxOutputTokens: 0, imageOnly: true })
  }
  return list
}

/** 从官方展示名解析出倍率，挂到条目上，并把后缀从名字里摘掉。 */
function withMultiplier(entry) {
  const { value, ok } = parseNameMultiplier(entry.name)
  if (!ok) return entry
  return {
    ...entry,
    rate: value,
    // ⚠ 把 `(x2.0)` 从展示名里摘掉：magpie 自己会在模型旁显示 `2×`，
    // 留着后缀就是两遍（截图里 `DeepSeek V4.1 Flash(x2.0) 2×`）。
    name: stripMultiplier(entry.name),
  }
}

/**
 * 去掉展示名末尾的倍率后缀。
 *
 * 全角 `（x3.0）` 与半角 `(x3.0)` 都去，与 `parseNameMultiplier` 的正则同源。
 */
function stripMultiplier(name) {
  return String(name ?? "").replace(/[（(]x[0-9]+(?:\.[0-9]+)?[）)]\s*$/, "").trim()
}

/**
 * 上游能力声明 → magpie 的两组模态字段（**唯一一处映射**）。
 *
 * # 只认上游说的话，不猜
 *
 *	vision          `capabilities.vision === true`
 *	                ∪ `capabilities.input_modalities` 含 `image`
 *	                ∪ 顶层 `supportsImage === true`
 *	模态数组         上游没给（或给了空数组）→ 回落 `["text"]`
 *	toolcall        `capabilities.function_calling !== false`
 *	reasoning       `capabilities.reasoning === true`
 *
 * # 为什么 vision 与模态数组要互相补齐
 *
 * 上游说 `vision: true` 但 `input_modalities` 里没写 `image` 时，两个字段会
 * **自相矛盾**：magpie 看 `attachment`（或 `modalities.input`）只取其中一个，
 * 于是同一份声明在不同 UI 上给出两个答案。这里把 `image` 补进模态数组，让
 * 两组声明永远一致 —— 补的方向只有一个：vision 为真则 image 进列表。
 *
 * # 生图模型不走这里
 *
 * `IMAGE_MODEL_IDS` 的能力来自「它只能生图」这一条端点事实（见
 * `src/models.mjs` 的实测表），与上游的文本能力无关。
 *
 * @param {{capabilities?: any, supportsImage?: boolean}} [entry] 上游条目（原始形状）
 * @returns {{vision: boolean, toolcall: boolean, reasoning: boolean,
 *   inputModalities: string[], outputModalities: string[],
 *   input: {text: boolean, image: boolean, audio: boolean, video: boolean, pdf: boolean},
 *   output: {text: boolean, image: boolean, audio: boolean, video: boolean, pdf: boolean}}}
 */
export function mapUpstreamCapabilities(entry) {
  const raw = entry?.capabilities
  const up = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}

  const inputModalities = stringList(up.input_modalities)
  const outputModalities = stringList(up.output_modalities)

  // 上游一个字都没说 → 纯文本。**不按模型名猜**（猜错的表现是发图卡死）。
  const input = inputModalities.length > 0 ? inputModalities : ["text"]
  const output = outputModalities.length > 0 ? outputModalities : ["text"]

  const vision = up.vision === true || input.includes("image") || entry?.supportsImage === true
  if (vision && !input.includes("image")) input.push("image")

  return {
    vision,
    toolcall: up.function_calling !== false,
    reasoning: up.reasoning === true,
    inputModalities: input,
    outputModalities: output,
    input: modalityFlags(input),
    output: modalityFlags(output),
  }
}

/**
 * 把模态字符串数组摊成 magpie 要的布尔对象。
 *
 * ⚠ 必须**显式写全**五个布尔值：省掉不等于「按 text 处理」——
 * magpie 只认 `typeof input.image === "boolean"`，没写就是「厂商未表态」，
 * 会退到 models.dev 按裸模型 id 投票（同名模型在别家标过 image 就会误判）。
 *
 * @param {string[]} mods
 * @returns {{text: boolean, image: boolean, audio: boolean, video: boolean, pdf: boolean}}
 */
function modalityFlags(mods) {
  const has = (m) => mods.includes(m)
  return { text: has("text"), image: has("image"), audio: has("audio"), video: has("video"), pdf: has("pdf") }
}

/** 只留非空字符串，并去重（上游偶尔把同一个模态写两遍）。 */
function stringList(value) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const out = []
  for (const v of value) {
    if (typeof v !== "string") continue
    const s = v.trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * 把条目转成 magpie `provider.models` 要的形状（OpenCode 的 `Model`）。
 *
 * ⚠ 这里的字段名是 **`toolcall`**（无下划线），与 `config` 钩子里的
 * `tool_call`（带下划线）不同。两处拼写不同，写错不会报错，
 * 只会让「能不能调工具」静默为假。
 *
 * ⚠ 能力**全部来自上游**（`mapUpstreamCapabilities`）：本函数不按模型名、
 * 不按静态表猜任何一项。上游没声明 = 纯文本。
 *
 * @param {any} provider 宿主给的 provider（含它已有的 models，可展开复用）
 * @param {Array<any>} entries
 * @returns {Record<string, object>}
 */
function toMagpieModels(provider, entries) {
  /** @type {Record<string, object>} */
  const out = {}
  const base = provider?.models ?? {}

  for (const e of entries) {
    const prior = base[e.id] ?? {}
    const imageOnly = e.imageOnly === true || IMAGE_MODEL_IDS.includes(e.id)
    const up = mapUpstreamCapabilities(e)

    // 生图模型：**只能生图**是端点事实（chat 会 404），不是上游的文本能力。
    // 所以它一律写成「收文本 → 出图片」，并且不读上游的 vision。
    const capabilities = imageOnly
      ? {
          ...(prior.capabilities ?? {}),
          toolcall: false,
          reasoning: false,
          input: { text: true, image: false, audio: false, video: false, pdf: false },
          output: { text: false, image: true, audio: false, video: false, pdf: false },
        }
      : {
          ...(prior.capabilities ?? {}),
          toolcall: up.toolcall,
          reasoning: up.reasoning,
          // ⚠ 必须显式写 modality 布尔值（见 modalityFlags 的说明）
          input: up.input,
          output: up.output,
        }

    /** @type {any} */
    const model = {
      ...prior,
      id: e.id,
      name: e.name || prior.name || e.id,
      limit: {
        context: e.contextWindow || prior?.limit?.context || 0,
        output: e.maxOutputTokens || prior?.limit?.output || 0,
      },
      capabilities,
      modalities: imageOnly
        ? { input: ["text"], output: ["image"] }
        : { input: up.inputModalities, output: up.outputModalities },
      // magpie 的两条「收不收图」判据：两处同源，避免一个说能、一个说不能。
      attachment: imageOnly ? false : up.vision,
      supportsImage: imageOnly ? false : up.vision,
    }
    // 官方倍率（解析不到就不给 —— 没有官方数据就不显示，不估算）
    if (typeof e.rate === "number" && e.rate > 0) model.rate = e.rate
    out[e.id] = model
  }
  return out
}

function firstPositive(...vals) {
  for (const v of vals) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}
