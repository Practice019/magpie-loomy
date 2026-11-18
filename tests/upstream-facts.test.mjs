import { test } from "node:test"
import assert from "node:assert/strict"

import {
  signInVerdict,
  applySignInHeader,
  isImageOnlyModel,
  SIGN_IN_HEADER,
} from "../src/upstream-facts.mjs"

test("HTTP 200 + 「缺少 token」→ expired（鉴权失败也是 200）", () => {
  assert.equal(signInVerdict(200, '{"code":"100002","desc":"缺少 token"}'), "expired")
})

test("「登录已失效」→ expired", () => {
  assert.equal(signInVerdict(200, "登录已失效，请重新登录"), "expired")
})

test("积分不足 → kept（账号没事，别误杀）", () => {
  assert.equal(signInVerdict(200, "You have insufficient credits"), "kept")
  assert.equal(signInVerdict(402, "insufficient credits"), "kept")
})

test("模型不可用 → kept", () => {
  assert.equal(signInVerdict(404, 'Model "x" is not supported on this endpoint'), "kept")
  assert.equal(signInVerdict(404, '{"message":"该模型暂未开放"}'), "kept")
})

test("参数错误 / 上下文超限 → kept", () => {
  assert.equal(signInVerdict(400, '{"error":{"type":"invalid_request_error"}}'), "kept")
  assert.equal(signInVerdict(400, "请求参数错误"), "kept")
  assert.equal(signInVerdict(400, "prompt is too long: 100001 tokens"), "kept")
  assert.equal(signInVerdict(400, "context_length_exceeded"), "kept")
  assert.equal(signInVerdict(400, "超出上下文限制"), "kept")
})

test("正文认不出的 401/403 → null（交给宿主默认判据）", () => {
  assert.equal(signInVerdict(401, ""), null)
  assert.equal(signInVerdict(403, ""), null)
})

test("正文认不出的其它 4xx/5xx → kept", () => {
  assert.equal(signInVerdict(500, "boom"), "kept")
  assert.equal(signInVerdict(429, "slow down"), "kept")
  assert.equal(signInVerdict(404, "nope"), "kept")
})

test("2xx → null（没什么可说的）", () => {
  assert.equal(signInVerdict(200, '{"ok":true}'), null)
})

test("正文判据优先于状态码", () => {
  // 关键：200 的鉴权失败必须被认出来
  assert.equal(signInVerdict(200, "缺少 token"), "expired")
  // 401 但正文说是模型问题 → 不误杀
  assert.equal(signInVerdict(401, "该模型暂未开放"), "kept")
})

test("applySignInHeader 只在有结论时写头", () => {
  const h = new Headers()
  applySignInHeader(h, "expired")
  assert.equal(h.get(SIGN_IN_HEADER), "expired")

  const h2 = new Headers()
  applySignInHeader(h2, null)
  assert.equal(h2.get(SIGN_IN_HEADER), null)
})

test("isImageOnlyModel 认那三个（名字只是旁证，模态才是契约）", () => {
  assert.equal(isImageOnlyModel("doubao-seedream-5-lite"), true)
  assert.equal(isImageOnlyModel("qwen-image-3.0-pro"), true)
  assert.equal(isImageOnlyModel("Hy-Image-3.5-preview"), true)
  assert.equal(isImageOnlyModel("spark-x"), false)
  assert.equal(isImageOnlyModel(""), false)
  assert.equal(isImageOnlyModel(null), false)
})
