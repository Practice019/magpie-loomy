// print-model-mapping.mjs 打一份**真实形状**的模型映射结果（人工核对用，不进 `node --test`）。
//
// 用法：
//
//	node scripts/print-model-mapping.mjs
//
// 数据来自 2026-11-20 的实测响应（`GET https://loomyad.xunfei.cn/api/v1/models`，
// `token:` 头）里被点到名的三条。它**不是**网络请求：想核真上游，把 `main()` 里
// 的 `PAYLOAD` 换成 `await (await fetch(...)).json()` 即可。
//
// 为什么要这个脚本：`provider.models` 的输出是 magpie 的「识图模型」下拉框与
// 路由的唯一依据，肉眼对 JSON 比读代码可信。

import { makeModelsHook } from "../src/hooks/models.mjs"

/** 实测响应（节选：一条识图、一条带 video、一条纯文本）。 */
const PAYLOAD = {
  object: "list",
  data: [
    {
      id: "DeepSeek-V4.1-Flash",
      name: "DeepSeek V4.1 Flash(x2.0)",
      context_length: 1048576,
      max_output_tokens: 384000,
      protocol: "openai_chat",
      supportsImage: null,
      capabilities: {
        reasoning: true,
        vision: true,
        function_calling: true,
        streaming: true,
        system_message: true,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
    },
    {
      id: "GLM-5.3-Flash",
      name: "GLM-5.3 Flash（x0.8）",
      context_length: 1048576,
      max_output_tokens: 131072,
      capabilities: { vision: true, input_modalities: ["text", "image", "video"] },
    },
    {
      id: "spark-x2.6",
      name: "Spark X2.6(x2.5)",
      context_length: 1048576,
      max_output_tokens: 131072,
      capabilities: { vision: false, input_modalities: ["text"] },
    },
  ],
}

/** 只印会进判定/UI 的那几项，别把整份 model 打出来。 */
function brief(m) {
  return {
    id: m.id,
    name: m.name,
    rate: m.rate,
    "capabilities.toolcall": m.capabilities.toolcall,
    "capabilities.reasoning": m.capabilities.reasoning,
    "capabilities.input": m.capabilities.input,
    modalities: m.modalities,
    attachment: m.attachment,
    supportsImage: m.supportsImage,
  }
}

async function main() {
  const hook = makeModelsHook({
    log: { warn: (m) => console.error(`warn: ${m}`) },
    fetchImpl: async () => Response.json(PAYLOAD),
  })

  const models = await hook({ models: {} }, { auth: { access: "x".repeat(32) } })

  for (const id of Object.keys(models)) console.log(JSON.stringify(brief(models[id]), null, 2))

  const ds = models["DeepSeek-V4.1-Flash"]
  console.log("\n—— 验收断言 ——")
  console.log(`DeepSeek-V4.1-Flash modalities.input = ${JSON.stringify(ds.modalities.input)}`)
  console.log(`含 image？ ${ds.modalities.input.includes("image")}`)
  console.log(`attachment = ${ds.attachment} / supportsImage = ${ds.supportsImage}`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
