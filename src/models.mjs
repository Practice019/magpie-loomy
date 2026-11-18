// models.mjs 模型目录的**静态兜底表** + 两条正交的「可用」轴。
//
// # 这份表的角色（2026-11-17 起）
//
//	provider.models（实时 /models）  → 目录的**正源**
//	本文件的静态表                   → 登录前 / 拉取失败时的**兜底基线**
//
// 实测：上游**按账号权限下发不同模型集**（同一个上游的两个号给出不同子集），
// 所以单号视角必然不全 —— 实时目录按账号各自拉，magpie 再取并集。
// 静态表只在「一个账号都还没登录」时让界面不是 0 models。
//
// 表里的数据是 2026-11-17 用真实账号 `GET /models` 拉下来的实测快照。
// 上游加模型后它不会自动更新 —— 那没关系，登录一次后实时目录就接管。
//
// # 为什么保留静态快照
//
//	① 可用性：目录若只依赖网络，一次上游抖动或 session 失效就会让 loomy 的
//	   整片模型从 magpie 的列表里消失，agent 据此判定「模型不存在」并报错 ——
//	   而真相只是这一轮没拉到。
//	② 可核对：静态表带着实测来源，是能被审计的。纯实时拉取没有任何基线。

/**
 * 一个模型条目。
 *
 * @typedef {object} Model
 * @property {string} id            上游认的模型名，**必须原样**发出去
 * @property {number} contextWindow 上下文窗口（0 = 上游未给，表示未知）
 * @property {number} maxOutputTokens 单次输出上限（0 = 未知，**不能据此裁成 0**）
 * @property {number} [rate]        官方成本倍率（从展示名后缀解析）
 * @property {boolean} unavailable  上游在 /chat/completions 上对这个模型返回 404
 */

/**
 * 实测快照（2026-11-17，真实账号 `GET /models`）。
 *
 * ⚠ `unavailable` **只**描述「能不能走 chat」，不代表「这个模型不能用」。
 *
 * 两个生图模型的 `modalities.output` 只有 `image`，本来就不该走 chat：
 *
 *	POST /chat/completions   {"model":"doubao-seedream-5-lite"} → 404 该模型暂未开放
 *	POST /images/generations {"model":"doubao-seedream-5-lite"} → 200 + 图片
 *
 * 所以「能不能用」取决于**端点**，一个布尔表达不了。判据：
 * 任何按 unavailable 过滤的地方，都只在**对话**语境下过滤。
 */
export const KNOWN_MODELS = Object.freeze([
  { id: "spark-x2.6", contextWindow: 1048576, maxOutputTokens: 131072, rate: 2.5, unavailable: false },
  { id: "DeepSeek-V4.1-Flash", contextWindow: 1048576, maxOutputTokens: 384000, rate: 2, unavailable: false },
  { id: "deepseek-v4-flash-1017", contextWindow: 1048576, maxOutputTokens: 384000, rate: 2, unavailable: false },
  { id: "GLM-5.3-Flash", contextWindow: 1048576, maxOutputTokens: 131072, rate: 0.8, unavailable: false },
  { id: "qwen3.8-flash", contextWindow: 1000000, maxOutputTokens: 131072, rate: 0.8, unavailable: false },
  { id: "mimo-v2.5", contextWindow: 1024000, maxOutputTokens: 128000, rate: 3.3, unavailable: false },
  // 上游的「自动·均衡」路由模型（0 上下文 = 上游未给）
  { id: "auto", contextWindow: 0, maxOutputTokens: 0, unavailable: false },
  // 下面三个只能走 /images/generations（chat 端点会 404）
  { id: "Hy-Image-3.5-preview", contextWindow: 100000, maxOutputTokens: 0, unavailable: true },
  { id: "doubao-seedream-5-lite", contextWindow: 128000, maxOutputTokens: 131072, unavailable: true },
  { id: "qwen-image-3.0-pro", contextWindow: 0, maxOutputTokens: 0, unavailable: true },
])

/**
 * 只能生图、不能对话的模型（走 IMAGE_GENERATE_PATH）。
 *
 * ⚠ 判据不是「名字像不像生图」，而是**上游自己的模态声明**：
 * 这三个模型的 `modalities.output` 都只有 `image`。名字只是旁证。
 */
export const IMAGE_MODEL_IDS = Object.freeze([
  "doubao-seedream-5-lite",
  "qwen-image-3.0-pro",
  "Hy-Image-3.5-preview",
])

/**
 * 上游自己认的别名。
 *
 * 实测：请求旧称会被服务端解析到新 ID 并返回成功，**所以别名不需要我们改写**。
 * 本表只在「按模型查输出上限」时用来归一（否则别名请求会因为查不到 entry
 * 而跳过 max_tokens 裁剪）。
 *
 * ⚠ 别名**不能**和真实 ID 只差大小写：那样会抢走「大小写不敏感直接命中」
 * 那条路，把用户明确写的真实模型解析成另一个。所以这里只放真正改名的旧称。
 */
export const MODEL_ALIASES = Object.freeze({
  // 2026-09 的那批旧 ID（上游已换成 *-1017）
  "deepseek-v4-flash-0731": "deepseek-v4-flash-1017",
  // 2026-09 的 spark 旧称
  "spark-x": "spark-x2.6",
})

/**
 * 返回**可用**模型（过滤掉 chat 404 的那些）。
 *
 * contextWindow / maxOutputTokens 为 0 表示未知 —— 契约允许。
 *
 * @returns {Model[]}
 */
export function availableModels() {
  return KNOWN_MODELS.filter((m) => !m.unavailable).map((m) => ({ ...m }))
}

/**
 * 按 ID 或别名查一个模型。
 *
 * 第二返回值报告「是否经别名命中」，供日志与测试区分：
 * 直接命中说明客户端用的规范名，别名命中说明它在用上游的旧称。
 *
 * @param {string} id
 * @returns {{ model: Model|null, viaAlias: boolean, ok: boolean }}
 */
export function resolveModel(id) {
  const want = String(id ?? "").trim()
  if (!want) return { model: null, viaAlias: false, ok: false }

  // 精确命中优先：别名表里可能有一个键**同时**是某个真实模型 ID 的情形，
  // 那时应当按真实 ID 解释。
  for (const m of KNOWN_MODELS) {
    if (m.id === want) return { model: m, viaAlias: false, ok: true }
  }

  const target = MODEL_ALIASES[want]
  if (target) {
    for (const m of KNOWN_MODELS) {
      if (m.id === target) return { model: m, viaAlias: true, ok: true }
    }
  }

  // 大小写不敏感兜底：上游的 ID 大小写混排（`DeepSeek-V4.1-Flash`），
  // 客户端抄配置时很容易写错一两个字母。
  const lower = want.toLowerCase()
  for (const m of KNOWN_MODELS) {
    if (m.id.toLowerCase() === lower) return { model: m, viaAlias: false, ok: true }
  }

  return { model: null, viaAlias: false, ok: false }
}

/**
 * 返回某模型（含别名）允许的输出上限；未知返回 0。
 *
 * 0 的语义是「不知道」，调用方**不要**据此把 max_tokens 裁成 0。
 *
 * @param {string} id
 * @returns {number}
 */
export function maxOutputFor(id) {
  const { model, ok } = resolveModel(id)
  if (!ok) return 0
  return model.maxOutputTokens > 0 ? model.maxOutputTokens : 0
}

/**
 * 这个模型是否只能走生图端点。
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isImageOnlyModel(id) {
  return IMAGE_MODEL_IDS.includes(String(id ?? "").trim())
}
