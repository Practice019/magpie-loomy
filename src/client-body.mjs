// client-body.mjs 「真实调用」与「探测」共用的**客户端 body 构造函数**。
//
// # 用户的要求（原话）
//
//	「完整的请求就直接用就行了，和客户端一样就行了呀，这样我们就不会被降级了。
//	  我们的目的就是伪装成客户端。」
//
// 所以这里不是「补几个字段」，而是**以抓包里那份完整 body 为底**（见
// `client-body-template.mjs`），只替换「这一轮真正属于调用方的两样东西」：
// model 与 messages（的 user/assistant/tool 部分）。
//
// # 保留模板值的字段（即便调用方传了不同的）
//
//	tools / tool_choice / max_tokens / reasoning_effort / $comment / stream_options
//
// 理由：这些是**客户端指纹**。调用方填不同的值我们就「不像客户端」了，
// 而「像不像客户端」直接影响上游怎么派模型（实证：简化 body 第 4 次就降级）。
//
// # system 提示词
//
// **一律用客户端的**（这是伪装的核心）。调用方自己的 system **不被丢弃**：
// 它作为**第二条 system 消息**追加在客户端 system 之后。这样既保持形态，
// 又不丢调用方的业务约束。
//
// # 其余 messages（user / assistant / tool）
//
// 一律用调用方的 —— 那才是「这一轮真正要处理的内容」。

import { CLIENT_BODY_TEMPLATE } from "./client-body-template.mjs"

/**
 * 构造一个与客户端同形的 body。
 *
 * @param {{messages?: any[], model?: string}} [input]
 *   `messages`：调用方的对话（system 会被挪到客户端 system 之后，其余原样）。
 *   `model`：要请求的模型；省略则用模板里的（`deepseek-v4-flash-1017`）。
 * @returns {object} 可直接 JSON.stringify 的 body
 */
export function buildClientBody({ messages, model } = {}) {
  const body = structuredClone(CLIENT_BODY_TEMPLATE)

  if (typeof model === "string" && model.trim()) body.model = model.trim()

  if (Array.isArray(messages) && messages.length > 0) {
    const clientSystem = (CLIENT_BODY_TEMPLATE.messages ?? []).find((m) => m?.role === "system")
    const callerSystem = messages.filter((m) => m?.role === "system")
    const rest = messages.filter((m) => m?.role !== "system")
    // 客户端 system 在前；调用方的 system 追加在其后（**不丢弃**）
    body.messages = clientSystem ? [clientSystem, ...callerSystem, ...rest] : [...callerSystem, ...rest]
  }

  // 客户端形态固定流式 + usage 帧
  body.stream = true
  if (body.stream_options === undefined || body.stream_options === null) {
    body.stream_options = { include_usage: true }
  }

  return body
}

/**
 * 这个 body 是不是「已经就是客户端形态」。
 *
 * 仅用于排障/日志：判断调用方给的 body 是否已经带齐模板里的关键字段。
 *
 * @param {any} body
 * @returns {boolean}
 */
export function looksLikeClientBody(body) {
  if (!body || typeof body !== "object") return false
  return (
    body.stream === true &&
    body.reasoning_effort === CLIENT_BODY_TEMPLATE.reasoning_effort &&
    body.max_tokens === CLIENT_BODY_TEMPLATE.max_tokens &&
    Array.isArray(body.tools) &&
    body.tools.length === CLIENT_BODY_TEMPLATE.tools.length
  )
}