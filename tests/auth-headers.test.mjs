import { test } from "node:test"
import assert from "node:assert/strict"

import { modelsAuth, chatAuth, imageAuth, pointsAuth } from "../src/auth-headers.mjs"

const AUTH = { session: "a".repeat(32) }

test("modelsAuth 只装 token，不装 Authorization", () => {
  const h = new Headers()
  modelsAuth(h, AUTH)
  assert.equal(h.get("token"), AUTH.session)
  assert.equal(h.get("Authorization"), null)
})

test("chatAuth 只装 Authorization: Bearer，不装 token", () => {
  const h = new Headers()
  chatAuth(h, AUTH)
  assert.equal(h.get("Authorization"), `Bearer ${AUTH.session}`)
  assert.equal(h.get("token"), null)
})

test("imageAuth 两个头都发（实测与官方客户端一致）", () => {
  const h = new Headers()
  imageAuth(h, AUTH)
  assert.equal(h.get("Authorization"), `Bearer ${AUTH.session}`)
  assert.equal(h.get("token"), AUTH.session)
})

test("pointsAuth 只装 token（积分网关不认 Authorization）", () => {
  const h = new Headers()
  pointsAuth(h, AUTH)
  assert.equal(h.get("token"), AUTH.session)
  assert.equal(h.get("Authorization"), null)
})

test("四个函数写的头互不相同 —— 钉死「谁用哪个」", () => {
  const cases = [
    ["models", modelsAuth, { token: true, auth: false }],
    ["chat", chatAuth, { token: false, auth: true }],
    ["image", imageAuth, { token: true, auth: true }],
    ["points", pointsAuth, { token: true, auth: false }],
  ]
  for (const [name, fn, want] of cases) {
    const h = new Headers()
    fn(h, AUTH)
    assert.equal(Boolean(h.get("token")), want.token, `${name}: token 头`)
    assert.equal(Boolean(h.get("Authorization")), want.auth, `${name}: Authorization 头`)
  }
})
