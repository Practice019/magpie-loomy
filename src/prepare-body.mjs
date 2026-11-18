// prepare-body.mjs 出站前改写对话请求体。
//
// 只做两件事，都是「不做上游会失败」或「显然是白费」的：
//
//  ① **强制 stream=true**。magpie 的网关要把上游的流按客户端要求重新编码
//     （流式或非流式），所以本层统一拿流。
//  ② **裁剪超限的 max_tokens / max_completion_tokens**。每个 Loomy 模型有
//     自己的输出上限（最大的是 MiniMax-M3 的 512000），客户端抄来的配置
//     很容易填一个通用大值（比如 1e6）。超出上限会被上游拒绝，
//     而那是一次完全白跑的往返。
//
// # 解析失败时原样返回
//
// 本函数的职责是「优化」，不是「校验」。在这里造一个错误，等于把一个
// 上游能诊断的问题变成一个我们自己编的问题。

import { maxOutputFor } from "./models.mjs"

/**
 * 在出站前改写请求体。
 *
 * @param {string|Uint8Array|null|undefined} body 上游 API 形状的 JSON 字符串
 * @returns {string|Uint8Array|null|undefined} 改写后的字符串；无法解析时**原样返回**
 */
export function prepareBody(body) {
  if (body == null) return body
  if (typeof body !== "string") return body // 非 UTF-8 的字节：不碰
  if (body.length === 0) return body

  /** @type {any} */
  let obj
  try {
    obj = JSON.parse(body)
  } catch {
    return body
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return body

  obj.stream = true

  const model = typeof obj.model === "string" ? obj.model : ""
  const limit = model ? maxOutputFor(model) : 0
  if (limit > 0) {
    clampTokenField(obj, "max_tokens", limit)
    clampTokenField(obj, "max_completion_tokens", limit)
  }

  try {
    return JSON.stringify(obj)
  } catch {
    return body
  }
}

/**
 * 把 obj[key] 夹到 limit 以内（只在它确实超限时才动）。
 *
 * 只在超限时改写：未超限时保留原始值，避免「每次请求都重写一遍数字」
 * 这种无意义的差异。
 *
 * ⚠ 非数字（字符串、null）不动：那是上游该诊断的形态，不是我们该纠正的。
 */
function clampTokenField(obj, key, limit) {
  const v = obj[key]
  if (typeof v !== "number" || !Number.isFinite(v)) return
  if (v <= limit) return
  obj[key] = limit
}

/**
 * 从请求体里取模型名（取不到返回空串）。
 *
 * @param {string} body
 * @returns {string}
 */
export function modelOf(body) {
  if (typeof body !== "string" || !body) return ""
  try {
    const obj = JSON.parse(body)
    return typeof obj?.model === "string" ? obj.model : ""
  } catch {
    return ""
  }
}
