// multipliers.mjs 从**官方 /models 接口**的模型展示名里解析成本倍率。
//
// # 数据源
//
// `GET /models` 每个模型的 `name` 字段，如 `"DeepSeek V4 Flash 0731（x3.0）"`。
// 官方把成本倍率下放在展示名后缀里 —— loomy 的 /models **没有独立价格字段**。
//
// # 拉不到就不显示
//
// 没有官方数据就返回空表（前端显示「x无」），**不估算**。伪造一个倍率
// 比不显示糟糕得多：用户会据此判断「用哪个模型划算」。

/**
 * 匹配模型展示名末尾的官方倍率后缀。
 *
 * 全角 `（x3.0）` 与半角 `(x3.0)` 都要认 —— 实测上游两种都发。
 */
const NAME_MULTIPLIER_RE = /[（(]x([0-9]+(?:\.[0-9]+)?)[）)]\s*$/

/**
 * 从官方展示名提取倍率。
 *
 * @param {string} name
 * @returns {{ value: number, ok: boolean }}
 *   `ok=false` 表示「没有倍率后缀」或「值不合法」，调用方据此跳过这一条。
 *   `x0` 视为不合法：0 不是倍率，是「没给」。
 */
export function parseNameMultiplier(name) {
  const m = NAME_MULTIPLIER_RE.exec(String(name ?? "").trim())
  if (!m) return { value: 0, ok: false }
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return { value: 0, ok: false }
  return { value, ok: true }
}

/**
 * 把一份 `/models` 的模型列表转成 `{ 模型id: 倍率 }`。
 *
 * 解析不出倍率的模型**不出现在结果里**（而不是出现并带 0）。
 *
 * @param {Array<{id?: string, name?: string}>} list
 * @returns {Record<string, number>}
 */
export function multipliersFromCatalog(list) {
  /** @type {Record<string, number>} */
  const out = {}
  if (!Array.isArray(list)) return out
  for (const entry of list) {
    const id = String(entry?.id ?? "").trim()
    if (!id) continue
    const { value, ok } = parseNameMultiplier(entry?.name)
    if (ok) out[id] = value
  }
  return out
}
