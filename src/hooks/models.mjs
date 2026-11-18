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

import { PROVIDER, DEFAULT_BASE_URL, MODELS_PATH } from "../constants.mjs"
import { modelsAuth } from "./../auth-headers.mjs"
import { parseNameMultiplier } from "../multipliers.mjs"
import { availableModels, IMAGE_MODEL_IDS } from "../models.mjs"

/** 拉目录的超时（一次目录请求不该占住太久）。 */
const CATALOG_TIMEOUT_MS = 15_000

/**
 * 构建 `provider.models` 钩子。
 *
 * @param {{baseUrl?: string, fetchImpl?: typeof fetch, log?: {warn: Function}}} [opts]
 * @returns {(provider: any, ctx?: {auth?: any}) => Promise<Record<string, object>>}
 */
export function makeModelsHook(opts = {}) {
  const baseUrl = String(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = opts.log ?? console

  return async function models(provider, ctx = {}) {
    const auth = ctx?.auth
    // 未登录：回静态表（否则界面上这个供应商一个模型都没有）
    if (!auth?.access) {
      return toMagpieModels(provider, staticEntries())
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
 * 把条目转成 magpie `provider.models` 要的形状（OpenCode 的 `Model`）。
 *
 * ⚠ 这里的字段名是 **`toolcall`**（无下划线），与 `config` 钩子里的
 * `tool_call`（带下划线）不同。两处拼写不同，写错不会报错，
 * 只会让「能不能调工具」静默为假。
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

    /** @type {any} */
    const model = {
      ...prior,
      id: e.id,
      name: e.name || prior.name || e.id,
      limit: {
        context: e.contextWindow || prior?.limit?.context || 0,
        output: e.maxOutputTokens || prior?.limit?.output || 0,
      },
      capabilities: {
        ...(prior.capabilities ?? {}),
        toolcall: !imageOnly,
        reasoning: false,
        // ⚠ 必须显式写 modality 布尔值：省掉不等于「按 text 处理」
        input: { text: true, image: false, audio: false, video: false, pdf: false },
      },
      modalities: imageOnly
        ? { input: ["text"], output: ["image"] }
        : { input: ["text"], output: ["text"] },
      attachment: false,
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
