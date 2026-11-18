// sms-login.mjs 讯飞账号网关的**短信验证码登录**。
//
// # 为什么需要这条路
//
// 「读本机客户端登录态」那条路在「客户端没装 / 没登录 / 插件跑在另一台机器上」
// 时完全不可用。而直接输手机号 + 验证码在任何部署下都能用。
//
// 协议来自对 `Loomy.exe` 的逆向报告：
//
//	POST {accountBase}/login/phone/sendMsgCode   → data.msgid（短信已发出）
//	POST {accountBase}/login/phone/checkCode     → data.session + data.userid
//
// **两个端点都需要 HMAC-SHA1 请求签名**，缺签名会直接 403/401 ——
// 所以本文件的主要重量在签名上，而不是在调用上。
//
// # 关于内置的那对 key（必须说清楚，不能装作没这回事）
//
// `accessKeyId` / `accessKeySecret` 随客户端安装包分发，藏在
// `resources/.env.prod` 里（AES-256-GCM + scrypt 口令**内嵌在同一个包里**）。
// 客户端自己的源码注释就写明这是 **"local-obfuscation"、不是真保密** ——
// 任何拿到安装包的人都能还原它们。
//
//	⚠ 它们**不是用户凭证**：泄漏不等于掉号，但它确实让「拿到安装包就能以
//	  官方身份调用账号网关」成立。这与「硬编码用户自己的 api_key」不是同一类
//	  东西，所以这里内置，同时留环境变量覆盖口。

import { createHmac, createHash, randomBytes, randomUUID } from "node:crypto"

import {
  DEFAULT_ACCOUNT_BASE_URL,
  DEFAULT_ACCOUNT_APP_ID,
  DEFAULT_ACCOUNT_ACCESS_KEY,
  DEFAULT_ACCOUNT_ACCESS_SECRET,
  ACCOUNT_UA,
  MAX_ACCOUNT_BODY,
  OK_CODE,
} from "./constants.mjs"
import { deriveUID, shortUID } from "./credential.mjs"

/** 一次签名所需的四件东西。 */
export class AccountGateway {
  /**
   * @param {{baseUrl?: string, appId?: string, accessKey?: string, accessSecret?: string,
   *   fetchImpl?: typeof fetch}} [opts]
   *   空字段落回默认值（客户端安装包里那套）。
   */
  constructor(opts = {}) {
    const pick = (v, def) => (String(v ?? "").trim() ? String(v).trim() : def)
    this.baseUrl = pick(opts.baseUrl, DEFAULT_ACCOUNT_BASE_URL).replace(/\/+$/, "")
    this.appId = pick(opts.appId, DEFAULT_ACCOUNT_APP_ID)
    this.accessKey = pick(opts.accessKey, DEFAULT_ACCOUNT_ACCESS_KEY)
    this.accessSecret = pick(opts.accessSecret, DEFAULT_ACCOUNT_ACCESS_SECRET)
    this.fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  }

  /** 签名所需的四件东西都齐了。 */
  configured() {
    return Boolean(this.baseUrl && this.appId && this.accessKey && this.accessSecret)
  }

  /**
   * 下发短信验证码，返回 msgid（下一步验码要带回）。
   *
   * @param {string} phone 11 位大陆手机号
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<string>}
   */
  async sendCode(phone, opts = {}) {
    const p = String(phone ?? "").trim()
    if (!p) throw new Error("loomy: 手机号不能为空")

    const data = await this.#post(
      "/login/phone/sendMsgCode",
      { base: this.#base(), param: { ccode: "86", phone: p, expire: 300 } },
      opts,
    )
    const msgid = String(data?.msgid ?? "")
    if (!msgid) throw new Error("loomy: 短信下发成功但回执里没有 msgid")
    return msgid
  }

  /**
   * 用手机号 + 验证码 + msgid 换取 session。
   *
   * 返回的凭证已经填好 session / uid / nickname，可直接落盘。
   *
   * @param {string} phone
   * @param {string} code
   * @param {string} msgid
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<object>} 一份 credential（见 credential.mjs）
   */
  async login(phone, code, msgid, opts = {}) {
    const p = String(phone ?? "").trim()
    const c = String(code ?? "").trim()
    const m = String(msgid ?? "").trim()
    if (!p || !c) throw new Error("loomy: 手机号与验证码都不能为空")

    const data = await this.#post(
      "/login/phone/checkCode",
      {
        base: this.#base(),
        param: { ccode: "86", phone: p, mcode: c, msgid: m, expire: 14 * 24 * 3600 },
      },
      opts,
    )

    const session = String(data?.session ?? "").trim()
    if (!session) throw new Error("loomy: 登录成功但回执里没有 session")

    const userId = String(data?.userid ?? "").trim()
    const phoneOut = String(data?.phone ?? "").trim() || p
    // 登录时刻由**我们**记下来（账号网关的回执里没有这个字段，
    // 而 loggedInAt 要用于「同一 uid 多份凭证取较新者」的排序）。
    const loggedInAt = new Date().toISOString()

    const uid = userId || deriveUID(session)
    return {
      session,
      uid,
      nickname: phoneOut || String(data?.nickname ?? "").trim() || shortUID(uid),
      phone: phoneOut,
      userId,
      loggedInAt,
    }
  }

  /**
   * 拼请求里的 base 段（与客户端 makeBase 逐字段一致）。
   *
   * traceid 是 32 位 hex（客户端用 UUID 去掉横线）。**每次请求重新生成** ——
   * 它是链路追踪 id，不是会话标识，重用会让多账号排障时对不上。
   */
  #base() {
    return {
      appid: this.appId,
      modelid: "web",
      version: "1.0.0",
      devid: "web",
      ua: ACCOUNT_UA,
      traceid: randomBytes(16).toString("hex"),
    }
  }

  /**
   * 签一个名、发一个 JSON 请求、解出 `data` 段。
   *
   * 账号网关的响应格式是 `{"code":"000000","desc":"…","data":{…}}`：
   * **业务失败也是 HTTP 200**，所以判据必须看 `code` 而不是状态码 ——
   * 与 loomy 模型代理的「200 + 缺少 token」是同一种（很容易搞错的）形态。
   */
  async #post(path, body, opts = {}) {
    if (!this.configured()) {
      throw new Error("loomy: 账号网关未配置（缺 base/appid/access key）")
    }
    const raw = JSON.stringify(body)
    const headers = new Headers(this.sign(path, raw))
    const init = { method: "POST", headers, body: raw }
    if (opts.signal) init.signal = opts.signal

    const resp = await this.fetchImpl(this.baseUrl + path, init)
    const text = await resp.text()

    /** @type {any} */
    let out
    try {
      out = JSON.parse(text)
    } catch {
      throw new Error(`loomy: 账号网关回执不是合法 JSON（HTTP ${resp.status}）: ${summarize(text)}`)
    }
    if (String(out?.code ?? "") !== OK_CODE) {
      // desc 是给人看的（「验证码错误」/「验证码已过期」…），原样带出去 ——
      // 换成我们自己的措辞会让用户失去唯一的可行动信息。
      throw new Error(`loomy: 账号网关返回 ${out?.code}: ${out?.desc ?? ""}`)
    }
    return out?.data
  }

  /**
   * 生成一次请求所需的全部鉴权头。
   *
   * # stringToSign 是 9 段以 \n 连接
   *
   *	METHOD  ESCAPED_PATH  ESCAPED_QUERY  CONTENT_MD5  CONTENT_TYPE
   *	DATE  NONCE  SIGNED_HEADERS  CANONICALIZED_HEADERS
   *
   * 本实现不发任何 `x-` 前缀的自定义头，所以第 8 段是空串、第 9 段也是空串
   * （拼接后 stringToSign 以两个 \n 结尾 —— 照抄客户端的实现，不要「顺手清理」）。
   *
   *	⚠ 判据必须逐段对齐：只要某一段少一个字符，服务端返回的是
   *
   * **签名不匹配**（而不是 401/403 那种一眼能看出的形态），
   * 实测表现与「key 不对」完全一样，极难分辨。
   *
   * @param {string} path
   * @param {string} body
   * @returns {Record<string, string>}
   */
  sign(path, body) {
    const date = new Date().toUTCString() // = Go 的 http.TimeFormat
    const nonce = randomUUID()

    let contentMD5 = ""
    if (body) {
      contentMD5 = createHash("md5").update(body, "utf8").digest("base64")
    }

    const parts = [
      "POST",
      escapeAccountPath(path),
      "", // ESCAPED_QUERY：本实现的三个端点都不带 query
      contentMD5,
      "application/json",
      date,
      nonce,
      "", // SIGNED_HEADERS：没有 x- 头
      "", // CANONICALIZED_HEADERS：同上
    ]
    const sig = createHmac("sha1", this.accessSecret).update(parts.join("\n"), "utf8").digest("base64")

    /** @type {Record<string, string>} */
    const headers = {
      Authorization: "account " + this.accessKey + ":" + sig,
      Date: date,
      Nonce: nonce,
      "Content-Type": "application/json",
    }
    if (contentMD5) headers["Content-MD5"] = contentMD5
    return headers
  }
}

/**
 * 按 RFC3986 **逐段**转义路径。
 *
 * `encodeURIComponent` 不转义 `!'()*`，而讯飞的签名要求它们也转义 ——
 * 客户端自己就是这么补的（其 sign.js），照抄。
 *
 * @param {string} p
 * @returns {string}
 */
export function escapeAccountPath(p) {
  let path = String(p ?? "")
  if (!path.startsWith("/")) path = "/" + path
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1)
  return path
    .split("/")
    .map((seg) => (seg === "" ? "" : encodeURIComponent(seg).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())))
    .join("/")
}

/**
 * 粗判手机号形态（11 位数字，以 1 开头）。
 *
 * ⚠ 只在**发短信之前**做一次体检，用来省下一条必然失败的短信；
 * 它不校验手机号是否真实存在 —— 那只有账号网关知道。
 *
 * @param {string} s
 * @returns {boolean}
 */
export function looksLikePhone(s) {
  return /^1\d{10}$/.test(String(s ?? "").trim())
}

function summarize(raw, max = 200) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim()
  if (!s) return "(空)"
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max).join("") + "…"
}
