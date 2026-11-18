import { test } from "node:test"
import assert from "node:assert/strict"

import { parseNameMultiplier, multipliersFromCatalog } from "../src/multipliers.mjs"

test("全角括号的倍率", () => {
  assert.deepEqual(parseNameMultiplier("DeepSeek V4 Flash 0731（x3.0）"), { value: 3, ok: true })
})

test("半角括号的倍率", () => {
  assert.deepEqual(parseNameMultiplier("GLM 5.3 Flash(x0.8)"), { value: 0.8, ok: true })
})

test("带空格的半角括号", () => {
  assert.deepEqual(parseNameMultiplier("Qwen 3.8 Max (x12.0)"), { value: 12, ok: true })
})

test("整数倍率", () => {
  assert.deepEqual(parseNameMultiplier("Kimi K2.6（x5）"), { value: 5, ok: true })
})

test("没有倍率后缀 → ok=false", () => {
  assert.equal(parseNameMultiplier("spark-x").ok, false)
  assert.equal(parseNameMultiplier("").ok, false)
  assert.equal(parseNameMultiplier(null).ok, false)
})

test("x0 不是合法倍率（0 的语义是「没给」）", () => {
  assert.equal(parseNameMultiplier("Foo（x0）").ok, false)
})

test("负数不是合法倍率", () => {
  assert.equal(parseNameMultiplier("Foo（x-1）").ok, false)
})

test("倍率必须在末尾 —— 中间出现不算", () => {
  assert.equal(parseNameMultiplier("Foo（x3.0） Bar").ok, false)
})

test("multipliersFromCatalog 只收解析出倍率的条目", () => {
  const out = multipliersFromCatalog([
    { id: "a", name: "A（x3.0）" },
    { id: "b", name: "B" },
    { id: "c", name: "C(x0.8)" },
    { id: "", name: "D(x1)" },
  ])
  assert.deepEqual(out, { a: 3, c: 0.8 })
})

test("multipliersFromCatalog 对非数组输入返回空表", () => {
  assert.deepEqual(multipliersFromCatalog(null), {})
  assert.deepEqual(multipliersFromCatalog(undefined), {})
  assert.deepEqual(multipliersFromCatalog("nope"), {})
})
