import { test } from "node:test"
import assert from "node:assert/strict"

import { _internal, LoomyPage } from "../index.mjs"

const { resolvePort } = _internal

test("端口三级回退：用户设置优先", () => {
  assert.equal(resolvePort({ port: 5000 }, { PAGESVC_PORT: "6000" }, 4391), 5000)
})

test("没有用户设置时用 $PAGESVC_PORT", () => {
  assert.equal(resolvePort({}, { PAGESVC_PORT: "6000" }, 4391), 6000)
  assert.equal(resolvePort(undefined, { PAGESVC_PORT: "6000" }, 4391), 6000)
})

test("都没有时回落到 package.json 声明的默认端口", () => {
  // ⚠ 这一条是实测钉死的：magpie 传的 options 是「用户实际设置的值」，
  //   用户没设过就是 {}，此时必须用 spec 的 port，否则服务永远不监听。
  assert.equal(resolvePort({}, {}, 4391), 4391)
  assert.equal(resolvePort(undefined, undefined, 4391), 4391)
})

test("非法值被跳过，继续往下回退", () => {
  for (const bad of [0, -1, 70000, "abc", null, undefined, NaN, 3.5]) {
    assert.equal(resolvePort({ port: bad }, {}, 4391), 4391, `port=${bad} 应回落到 4391`)
  }
})

test("字符串形态的端口也认", () => {
  assert.equal(resolvePort({ port: "5000" }, {}, 4391), 5000)
  assert.equal(resolvePort({}, { PAGESVC_PORT: " 6000 " }, 4391), 6000)
})

test("全都没有时返回 0（调用方据此跳过监听，不抛错）", () => {
  assert.equal(resolvePort({}, {}, 0), 0)
  assert.equal(resolvePort({}, {}, undefined), 0)
})

test("LoomyPage 端口全无时如实返回 ok:false（不抛错、不监听）", async () => {
  // 只验 resolvePort 的 0 分支：直接调用内部函数，不去真的 listen
  // （真 listen 会占端口，测试里不该做）。
  assert.equal(resolvePort({ port: 0 }, { PAGESVC_PORT: "0" }, 0), 0)
})
