// client-store.mjs 读**本机 Loomy 客户端**的 Local Storage。
//
// # 为什么需要直接读客户端的数据目录
//
// 三件事共用同一个数据源，而且都只能从这里拿：
//
//  ① **登录**：Loomy 的登录发生在桌面客户端里，没有可发起的 OAuth 流程
//     （没有授权页、没有回调）。唯一可行的入口就是读客户端已经登录好的
//     那一份 session。
//  ② **额度（缓存兜底）**：积分余额不在模型代理端点上 —— 实测打了 17 条
//     候选路径（/points、/user/points、/balance、/quota…）全部 404。
//     真实来源是客户端通过 IPC 问 Electron 主进程要的，而客户端把结果
//     **明文缓存**在 `loomy-points-summary` 键下。
//  ③ **Token 到期**：这个键的 JSON 里**没有**任何 expires/ttl 字段 ——
//     所以那个问题的正确答案不是「补一列」，而是「如实说它不过期」。
//
// # 数据在哪
//
// Electron 的 Local Storage 就是 leveldb。登录态与积分摘要都以 JSON 字符串
// 直接存在值里（明文，未加密）：
//
//	loomy-auth-session     {"phone","maskedPhone","session","userid","loggedInAt"}
//	loomy-points-summary   {"balance","dailyBalance","updatedAt",…}
//
// Windows 实测路径：`%APPDATA%\Loomy\Local Storage\leveldb\000003.log`
//
// # 为什么是「扫原始字节」而不是用一个 leveldb 库
//
//  ① 不能给一个插件加一个存储引擎依赖（且 leveldb 会带来 cgo）。
//  ② **不能对客户端的数据目录加锁**。真正的 leveldb 打开会创建 LOCK 文件并
//     **持锁**，而客户端自己随时可能在跑 —— 只读扫描不会干扰它。
//  ③ 客户端写的就是**明文 JSON**，没有需要解析的编码。
//
// 代价是：扫描会看到写入过程中的**半截记录**。所以每个候选片段都要求
// 「是一个结构完整的 JSON 对象」，不完整就跳过 —— 宁可少一条候选，
// 也不要解出一份字段错位的凭证（那是本项目最贵的一类缺陷）。

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"

import {
  KEY_AUTH_SESSION,
  KEY_POINTS_SUMMARY,
  CLIENT_STORE_REL,
  STORE_FILE_SUFFIXES,
  MAX_STORE_FILE_BYTES,
  KEY_VALUE_GAP,
} from "./constants.mjs"
import { parseCredential, pickWinners } from "./credential.mjs"

/**
 * 返回本机 Loomy 客户端的 Local Storage 目录。
 *
 * 目录不存在时返回**空串**（而不是一个不存在的路径）：调用方据此区分
 * 「本机没装客户端」与「装了但读不到」，前者是正常状态（插件可以跑在
 * 另一台机器上），后者才值得记日志。
 *
 * @param {{env?: Record<string, string|undefined>, platform?: string, home?: string}} [opts]
 * @returns {string}
 */
export function defaultClientStoreDir(opts = {}) {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? homedir()

  let base = ""
  if (platform === "win32") {
    base = env.APPDATA || ""
  } else if (platform === "darwin") {
    base = join(home, "Library", "Application Support")
  } else {
    base = env.XDG_CONFIG_HOME || join(home, ".config")
  }
  if (!base) return ""

  const p = join(base, ...CLIENT_STORE_REL)
  try {
    if (!statSync(p).isDirectory()) return ""
  } catch {
    return ""
  }
  return p
}

/**
 * 把 dir 下所有 leveldb 数据文件读成一段文本。
 *
 * # 为什么把多个文件拼在一起
 *
 * 键的历史可能横跨 `.log`（memtable 的预写日志）与 `.ldb`（已落盘的 SST）。
 * 必须一起看，只看 `.log` 会在客户端做过一次 compaction 之后**突然读不到**。
 *
 * 拼接顺序按**文件修改时间升序**：新文件在后，与 extractJSONAfter 内部
 * 「后出现者更晚」的取值方向一致。
 *
 * @param {string} dir
 * @returns {{text: string, files: string[]}}
 */
export function readStoreText(dir) {
  if (!dir) return { text: "", files: [] }

  /** @type {string[]} */
  let names = []
  try {
    names = readdirSync(dir)
  } catch (e) {
    throw new Error(`loomy: 读取客户端数据目录 ${dir} 失败: ${e?.message ?? e}`)
  }

  // 后缀过滤：刻意**不**包含裸 `LOG` / `LOG.old` —— 那是 leveldb 自己的
  // 运行日志（记录 compaction 事件），里面没有用户数据。
  const suffixes = STORE_FILE_SUFFIXES.map((g) => g.replace(/^\*/, ""))
  /** @type {{path: string, mtime: number}[]} */
  const files = []
  for (const name of names) {
    if (!suffixes.some((s) => name.endsWith(s))) continue
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      files.push({ path: p, mtime: st.mtimeMs })
    } catch {
      continue
    }
  }
  if (files.length === 0) return { text: "", files: [] }

  // 按修改时间升序；时间相同则按路径序，保证结果可复现。
  files.sort((a, b) => (a.mtime === b.mtime ? (a.path < b.path ? -1 : 1) : a.mtime - b.mtime))

  /** @type {Buffer[]} */
  const parts = []
  const used = []
  for (const f of files) {
    let buf
    try {
      buf = readFileSync(f.path)
    } catch {
      // 客户端在跑的时候 leveldb 会滚动/重命名文件，遇到一个刚被删掉的名字
      // 是常态，不该让整次读取失败。
      continue
    }
    if (!buf || buf.length === 0) continue
    parts.push(buf.subarray(0, MAX_STORE_FILE_BYTES))
    parts.push(Buffer.from("\n")) // 文件之间插一个换行，避免两个文件的字节黏成一个假 JSON
    used.push(basename(f.path))
  }
  return { text: Buffer.concat(parts).toString("utf8"), files: used }
}

/**
 * 找出所有「紧跟在 key 之后」的完整 JSON 对象。
 *
 * # 为什么不用正则
 *
 * 常见写法是 `r'key.{0,20}(\{.*?"session".*?\})'`。它依赖「对象里没有嵌套
 * 花括号、且 "session" 出现在第一个字段附近」—— 对当前客户端数据成立，
 * 但 `.*?` 的终止条件由**内容**决定：一旦 JSON 里出现 `}`（哪怕在字符串里），
 * 匹配就会**提前结束**，产出一个语法合法但内容被切断的片段。
 *
 * 所以这里用**配平扫描**：从 `{` 开始数括号，并且识别字符串与转义 ——
 * 与 JSON 词法一致，不依赖字段顺序。
 *
 * @param {string} text
 * @param {string} key
 * @param {number} maxGap
 * @returns {string[]}
 */
export function extractJSONAfter(text, key, maxGap = KEY_VALUE_GAP) {
  /** @type {string[]} */
  const out = []
  if (!text || !key) return out

  let from = 0
  for (;;) {
    const i = text.indexOf(key, from)
    if (i < 0) break
    from = i + key.length

    const limit = Math.min(from + maxGap, text.length)
    if (from >= limit) continue

    const j = text.indexOf("{", from)
    if (j < 0 || j >= limit) continue

    const end = jsonObjectEnd(text, j)
    if (end < 0) continue
    out.push(text.slice(j, end))
  }
  return out
}

/**
 * 返回从 start（必须是 `{`）起的第一个**配平** JSON 对象的结束下标 +1。
 *
 * 配平规则与 JSON 词法一致：字符串内的花括号不计入深度，`\` 转义的下一个
 * 字符被跳过（否则 `"\\"` 之后的引号会被误判为字符串结束）。
 * 找不到配平点（截断的记录）时返回 -1。
 *
 * @param {string} s
 * @param {number} start
 * @returns {number}
 */
export function jsonObjectEnd(s, start) {
  if (start >= s.length || s[start] !== "{") return -1
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) {
        esc = false
      } else if (c === "\\") {
        esc = true
      } else if (c === '"') {
        inStr = false
      }
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === "{") depth += 1
    else if (c === "}") {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * 从 dir 读客户端登录态。
 *
 *	目录为空 / 没有该键        → null（**不是错误**）
 *	键在但没有任何完整 JSON     → null（同上，写入中的半截记录）
 *	读目录本身失败              → 抛错
 *
 * 同一键多份时取 `loggedInAt` **最新**的一份 —— 客户端在同一键上追加写入，
 * 旧值并不会被物理删除。
 *
 * @param {string} dir
 * @returns {{credential: object|null, source: string}}
 */
export function readLocalAuth(dir) {
  if (!dir) return { credential: null, source: "" }

  const { text, files } = readStoreText(dir)
  const blobs = extractJSONAfter(text, KEY_AUTH_SESSION, KEY_VALUE_GAP)
  if (blobs.length === 0) return { credential: null, source: files.join(",") }

  /** @type {any[]} */
  const parsed = []
  for (const raw of blobs) {
    try {
      parsed.push(parseCredential(raw))
    } catch {
      // 半截记录/无关片段：跳过。**不记日志** —— 这是扫描式读取的常态
      // （leveldb 里有历史与中间状态），每个都打一行会把真正的故障淹掉。
    }
  }
  const winners = pickWinners(parsed)
  if (winners.length === 0) return { credential: null, source: files.join(",") }

  winners.sort((a, b) => String(b.loggedInAt ?? "").localeCompare(String(a.loggedInAt ?? "")))
  return { credential: winners[0], source: files.join(",") }
}

/**
 * 从 dir 读客户端缓存的积分摘要。
 *
 * 返回 null 表示「读不到」—— 与 readLocalAuth 同口径，读不到是正常状态。
 *
 * # 为什么是「按时间叠加」而不是「取最新一条」
 *
 * 实测客户端会写入**部分更新**的记录：
 *
 *	{"balance":5500,"dailyBalance":4950,"updatedAt":"…09:38:46…"}
 *	{"balance":5500,"updatedAt":"…03:04:34…"}          ← 只有 balance
 *
 * 取最新一条会丢掉上一条里还没被覆盖的字段。叠加的语义正是客户端的真实
 * 行为：每次写入只改它知道的那几个字段。
 *
 * # 为什么每个字段都带 `…Known`
 *
 * 「字段缺失」与「字段是 0」在展示语义上完全不同：前者是「没读到」，
 * 后者是「已用完」。只回数字会把未知压成确定的零，用户据此以为账号
 * 正在烧永久积分。
 *
 * @param {string} dir
 * @returns {{balance: number, balanceKnown: boolean, dailyBalance: number,
 *   dailyKnown: boolean, updatedAt: string}|null}
 */
export function readLocalPoints(dir) {
  if (!dir) return null

  let text
  try {
    text = readStoreText(dir).text
  } catch {
    return null
  }

  /** @type {any[]} */
  const wires = []
  for (const raw of extractJSONAfter(text, KEY_POINTS_SUMMARY, KEY_VALUE_GAP)) {
    let w
    try {
      w = JSON.parse(raw)
    } catch {
      continue // 半截记录：跳过
    }
    if (!w || typeof w !== "object") continue
    // 至少要有一个数值字段，否则它只是名字像而已。
    if (
      w.balance === undefined &&
      w.dailyBalance === undefined &&
      w.dailyConsumedPoints === undefined &&
      w.dailyRemainingPoints === undefined
    ) {
      continue
    }
    wires.push(w)
  }
  if (wires.length === 0) return null

  // ISO8601 同格式下字符串序即时间序。空时间视为最旧。
  wires.sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")))

  const out = {
    balance: 0,
    balanceKnown: false,
    dailyBalance: 0,
    dailyKnown: false,
    updatedAt: "",
  }
  for (const w of wires) {
    if (w.balance !== undefined && w.balance !== null) {
      out.balance = Number(w.balance) || 0
      out.balanceKnown = true
    }
    if (w.dailyBalance !== undefined && w.dailyBalance !== null) {
      out.dailyBalance = Number(w.dailyBalance) || 0
      out.dailyKnown = true
    }
    if (w.updatedAt) out.updatedAt = String(w.updatedAt)
  }
  return out
}

/** 报告某路径是否存在且是目录（给「诊断」用）。 */
export function isDir(p) {
  try {
    return !!p && statSync(p).isDirectory()
  } catch {
    return false
  }
}

export { existsSync }
