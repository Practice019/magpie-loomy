// route-store.mjs 把「某账号的 DeepSeek-V4.1-Flash 是否被改路由」的判定结果
// 存到插件自己的状态文件里。
//
// # 为什么需要落盘
//
// 一次探测要发一次 chat（**扣积分**）+ 轮询账本最多 6×5 秒，所以结果不能
// 每次打开面板都重算：它是一份**带时间戳的判定**，而不是一个实时属性。
// 调用方据此决定「多久复测一次」，本文件只负责如实存取。
//
// # 文件位置与格式
//
//	<configDir>/loomy-route-state.json
//	{"150****3411":{"verdict":"routed","servedModel":"spark-x2.6-low",
//	                "checkedAt":"2026-11-19T…","requested":"DeepSeek-V4.1-Flash"}}
//
// 键统一是 **String(uid)**：magpie 里同一个账号可能以数字 uid 出现，也可能
// 以手机号昵称（`150****3411`）出现。不统一就会写出两份、读回一份 ——
// 表现是「探测过了，但面板说没探测过」。
//
// # 两个会静默出错的坑
//
//  1. **损坏的文件不能让整个面板报错**。这个文件是缓存，不是真相；读失败
//     一律返回 `ok:false` + 空表，调用方降级成「重新探测」即可。
//  2. **写必须原子**（临时文件 + rename）。宿主随时可能读到半个 JSON；
//     非原子写会让「正常状态」被下一次读取判成损坏，然后被覆盖掉。
//  3. **一次写入是一个同步的读改写**。Node 单线程下这天然串行，所以同进程
//     并发探测不同账号不会互相吞条目；但**不要**让两个进程同时写这个文件
//     （rename 会互相覆盖）。本插件的写入方只有面板服务一处。
//
// ⚠ 目录不存在要 `mkdir -p`：`configDir` 是 magpie 给的，插件不该假设它已建好。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** 状态文件名（与 `loomy-panel-state.json` 同目录、不同文件）。 */
const STATE_FILE = "loomy-route-state.json"

/**
 * 状态文件的绝对路径。
 *
 * 没有 `configDir` 时返回**空串**（与 `client-store.mjs` 的
 * `defaultClientStoreDir` 同口径）：调用方据此区分「没配置」与
 * 「配置了但读不到」，前者是正常状态。
 *
 * @param {string} [configDir]
 * @returns {string}
 */
export function routeStatePath(configDir) {
  const dir = String(configDir ?? "").trim()
  if (!dir) return ""
  return join(dir, STATE_FILE)
}

/**
 * 读整个状态表。
 *
 *	文件不存在            → {ok:true, data:{}}（没探测过 ≠ 读失败）
 *	JSON 损坏 / 不是对象   → {ok:false, data:{}, error}
 *	没有 configDir        → {ok:false, data:{}, error}
 *
 * @param {string} [configDir]
 * @returns {{ok: boolean, data: Record<string, any>, error: string}}
 */
export function readRouteState(configDir) {
  const file = routeStatePath(configDir)
  if (!file) return { ok: false, data: {}, error: "未设置 configDir，无法定位路由状态文件" }

  let text
  try {
    text = readFileSync(file, "utf8")
  } catch (e) {
    if (e?.code === "ENOENT") return { ok: true, data: {}, error: "" }
    return { ok: false, data: {}, error: `读取路由状态失败: ${errorText(e)}` }
  }

  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 只报「不是合法 JSON」，不回显文件内容 —— 里面可能有账号键。
    return { ok: false, data: {}, error: "路由状态文件不是合法 JSON" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, data: {}, error: "路由状态文件的顶层必须是一个对象" }
  }
  return { ok: true, data: parsed, error: "" }
}

/**
 * 写入（或覆盖）一个账号的判定结果。
 *
 * 读改写 + 原子替换：先读现有表（损坏时从空表重建），加/改一个键，
 * 写临时文件后 rename。失败一律返回 `{ok:false, error}`，不抛 ——
 * 状态文件写不进去不该让探测本身看起来失败。
 *
 * @param {string} [configDir]
 * @param {string|number} uid
 * @param {{verdict: string, servedModel: string, checkedAt: string, requested: string}} entry
 * @returns {{ok: boolean, error: string}}
 */
export function writeRouteState(configDir, uid, entry) {
  const file = routeStatePath(configDir)
  if (!file) return { ok: false, error: "未设置 configDir，无法保存路由状态" }

  const key = String(uid ?? "").trim()
  if (!key) return { ok: false, error: "uid 不能为空" }

  // 损坏的文件按空表处理：它是缓存，重建比报错更有用。
  const prior = readRouteState(configDir)
  const data = prior.ok ? prior.data : {}
  // ⚠ 用 defineProperty 而不是 `data[key] = entry`：键来自 uid，
  // 万一叫 `__proto__`，普通赋值会去改原型而不是写一个键。
  const next = { ...data }
  Object.defineProperty(next, key, {
    value: entry,
    enumerable: true,
    configurable: true,
    writable: true,
  })

  const temp = `${file}.${randomUUID()}.tmp`
  try {
    mkdirSync(String(configDir), { recursive: true })
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    renameSync(temp, file)
    return { ok: true, error: "" }
  } catch (e) {
    return { ok: false, error: `保存路由状态失败: ${errorText(e)}` }
  } finally {
    // rename 成功时临时文件已经不存在；失败时清掉，别在 configDir 里留垃圾。
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      // 清理失败不影响结果，忽略。
    }
  }
}

/**
 * 读某账号的判定结果。
 *
 * 读不到 / 文件损坏 / 没探测过 → null（三者对调用方是同一件事：**没有可用判定**）。
 *
 * @param {string} [configDir]
 * @param {string|number} uid 支持昵称键与数字 uid
 * @returns {{verdict: string, servedModel: string, checkedAt: string, requested: string}|null}
 */
export function getAccountRoute(configDir, uid) {
  const key = String(uid ?? "").trim()
  if (!key) return null
  const state = readRouteState(configDir)
  if (!state.ok) return null
  const entry = state.data[key]
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
  return entry
}

// ── 内部 ────────────────────────────────────────────────────────────────

/** 生成临时文件名用的 UUID；不引入依赖，直接用 Node 自带实现。 */
function randomUUID() {
  return globalThis.crypto.randomUUID()
}

/** 把错误压成一行短文本（不含文件内容）。 */
function errorText(e) {
  return String(e?.message ?? e ?? "未知错误").replace(/\s+/g, " ").trim().slice(0, 200)
}
