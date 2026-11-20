// token-life.test.mjs JWT 有效期的只读判据（三仓库共用同一份实现）。
//
// # loomy 不用它续期
//
// 本插件的 session 不过期、也没有 refresh token（`src/credential.mjs`），所以
// `auth.refresh` **刻意不存在**。这个模块只是让「是否过半」这条判据在多个仓库
// 里长得一样，方便日后比对 —— 本文件因此只钉**纯函数行为**，不碰任何钩子。
//
// 钉四件事：
//
//	1. `readJwtClaims` 能从真机形状的 token 读出 `iat`/`exp`
//	2. 非 JWT（段数不对 / 不是 base64url / 不是 JSON / payload 没这两个字段）→ null
//	3. `pastHalfLife(iat, iat+7200, iat+3599)` → **false**（还剩 3601 秒 > 一半）
//	4. `pastHalfLife(iat, iat+7200, iat+3601)` → **true**（只剩 3599 秒 < 一半）

import { test } from "node:test"
import assert from "node:assert/strict"

import { readJwtClaims, pastHalfLife } from "../src/token-life.mjs"

/** base64url 编码（无填充，JWT 的形态）。 */
function b64url(text) {
  return Buffer.from(String(text), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** 拼一条**形状真实**的 JWT（签名段是假的 —— 本模块不校验签名）。 */
function jwtOf(payload, { header = { alg: "HS256", typ: "JWT" } } = {}) {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.c2lnbmF0dXJl`
}

// ── 1. 能读出 iat / exp ────────────────────────────────────────────────

test("readJwtClaims：读出真机形状 token 的 iat / exp", () => {
  // 真机形状（loomy / workbuddy 同族）：秒级 iat，exp = iat + 2h
  const iat = 1_763_600_000
  const exp = iat + 7200
  const token = jwtOf({
    sub: "260911173523492332",
    iat,
    exp,
    // 干扰字段：不许被误读成时间
    nbf: iat,
    deviceId: "8f2f0b8a-1f3c-4b7e-9a55-0d1c2b3a4e5f",
  })

  const claims = readJwtClaims(token)
  assert.ok(claims, "合法 JWT 必须读出 claims")
  assert.equal(claims.iat, iat)
  assert.equal(claims.exp, exp)
})

test("readJwtClaims：多字节 payload（中文昵称）也解得出 UTF-8", () => {
  const token = jwtOf({ nickname: "张三 · 测试", iat: 100, exp: 820 })
  const claims = readJwtClaims(token)
  assert.equal(claims.iat, 100)
  assert.equal(claims.exp, 820)
})

// ── 2. 认不出就是 null ────────────────────────────────────────────────

test("readJwtClaims：非 JWT 一律 null（不猜）", () => {
  assert.equal(readJwtClaims(""), null, "空串")
  assert.equal(readJwtClaims("not-a-jwt"), null, "不是三段")
  assert.equal(readJwtClaims("a.b.c.d.e"), null, "五段（JWE）不认")
  assert.equal(readJwtClaims("aaa.%%%.ccc"), null, "payload 不是 base64url")
  assert.equal(readJwtClaims(`${b64url("{}")}.${b64url("[1,2]")}.sig`), null, "payload 是数组")
  assert.equal(readJwtClaims(jwtOf({ sub: "x" })), null, "没有 iat / exp")
  assert.equal(readJwtClaims(jwtOf({ iat: "yesterday", exp: "tomorrow" })), null, "不是数字")
  assert.equal(readJwtClaims(null), null, "null 输入")
})

test("readJwtClaims：只有一个字段时另一个给 0（不编造）", () => {
  assert.deepEqual(readJwtClaims(jwtOf({ exp: 5000 })), { iat: 0, exp: 5000 })
  assert.deepEqual(readJwtClaims(jwtOf({ iat: 1000 })), { iat: 1000, exp: 0 })
})

// ── 3 / 4. 过半判据的两个边界 ─────────────────────────────────────────

test("pastHalfLife：还差 3601 秒到过期（总寿命 7200）→ false（不急）", () => {
  const iat = 1_700_000_000
  const exp = iat + 7200
  // 已过 3599 秒：剩 3601 秒 > 3600（一半）⇒ 还没过半
  assert.equal(pastHalfLife(iat, exp, iat + 3599), false)
})

test("pastHalfLife：只剩 3599 秒（总寿命 7200）→ true（该续了）", () => {
  const iat = 1_700_000_000
  const exp = iat + 7200
  // 已过 3601 秒：剩 3599 秒 < 3600 ⇒ 已过半
  assert.equal(pastHalfLife(iat, exp, iat + 3601), true)
})

test("pastHalfLife：刚好一半（剩 3600 秒）也算过半 → true", () => {
  const iat = 1_700_000_000
  assert.equal(pastHalfLife(iat, iat + 7200, iat + 3600), true)
})

test("pastHalfLife：已过期 → true；总寿命算不出来 → true（交调用方兜底）", () => {
  const iat = 1_700_000_000
  assert.equal(pastHalfLife(iat, iat + 7200, iat + 7200), true, "刚好到期")
  assert.equal(pastHalfLife(iat, iat + 7200, iat + 9999), true, "已过期")
  assert.equal(pastHalfLife(iat, iat, iat), true, "total = 0")
  assert.equal(pastHalfLife(iat, iat - 100, iat), true, "时间倒退")
  assert.equal(pastHalfLife(NaN, iat + 7200, iat), true, "NaN")
  assert.equal(pastHalfLife(0, 0, 0), true, "全 0")
})

test("pastHalfLife：默认 nowSec 取当前时间（不需要注入也能工作）", () => {
  const now = Math.floor(Date.now() / 1000)
  // 一个刚签发、寿命 2h 的 token ⇒ 不该续
  assert.equal(pastHalfLife(now, now + 7200), false)
  // 一个 3 小时前签发、寿命 2h 的 token ⇒ 早该续（已过期）
  assert.equal(pastHalfLife(now - 10_800, now - 3_600), true)
})