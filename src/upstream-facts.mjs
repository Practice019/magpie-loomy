// upstream-facts.mjs 「上游的错误长什么样」——只有本插件知道的事实。
//
// # 这个文件为什么存在，以及为什么这么短
//
// 重试、换号、熔断、冷却**全部由 magpie 网关负责**，本插件不碰。
// 插件只需要回答一件 magpie 猜不出来的事：
//
//	「这个 401/403 到底是不是「登录失效」？」
//
// 因为 magpie 的默认判据是「401 → 标记账号需要重新登录」。而本上游的失败
// 有三种完全不同的形状，其中两种**不是**登录问题：
//
//	缺少 token / 登录已失效        → 真的登录失效 → 标 expired
//	模型不可用 / 内容拦截           → 账号没事     → 标 kept
//	其余（额度、限流、5xx）         → 账号没事     → 标 kept
//
// 标错的代价：把一个健康的账号打成「需要重新登录」，用户会去删一个其实
// 好好的号。
//
// # Loomy 的错误形态（源项目手册第 9/10 节，全部是实测原文）
//
//	{"code":"100002","desc":"缺少 token"}        ← 注意：HTTP **200**
//	登录已失效，请重新登录                        ← session 无效
//	You have insufficient credits to make ...     ← 积分耗尽
//	Model "xxx" is not supported on this endpoint ← 模型名不对
//	该模型暂未开放                                ← 404，生图模型被 chat 端点拒
//	{"error":{"type":"invalid_request_error"}}
//	prompt is too long: 100001 tokens > 100000 maximum
//
// ⚠ 第一条印证了双轨鉴权的坑：**鉴权失败的响应是 200**。
// 所以判据必须先看正文，不能只看状态码。

/** magpie 的登录态标记头。宿主会在转发前把它去掉。 */
export const SIGN_IN_HEADER = "X-Magpie-Sign-In"

/** 登录真的失效了。 */
const MARK_SESSION_DEAD = ["缺少 token", "登录已失效"]

/**
 * 账号没事、但请求失败的那些（明确要 `kept`，避免误杀）。
 *
 * 这一列宁可长一点：多列一条的代价只是「某条别的错误没被当成登录问题」，
 * 而漏一条的代价是把健康账号标成需要重登。
 */
const MARK_ACCOUNT_FINE = [
  "insufficient credits",
  "is not supported on this endpoint",
  "该模型暂未开放",
  "model_not_found",
  "invalid_request_error",
  "请求参数错误",
  "context_length_exceeded",
  "prompt is too long",
  "maximum context length",
  "exceeds the maximum",
  "context overflow",
  "too many tokens",
  "超出上下文",
]

/**
 * 判断一次上游应答该给 magpie 什么登录态标记。
 *
 * @param {number} status HTTP 状态码
 * @param {string} body   响应正文（可以为空）
 * @returns {"expired"|"kept"|null} null = 不表态，交给宿主默认判据
 */
export function signInVerdict(status, body) {
  const text = String(body ?? "")
  const lower = text.toLowerCase()

  // ── 正文判据优先（鉴权失败的响应是 200，状态码靠不住）──
  if (MARK_SESSION_DEAD.some((m) => text.includes(m))) return "expired"
  if (MARK_ACCOUNT_FINE.some((m) => lower.includes(m.toLowerCase()))) return "kept"

  // ── 正文认不出时的状态码兜底 ──
  // 401/403 交给宿主默认判据（它会标 expired），但我们已经排除了
  // 「正文说明是别的问题」的那些。
  if (status === 401 || status === 403) return null
  // 其余状态码不是登录问题 —— 明确 kept，防止宿主按 401 之外的规则误判。
  if (status >= 400) return "kept"
  return null
}

/**
 * 把登录态标记装进响应头。
 *
 * @param {Headers} headers
 * @param {"expired"|"kept"|"renewed"|null} verdict
 */
export function applySignInHeader(headers, verdict) {
  if (verdict) headers.set(SIGN_IN_HEADER, verdict)
}

/**
 * 这个模型 ID 是不是「只能生图、不能对话」的那一类。
 *
 * ⚠ 判据是**上游自己的模态声明**（三个模型的 `modalities.output` 只有 `image`），
 * 不是「名字像不像生图」。名字只是旁证。
 *
 * 用途：chat 请求打到这类模型时，如实回 404 而不是转发出去拿一个
 * 「该模型暂未开放」再让宿主把它当成故障。
 */
export const IMAGE_ONLY_MODEL_IDS = Object.freeze([
  "doubao-seedream-5-lite",
  "qwen-image-3.0-pro",
  "Hy-Image-3.5-preview",
])

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isImageOnlyModel(id) {
  return IMAGE_ONLY_MODEL_IDS.includes(String(id ?? "").trim())
}
