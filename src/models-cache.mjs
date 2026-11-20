// models-cache.mjs 模型目录的**文件缓存** —— 上游 `/models` 只读一次，之后永不自动失效。
//
// # 为什么必须有它（真机事故：掉号）
//
// 原来的 `provider.models` **每个账号各拉一次** `/api/v1/models`，零缓存：
//
//	301 个账号 × 每次 magpie 重读模型列表 = 301 次请求
//	开发者一天重启 8 次 ≈ 2400 次请求
//
// 服务端把这判成**批量探测** ⇒ 风控 ⇒ session 失效（实测 19 个 expired，
// 其中 18 个是 session-expired）。这不是「额度用完了」，是我们自己把号打死的。
//
// 而且这件事**从原理上就不该做**：模型目录是 **provider 级**的 —— 同一个上游
// 对所有账号下发的列表相同。一次就够。
//
// # 用户的要求（原话）
//
//	「更新缓存我们控制不要自动」「不会过期」「重启不要发请求」
//
// 所以这里**没有 TTL**：文件在 ⇒ 永远命中 ⇒ 0 次上游请求。想刷新就删文件
// （或让面板/用户显式触发），插件自己**永远不**主动失效。
//
// # 四条纪律（也是 `hooks/models.mjs` 的调用顺序）
//
//	① 有缓存 → 直接返回，**绝不请求上游**
//	② 无缓存 → 整个 provider 只拉**一次**（模块级 in-flight 去重：
//	           301 个账号并发调用只产生 1 次请求）
//	③ 拉成功 → 写缓存 → 返回
//	④ 拉失败 → 回退静态表，**不写缓存**（下次还能重试）
//
// # 文件形状
//
//	<configDir>/loomy-models-cache.json
//	{ "https://loomyad.xunfei.cn/api/v1": { at: 1763…, list: [{id, name, …}], source: "live" } }
//
// 键是 **baseUrl**：用户可以在插件选项里改基址，不同基址的目录是两份东西。
//
// # 会静默出错的两个坑
//
//	1. 损坏的文件不能让插件报错：它是缓存，读不出来就当作「没有缓存」重拉一次。
//	2. 写必须原子（临时文件 + rename）：宿主随时可能读到半个 JSON。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** 缓存文件名（与 `loomy-route-state.json` 同目录、不同文件）。 */
export const MODELS_CACHE_FILE = "loomy-models-cache.json"

/**
 * 缓存文件的绝对路径。
 *
 * 没有 `configDir` 时返回**空串**（与 `route-store.mjs` 同口径）：
 * 调用方据此区分「没配置」与「配置了但读不到」。
 *
 * @param {string} [configDir]
 * @returns {string}
 */
export function modelsCachePath(configDir) {
  const dir = String(configDir ?? "").trim()
  if (!dir) return ""
  return join(dir, MODELS_CACHE_FILE)
}

/**
 * 读整张缓存表。
 *
 *	文件不存在         → {}
 *	JSON 损坏 / 不是对象 → {}（缓存坏了就当没有，重拉一次即可）
 *	没有 configDir      → {}
 *
 * @param {string} [configDir]
 * @returns {Record<string, {at: number, list: any[], source: string}>}
 */
export function readModelsCache(configDir) {
  const file = modelsCachePath(configDir)
  if (!file || !existsSync(file)) return {}
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  /** @type {Record<string, any>} */
  const out = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    // ⚠ `list` 必须是数组：空数组也算合法（上游真的一个模型都不给），
    //   但**非数组**一律视为坏记录 —— 拿它当目录会让模型列表静默变空。
    if (!Array.isArray(/** @type {any} */ (value).list)) continue
    out[key] = {
      at: Number(/** @type {any} */ (value).at) || 0,
      list: /** @type {any} */ (value).list,
      source: String(/** @type {any} */ (value).source ?? "live"),
    }
  }
  return out
}

/**
 * 取某个基址的缓存目录（没有就 null）。
 *
 * @param {string} [configDir]
 * @param {string} baseUrl
 * @returns {Array<any>|null} 命中时是**目录数组本身**
 */
export function readCachedModels(configDir, baseUrl) {
  const key = normalizeBase(baseUrl)
  if (!key) return null
  const hit = readModelsCache(configDir)[key]
  return hit && Array.isArray(hit.list) ? hit.list : null
}

/**
 * 写某个基址的目录（读改写 + 原子替换，**不覆盖**其它基址）。
 *
 * 失败不抛：缓存写不进去不该让「这次能列模型」变成失败。
 *
 * @param {string} [configDir]
 * @param {string} baseUrl
 * @param {any[]} list
 * @param {{source?: string, now?: () => number}} [opts]
 * @returns {{ok: boolean, error: string}}
 */
export function writeModelsCache(configDir, baseUrl, list, opts = {}) {
  const file = modelsCachePath(configDir)
  if (!file) return { ok: false, error: "未设置 configDir，无法保存模型目录缓存" }
  const key = normalizeBase(baseUrl)
  if (!key) return { ok: false, error: "baseUrl 为空，无法定位缓存键" }
  if (!Array.isArray(list)) return { ok: false, error: "list 必须是数组" }

  const table = readModelsCache(configDir)
  // ⚠ 用 defineProperty：键来自 baseUrl，万一含 `__proto__` 之类会改原型。
  Object.defineProperty(table, key, {
    value: {
      at: typeof opts.now === "function" ? opts.now() : Date.now(),
      list,
      source: String(opts.source ?? "live"),
    },
    enumerable: true,
    configurable: true,
    writable: true,
  })

  const temp = `${file}.${globalThis.crypto.randomUUID()}.tmp`
  try {
    mkdirSync(String(configDir), { recursive: true })
    writeFileSync(temp, JSON.stringify(table, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    renameSync(temp, file)
    return { ok: true, error: "" }
  } catch (e) {
    return { ok: false, error: `保存模型目录缓存失败: ${errorText(e)}` }
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      // 清理失败不影响结果
    }
  }
}

/**
 * 清掉某个基址（或整张表）的缓存 —— **只有用户/面板显式要求时才调**。
 *
 * @param {string} [configDir]
 * @param {string} [baseUrl] 省略 = 清整张表
 * @returns {{ok: boolean, error: string}}
 */
export function clearModelsCache(configDir, baseUrl) {
  const file = modelsCachePath(configDir)
  if (!file) return { ok: false, error: "未设置 configDir，无法定位模型目录缓存" }
  const key = normalizeBase(baseUrl)
  try {
    if (!key) {
      if (existsSync(file)) unlinkSync(file)
      return { ok: true, error: "" }
    }
    const table = readModelsCache(configDir)
    if (!(key in table)) return { ok: true, error: "" }
    delete table[key]
    if (Object.keys(table).length === 0) {
      if (existsSync(file)) unlinkSync(file)
      return { ok: true, error: "" }
    }
    const temp = `${file}.${globalThis.crypto.randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(table, null, 2) + "\n", { flag: "wx", mode: 0o600 })
      renameSync(temp, file)
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
    return { ok: true, error: "" }
  } catch (e) {
    return { ok: false, error: `清除模型目录缓存失败: ${errorText(e)}` }
  }
}

// ── 内部 ────────────────────────────────────────────────────────────────

/** 基址归一：去尾部斜杠（`…/api/v1/` 与 `…/api/v1` 是同一个键）。 */
function normalizeBase(baseUrl) {
  return String(baseUrl ?? "").trim().replace(/\/+$/, "")
}

/** 把错误压成一行短文本（不含文件内容）。 */
function errorText(e) {
  return String(e?.message ?? e ?? "未知错误").replace(/\s+/g, " ").trim().slice(0, 200)
}