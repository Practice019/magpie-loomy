// multimodal-passthrough.test.mjs 多模态 content **原样透传**（不裁剪 image_url）。
//
// # 为什么这条必须钉住
//
// magpie 会把一条消息的 `content` 作为**数组**交给我们（OpenAI 的多模态形状）：
//
//	[{"type":"text","text":"hi"},
//	 {"type":"image_url","image_url":{"url":"data:image/png;base64,...."}}]
//
// loader 是唯一碰请求体的地方，它一旦「顺手整理」成字符串（或只留 text 段），
// 图就静默消失：上游收到一条纯文本请求，用户看到的却是「模型不认图 / 卡住」。
// 所以这里断言的是**出站 body 里的那一份 content 与入参逐字段相等**。
//
// ⚠ 全部注入 fetchImpl：本测试**不允许**打真上游。

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeLoaderHook } from "../src/hooks/loader.mjs"

const SESSION = "a".repeat(32)
const CHAT_URL = "https://loomyad.xunfei.cn/api/v1/chat/completions"

/** 一条真正会被发出去的多模态消息。 */
const PARTS = [
  { type: "text", text: "hi" },
  { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } },
]

/** 抓出站请求体。 */
function capture(status = 500) {
  /** @type {any[]} */
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response("{}", { status, headers: { "content-type": "application/json" } })
  }
  return { calls, fetchImpl }
}

async function loaderWith(opts) {
  const hook = makeLoaderHook({ log: { warn() {} }, ...opts })
  return hook(async () => ({ type: "oauth", access: SESSION, uid: "uid-1" }))
}

for (const bodyMode of ["client-body", "client-shape", "default", "passthrough"]) {
  test(`bodyMode:${bodyMode} → messages[].content 数组原样透传`, async () => {
    const { calls, fetchImpl } = capture()
    const loader = await loaderWith({ fetchImpl, bodyMode })

    await loader.fetch(CHAT_URL, {
      method: "POST",
      body: JSON.stringify({
        model: "DeepSeek-V4.1-Flash",
        messages: [{ role: "user", content: PARTS }],
      }),
    })

    assert.equal(calls.length, 1)
    const sent = JSON.parse(calls[0].init.body)
    const user = sent.messages.filter((m) => m?.role === "user").at(-1)
    assert.deepEqual(user.content, PARTS, "image_url 段必须逐字段还在（顺序也不能变）")
  })
}

test("tool 消息与 assistant 消息里的数组 content 也不被改写", async () => {
  const { calls, fetchImpl } = capture()
  const loader = await loaderWith({ fetchImpl, bodyMode: "client-body" })

  const history = [
    { role: "user", content: PARTS },
    { role: "assistant", content: [{ type: "text", text: "看到了" }] },
  ]
  await loader.fetch(CHAT_URL, {
    method: "POST",
    body: JSON.stringify({ model: "DeepSeek-V4.1-Flash", messages: history }),
  })

  const sent = JSON.parse(calls[0].init.body)
  // client-body 会在最前面放客户端的 system（伪装用），其余顺序原样
  const tail = sent.messages.slice(-2)
  assert.deepEqual(tail[0], { role: "user", content: PARTS })
  assert.deepEqual(tail[1], history[1])
})
