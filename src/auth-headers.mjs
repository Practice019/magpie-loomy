// auth-headers.mjs 双轨鉴权 —— 本插件对上游唯一「不可省」的知识。
//
// ⚠⚠ 这是整个插件里最容易出错、也最难排查的一段。源项目手册第 3 节把它列为
// 「90% 的人卡在这」。
//
// 同一个上游的两个端点认**不同**的 Header：
//
//	GET  /models            →  token: <session>
//	POST /chat/completions  →  Authorization: Bearer <session>
//
// 用错的那一个返回 HTTP **200** + `{"code":"100002","desc":"缺少 token"}`。
//
// 注意那个 200：**「看状态码判断鉴权对不对」这条路是不通的**。
// 拿 Authorization 去拉目录会拿到一段没有模型列表的 JSON，于是失败以
// 「目录为空 / 解析不出模型」的形态出现，而不是「鉴权头用错了」——
// 上游不会告诉你，你只能从「为什么目录是空的」倒推。
//
// # 为什么拆成两个独立的小函数，而不是一个 applyAuth(headers, kind)
//
// 合成一个带 kind 参数的函数之后，两处调用点长得一模一样：
//
//	applyAuth(h, AUTH_MODELS)
//	applyAuth(h, AUTH_CHAT)
//
// 评审时看不出哪个端点用了哪个 Header，改错一个（把两个 kind 写反）
// 在 diff 里几乎不可见。拆成两个各自命名的函数之后，「谁用了哪个」
// 在调用点就是字面事实。有测试钉死这对判据。
//
// # 三个端点的差异（都是实测，不是风格选择）
//
//	/models              token                只发这一个
//	/chat/completions    Authorization        只发这一个
//	/images/generations  **两个都发**          官方客户端也是两个都发
//	/search/tencent      Authorization        只发这一个（最小必要）
//
// 生图那里两个都发是唯一有实测背书的形态：官方客户端的注释写着
// 「session 模式同时塞 token + Authorization（兼容 Loomy iModel 两种入参）」。

import { DEFAULT_LOOMY_VERSION, REQUEST_PURPOSE_CHAT, CLIENT_ACCEPT } from "./constants.mjs"
import { createHash } from "node:crypto"

/**
 * 给**模型目录**请求装鉴权头。
 *
 * 目标形态：`token: <session>`
 *
 * @param {Headers} headers
 * @param {{session: string}} auth
 */
export function modelsAuth(headers, auth) {
  headers.set("token", auth.session)
}

/**
 * 给**对话**请求装鉴权头。
 *
 * 目标形态：`Authorization: Bearer <session>`
 *
 * @param {Headers} headers
 * @param {{session: string}} auth
 */
export function chatAuth(headers, auth) {
  headers.set("Authorization", `Bearer ${auth.session}`)
}

/**
 * 给**生图**请求装鉴权头：两个都发。
 *
 * ⚠ 只在生图端点上这么做。别把它推广到 chat/models —— 那两个是严格单轨。
 *
 * @param {Headers} headers
 * @param {{session: string}} auth
 */
export function imageAuth(headers, auth) {
  chatAuth(headers, auth)
  modelsAuth(headers, auth)
}

/**
 * 给**积分网关**请求装鉴权头。
 *
 * ⚠ 积分网关只认 `token:`，与 /models 同一条轨（不是 /chat/completions 那条）。
 * 实测该网关不认 Authorization。
 *
 * @param {Headers} headers
 * @param {{session: string}} auth
 */
export function pointsAuth(headers, auth) {
  headers.set("token", auth.session)
}

// ── 客户端指纹：让出站请求与 Loomy 客户端**逐项一致** ────────────────────
//
// # 为什么这件事和鉴权头一样重要
//
// 客户端自己的注释（v0.9.39 `request-headers.js`）：
//
//	「实测 Loomy iModel 缺 traceparent 时 chat/completions 会挂死直到超时。」
//
// 只发 `Authorization` 的结果是「能用一会儿，然后卡死在超时上」——
// 因为请求看起来不像客户端发的。下面这些头客户端**每个请求都发**：
//
//	Accept / Content-Type            JSON 两次声明（上游按它决定是否流式）
//	traceparent                      每个请求新生成（复用等于没发）
//	loomy-version                    客户端版本
//	X-Loomy-Request-Purpose          对话主链路固定 chat.message
//	ChatId / MsgId / TurnId / InvokeOrigin   有值才发（缺失是常态）
//	token + Authorization            session 模式两个都发
//
// ⚠ 只做 **merge**：绝不删除调用方/宿主已经设过的头（宿主注入的
// `Authorization` 值相同则覆盖，`X-*` 之类一律保留）。

/** 一个 8 位十六进制片段（`crypto.getRandomValues`，不引入依赖）。 */
function randomHex(bytes) {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  let out = ""
  for (const b of buf) out += b.toString(16).padStart(2, "0")
  return out
}

/**
 * 生成一个 W3C `traceparent`：`00-<32hex>-<16hex>-01`。
 *
 * ⚠ **每次请求都要新生成**：客户端是每请求一个新 ID；复用同一个会让上游
 * 把它当成重复/重放，正是「挂死直到超时」的形态。
 *
 * @returns {string}
 */
export function newTraceparent() {
  return `00-${randomHex(16)}-${randomHex(8)}-01`
}

/**
 * 给**对话**请求装与客户端一致的完整头组。
 *
 * @param {Headers} headers 就地修改并返回（方便链式）
 * @param {{session: string}} auth
 * @param {{chatId?: string, msgId?: string, turnId?: string, invokeOrigin?: string,
 *   purpose?: string, version?: string}} [opts]
 *   有值才发的那些头来自调用方（客户端的 ChatId / MsgId / TurnId / InvokeOrigin）。
 * @returns {Headers}
 */
export function chatHeaders(headers, auth, opts = {}) {
  // 鉴权：session 模式**两个都发**（客户端 `useSessionAuth` 分支就是这么做的）
  headers.set("Authorization", `Bearer ${auth.session}`)
  headers.set("token", auth.session)

  // 客户端固定/半固定头
  // ⚠ `Accept` 抓包实证是通配符 `*/*`（不是 application/json）
  headers.set("Accept", String(opts.accept ?? CLIENT_ACCEPT))
  headers.set("Content-Type", "application/json")
  headers.set("traceparent", newTraceparent())
  headers.set("loomy-version", String(opts.version ?? DEFAULT_LOOMY_VERSION))
  headers.set("X-Loomy-Request-Purpose", String(opts.purpose ?? REQUEST_PURPOSE_CHAT))
  if (opts.sessionAffinity) headers.set("X-Session-Affinity", String(opts.sessionAffinity))

  // 「有才发」的那些：缺失是常态，不要凭空造
  const optional = { ChatId: opts.chatId, MsgId: opts.msgId, TurnId: opts.turnId, InvokeOrigin: opts.invokeOrigin }
  for (const [name, value] of Object.entries(optional)) {
    const v = String(value ?? "").trim()
    if (v) headers.set(name, v)
  }
  return headers
}

/**
 * 由账号身份派生一个**稳定**的 `ses_<20 位 [A-Za-z0-9]>`（`X-Session-Affinity`）。
 *
 * # 为什么必须按账号稳定
 *
 * 抓包实证客户端发的是 `x-session-affinity: ses_<20位>`。这是「会话粘性」信号
 * （同一个人一直在同一个会话里）。如果每请求随机，上游看到的就是「一个人
 * 每次都是新会话」；如果对所有账号用同一个值，又等于「所有人共用一个会话」。
 * 所以：**同一个 uid 恒定，不同 uid 不同**，且不落盘（纯派生，重启也不变）。
 *
 * @param {string} uid
 * @returns {string} uid 为空时返回 ""（调用方据此不发这个头）
 */
export function sessionAffinity(uid) {
  const key = String(uid ?? "").trim()
  if (!key) return ""
  const digest = createHash("sha256").update(key).digest()
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let n = BigInt(`0x${digest.toString("hex")}`)
  let out = ""
  for (let i = 0; i < 20; i += 1) {
    out += alphabet[Number(n % 62n)]
    n /= 62n
  }
  return `ses_${out}`
}
