import { test } from "node:test"
import assert from "node:assert/strict"

import { extractItems, toSignInResult, makeImportHook, IMPORT_MOST } from "../src/importer.mjs"

const S = (c) => c.repeat(32)

test("数组形态", () => {
  const { items, shapes } = extractItems(JSON.stringify([{ session: S("a") }, { session: S("b") }]))
  assert.equal(items.length, 2)
  assert.equal(shapes, "json-array")
})

test("单个对象", () => {
  const { items, shapes } = extractItems(JSON.stringify({ session: S("a") }))
  assert.equal(items.length, 1)
  assert.equal(shapes, "json-object")
})

test("包了一层的对象（accounts / data / list / items）", () => {
  for (const key of ["accounts", "data", "list", "items"]) {
    const { items } = extractItems(JSON.stringify({ [key]: [{ session: S("a") }] }))
    assert.equal(items.length, 1, `key=${key}`)
  }
})

test("每行一个 JSON（NDJSON）", () => {
  const text = `{"session":"${S("a")}"}\n{"session":"${S("b")}"}`
  const { items, shapes } = extractItems(text)
  assert.equal(items.length, 2)
  assert.equal(shapes, "ndjson")
})

test("整段是一串裸 session（每行一个 32 位 hex）", () => {
  const { items, shapes } = extractItems(`${S("a")}\n${S("b")}`)
  assert.equal(items.length, 2)
  assert.equal(shapes, "bare-sessions")
})

test("散落在文本里的 session 也能抠出来（去重）", () => {
  const text = `我的账号 ${S("a")} 还有一个 ${S("a")} 和 ${S("b")}`
  const { items, shapes } = extractItems(text)
  assert.equal(items.length, 2)
  assert.equal(shapes, "scattered-sessions")
})

test("空文本返回空", () => {
  assert.deepEqual(extractItems("").items, [])
  assert.deepEqual(extractItems("   ").items, [])
})

test("认不出的文本返回空 + unrecognised", () => {
  const r = extractItems("hello world, nothing here")
  assert.equal(r.items.length, 0)
  assert.equal(r.shapes, "unrecognised")
})

// ── 转成登录结果 ───────────────────────────────────────────────────────

test("合法的 session 转成 oauth 形态（access 而非 key）", async () => {
  const r = await toSignInResult({ session: S("a"), userid: "u1" })
  assert.equal(r.type, "success")
  // ⚠ 实测钉死：type=api 的凭证 magpie 不调 auth.usage，额度区一片空白
  assert.ok(r.access)
  assert.equal(r.key, undefined)
  assert.equal(r.expires, 0)
  assert.equal(r.refresh, "")
  assert.equal(r.uid, "u1")
})

test("解掉 auth / account / credential / data 嵌套", async () => {
  for (const key of ["auth", "account", "credential", "data"]) {
    const r = await toSignInResult({ [key]: { session: S("a") } })
    assert.equal(r.type, "success", `key=${key}`)
  }
})

test("缺 session 的条目报 failed，不抛异常", async () => {
  const r = await toSignInResult({ phone: "13800000000" })
  assert.equal(r.type, "failed")
  assert.match(r.error, /session/)
})

test("verify 失败时报 failed 并带上 accountId", async () => {
  const r = await toSignInResult(
    { session: S("a"), phone: "138****0000" },
    { verify: async () => { throw new Error("登录已失效") } },
  )
  assert.equal(r.type, "failed")
  assert.match(r.error, /session 不可用/)
  assert.equal(r.accountId, "138****0000")
})

test("verify 通过时正常返回", async () => {
  let called = 0
  const r = await toSignInResult({ session: S("a") }, { verify: async () => { called += 1 } })
  assert.equal(r.type, "success")
  assert.equal(called, 1)
})

// ── 钩子整体 ───────────────────────────────────────────────────────────

test("importFrom 是一句给界面看的说明", () => {
  const h = makeImportHook()
  assert.equal(typeof h.importFrom, "string")
  assert.ok(h.importFrom.length > 0 && h.importFrom.length <= 300)
  assert.ok(h.importFroms.zh && h.importFroms.en)
})

test("import 处理多个文件", async () => {
  const h = makeImportHook()
  const r = await h.import([
    JSON.stringify([{ session: S("a") }]),
    JSON.stringify([{ session: S("b") }]),
  ])
  assert.equal(r.length, 2)
  assert.ok(r.every((x) => x.type === "success"))
})

test("import 没有文件时返回空数组（不算失败）", async () => {
  const h = makeImportHook()
  const r = await h.import(["", "   ", null])
  assert.equal(r.length, 0)
})

test("import 对完全认不出的内容给一条 failed（不静默返回空）", async () => {
  const h = makeImportHook()
  const r = await h.import(["hello world"])
  assert.equal(r.length, 1)
  assert.equal(r[0].type, "failed")
  assert.match(r[0].error, /没从文件里认出账号/)
})

test("import 一条坏数据不影响同批的好数据", async () => {
  const h = makeImportHook()
  const r = await h.import([
    JSON.stringify([{ session: S("a") }, { phone: "no-session" }, { session: S("b") }]),
  ])
  assert.equal(r.length, 3)
  assert.equal(r.filter((x) => x.type === "success").length, 2)
  assert.equal(r.filter((x) => x.type === "failed").length, 1)
})

test("import 最多收 IMPORT_MOST 条（magpie 的上限）", async () => {
  const h = makeImportHook()
  const many = Array.from({ length: 150 }, (_, i) => ({
    session: i.toString(16).padStart(32, "0"),
  }))
  const r = await h.import([JSON.stringify(many)])
  assert.equal(r.length, IMPORT_MOST)
})

test("import 被 abort 时尽早停下", async () => {
  const h = makeImportHook()
  const ac = new AbortController()
  ac.abort()
  const r = await h.import([JSON.stringify([{ session: S("a") }])], { signal: ac.signal })
  assert.equal(r.length, 1)
  assert.equal(r[0].type, "failed")
})

test("import 对非数组 texts 返回空数组", async () => {
  const h = makeImportHook()
  assert.deepEqual(await h.import(undefined), [])
  assert.deepEqual(await h.import(null), [])
})
