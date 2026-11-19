import { test } from "node:test"
import assert from "node:assert/strict"

import { prepareBody, modelOf } from "../src/prepare-body.mjs"

test("强制 stream=true", () => {
  const out = JSON.parse(prepareBody(JSON.stringify({ model: "spark-x", messages: [] })))
  assert.equal(out.stream, true)
})

test("stream=false 也会被改成 true", () => {
  const out = JSON.parse(prepareBody(JSON.stringify({ model: "spark-x", stream: false })))
  assert.equal(out.stream, true)
})

// ⚠ 第十六轮改判据（用户明确要求：「我就是要原始的 BODY 一模一样」）：
// `max_tokens` / `max_completion_tokens` / `reasoning_effort` **一律不裁剪、不补默认值**。
// 唯一保留的改写是 `stream=true` 与 `stream_options.include_usage`。
test("max_tokens: 200000 原样保留（不再裁剪）", () => {
  const out = JSON.parse(prepareBody(JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 200000 })))
  assert.equal(out.max_tokens, 200000)
})

test("max_completion_tokens 同样原样保留", () => {
  const out = JSON.parse(
    prepareBody(JSON.stringify({ model: "GLM-5.3-Flash", max_completion_tokens: 999999 })),
  )
  assert.equal(out.max_completion_tokens, 999999)
})

test("已有 max_tokens: 100 保留（给多少发多少）", () => {
  const out = JSON.parse(prepareBody(JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 100 })))
  assert.equal(out.max_tokens, 100)
})

test("**没有** max_tokens 时不许凭空加", () => {
  const out = JSON.parse(prepareBody(JSON.stringify({ model: "DeepSeek-V4.1-Flash", messages: [] })))
  assert.equal(out.max_tokens, undefined)
  assert.equal(out.max_completion_tokens, undefined)
})

test("**没有** reasoning_effort 时不许凭空加；已有 low 保留", () => {
  const a = JSON.parse(prepareBody(JSON.stringify({ model: "DeepSeek-V4.1-Flash" })))
  assert.equal(a.reasoning_effort, undefined, "别替调用方决定推理强度")

  const b = JSON.parse(prepareBody(JSON.stringify({ model: "DeepSeek-V4.1-Flash", reasoning_effort: "low" })))
  assert.equal(b.reasoning_effort, "low")
})

test("字符串形态的 max_tokens 不动（那是上游该诊断的形态）", () => {
  const out = JSON.parse(prepareBody(JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: "999999" })))
  assert.equal(out.max_tokens, "999999")
})

test("解析失败原样返回（本函数职责是优化不是校验）", () => {
  const bad = "{not json"
  assert.equal(prepareBody(bad), bad)
})

test("空串 / null / 字节原样返回", () => {
  assert.equal(prepareBody(""), "")
  assert.equal(prepareBody(null), null)
  assert.equal(prepareBody(undefined), undefined)
  const bytes = new Uint8Array([1, 2, 3])
  assert.equal(prepareBody(bytes), bytes)
})

test("数组形态的 body 原样返回", () => {
  const arr = "[1,2,3]"
  assert.equal(prepareBody(arr), arr)
})

test("保留其他字段不动", () => {
  const out = JSON.parse(
    prepareBody(JSON.stringify({ model: "spark-x", messages: [{ role: "user", content: "hi" }], temperature: 0.7 })),
  )
  assert.deepEqual(out.messages, [{ role: "user", content: "hi" }])
  assert.equal(out.temperature, 0.7)
})

test("大整数不会变成科学计数法", () => {
  // 用一个**不会被我们改写**的大整数字段（max_tokens 现在会被裁到 32000）
  const text = prepareBody(JSON.stringify({ model: "unknown", max_tokens: 8, seed: 1048576 }))
  assert.ok(text.includes("1048576"), `实际输出：${text}`)
  assert.ok(!/e\+/.test(text), `不应出现科学计数法：${text}`)
})

test("modelOf 取模型名", () => {
  assert.equal(modelOf(JSON.stringify({ model: "spark-x" })), "spark-x")
  assert.equal(modelOf("{}"), "")
  assert.equal(modelOf("{bad"), "")
  assert.equal(modelOf(""), "")
})

// ── 与客户端 1:1：stream_options.include_usage ──────────────────────────
//
// 客户端走 AI SDK 流式请求，会带 `stream_options: { include_usage: true }`。
// 缺了它，上游不在流里给 usage 帧 —— 计量与「这个请求花了多少」都会缺一块。

test("stream=true 且没有 stream_options → 补 {include_usage:true}", () => {
  const out = JSON.parse(prepareBody(JSON.stringify({ model: "spark-x", messages: [] })))
  assert.deepEqual(out.stream_options, { include_usage: true })
})

test("stream_options 存在但缺 include_usage → 只补这个字段，别的保留", () => {
  const out = JSON.parse(
    prepareBody(JSON.stringify({ model: "spark-x", stream_options: { other: 1 } })),
  )
  assert.deepEqual(out.stream_options, { other: 1, include_usage: true })
})

test("stream_options 是字符串 / 数组 → 原样不动（那是上游该诊断的形态）", () => {
  for (const bad of ["oops", [1, 2]]) {
    const out = JSON.parse(prepareBody(JSON.stringify({ model: "spark-x", stream_options: bad })))
    assert.deepEqual(out.stream_options, bad, `不该改: ${JSON.stringify(bad)}`)
  }
})

test("显式 include_usage:false 不被改成 true（尊重调用方）", () => {
  const out = JSON.parse(
    prepareBody(JSON.stringify({ model: "spark-x", stream_options: { include_usage: false } })),
  )
  assert.equal(out.stream_options.include_usage, false)
})

// ── 第十六轮：**不裁剪、不补默认值**（用户要求「原始 body 一模一样」）──
// 上面的用例已覆盖三态；这里只保留「没给就不加」的显式断言（见 max_tokens/reasoning_effort 那两条）。

test("messages / tools / tool_choice **一个字都不动**（那是调用方的语义）", () => {
  const input = {
    model: "DeepSeek-V4.1-Flash",
    messages: [
      { role: "system", content: "超长人设".repeat(30) },
      { role: "user", content: "hi" },
    ],
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "f" } },
  }
  const out = JSON.parse(prepareBody(JSON.stringify(input)))
  assert.deepEqual(out.messages, input.messages)
  assert.deepEqual(out.tools, input.tools)
  assert.deepEqual(out.tool_choice, input.tool_choice)
})
