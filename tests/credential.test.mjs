import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  deriveUID,
  looksLikeSession,
  parseCredential,
  marshalCredential,
  pickWinners,
  shortUID,
} from "../src/credential.mjs"

const SESSION = "a".repeat(32)

test("deriveUID 是 sha256 前 16 位十六进制，且确定性", () => {
  const want = createHash("sha256").update(SESSION, "utf8").digest("hex").slice(0, 16)
  assert.equal(deriveUID(SESSION), want)
  assert.equal(deriveUID(SESSION), deriveUID(SESSION))
  assert.match(deriveUID(SESSION), /^[0-9a-f]{16}$/)
})

test("looksLikeSession 只认 32 位小写 hex", () => {
  assert.equal(looksLikeSession(SESSION), true)
  assert.equal(looksLikeSession("A".repeat(32)), false) // 大写不认
  assert.equal(looksLikeSession("a".repeat(31)), false)
  assert.equal(looksLikeSession("a".repeat(33)), false)
  assert.equal(looksLikeSession(""), false)
})

test("parseCredential 认客户端原样形态", () => {
  const a = parseCredential(
    JSON.stringify({
      phone: "13800000000",
      maskedPhone: "138****0000",
      session: SESSION,
      userid: "le260915174611208423",
      loggedInAt: "2026-09-14T08:15:28.627Z",
    }),
  )
  assert.equal(a.session, SESSION)
  assert.equal(a.uid, "le260915174611208423")
  assert.equal(a.phone, "138****0000") // maskedPhone 优先
  assert.equal(a.userId, "le260915174611208423")
  assert.equal(a.nickname, "138****0000") // 手机号优先
  assert.equal(a.loggedInAt, "2026-09-14T08:15:28.627Z")
})

test("parseCredential 认网关写盘形态（多出 uid/nickname）", () => {
  const a = parseCredential(
    JSON.stringify({ session: SESSION, uid: "u-1", nickname: "NK6952053", loggedInAt: "" }),
  )
  assert.equal(a.uid, "u-1")
  assert.equal(a.nickname, "NK6952053")
})

test("parseCredential 的 UID 顺序：userid 优先于已存的 uid", () => {
  // 同一个号在「先派生了 uid、后拿到 userid」之后必须收敛到 userid，
  // 否则池子里会出现同一份凭证的两个账号。
  const a = parseCredential(
    JSON.stringify({ session: SESSION, uid: "derived-old", userid: "real-userid" }),
  )
  assert.equal(a.uid, "real-userid")
})

test("parseCredential 认驼峰 userId，但全小写 userid 优先", () => {
  assert.equal(parseCredential(JSON.stringify({ session: SESSION, userId: "camel" })).userId, "camel")
  assert.equal(
    parseCredential(JSON.stringify({ session: SESSION, userid: "lower", userId: "camel" })).userId,
    "lower",
  )
})

test("parseCredential 没有 uid/userid 时派生稳定 uid", () => {
  const a = parseCredential(JSON.stringify({ session: SESSION }))
  assert.equal(a.uid, deriveUID(SESSION))
  assert.equal(a.nickname, shortUID(a.uid))
})

test("parseCredential 缺 session 直接抛错", () => {
  assert.throws(() => parseCredential(JSON.stringify({ userid: "x" })), /缺少 session/)
  assert.throws(() => parseCredential("{}"), /缺少 session/)
})

test("parseCredential 非法 JSON 抛错", () => {
  assert.throws(() => parseCredential("{not json"), /不是合法 JSON/)
})

test("parseCredential 也接受对象输入", () => {
  assert.equal(parseCredential({ session: SESSION }).session, SESSION)
})

test("marshalCredential 带缩进与结尾换行，且能被 parseCredential 读回", () => {
  const a = parseCredential(JSON.stringify({ session: SESSION, userid: "u1", loggedInAt: "t1" }))
  const text = marshalCredential(a)
  assert.ok(text.endsWith("\n"))
  assert.ok(text.includes("\n  "))
  const back = parseCredential(text)
  assert.equal(back.session, a.session)
  assert.equal(back.uid, a.uid)
  assert.equal(back.loggedInAt, a.loggedInAt)
})

test("pickWinners 同一 uid 保留 loggedInAt 较新的一份", () => {
  const older = parseCredential(JSON.stringify({ session: "b".repeat(32), uid: "u1", loggedInAt: "2026-01-01T00:00:00Z" }))
  const newer = parseCredential(JSON.stringify({ session: "c".repeat(32), uid: "u1", loggedInAt: "2026-02-01T00:00:00Z" }))
  const out = pickWinners([older, newer])
  assert.equal(out.length, 1)
  assert.equal(out[0].session, "c".repeat(32))
})

test("pickWinners 空时间视为最旧", () => {
  const noTime = parseCredential(JSON.stringify({ session: "b".repeat(32), uid: "u1" }))
  const timed = parseCredential(JSON.stringify({ session: "c".repeat(32), uid: "u1", loggedInAt: "2026-02-01T00:00:00Z" }))
  assert.equal(pickWinners([noTime, timed])[0].session, "c".repeat(32))
  assert.equal(pickWinners([timed, noTime])[0].session, "c".repeat(32))
})

test("pickWinners 保持 uid 首次出现顺序（不按 map 遍历）", () => {
  const a = parseCredential(JSON.stringify({ session: "b".repeat(32), uid: "z-last" }))
  const b = parseCredential(JSON.stringify({ session: "c".repeat(32), uid: "a-first" }))
  assert.deepEqual(pickWinners([a, b]).map((x) => x.uid), ["z-last", "a-first"])
})

test("pickWinners 跳过空 uid / null", () => {
  const ok = parseCredential(JSON.stringify({ session: SESSION, uid: "u1" }))
  assert.deepEqual(pickWinners([null, { uid: "" }, ok]).map((x) => x.uid), ["u1"])
})

test("shortUID 前 8 位", () => {
  assert.equal(shortUID("0123456789abcdef"), "01234567")
  assert.equal(shortUID("abc"), "abc")
})
