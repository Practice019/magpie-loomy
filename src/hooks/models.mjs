// models.mjs 每条账号的模型目录 —— 目录的**正源**。
//
// # 为什么不能只靠 config 里的静态表
//
// 实测：上游**按账号权限下发不同模型集**。同一个上游的两个号给出的模型集合
// 只有部分交集（一个号 10 个、另一个号另一组）。所以：
//
//	静态表        冷启动兜底（登录前 / 全部拉取失败时）
//	provider.models 每个账号问一次，取该账号真实的目录
//	magpie         再把多个账号的并集拿去展示与路由
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
// 路由判定的读取器官在 loader（它是 `accountKeys`/`accountRoute` 的所有者）。
// 依赖方向：hooks/models → hooks/loader → src/{prepare-body,upstream-facts}，
// 没有回边，也不会反向摸到 index.mjs。
import { accountKeys, accountRoute } from "./loader.mjs"

/** 拉目录的超时（一次目录请求不该占住太久）。 */
const CATALOG_TIMEOUT_MS = 15_000

/**
 * 构建 `provider.models` 钩子。
 *
 * @param {{baseUrl?: string, fetchImpl?: typeof fetch, log?: {warn: Function},
 *   configDir?: string, routeStore?: any}} [opts]
 *   `configDir` / `routeStore`：读「这个账号是不是被上游限制了」。
 * @returns {(provider: any, ctx?: {auth?: any}) => Promise<Record<string, object>>}
 */
export function makeModelsHook(opts = {}) {
  const baseUrl = String(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = opts.log ?? console
  const configDir = String(opts.configDir ?? "").trim()
  const storeOpt = opts.routeStore

  return async function models(provider, ctx = {}) {
    const auth = ctx?.auth
    // 未登录：回静态表（否则界面上这个供应商一个模型都没有）
    if (!auth?.access) {
      return toMagpieModels(provider, staticEntries())
    }

    // ── 空目录：这个号不该再收到任何请求 ──
    // 先判再拉：既省一次上游请求，也不给宿主任何「其实它能用」的暗示。
    // 三种结论都置空：
    //	routed    —— 上游把整号改路由（付 2× 拿 spark），发出去也是白付钱
    //	expired   —— session 已过期，发出去只会 401，白耗一次换号
    //	exhausted —— 余额不足（402），发出去只会再 402
    // ⚠ 这里返回 `{}` 而不是「删掉某个模型」：整号坏（实测 GLM / qwen / 两个
    // deepseek 全部落到 spark-x2.6-low），只删一个模型等于让别的模型继续被换掉。
    const hit = await lookupRoute(auth, { configDir, routeStore: storeOpt })
    const verdict = hit?.entry?.verdict
    if (verdict === "routed" || verdict === "expired" || verdict === "exhausted") {
      try {
        log.warn?.(
          verdict === "expired"
            ? `loomy: 账号 ${hit.key} 登录已失效（session 过期），目录置空（不派活）`
            : verdict === "exhausted"
              ? `loomy: 账号 ${hit.key} 积分余额不足（上游 402），目录置空（不派活）`
              : `loomy: 账号 ${hit.key} 已被上游限制（全部模型实际由 ${String(hit.entry?.servedModel ?? "").trim() || "上游其它模型"} 服务），目录置空（不派活）`,
        )
      } catch {
        /* 日志失败不是业务失败 */
      }
      return {}
    }

    try {
      const live = await fetchCatalog({ baseUrl, session: auth.access, fetchImpl: doFetch, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
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
