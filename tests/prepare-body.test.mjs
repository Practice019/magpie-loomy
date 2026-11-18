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

test("超限的 max_tokens 被裁到该模型上限", () => {
  const out = JSON.parse(
    prepareBody(JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 1000000 })),
  )
  assert.equal(out.max_tokens, 131072)
})

test("超限的 max_completion_tokens 同样被裁", () => {
  const out = JSON.parse(
    prepareBody(JSON.stringify({ model: "GLM-5.3-Flash", max_completion_tokens: 999999 })),
  )
  assert.equal(out.max_completion_tokens, 131072)
})

test("未超限的 max_tokens 保持原值", () => {
  const out = JSON.parse(prepareBody(JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 100 })))
  assert.equal(out.max_tokens, 100)
})

test("别名模型的裁剪按归一名生效", () => {
  const out = JSON.parse(
    prepareBody(JSON.stringify({ model: "deepseek-v4.1-flash", max_tokens: 999999 })),
  )
  assert.equal(out.max_tokens, 384000)
})

test("未知模型不裁剪（上限未知 = 0，不能据此裁成 0）", () => {
  const out = JSON.parse(prepareBody(JSON.stringify({ model: "unknown-model", max_tokens: 999999 })))
  assert.equal(out.max_tokens, 999999)
})

test("没有 model 字段时不裁剪", () => {
  const out = JSON.parse(prepareBody(JSON.stringify({ max_tokens: 999999 })))
  assert.equal(out.max_tokens, 999999)
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
  const text = prepareBody(JSON.stringify({ model: "unknown", max_tokens: 1048576 }))
  assert.ok(text.includes("1048576"), `实际输出：${text}`)
  assert.ok(!/e\+/.test(text), `不应出现科学计数法：${text}`)
})

test("modelOf 取模型名", () => {
  assert.equal(modelOf(JSON.stringify({ model: "spark-x" })), "spark-x")
  assert.equal(modelOf("{}"), "")
  assert.equal(modelOf("{bad"), "")
  assert.equal(modelOf(""), "")
})
