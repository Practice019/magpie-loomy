// importer.mjs `auth.import` —— 从**文件**批量导入账号。
//
// # 这是 magpie 自己的钩子（OpenCode 会忽略）
//
// 用户点了供应商编辑页里的「从文件导入账号…」，magpie 会弹出文件选择器，
// 把每个文件的**文本内容**交给这个钩子：
//
//	auth.import(texts, { signal }) → 一组登录结果
//
// 每个结果与一次正常登录的产出**同形**（`{type:"success", access, …}`
// 或 `{type:"failed", error}`），magpie 按登录的方式把它保存成账号 ——
// 「加一个账号」或「覆盖它本来就是的那个账号」。
//
// 好处是：**面板里不用再做一套导入 UI**，magpie 原生支持，而且导入的账号
// 与手工登录的账号走同一条落盘路径（不存在两套格式）。
//
// # 为什么要宽容解析
//
// Loomy 的账号 JSON 在实际使用里有好几种形态（用户从不同工具导出的）：
//
//	[{"phone","userid","session","nickname"}]   数组
//	{"phone","session"}                          单个对象
//	{…}\n{…}\n{…}                               每行一个（NDJSON）
//	[{"auth":{"session":"…"}}]                   嵌套包装
//	"session 字符串本身"                          最裸的形态
//
// 全部认。解析不出 session 的条目**逐条**报 failed，不影响其它条目 ——
// 一条坏数据不该让整次导入失败。
//
// # 与面板那条导入的关系
//
// 面板（`server.mjs` 的 `/api/import`）保留，用于「机器之间搬账号」这种
// 需要**写入 magpie 配置**的场景；而用户日常「从文件导入」走这里，
// 是 magpie 官方入口。两条路最终都落到同一份凭证形态。

import { parseCredential, looksLikeSession, shortUID } from "./credential.mjs"
import { PROVIDER } from "./constants.mjs"

/**
 * 给界面显示的一句话：要选什么文件。
 *
 * ⚠ 最多 300 字节（magpie 会截断），所以写短。
 */
export const IMPORT_FROM = "Loomy 账号 JSON（含 session 字段）"

/** 多语言版本的同一句话。 */
export const IMPORT_FROMS = {
  zh: "Loomy 账号 JSON（含 session 字段）",
  "zh-TW": "Loomy 帳號 JSON（含 session 欄位）",
  en: "a Loomy account JSON (with a session field)",
}

/**
 * 从一段文本里抽出所有候选账号对象。
 *
 * 按顺序尝试四种形态，**取第一个能解析出东西的**（不合并，避免同一份
 * 数据被解析两次）。
 *
 * @param {string} text
 * @returns {{ items: any[], shapes: string }}
 */
export function extractItems(text) {
  const raw = String(text ?? "").trim()
  if (!raw) return { items: [], shapes: "empty" }

  // ① 整段是合法 JSON（数组或单个对象）
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return { items: v, shapes: "json-array" }
    if (v && typeof v === "object") {
      // 有些导出会包一层：{"accounts":[...]} / {"data":[...]} / {"list":[...]}
      for (const key of ["accounts", "data", "list", "items"]) {
        if (Array.isArray(v[key])) return { items: v[key], shapes: `json-object.${key}` }
      }
      return { items: [v], shapes: "json-object" }
    }
    // 裸字符串：它自己可能就是 session
    if (typeof v === "string") return { items: [{ session: v }], shapes: "json-string" }
  } catch {
    // 不是整段 JSON，往下试
  }

  // ② 每行一个 JSON（NDJSON）
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const perLine = []
  let parsedAny = false
  for (const line of lines) {
    try {
      const v = JSON.parse(line)
      if (Array.isArray(v)) perLine.push(...v)
      else perLine.push(v)
      parsedAny = true
    } catch {
      // 这一行不是 JSON：可能是裸 session，兜到 ③ 一起处理
    }
  }
  if (parsedAny) return { items: perLine, shapes: "ndjson" }

  // ③ 整段就是一串 session（每行一个 32 位 hex）
  const bare = lines.filter((l) => looksLikeSession(l))
  if (bare.length > 0) return { items: bare.map((session) => ({ session })), shapes: "bare-sessions" }

  // ④ 文本里散落着 session（从截图/日志里抠出来的情形）
  const found = raw.match(/\b[0-9a-f]{32}\b/g) ?? []
  if (found.length > 0) {
    return { items: [...new Set(found)].map((session) => ({ session })), shapes: "scattered-sessions" }
  }

  return { items: [], shapes: "unrecognised" }
}

/**
 * 把一条原始条目转成「登录成功」结果。
 *
 * ⚠ 返回值必须与 `authorize/callback` 的产出**同形** —— magpie 按登录的
 * 方式保存它。用 `access` 而不是 `key`：实测 `type:"api"` 的凭证 magpie
 * 不会调 `auth.usage`，账号卡会显示「未登录」（见 AGENTS.md 坑 #2）。
 *
 * @param {any} item
 * @param {object} [opts]
 * @param {(session: string) => Promise<void>} [opts.verify] 可选：验证 session
 * @returns {Promise<object>}
 */
export async function toSignInResult(item, opts = {}) {
  /** @type {any} */
  let source = item

  // 解掉常见的嵌套包装：{"auth":{...}} / {"account":{...}} / {"credential":{...}}
  if (source && typeof source === "object" && !source.session) {
    for (const key of ["auth", "account", "credential", "data"]) {
      const inner = source[key]
      if (inner && typeof inner === "object" && inner.session) {
        source = inner
        break
      }
    }
  }

  let cred
  try {
    cred = parseCredential(source)
  } catch (e) {
    return { type: "failed", error: String(e?.message ?? e) }
  }

  // 可选：验证一次（能被 /models 认下才收）。
  // 失败**不阻断** —— 上游可能只是这一刻不通，而凭证本身是对的。
  if (opts.verify) {
    try {
      await opts.verify(cred.session)
    } catch (e) {
      return { type: "failed", error: `session 不可用：${e?.message ?? e}`, accountId: cred.nickname }
    }
  }

  return {
    type: "success",
    access: cred.session,
    // 本上游没有 refresh token（session 不过期）。
    refresh: "",
    // 0 = 不会过期、不要续期。
    expires: 0,
    accountId: cred.nickname || shortUID(cred.uid),
    uid: cred.uid,
    metadata: {
      uid: cred.uid,
      nickname: cred.realNickname || cred.nickname,
      phone: cred.phone,
      userId: cred.userId,
      loggedInAt: cred.loggedInAt,
    },
  }
}

/** magpie 一次最多收 100 条（`IMPORT_MOST`，见其 host.js）。 */
export const IMPORT_MOST = 100

/**
 * 构建 `auth.import` 钩子。
 *
 * @param {{verify?: (session: string) => Promise<void>}} [opts]
 * @returns {{
 *   import: (texts: string[], ctx?: {signal?: AbortSignal}) => Promise<object[]>,
 *   importFrom: string,
 *   importFroms: Record<string, string>,
 * }}
 */
export function makeImportHook(opts = {}) {
  return {
    importFrom: IMPORT_FROM,
    importFroms: IMPORT_FROMS,

    /**
     * @param {string[]} texts 用户选中的每个文件的文本
     * @param {{signal?: AbortSignal}} [ctx]
     * @returns {Promise<object[]>} 一组登录结果（与 authorize 的产出同形）
     */
    async import(texts, ctx = {}) {
      const list = Array.isArray(texts) ? texts.filter((t) => typeof t === "string" && t.trim()) : []
      if (list.length === 0) return []

      /** @type {object[]} */
      const results = []
      for (const text of list) {
        if (ctx.signal?.aborted) break

        const { items } = extractItems(text)
        for (const item of items) {
          if (results.length >= IMPORT_MOST) break
          if (ctx.signal?.aborted) break
          results.push(await toSignInResult(item, { verify: opts.verify }))
        }
        if (results.length >= IMPORT_MOST) break
      }

      // 一条都没解析出来：给一条 failed 说明原因，而不是静默返回空数组。
      // 静默的空结果在界面上表现为「点了导入，什么都没发生」。
      if (results.length === 0) {
        return [{ type: "failed", error: `没从文件里认出账号（要含 session 字段的 JSON；provider=${PROVIDER}）` }]
      }
      return results.slice(0, IMPORT_MOST)
    },
  }
}
