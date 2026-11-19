import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  routeStatePath,
  readRouteState,
  writeRouteState,
  getAccountRoute,
} from "../src/route-store.mjs"

/** 每个用例一个独立临时目录，跑完删掉。 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-route-state-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const ENTRY = {
  verdict: "routed",
  servedModel: "spark-x2.6-low",
  checkedAt: "2026-11-19T00:00:00.000Z",
  requested: "DeepSeek-V4.1-Flash",
}

test("routeStatePath 固定落在 <configDir>/loomy-route-state.json", (t) => {
  const dir = tempDir(t)
  assert.equal(routeStatePath(dir), join(dir, "loomy-route-state.json"))
  assert.equal(routeStatePath(""), "")
  assert.equal(routeStatePath(undefined), "")
})

test("没写过时读到空表（不是错误）", (t) => {
  const dir = tempDir(t)
  const r = readRouteState(dir)
  assert.equal(r.ok, true)
  assert.deepEqual(r.data, {})
  assert.equal(r.error, "")
  assert.equal(getAccountRoute(dir, "150****3411"), null)
})

test("写入后能按昵称键读回来", (t) => {
  const dir = tempDir(t)
  const w = writeRouteState(dir, "150****3411", ENTRY)
  assert.equal(w.ok, true)

  const r = readRouteState(dir)
  assert.equal(r.ok, true)
  assert.deepEqual(r.data["150****3411"], ENTRY)
  assert.deepEqual(getAccountRoute(dir, "150****3411"), ENTRY)
  assert.equal(getAccountRoute(dir, "someone-else"), null)
})

test("数字 uid 与字符串 uid 是同一个键", (t) => {
  const dir = tempDir(t)
  assert.equal(writeRouteState(dir, 12345, ENTRY).ok, true)

  assert.deepEqual(getAccountRoute(dir, 12345), ENTRY)
  assert.deepEqual(getAccountRoute(dir, "12345"), ENTRY)
  assert.match(readFileSync(routeStatePath(dir), "utf8"), /"12345"/)
})

test("损坏的 JSON 不抛，返回 ok:false", (t) => {
  const dir = tempDir(t)
  writeFileSync(routeStatePath(dir), '{"150****3411": {oops')

  const r = readRouteState(dir)
  assert.equal(r.ok, false)
  assert.deepEqual(r.data, {})
  assert.equal(typeof r.error, "string")
  assert.notEqual(r.error, "")
  assert.equal(getAccountRoute(dir, "150****3411"), null)
})

test("合法 JSON 但不是对象也算损坏", (t) => {
  const dir = tempDir(t)
  writeFileSync(routeStatePath(dir), "[1,2,3]")

  const r = readRouteState(dir)
  assert.equal(r.ok, false)
  assert.deepEqual(r.data, {})
})

test("损坏后仍能写入并恢复", (t) => {
  const dir = tempDir(t)
  writeFileSync(routeStatePath(dir), "not json at all")

  const w = writeRouteState(dir, "150****3411", ENTRY)
  assert.equal(w.ok, true)

  const r = readRouteState(dir)
  assert.equal(r.ok, true)
  assert.deepEqual(r.data["150****3411"], ENTRY)
})

test("目录不存在时自动创建", (t) => {
  const dir = tempDir(t)
  const nested = join(dir, "a", "b")

  const w = writeRouteState(nested, "150****3411", ENTRY)
  assert.equal(w.ok, true)
  assert.equal(existsSync(routeStatePath(nested)), true)
})

test("两次写入是合并而不是覆盖别人的条目", (t) => {
  const dir = tempDir(t)
  writeRouteState(dir, "150****3411", ENTRY)
  writeRouteState(dir, "139****0000", { ...ENTRY, verdict: "clean" })

  const r = readRouteState(dir)
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(r.data).sort(), ["139****0000", "150****3411"])
})

test("没有 configDir 时明确失败，不写任何文件", () => {
  assert.equal(routeStatePath(""), "")
  const r = readRouteState("")
  assert.equal(r.ok, false)
  assert.deepEqual(r.data, {})
  assert.match(r.error, /configDir/)

  const w = writeRouteState("", "150****3411", ENTRY)
  assert.equal(w.ok, false)
  assert.match(w.error, /configDir/)
  assert.equal(getAccountRoute("", "150****3411"), null)
})

test("configDir 实际是个文件时写入失败但不抛", (t) => {
  const dir = tempDir(t)
  const notADir = join(dir, "blocker")
  writeFileSync(notADir, "x")

  const w = writeRouteState(notADir, "150****3411", ENTRY)
  assert.equal(w.ok, false)
  assert.equal(typeof w.error, "string")
  assert.notEqual(w.error, "")
})

test("目录存在但状态文件是目录时读取返回 ok:false", (t) => {
  const dir = tempDir(t)
  mkdirSync(routeStatePath(dir))

  const r = readRouteState(dir)
  assert.equal(r.ok, false)
  assert.deepEqual(r.data, {})
})
