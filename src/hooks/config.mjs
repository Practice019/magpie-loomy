// config.mjs 声明供应商与**未登录时**的模型表。
//
// # 为什么未登录也必须给模型
//
// magpie 明确要求：`config` 钩子里没有模型时，供应商在界面上显示 "0 models"，
// 用户会以为插件坏了。而模型目录的另一条路（`provider.models`）只在
// **已登录的账号**上被调用。
//
// 所以这里给的是**冷启动兜底基线**，不是权威目录：
//
//	provider.models（实时、按账号）  → 目录的正源
//	config 里的静态表                → 登录前 / 拉取失败时的兜底
//
// 静态表本身是 2026-09-14 的实测快照，上游加模型后它不会自动更新 ——
// 那没关系，登录成功一次后实时目录就会接管。

import { PROVIDER, DEFAULT_BASE_URL } from "../constants.mjs"
import { availableModels, IMAGE_MODEL_IDS } from "../models.mjs"

/** 本上游是 OpenAI 兼容协议 ⇒ AI SDK 用这个包，路径是 /chat/completions。 */
export const NPM = "@ai-sdk/openai-compatible"

/**
 * Loomy 的对话模型**全部是纯文本**。
 *
 * ⚠ 必须显式写全，且 `image` 要写成布尔值 `false`。
 * 省掉不等于「按 text 处理」：magpie 只认 `typeof input.image === "boolean"`，
 * 没写就是「厂商未表态」，会退到 models.dev 按裸模型 id 投票 ——
 * 同名模型只要在别家标过 `image`，这个实际收不了图的模型就会被当成能收图，
 * 然后把截图直发上游、被拒。
 */
const TEXT_ONLY_MODALITIES = { input: ["text"], output: ["text"] }

/**
 * 把静态快照转成 `config` 钩子要的模型表。
 *
 * ⚠ `config` 钩子里的形状是 OpenCode 的 `Model`，字段名用 **`tool_call`**
 * （带下划线）。而在 `provider.models` 返回值里同一个能力叫 **`toolcall`**
 * （无下划线）。两处拼写不同，写错不会报错，只会让「能不能调工具」静默为假。
 *
 * @returns {Record<string, object>}
 */
export function staticModels() {
  /** @type {Record<string, object>} */
  const out = {}
  for (const m of availableModels()) {
    out[m.id] = {
      name: m.name || m.id,
      limit: {
        context: m.contextWindow || 0,
        output: m.maxOutputTokens || 0,
      },
      // 上游全部支持工具调用与推理链（源项目实测）
      tool_call: true,
      attachment: false,
      modalities: TEXT_ONLY_MODALITIES,
    }
  }

  // 生图模型也要列：它们走 /v1/images/generations，不进对话列表。
  // 名字必须命中 magpie 的 DrawsID 判据（含 seedream / image 等词），
  // 这三个都命中。
  for (const id of IMAGE_MODEL_IDS) {
    if (out[id]) {
      // 已在静态表里（chat 不可用的那两条）：改成只输出图片
      out[id] = {
        ...out[id],
        attachment: false,
        modalities: { input: ["text"], output: ["image"] },
      }
      continue
    }
    out[id] = {
      name: id,
      limit: { context: 0, output: 0 },
      tool_call: false,
      attachment: false,
      modalities: { input: ["text"], output: ["image"] },
    }
  }
  return out
}

/**
 * 构建 `config` 钩子。
 *
 * @returns {(cfg: any) => Promise<void>}
 */
export function makeConfigHook(opts = {}) {
  const api = String(opts.baseUrl ?? "").trim() || DEFAULT_BASE_URL
  return async (cfg) => {
    cfg.provider ??= {}
    // 用 ??= 以免覆盖用户在 plugins.json 里配置的供应商条目
    cfg.provider[PROVIDER] ??= {
      name: "讯飞 Loomy",
      npm: NPM,
      api,
      models: staticModels(),
    }
  }
}
