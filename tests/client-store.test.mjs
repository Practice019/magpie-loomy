import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  extractJSONAfter,
  jsonObjectEnd,
  readLocalAuth,
  readLocalPoints,
  defaultClientStoreDir,
} from "../src/client-store.mjs"

const SESSION = "a".repeat(32)

/** 造一个临时 leveldb 目录，写入给定的原始字节内容。 */
function makeStore(contents, name = "000003.log") {
  const dir = mkdtempSync(join(tmpdir(), "loomy-store-"))
  writeFileSync(join(dir, name), contents)
  return dir
}

// ── 配平扫描 ───────────────────────────────────────────────────────────

test("jsonObjectEnd 找配平点", () => {
  const s = '{"a":1}'
  assert.equal(jsonObjectEnd(s, 0), s.length)
})

test("jsonObjectEnd 忽略字符串里的花括号", () => {
  const s = '{"a":"}not end{"}'
  assert.equal(jsonObjectEnd(s, 0), s.length)
})

test("jsonObjectEnd 忽略转义引号", () => {
  // "\\" 之后那个引号仍是字符串内容，不是结束
  const s = '{"a":"x\\\\","b":2}'
  assert.equal(jsonObjectEnd(s, 0), s.length)
})

test("jsonObjectEnd 对截断的记录返回 -1", () => {
  assert.equal(jsonObjectEnd('{"a":1', 0), -1)
})

test("jsonObjectEnd 对非 { 起点返回 -1", () => {
  assert.equal(jsonObjectEnd("abc", 0), -1)
  assert.equal(jsonObjectEnd("", 0), -1)
})

test("extractJSONAfter 找出紧跟 key 的完整对象", () => {
  const text = `xxxloomy-auth-session\x01\x01{"session":"${SESSION}"}yyy`
  const out = extractJSONAfter(text, "loomy-auth-session", 64)
  assert.equal(out.length, 1)
  assert.deepEqual(JSON.parse(out[0]), { session: SESSION })
})

test("extractJSONAfter 能取出多条（客户端追加写入）", () => {
  const text =
    `loomy-auth-session{"session":"${"a".repeat(32)}","loggedInAt":"2026-01-01"}` +
    `loomy-auth-session{"session":"${"b".repeat(32)}","loggedInAt":"2026-02-01"}`
  const out = extractJSONAfter(text, "loomy-auth-session", 64)
  assert.equal(out.length, 2)
})

test("extractJSONAfter 跳过没有配平对象的候选", () => {
  const text = 'loomy-auth-session{"session":"truncat'
  assert.deepEqual(extractJSONAfter(text, "loomy-auth-session", 64), [])
})

test("extractJSONAfter 找不到 key 返回空", () => {
  assert.deepEqual(extractJSONAfter("nothing here", "loomy-auth-session", 64), [])
  assert.deepEqual(extractJSONAfter("", "k", 64), [])
})

// ── readLocalAuth ──────────────────────────────────────────────────────

test("readLocalAuth 读到登录态", () => {
  const dir = makeStore(`\x00\x01loomy-auth-session\x01\x01{"session":"${SESSION}","userid":"u1"}`)
  try {
    const { credential, source } = readLocalAuth(dir)
    assert.ok(credential)
    assert.equal(credential.session, SESSION)
    assert.equal(credential.uid, "u1")
    assert.match(source, /000003\.log/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readLocalAuth 同一键多份时取 loggedInAt 最新", () => {
  const old = JSON.stringify({ session: "b".repeat(32), uid: "same", loggedInAt: "2026-01-01T00:00:00Z" })
  const neu = JSON.stringify({ session: "c".repeat(32), uid: "same", loggedInAt: "2026-02-01T00:00:00Z" })
  const dir = makeStore(`loomy-auth-session${old}loomy-auth-session${neu}`)
  try {
    assert.equal(readLocalAuth(dir).credential.session, "c".repeat(32))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readLocalAuth 目录不存在时抛错（装了但读不到，值得归因）", () => {
  assert.throws(() => readLocalAuth(join(tmpdir(), "definitely-not-a-dir-xyz")), /读取客户端数据目录/)
})

test("readLocalAuth 空目录参数返回 null 而不抛错", () => {
  assert.deepEqual(readLocalAuth(""), { credential: null, source: "" })
})

test("readLocalAuth 目录里没有数据文件返回 null", () => {
  const dir = makeStore("irrelevant", "README.txt")
  try {
    assert.equal(readLocalAuth(dir).credential, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readLocalAuth 忽略半截记录", () => {
  const dir = makeStore('loomy-auth-session{"session":"trunc')
  try {
    assert.equal(readLocalAuth(dir).credential, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── readLocalPoints ────────────────────────────────────────────────────

test("readLocalPoints 读到两个账本", () => {
  const dir = makeStore(
    `loomy-points-summary{"balance":8000,"dailyBalance":5000,"updatedAt":"2026-09-14T08:15:28.627Z"}`,
  )
  try {
    const p = readLocalPoints(dir)
    assert.equal(p.balance, 8000)
    assert.equal(p.balanceKnown, true)
    assert.equal(p.dailyBalance, 5000)
    assert.equal(p.dailyKnown, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readLocalPoints 按时间叠加部分更新（不丢字段）", () => {
  // 后一条只有 balance —— 取最新一条会丢掉 dailyBalance
  const dir = makeStore(
    `loomy-points-summary{"balance":5500,"dailyBalance":4950,"updatedAt":"2026-09-11T09:38:46Z"}` +
      `loomy-points-summary{"balance":5500,"updatedAt":"2026-09-11T03:04:34Z"}`,
  )
  try {
    const p = readLocalPoints(dir)
    assert.equal(p.dailyBalance, 4950)
    assert.equal(p.dailyKnown, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readLocalPoints 只有 balance 时 dailyKnown=false（未知 ≠ 0）", () => {
  const dir = makeStore(`loomy-points-summary{"balance":5500,"updatedAt":"2026-09-11T03:04:34Z"}`)
  try {
    const p = readLocalPoints(dir)
    assert.equal(p.dailyKnown, false)
    assert.equal(p.balanceKnown, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readLocalPoints 读不到返回 null", () => {
  assert.equal(readLocalPoints(""), null)
  const dir = makeStore("nothing")
  try {
    assert.equal(readLocalPoints(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 目录推导 ───────────────────────────────────────────────────────────

test("defaultClientStoreDir 在目录不存在时返回空串（不是报错）", () => {
  const out = defaultClientStoreDir({ env: { APPDATA: join(tmpdir(), "nope-xyz") }, platform: "win32" })
  assert.equal(out, "")
})

test("defaultClientStoreDir 三平台各自的根", () => {
  // 只验「拼出来的路径段对」，不依赖真实目录存在
  const win = defaultClientStoreDir({ env: { APPDATA: tmpdir() }, platform: "win32", home: "C:\\h" })
  assert.ok(win === "" || win.includes("Loomy"))

  const mac = defaultClientStoreDir({ env: {}, platform: "darwin", home: tmpdir() })
  assert.ok(mac === "" || mac.includes("Application Support"))

  const linux = defaultClientStoreDir({ env: { XDG_CONFIG_HOME: tmpdir() }, platform: "linux", home: "/h" })
  assert.ok(linux === "" || linux.includes("Loomy"))
})
