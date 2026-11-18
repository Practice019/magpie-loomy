// credential.mjs Loomy 的凭证模型。
//
// # 为什么只有这么短的凭证
//
//	workbuddy → {accessToken, refreshToken, uid, domain}    + 刷新轮转
//	codearts  → {AK, SK, SessionToken, RefreshToken, DPoP私钥} + 一次性 refresh_token + 签名
//	loomy     → {session}                                     ← 就这一个字段
//
// 来源：Loomy 是 Electron 应用，登录后把登录态明文写在
// `%APPDATA%\Loomy\Local Storage\leveldb\*.log` 的 `loomy-auth-session` 键下，
// 里面的 `session`（32 位小写 hex）就是它的 API 凭证。
//
// # 为什么本插件**不实现** auth.refresh
//
// 证据（源项目手册第 2.2 / 2.3 节）：
//
//	· 客户端重启 4 次，session 值始终未变
//	· Local Storage 里该键只有 1 条历史，从未轮换
//	· 源码里没有 /auth/refresh、checkSession、sessionExpired 之类的判断
//	· 服务端 /models 响应无 expires / ttl 字段，响应头无 Expires
//	· 无效 session 的报错是「登录已失效，请重新登录」——区分「无效」与「过期」
//
// 也就是说：**没有可刷的东西**。造一个空的 refresh 会让 magpie 以为
// 「这个上游的凭证能自动恢复」，从而把「换号重试」当成有效处置 ——
// 而现实是只能人工重登。失效应当被标成 signIn: "expired"（见 src/http.mjs）。

import { createHash } from "node:crypto"

/**
 * 一份 Loomy 凭证。
 *
 * @typedef {object} Credential
 * @property {string} session     32 位小写 hex，**唯一**的鉴权材料
 * @property {string} uid         账号主键（magpie 用它区分账号）
 * @property {string} nickname    展示名（手机号掩码优先）
 * @property {string} phone       客户端登录态里的手机号
 * @property {string} userId      客户端登录态里的 userid
 * @property {string} loggedInAt  客户端记录的登录时刻（ISO8601 字符串）
 */

/**
 * 由 session 派生一个稳定 UID。
 *
 * 用在「客户端登录态里没有 userid」的情形（手抄 session、或上游改了字段名）。
 * 取 sha256 前 16 位十六进制而不是直接截 session：
 * 一是避免把凭证本身当成账号标识到处出现在日志/界面里，二是长度可控。
 *
 * @param {string} session
 * @returns {string}
 */
export function deriveUID(session) {
  return createHash("sha256").update(String(session ?? ""), "utf8").digest("hex").slice(0, 16)
}

/**
 * 报告 session 是否形如实测的 32 位小写 hex。
 *
 * ⚠ 它只用来**告警**，**不作为拒绝条件**。
 *
 * 上游随时可能改成别的形态（加长、加前缀、换编码）。硬校验的后果是
 * 一个仍然可用的凭证被我们自己拒之门外，而用户看到的是「一填就报错」——
 * 那种错误最难归因：明明是上游格式变了，却像用户抄错了。
 *
 * @param {string} s
 * @returns {boolean}
 */
export function looksLikeSession(s) {
  return /^[0-9a-f]{32}$/.test(String(s ?? ""))
}

/** 返回第一个非空（去空白后）的字符串。 */
function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = String(v ?? "").trim()
    if (s) return s
  }
  return ""
}

/** 日志用的短 uid：前 8 位。 */
export function shortUID(uid) {
  const s = String(uid ?? "")
  return s.length <= 8 ? s : s.slice(0, 8)
}

/**
 * 解析一份凭证 JSON。
 *
 * 同时认两种形态，这是刻意的：
 *
 *	① 客户端原样导出的登录态（只有 session/userid/phone/loggedInAt）
 *	② 本插件写盘的形态（多出 uid/nickname）
 *
 * 用户从客户端数据目录抄出来的是 ①，粘进 magpie 就能用；
 * 插件自己写出来的是 ②，重启后能原样读回。拒绝任何一种都会造成
 * 「手工能建、程序建的不认」这种别扭的不对称。
 *
 * @param {string|object} raw
 * @returns {Credential}
 * @throws 缺少 session 时抛错（它是唯一鉴权材料，留空只会在第一次请求时
 *   炸成「登录已失效」，不如在加载时就说清）
 */
export function parseCredential(raw) {
  /** @type {any} */
  let rs
  if (typeof raw === "string") {
    try {
      rs = JSON.parse(raw)
    } catch (e) {
      throw new Error(`loomy: 凭证不是合法 JSON: ${e?.message ?? e}`)
    }
  } else {
    rs = raw
  }
  if (!rs || typeof rs !== "object") {
    throw new Error("loomy: 凭证必须是 JSON 对象")
  }

  const session = String(rs.session ?? "").trim()
  if (!session) {
    throw new Error("loomy: 凭证缺少 session 字段（它是唯一鉴权材料）")
  }

  const phone = firstNonEmpty(rs.maskedPhone, rs.phone)
  const userId = firstNonEmpty(rs.userid, rs.userId)

  // UID 顺序**不能反**：同一个号在「先派生了 uid、后拿到 userid」之后
  // 必须收敛到 userid，否则池子里会出现同一份凭证的两个账号。
  const uid = firstNonEmpty(userId, rs.uid, deriveUID(session))

  // 昵称**手机号优先**（与其他上游统一用手机号显示账号）。
  // 顺序不能是 nickname 在前 —— 批量导入的凭证里 nickname 往往是登录态的
  // 名称，而同一份凭证里明明有 phone。
  const nickname = firstNonEmpty(phone, rs.nickname, shortUID(uid))

  return {
    session,
    uid,
    nickname,
    realNickname: firstNonEmpty(rs.realNickname, rs.nickname),
    phone,
    userId,
    loggedInAt: String(rs.loggedInAt ?? ""),
  }
}

/**
 * 把凭证编成落盘形态（②）。
 *
 * 带缩进与结尾换行：这些文件是人会打开看的（排查 session 是不是抄错了），
 * 压成一行会让 diff 与肉眼核对都变得难受。
 *
 * @param {Credential} auth
 * @returns {string}
 */
export function marshalCredential(auth) {
  return JSON.stringify(
    {
      session: auth.session,
      uid: auth.uid,
      nickname: auth.nickname,
      realNickname: auth.realNickname,
      phone: auth.phone,
      userId: auth.userId,
      loggedInAt: auth.loggedInAt,
    },
    null,
    2,
  ) + "\n"
}

/**
 * 按 UID 去重，同一 UID 保留 loggedInAt 较新的一份。
 *
 * # 为什么需要
 *
 * 同一个号可能既有一份「手抄的 session」，又有一份「插件写回的」，
 * 或者用户复制文件时留下了 `loomy-<uid> (1).json`。两份都进池子会让
 * 同一个号被当成两个账号（并发上限被虚增、日志对不上）。
 *
 * 返回顺序 = UID 在入参里**首次出现**的顺序，不按 map 遍历
 * —— map 顺序随机，会让池子内容与启动日志不可复现。
 *
 * @param {Credential[]} list
 * @returns {Credential[]}
 */
export function pickWinners(list) {
  /** @type {Map<string, Credential>} */
  const best = new Map()
  /** @type {string[]} */
  const order = []
  for (const a of list) {
    if (!a || !a.uid) continue
    const cur = best.get(a.uid)
    if (!cur) {
      best.set(a.uid, a)
      order.push(a.uid)
      continue
    }
    // loggedInAt 是 ISO8601，同格式下字符串比较即时间序。
    // 空值视为最旧：有时间的比没时间的可信。
    if (String(a.loggedInAt ?? "") > String(cur.loggedInAt ?? "")) {
      best.set(a.uid, a)
    }
  }
  return order.map((uid) => /** @type {Credential} */ (best.get(uid)))
}
