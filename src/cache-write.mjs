// 缓存文件里的**单个键**的原子改写 —— loader（额度记账）与 server 共用同一种写法。
//
// # 为什么单独一个模块
//
// `server.mjs` 里已经有一份实现（`writeKeyedCache`），但 loader 不能 import
// server（那是面板宿主，依赖方向会反过来）。两边各写一份又必然漂移，
// 所以把「读‑改‑原子写」这一段提出来，两处调同一个。
//
// # 原子性
//
// 先写 `<file>.<uuid>.tmp`（`wx` + 0600），再 `rename` 覆盖。中途失败只留 tmp，
// 由 finally 清掉 —— 绝不会出现「写到一半的 json 被当成缓存读回去」。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

/**
 * 读一个 keyed 缓存文件里的某张表；缺文件 / 坏 JSON 一律返回空表（绝不抛）。
 *
 * @param {string} configDir
 * @param {string} file 文件名（相对 configDir）
 * @param {string} key 表名（如 `accounts` / `codes`）
 * @returns {Record<string, any>}
 */
export function readKeyedCacheFile(configDir, file, key) {
  try {
    const raw = readFileSync(join(configDir, file), "utf8")
    const data = JSON.parse(raw)
    const table = data?.[key]
    return table && typeof table === "object" && !Array.isArray(table) ? table : {}
  } catch {
    return {}
  }
}

/**
 * 把 `uid → entry` 写进缓存文件的某张表（其它键不动），原子落盘。
 *
 * @param {string} configDir
 * @param {string} file 文件名（相对 configDir）
 * @param {string} key 表名
 * @param {string} uid 键
 * @param {any} entry 值
 * @returns {Record<string, any>} 写后的完整数据
 */
export function writeKeyedCacheFile(configDir, file, key, uid, entry) {
  if (!configDir) throw new Error("未设置 configDir，无法保存缓存")
  const k = String(uid ?? "").trim()
  if (!k) throw new Error("uid 不能为空")

  const table = { ...readKeyedCacheFile(configDir, file, key) }
  // ⚠ 用 defineProperty：键来自 uid，万一叫 `__proto__` 普通赋值会改原型
  Object.defineProperty(table, k, { value: entry, enumerable: true, configurable: true, writable: true })

  const data = { updatedAt: Date.now(), [key]: table }
  const path = join(configDir, file)
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    mkdirSync(String(configDir), { recursive: true })
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return data
}