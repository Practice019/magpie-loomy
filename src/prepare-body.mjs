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

// ⚠ 不再 import `maxOutputFor`：既然不裁剪，就不需要模型上限。

/**
 * 客户端对话请求的固定输出上限（抓包实证）。
 *
 * ⚠ 仅**导出供面板/文档引用**：用户明确要求「原始 body 一模一样」，
 * 所以 `prepareBody` **不再**用它裁剪、也不再补默认值。
 */
export const CLIENT_CHAT_MAX_TOKENS = 32_000

/**
 * 客户端固定的推理强度（抓包实证）。
 *
 * ⚠ 同上：仅导出备查，`prepareBody` 不再注入。
 */
export const CLIENT_REASONING_EFFORT = "high"

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

  // ── 与客户端 1:1：`stream_options.include_usage` ──
  //
  // 客户端走 AI SDK 流式请求，会带 `stream_options: { include_usage: true }`。
  // 缺了它上游不在流里给 usage 帧，「这次花了多少」就缺一块。
  //
  // ⚠ 三条边界：
  //	① 只在流式时补（本函数已经强制 stream=true，所以就在下面）
  //	② `stream_options` 是字符串 / 数组时**不动** —— 那是上游该诊断的形态
  //	③ 调用方显式写了 `include_usage: false` 就尊重它，别改成 true
  if (obj.stream === true) {
    if (obj.stream_options === undefined) {
      obj.stream_options = { include_usage: true }
    } else if (
      obj.stream_options &&
      typeof obj.stream_options === "object" &&
      !Array.isArray(obj.stream_options) &&
      obj.stream_options.include_usage === undefined
    ) {
      obj.stream_options.include_usage = true
    }
  }

  // ── ⚠ 这里**不再**裁剪或补默认值（用户明确要求：原始 body 一模一样）──
  //
  // 历史：曾把 `max_tokens` 裁到 32000、给 `reasoning_effort` 补 `"high"`，
  // 依据是「客户端就是这么发的」。但用户的原话是：
  //
  //	「为什么要自己裁剪呢？我就是要原始的 BODY 一模一样。」
  //
  // 所以现在只做两件 magpie 与上游**必要**的改写：
  //	① `stream = true`    —— magpie 网关要把流按客户端要求重新编码，非流式拿不到
  //	② `stream_options`   —— 客户端也带；缺了流里就没有 usage 帧
  //
  // `max_tokens` / `max_completion_tokens` / `reasoning_effort`：**调用方给多少
  // 就发多少，没给就不加**。`messages` / `tools` / `tool_choice` 依旧一字不动。
  //
  // 需要「连这两处也不改」的极端验证，用 `makeLoaderHook({ bodyMode: "passthrough" })`。

  try {
    return JSON.stringify(obj)
  } catch {
    return body
  }
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
