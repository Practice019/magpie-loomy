import { test } from "node:test"
import assert from "node:assert/strict"

import {
  KNOWN_MODELS,
  IMAGE_MODEL_IDS,
  MODEL_ALIASES,
  availableModels,
  resolveModel,
  maxOutputFor,
  isImageOnlyModel,
} from "../src/models.mjs"

test("静态快照是 2026-11-17 的实测目录（10 条）", () => {
  assert.equal(KNOWN_MODELS.length, 10)
})

test("第一条是 spark-x2.6（上游当前的主模型）", () => {
  assert.equal(KNOWN_MODELS[0].id, "spark-x2.6")
  assert.equal(KNOWN_MODELS[0].contextWindow, 1048576)
})

test("availableModels 过滤掉只能生图的三个", () => {
  const ids = availableModels().map((m) => m.id)
  assert.equal(ids.length, 7)
  for (const id of IMAGE_MODEL_IDS) assert.ok(!ids.includes(id), `${id} 不该进对话目录`)
})

test("availableModels 返回副本，改它不影响静态表", () => {
  const a = availableModels()
  a[0].maxOutputTokens = 1
  assert.equal(KNOWN_MODELS[0].maxOutputTokens, 131072)
})

test("resolveModel 精确命中优先于别名", () => {
  const r = resolveModel("deepseek-v4-flash-1017")
  assert.equal(r.ok, true)
  assert.equal(r.viaAlias, false)
})

test("resolveModel 认上游旧称", () => {
  const r = resolveModel("deepseek-v4-flash-0731")
  assert.equal(r.ok, true)
  assert.equal(r.viaAlias, true)
  assert.equal(r.model.id, "deepseek-v4-flash-1017")
})

test("resolveModel 大小写不敏感兜底（ID 混排易抄错）", () => {
  const r = resolveModel("deepseek-v4.1-flash")
  assert.equal(r.ok, true)
  assert.equal(r.model.id, "DeepSeek-V4.1-Flash")

  const r2 = resolveModel("GLM-5.3-FLASH")
  assert.equal(r2.ok, true)
  assert.equal(r2.model.id, "GLM-5.3-Flash")
})

test("resolveModel 未知 / 空串返回 ok=false", () => {
  assert.equal(resolveModel("nope").ok, false)
  assert.equal(resolveModel("").ok, false)
  assert.equal(resolveModel(null).ok, false)
  assert.equal(resolveModel(undefined).ok, false)
})

test("resolveModel 去空白后仍能命中", () => {
  assert.equal(resolveModel("  auto  ").model.id, "auto")
})

test("maxOutputFor 未知返回 0（0 = 不知道，不能据此裁剪）", () => {
  assert.equal(maxOutputFor("spark-x2.6"), 131072)
  assert.equal(maxOutputFor("nope"), 0)
  // auto 的上限上游未给
  assert.equal(maxOutputFor("auto"), 0)
})

test("isImageOnlyModel 只认生图清单", () => {
  assert.equal(isImageOnlyModel("doubao-seedream-5-lite"), true)
  assert.equal(isImageOnlyModel("qwen-image-3.0-pro"), true)
  assert.equal(isImageOnlyModel("Hy-Image-3.5-preview"), true)
  assert.equal(isImageOnlyModel("spark-x2.6"), false)
  assert.equal(isImageOnlyModel(""), false)
})

test("生图模型在 chat 轴上是 unavailable —— 两条轴互不代表", () => {
  for (const id of IMAGE_MODEL_IDS) {
    const { model, ok } = resolveModel(id)
    assert.ok(ok, `${id} 应在静态表里`)
    assert.equal(model.unavailable, true, `${id} 应标记为 chat 不可用`)
  }
})

test("别名表的目标都存在（没有指向不存在的模型）", () => {
  const ids = new Set(KNOWN_MODELS.map((m) => m.id))
  for (const [from, to] of Object.entries(MODEL_ALIASES)) {
    assert.ok(ids.has(to), `别名 ${from} → ${to} 指向了不存在的模型`)
  }
})

test("倍率来自实测（能从展示名解析出来的才有）", () => {
  const rates = Object.fromEntries(
    KNOWN_MODELS.filter((m) => typeof m.rate === "number").map((m) => [m.id, m.rate]),
  )
  assert.equal(rates["GLM-5.3-Flash"], 0.8)
  assert.equal(rates["mimo-v2.5"], 3.3)
  assert.equal(rates["spark-x2.6"], 2.5)
})
