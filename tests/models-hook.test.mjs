import { test } from "node:test"
import assert from "node:assert/strict"

import { makeModelsHook } from "../src/hooks/models.mjs"

const SESSION = "a".repeat(32)

/** 假上游：返回带倍率后缀的展示名。 */
function fakeCatalog() {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "m1", name: "Foo Flash(x2.0)", context_window: 1000, max_output_tokens: 100 },
          { id: "m2", name: "Bar Pro（x0.8）", context_window: 2000, max_output_tokens: 200 },
          { id: "m3", name: "Baz" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
}

test("倍率从展示名解析出来，并在名字里被摘掉（否则与 magpie 的 2× 重复）", async () => {
  const hook = makeModelsHook({ fetchImpl: fakeCatalog() })
  const out = await hook({ models: {} }, { auth: { access: SESSION } })

  assert.equal(out.m1.rate, 2)
  assert.equal(out.m1.name, "Foo Flash", "半角 (x2.0) 应被摘掉")

  assert.equal(out.m2.rate, 0.8)
  assert.equal(out.m2.name, "Bar Pro", "全角 （x0.8） 应被摘掉")
})

test("没有倍率后缀的名字原样保留，且不给 rate", async () => {
  const hook = makeModelsHook({ fetchImpl: fakeCatalog() })
  const out = await hook({ models: {} }, { auth: { access: SESSION } })
  assert.equal(out.m3.name, "Baz")
  assert.equal(out.m3.rate, undefined, "解析不到倍率就不给 —— 不估算")
})

test("模型条目显式声明 text-only（漏了会被当成能收图）", async () => {
  const hook = makeModelsHook({ fetchImpl: fakeCatalog() })
  const out = await hook({ models: {} }, { auth: { access: SESSION } })
  for (const m of Object.values(out)) {
    assert.equal(m.capabilities.input.image, false)
    assert.equal(m.attachment, false)
  }
})

test("provider.models 用 token 头（不是 Bearer）", async () => {
  /** @type {any[]} */
  const calls = []
  const spy = async (url, init) => {
    calls.push({ url: String(url), init })
    return fakeCatalog()(url, init)
  }
  const hook = makeModelsHook({ fetchImpl: spy })
  await hook({ models: {} }, { auth: { access: SESSION } })
  assert.equal(calls[0].init.headers.get("token"), SESSION)
  assert.equal(calls[0].init.headers.get("Authorization"), null)
})

test("未登录时回静态表（否则界面显示 0 models）", async () => {
  const hook = makeModelsHook({ fetchImpl: fakeCatalog() })
  const out = await hook({ models: {} }, {})
  assert.ok(Object.keys(out).length > 0)
})

test("上游失败时回静态表，不抛错（抛了宿主也只会保留旧列表，但没有线索）", async () => {
  const bad = async () => new Response("boom", { status: 502 })
  const hook = makeModelsHook({ fetchImpl: bad, log: { warn() {} } })
  const out = await hook({ models: {} }, { auth: { access: SESSION } })
  assert.ok(Object.keys(out).length > 0)
})

test("展开 provider 已有的模型条目（保留它给的字段）", async () => {
  const hook = makeModelsHook({ fetchImpl: fakeCatalog() })
  const out = await hook(
    { models: { m1: { name: "已有名字", cost: { input: 1 } } } },
    { auth: { access: SESSION } },
  )
  assert.deepEqual(out.m1.cost, { input: 1 })
})
