// models-capabilities.test.mjs 模型能力**全部来自上游**（不再写死「纯文本」）。
//
// 背景（用户原话）：
//
//	「把这我们的这些插件全部都修复一下。每个模型它能支持什么，全部从上游获取就行了。」
//
// 症状：写死 `image:false` → magpie 的「识图模型」下拉框里一个 loomy 模型都没有，
// 路由组选到它就把图发出去、然后卡死。
//
// 实测上游（2026-11-20，`GET /api/v1/models`，`token:` 头）：
//
//	{"id":"DeepSeek-V4.1-Flash","supportsImage":null,
//	 "capabilities":{"reasoning":true,"vision":true,"function_calling":true,"streaming":true,
//	                 "system_message":true,"input_modalities":["text","image"],
//	                 "output_modalities":["text"]}}
//	{"id":"GLM-5.3-Flash","capabilities":{"vision":true,
//	                 "input_modalities":["text","image","video"]}}
//	{"id":"spark-x2.6","capabilities":{"vision":false,"input_modalities":["text"]}}
//
// ⚠ 全部注入 fetchImpl：本测试**不允许**打真上游。

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeModelsHook, mapUpstreamCapabilities } from "../src/hooks/models.mjs"
import { IMAGE_MODEL_IDS } from "../src/models.mjs"

const SESSION = "a".repeat(32)

/** 造一个「上游返回这些条目」的钩子。 */
function hooksFor(entries) {
  return makeModelsHook({
    log: { warn() {} },
    fetchImpl: async () => Response.json({ data: entries }),
  })
}

/** 跑一次钩子，取第 id 个模型。 */
async function modelOf(entries, id) {
  const hook = hooksFor(entries)
  const out = await hook({ models: {} }, { auth: { access: SESSION } })
  return out[id]
}

test("vision:true + input_modalities 含 image → input.image / modalities.input / attachment 全部为真", async () => {
  const m = await modelOf(
    [
      {
        id: "DeepSeek-V4.1-Flash",
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
    ],
    "DeepSeek-V4.1-Flash",
  )

  assert.equal(m.capabilities.input.image, true, "上游说能收图 ⇒ input.image 必须为真")
  assert.equal(m.capabilities.input.text, true)
  assert.ok(m.modalities.input.includes("image"), "识图模型下拉框只认 modalities.input")
  assert.deepEqual(m.modalities, { input: ["text", "image"], output: ["text"] })
  assert.equal(m.attachment, true)
  assert.equal(m.supportsImage, true)
  assert.equal(m.capabilities.reasoning, true, "上游说 reasoning:true 就照抄")
  assert.equal(m.capabilities.toolcall, true, "上游没否认 function_calling ⇒ 可调工具")
})

test("vision:false → 不含 image（spark-x2.6 的形状）", async () => {
  const m = await modelOf(
    [{ id: "spark-x2.6", capabilities: { vision: false, input_modalities: ["text"] } }],
    "spark-x2.6",
  )

  assert.equal(m.capabilities.input.image, false)
  assert.deepEqual(m.modalities, { input: ["text"], output: ["text"] })
  assert.equal(m.attachment, false)
  assert.equal(m.supportsImage, false)
})

test("上游完全没有能力字段 → 回落 [\"text\"]，不按模型名猜", async () => {
  const m = await modelOf([{ id: "m-bare", name: "Bare Flash(x2.0)" }], "m-bare")

  assert.deepEqual(m.modalities, { input: ["text"], output: ["text"] })
  assert.deepEqual(m.capabilities.input, { text: true, image: false, audio: false, video: false, pdf: false })
  assert.equal(m.attachment, false)
  assert.equal(m.supportsImage, false)
  assert.equal(m.capabilities.toolcall, true, "上游没说话时不夺走工具能力")
  assert.equal(m.capabilities.reasoning, false)
})

test("function_calling:false → toolcall:false（上游说不调工具就不调）", async () => {
  const m = await modelOf(
    [{ id: "no-tools", capabilities: { function_calling: false, input_modalities: ["text"] } }],
    "no-tools",
  )
  assert.equal(m.capabilities.toolcall, false)

  const yes = await modelOf(
    [{ id: "with-tools", capabilities: { function_calling: true, input_modalities: ["text"] } }],
    "with-tools",
  )
  assert.equal(yes.capabilities.toolcall, true)
})

test("生图模型保持现状：output 只有 image、不能调工具、不收图", async () => {
  const id = IMAGE_MODEL_IDS[0]
  const m = await modelOf([{ id }], id)

  assert.deepEqual(m.modalities, { input: ["text"], output: ["image"] })
  assert.equal(m.capabilities.toolcall, false)
  assert.equal(m.capabilities.input.image, false)
  assert.equal(m.attachment, false)
})

test("vision:true 但模态数组没列 image → 自动补齐，两组声明不许自相矛盾", async () => {
  const m = await modelOf(
    [{ id: "half-declared", capabilities: { vision: true, input_modalities: ["text"] } }],
    "half-declared",
  )
  assert.equal(m.capabilities.input.image, true)
  assert.ok(m.modalities.input.includes("image"))
  assert.equal(m.attachment, true)
})

test("input_modalities 里的 video / audio / pdf 一并映射（GLM-5.3-Flash 带 video）", async () => {
  const m = await modelOf(
    [{ id: "GLM-5.3-Flash", capabilities: { vision: true, input_modalities: ["text", "image", "video"] } }],
    "GLM-5.3-Flash",
  )
  assert.equal(m.capabilities.input.video, true)
  assert.equal(m.capabilities.input.audio, false)
  assert.deepEqual(m.modalities.input, ["text", "image", "video"])
})

test("mapUpstreamCapabilities 是纯函数：顶层 supportsImage 也认，空数组回落 text", () => {
  const viaTopLevel = mapUpstreamCapabilities({ supportsImage: true })
  assert.equal(viaTopLevel.vision, true)
  assert.deepEqual(viaTopLevel.inputModalities, ["text", "image"])

  const empty = mapUpstreamCapabilities({ capabilities: { input_modalities: [], output_modalities: [] } })
  assert.deepEqual(empty.inputModalities, ["text"])
  assert.deepEqual(empty.outputModalities, ["text"])
  assert.equal(empty.vision, false)

  const junk = mapUpstreamCapabilities({ capabilities: ["not-an-object"] })
  assert.deepEqual(junk.inputModalities, ["text"])
})
