// token-life.mjs JWT 有效期的**只读**判据 —— 三个插件仓库共用同一份实现。
//
// # 为什么要有这个模块（loomy 自己并**不**用它续期）
//
// loomy 的 session 不过期、也没有 refresh token（见 `src/credential.mjs`），
// 所以本插件**不实现** `auth.refresh`。这里放工具函数的唯一理由是
// **让判据实现保持一致**：别的上游（workbuddy / codearts 那一类）真的会续期，
// 而三个仓库各写一份「是否过半」的判据时，总有一个会写错边界。
//
// ⚠ **不要把本模块接到 loomy 的任何钩子上。** 它的存在只是为了让
// `readJwtClaims` / `pastHalfLife` 在多个仓库里是同一段代码，日后好比对。
//
// # 两条纪律
//
//	1. **不校验签名**：这里只回答「这个 token 还有多久」，不做安全判断。
//	   （真实校验是上游的事；我们把签名拿去当判据只会造假结论。）
//	2. **认不出就认不出**：不是 JWT（段数不对 / 不是 base64url / 不是 JSON /
//	   没有数字型 `iat`·`exp`）一律返回 `null`，绝不猜。

/**
 * 从一条 JWT 里读出 `iat` / `exp`（秒），**不校验签名**。
 *
 * 只解第二段（payload），只看 `iat` 与 `exp` 两个字段：
 *
 *	① 不是 3 段 → null
 *	② 第二段不是合法 base64url / 不是合法 JSON 对象 → null
 *	③ `iat` 或 `exp` 不是有限数字 → 那两个字段给 0（仍返回对象 —— 调用方能用
 *	   另一个字段判断），**两 个都缺** → null
 *
 * @param {string} token
 * @returns {{iat: number, exp: number}|null}
 */
export function readJwtClaims(token) {
  const raw = String(token ?? "").trim()
  if (!raw) return null

  const parts = raw.split(".")
  // JWT 必须是 `header.payload.signature` 三段（JWE 的 5 段不在此列：本判据只认 JWS）
  if (parts.length !== 3) return null

  /** @type {any} */
  let payload
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]))
  } catch {
    return null
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null

  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const iat = num(payload.iat)
  const exp = num(payload.exp)
  // 两个都没有 —— 这不是一个能用来判断有效期的 token
  if (iat === null && exp === null) return null

  return { iat: iat ?? 0, exp: exp ?? 0 }
}

/**
 * 是否已经走完一半有效期（或已过期）⇒ **该续期**。
 *
 * # 为什么是「过半」而不是「快到期」
 *
 * 续期窗口要留给失败重试与网络抖动。等到剩 5% 再续，第一次失败就没有第二次机会了。
 * 过半是一个**与总寿命成比例**的阈值：短寿命 token 早一点、长寿命 token 也早一点，
 * 不会出现「1 小时的就剩 30 分钟才续、12 小时的要剩 6 分钟才续」这种荒谬比例。
 *
 * # 总有效期算不出来时返回 `true`
 *
 * `total <= 0`（`exp <= iat` / 字段缺失 / 时间倒退）说明这份 token **不可信**，
 * 交给调用方兜底（它的兜底通常是「重新登录」，比「永远不续」安全）。
 *
 * @param {number} iatSec 签发时刻（秒）
 * @param {number} expSec 过期时刻（秒）
 * @param {number} [nowSec] 当前时刻（秒；测试注入固定时钟）
 * @returns {boolean}
 */
export function pastHalfLife(iatSec, expSec, nowSec = Math.floor(Date.now() / 1000)) {
  const iat = Number(iatSec)
  const exp = Number(expSec)
  const now = Number(nowSec)
  const total = exp - iat
  if (!Number.isFinite(total) || total <= 0) return true
  if (!Number.isFinite(now)) return true
  return exp - now <= total * 0.5
}

// ── 内部 ────────────────────────────────────────────────────────────────

/**
 * base64url → UTF-8 字符串。
 *
 * JWT 用的是 base64url（`-` / `_`，无填充），先补 `=` 再交给 `atob`；
 * 中文 / emoji 这类多字节字符必须按 UTF-8 解，不能直接 `atob` 出二进制串。
 *
 * @param {string} seg
 * @returns {string}
 */
function base64UrlDecode(seg) {
  const normalized = String(seg).replace(/-/g, "+").replace(/_/g, "/")
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4))
  const binary = atob(normalized + pad)
  // atob 给的是「每字节一个 char」的二进制串 —— 手工解码成 UTF-8
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}