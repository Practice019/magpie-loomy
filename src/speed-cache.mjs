// speed-cache.mjs 速率表的文件缓存 —— 面板刷新写、`provider.models` 读。
//
// # 为什么单独一个文件
//
// `src/speed.mjs` 是**纯计算**（不读文件、不发请求，测试里可以随便喂数据）。
// 落盘这件事有它自己的四条纪律（原子写 / 坏文件当没有 / 没 configDir 不写 /
// 不制造垃圾目录），与计算无关，所以分成两个模块。
//
// # 文件形状
//
//	<configDir>/loomy-speed-cache.json
//	{
//	  "updatedAt": 1763…,
//	  "b": { "deepseek-v4-flash-1017": 126.5 },
//	  "accounts": {
//	    "deepseek-v4-flash-1017|16540492083": {
//	      "model": "deepseek-v4-flash-1017", "account": "16540492083",
//	      "lastSpeed": 24.0, "lastAt": 1763…, "avgSpeed": 93.2, "calls": 37,
//	      "verdict": "slow"
//	    }
//	  }
//	}
//
// # 谁写、谁读
//
//	写：**只有** `POST /api/speed/refresh`（用户在面板点「刷新速率」）。
//	    magpie 的 `config` / `auth.*` 钩子永远不写也不刷新它。
//	读：`src/hooks/models.mjs`（跳过慢号）与 `GET /api/speed`（面板显示）。
//
// # 读失败一律「当作没有缓存」
//
// 缓存坏了不等于号坏了。`readSpeedCache()` 返回 `null` 时调用方必须**完全退回
// 原行为**（所有模型都报），而不是抛错或把模型全摘掉。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** 速率缓存文件名（与 `loomy-models-cache.json` / `loomy-route-state.json` 同目录）。 */
export const SPEED_CACHE_FILE = "loomy-speed-cache.json"

/** 面板设置文件名（只为了读 `speedSkip` 这一个开关）。 */
const PANEL_SETTINGS_FILE = "loomy-panel-settings.json"

/**
 * 缓存文件的绝对路径。没有 `configDir` 时返回空串（与 `models-cache.mjs` 同口径）。
 *
 * @param {string} [configDir]
 * @returns {string}
 */
export function speedCachePath(configDir) {
  const dir = String(configDir ?? "").trim()
  if (!dir) return ""
  return join(dir, SPEED_CACHE_FILE)
}

/**
 * 读速率表。
 *
 *	文件不存在 / 没有 configDir   → null（= 没有缓存）
 *	JSON 损坏 / 顶层不是对象       → null
 *	`accounts` 不是对象（数组也算坏）→ null
 *	单条坏记录（缺 model / account）→ **丢掉那一条**，其余照用
 *
 * 「单条坏记录只丢一条」是刻意的：一条写坏不该让整张表作废，
 * 但它也不能冒充一个账号进判定（缺 model 的条目会让 `fastCount` 算错）。
 *
 * @param {string} [configDir]
 * @returns {{updatedAt: number, b: Record<string, number>, accounts: Record<string, {
 *   model: string, account: string, lastSpeed: number|null, lastAt: number,
 *   avgSpeed: number|null, calls: number, verdict: string}>}|null}
 */
export function readSpeedCache(configDir) {
  const file = speedCachePath(configDir)
  if (!file || !existsSync(file)) return null
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const raw = parsed.accounts
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null

  /** @type {Record<string, number>} */
  const b = {}
  for (const [model, value] of Object.entries(parsed.b && typeof parsed.b === "object" ? parsed.b : {})) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) b[model] = n
  }

  /** @type {Record<string, any>} */
  const accounts = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const model = String(/** @type {any} */ (value).model ?? "").trim()
    const account = String(/** @type {any} */ (value).account ?? "").trim()
    if (!model || !account) continue
    const verdict = String(/** @type {any} */ (value).verdict ?? "")
    accounts[key] = {
      model,
      account,
      lastSpeed: numberOrNull(/** @type {any} */ (value).lastSpeed),
      lastAt: Number(/** @type {any} */ (value).lastAt) || 0,
      avgSpeed: numberOrNull(/** @type {any} */ (value).avgSpeed),
      calls: Number(/** @type {any} */ (value).calls) || 0,
      // 只认三档；认不出的（旧版本写进来的别的词）当 unknown —— 不能当 normal 放行，
      // 也不能当 slow 摘掉。unknown 是唯一安全的兜底。
      verdict: verdict === "slow" || verdict === "normal" ? verdict : "unknown",
    }
  }

  return { updatedAt: Number(parsed.updatedAt) || 0, b, accounts }
}

/**
 * 写速率表（原子替换：临时文件 + rename）。
 *
 * 失败不抛，返回 `{ok, error}`：写不进缓存不该让「刷新速率」整个失败 ——
 * 面板仍应显示本次算出来的结果。
 *
 * @param {string} [configDir]
 * @param {{updatedAt?: number, b?: Record<string, number>, accounts?: Record<string, any>}} table
 * @returns {{ok: boolean, error: string}}
 */
export function writeSpeedCache(configDir, table) {
  const file = speedCachePath(configDir)
  if (!file) return { ok: false, error: "未设置 configDir，无法保存速率缓存" }
  if (!table || typeof table !== "object") return { ok: false, error: "速率表无效" }
  const data = {
    updatedAt: Number(table.updatedAt) || Date.now(),
    b: table.b && typeof table.b === "object" ? table.b : {},
    accounts: table.accounts && typeof table.accounts === "object" ? table.accounts : {},
  }
  const temp = `${file}.${globalThis.crypto.randomUUID()}.tmp`
  try {
    mkdirSync(String(configDir), { recursive: true })
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    renameSync(temp, file)
    return { ok: true, error: "" }
  } catch (e) {
    return { ok: false, error: `保存速率缓存失败: ${String(e?.message ?? e).slice(0, 200)}` }
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      // 清理失败不影响结果
    }
  }
}

/**
 * 面板上的「按速率跳过慢号」开关（`loomy-panel-settings.json` 的 `speedSkip`）。
 *
 * # 为什么由这里读，而不是让钩子去 import server.mjs
 *
 * 依赖方向：`server.mjs`（面板宿主）**不 import** `src/hooks/`；反过来
 * `src/hooks/models.mjs` 也不该 import 面板宿主。所以这个开关的读取放在
 * 「两侧都已经依赖的缓存层」里，只有一处实现。
 *
 * # 缺省 = 开
 *
 * 与 magpie 供应商页的 `option("speedskip", true)` 同口径：**没有设置就是开**。
 * 只有显式的 `false` 才算关 —— 一个读不出来的设置文件不该把功能悄悄关掉，
 * 也不该把慢号突然全放回来。
 *
 * @param {string} [configDir]
 * @returns {boolean}
 */
export function readSpeedSkipSetting(configDir) {
  const dir = String(configDir ?? "").trim()
  if (!dir) return true
  try {
    const raw = readFileSync(join(dir, PANEL_SETTINGS_FILE), "utf8")
    /** @type {any} */
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true
    return parsed.speedSkip !== false
  } catch {
    return true
  }
}

/** 有限数 → 数值；其余（含 null / undefined / "" / NaN）→ null。 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
