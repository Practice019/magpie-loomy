// traffic.mjs 「这个号最近一次**真实请求**被哪个模型服务」的旁路证据。
//
// # 它为什么存在（比探测便宜得多）
//
// 判断「号有没有被换模型」最贵的一步是发一次计费 chat + 轮询积分账本
// （`src/route.mjs` 的 `probeRoute`）。但**真实请求本来就发生过** ——
// 只要在出站时把「谁、请求了什么模型、什么时候」记下来，巡检侧再去读账本
// 比对，就能免费得出「这次请求实际落在哪个模型上」。
//
// 代价：只有在用户真的用这个号时才会有记录。闲置号没有证据，仍需探测。
//
// # 三条硬性质
//
//	① **永不抛**：这是旁路证据。写失败、文件损坏、目录不可写，一律吞掉 ——
//	   它绝不能影响一次真实请求（调用点用 `void`，连异常都不该冒出来）。
//	② **有界**：每个 uid 只留最近 `MAX_PER_UID` 条。否则一个 184 号池子
//	   长跑几个月会把文件写到几十 MB，而每次写入都要整表读写。
//	③ **原子**：temp + rename。宿主/巡检侧随时可能读到半个 JSON；
//	   非原子写会让「正常状态」被下一次读取判成损坏，然后被重建覆盖掉。
//
// # 文件位置与格式
//
//	<configDir>/loomy-traffic.json
//	{"updatedAt": 1795050344000,
//	 "accounts": {"260911173523492332": [{"model":"DeepSeek-V4.1-Flash","at":1795050344000}]}}
//
// ⚠ 没有 `configDir` 时路径是**空串**（与 `route-store.mjs` 的
// `routeStatePath` 同口径）：调用方据此区分「没配置」与「配置了但读不到」，
// 前者是正常状态。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** 每个 uid 保留的最近记录条数（文件总量因此有界）。 */
export const MAX_PER_UID = 20

/** 状态文件名（与 `loomy-route-state.json` 同目录、不同文件）。 */
const TRAFFIC_FILE = "loomy-traffic.json"

/**
 * 状态文件的绝对路径；没有 configDir 时返回空串。
 *
 * @param {string} [configDir]
 * @returns {string}
 */
export function trafficPath(configDir) {
  const dir = String(configDir ?? "").trim()
  if (!dir) return ""
  return join(dir, TRAFFIC_FILE)
}

/**
 * 读整表（含 `updatedAt`）。内部用；导出的 `readAllTraffic` 只给账号表。
 *
 *	文件不存在 / 损坏 / 不是对象 / 没有 configDir → 空表（都当空，不抛）
 *
 * @param {string} [configDir]
 * @returns {{updatedAt: number, accounts: Record<string, Array<{model: string, at: number}>>}}
 */
function readTable(configDir) {
  const file = trafficPath(configDir)
  if (!file) return { updatedAt: 0, accounts: {} }

  let text
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return { updatedAt: 0, accounts: {} }
  }

  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 损坏的文件当空表：它是旁路证据，重建比报错有用。
    return { updatedAt: 0, accounts: {} }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { updatedAt: 0, accounts: {} }

  const accounts = parsed.accounts && typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)
    ? parsed.accounts
    : {}
  return { updatedAt: Number(parsed.updatedAt) || 0, accounts }
}

/**
 * 读**所有账号**的记录表。
 *
 * 形态就是 `{ [uid]: Array<{model, at}> }`（`updatedAt` 属于文件内部字段，
 * 不影响调用方）。
 *
 * @param {string} [configDir]
 * @returns {Record<string, Array<{model: string, at: number}>>}
 */
export function readAllTraffic(configDir) {
  return readTable(configDir).accounts
}

/**
 * 读某账号的记录，按 `at` 升序。
 *
 * ⚠ 排序在这里做一遍（写入时也保持有序）：文件可能被别的实现/手改过，
 * 读侧不该信任磁盘上的顺序。
 *
 * @param {string} [configDir]
 * @param {string|number} uid
 * @returns {Array<{model: string, at: number}>}
 */
export function readTraffic(configDir, uid) {
  const key = String(uid ?? "").trim()
  if (!key) return []
  const all = readAllTraffic(configDir)
  const raw = all[key]
  if (!Array.isArray(raw)) return []

  /** @type {Array<{model: string, at: number}>} */
  const out = []
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue
    const model = String(e.model ?? "").trim()
    const at = Number(e.at)
    if (!model || !Number.isFinite(at)) continue
    out.push({ model, at })
  }
  out.sort((a, b) => a.at - b.at)
  return out
}

/**
 * 记录一条真实请求。
 *
 * # 语义
 *
 *	合法条目        → 追加，并裁到最近 `MAX_PER_UID` 条
 *	非法条目        → 忽略（不写、不抛）
 *	没有 configDir  → 跳过（返回 {ok:false}，但**永不抛**）
 *
 * # 为什么是「读改写 + rename」
 *
 * Node 单线程下同步读写天然串行，所以同进程并发记录不同账号不会互相吞条目。
 * 但**不要**让两个进程同时写这个文件（rename 会互相覆盖）—— 本插件的
 * 写入方只在 loader 一处。
 *
 * @param {string} [configDir]
 * @param {string|number} uid
 * @param {{model: string, at?: number}} entry
 * @returns {{ok: boolean, error: string}}
 */
export function recordTraffic(configDir, uid, entry) {
  const file = trafficPath(configDir)
  const key = String(uid ?? "").trim()
  const model = String(entry?.model ?? "").trim()
  // 非法输入不是错误，只是「没有可记的东西」
  if (!file || !key || !model) return { ok: false, error: "" }

  const at = Number.isFinite(Number(entry?.at)) ? Number(entry.at) : Date.now()

  try {
    const prior = readTable(configDir)
    const accounts = { ...prior.accounts }

    const list = Array.isArray(accounts[key]) ? accounts[key].slice() : []
    list.push({ model, at })
    list.sort((a, b) => Number(a?.at) - Number(b?.at))
    // 有界：只留最近的
    accounts[key] = list.slice(-MAX_PER_UID)

    const next = { updatedAt: Date.now(), accounts }
    const temp = `${file}.${globalThis.crypto.randomUUID()}.tmp`

    try {
      mkdirSync(String(configDir), { recursive: true })
      writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 })
      renameSync(temp, file)
      return { ok: true, error: "" }
    } finally {
      // rename 成功时临时文件已不存在；失败时清掉，别在 configDir 里留垃圾。
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        // 清理失败不影响结果
      }
    }
  } catch (e) {
    // ⚠ 永不抛：旁路证据的失败不能影响主流程
    return { ok: false, error: String(e?.message ?? e ?? "未知错误").slice(0, 200) }
  }
}