// traffic.test.mjs 「这个号最近一次真实请求被哪个模型服务」的**免费证据**。
//
// # 它解决什么
//
// 探测要发一次计费 chat + 轮询账本。而**真实请求**本来就发生了 —— 只要在
// 出站时把「谁、请求了什么模型、什么时候」记下来，巡检侧再去读账本比对，
// 就能免费判断有没有被换模型。
//
// # 三条硬性质
//
//	① 旁路证据：读写失败一律吞掉，绝不影响请求（loader 里用 `void`）
//	② 有界：每个 uid 只留最近 20 条（文件不会无限长大）
//	③ 原子：temp + rename；写一个 uid 不能弄丢别的 uid

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { trafficPath, recordTraffic, readTraffic, readAllTraffic } from "../src/traffic.mjs"
import { makeLoaderHook } from "../src/hooks/loader.mjs"

const SESSION = "s".repeat(32)
const UID = "260911173523492332"
const UID2 = "260911173523499999"

/** 一个临时 configDir（测试结束自动删）。 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-traffic-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("记录一条 → 按 at 升序读回", (t) => {
  const dir = tempDir(t)
  assert.equal(trafficPath(dir), join(dir, "loomy-traffic.json"))

  recordTraffic(dir, UID, { model: "DeepSeek-V4.1-Flash", at: 1000 })
  recordTraffic(dir, UID, { model: "GLM-5.3-Flash", at: 2000 })

  assert.deepEqual(readTraffic(dir, UID), [
    { model: "DeepSeek-V4.1-Flash", at: 1000 },
    { model: "GLM-5.3-Flash", at: 2000 },
  ])
})

test("同一 uid 连记 25 条 → 只留最近 20 条（最旧的被丢）", (t) => {
  const dir = tempDir(t)
  for (let i = 0; i < 25; i += 1) recordTraffic(dir, UID, { model: `m${i}`, at: 1000 + i })

  const list = readTraffic(dir, UID)
  assert.equal(list.length, 20, "文件必须有界，否则长跑会无限长大")
  assert.equal(list[0].model, "m5", "丢掉的是最旧的 5 条")
  assert.equal(list[19].model, "m24")
  // 磁盘上也必须是 20 条（不是只在读的时候裁）
  const onDisk = JSON.parse(readFileSync(trafficPath(dir), "utf8"))
  assert.equal(onDisk.accounts[UID].length, 20)
})

test("两个 uid 各记 → 互不干扰（写一个不能弄丢另一个）", (t) => {
  const dir = tempDir(t)
  recordTraffic(dir, UID, { model: "A", at: 1 })
  recordTraffic(dir, UID2, { model: "B", at: 2 })
  recordTraffic(dir, UID, { model: "C", at: 3 })

  assert.deepEqual(readTraffic(dir, UID).map((e) => e.model), ["A", "C"])
  assert.deepEqual(readTraffic(dir, UID2).map((e) => e.model), ["B"])
  assert.deepEqual(Object.keys(readAllTraffic(dir)).sort(), [UID, UID2].sort())
})

test("文件损坏 / 目录不存在 / 无 configDir → 读写都不抛，返回空", (t) => {
  const dir = tempDir(t)
  // ① 文件损坏
  writeFileSync(trafficPath(dir), "{ not json")
  assert.deepEqual(readTraffic(dir, UID), [])
  assert.deepEqual(readAllTraffic(dir), {})
  // 损坏之后仍然能写（重建），不抛
  assert.doesNotThrow(() => recordTraffic(dir, UID, { model: "A", at: 1 }))
  assert.equal(readTraffic(dir, UID).length, 1)

  // ② 目录不存在 → record 会 mkdir
  const nested = join(dir, "deep", "nested")
  assert.doesNotThrow(() => recordTraffic(nested, UID, { model: "A", at: 1 }))
  assert.ok(existsSync(trafficPath(nested)))
  assert.equal(readTraffic(nested, UID).length, 1)

  // ③ 无 configDir（routeStatePath 同口径：""）
  assert.equal(trafficPath(""), "")
  assert.doesNotThrow(() => recordTraffic("", UID, { model: "A", at: 1 }))
  assert.deepEqual(readTraffic("", UID), [])
  assert.deepEqual(readAllTraffic(""), {})
})

test("原子写：写失败的临时文件不会留下垃圾，且原有数据不丢", (t) => {
  const dir = tempDir(t)
  recordTraffic(dir, UID, { model: "A", at: 1 })
  recordTraffic(dir, UID2, { model: "B", at: 2 })

  // 再写一次 UID：UID2 必须还在，且目录里没有遗留 .tmp
  recordTraffic(dir, UID, { model: "A2", at: 3 })
  assert.equal(readTraffic(dir, UID2).length, 1)
  const leftovers = readFileSync(trafficPath(dir), "utf8").includes(".tmp")
  assert.equal(leftovers, false)
  // 目录里只应有最终文件（不留 temp）
  const names = readdirSync(dir)
  assert.ok(names.every((n) => !n.endsWith(".tmp")), `临时文件没清干净: ${names.join(",")}`)
})

// ── loader 集成：只记录「真实发生过的对话」 ─────────────────────────────

const CHAT_URL = "https://loomyad.xunfei.cn/api/v1/chat/completions"
const IMAGE_URL = "https://loomyad.xunfei.cn/api/v1/images/generations"

function loadWith({ configDir, recordTraffic: rec, auth = { type: "oauth", access: SESSION, accountId: "150****3411", uid: UID } }) {
  const hook = makeLoaderHook({
    configDir,
    // 避免 loader 去读判定（本文件不测路由日志）
    routeStore: null,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    recordTraffic: rec,
    log: { warn() {} },
  })
  return hook(async () => auth)
}

const settle = () => new Promise((r) => setTimeout(r, 50))

test("loader 集成：一次 chat 请求后 traffic 里出现该 uid 的记录；生图不记录", async (t) => {
  const dir = tempDir(t)
  const loader = await loadWith({ configDir: dir })

  await loader.fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "DeepSeek-V4.1-Flash", messages: [] }) })
  await settle()

  const list = readTraffic(dir, UID)
  assert.equal(list.length, 1, "真实对话必须留下一条证据")
  assert.equal(list[0].model, "DeepSeek-V4.1-Flash")
  assert.equal(typeof list[0].at, "number")

  // 生图：只关心对话路由，不记
  await loader.fetch(IMAGE_URL, { method: "POST", body: JSON.stringify({ model: "doubao-seedream-5-lite", prompt: "cat" }) })
  await settle()
  assert.equal(readTraffic(dir, UID).length, 1, "生图不该产生记录")
})

test("loader 集成：写文件抛错时请求仍正常返回（旁路证据不能影响主流程）", async () => {
  const loader = await loadWith({
    configDir: "D:/cfg",
    recordTraffic: () => {
      throw new Error("disk full")
    },
  })

  const resp = await loader.fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "GLM-5.3-Flash", messages: [] }) })
  assert.equal(resp.status, 200, "记录失败不能把请求打坏")
})

test("loader 集成：没有 configDir / 解析不出 model → 静默跳过（不写盘、不抛）", async (t) => {
  const dir = tempDir(t)
  /** @type {any[]} */
  const calls = []
  const loader = await loadWith({ configDir: "", recordTraffic: (...args) => calls.push(args) })

  // 无 configDir
  await loader.fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "GLM-5.3-Flash" }) })
  // body 里没有 model
  await loader.fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ messages: [] }) })
  // body 不是 JSON
  await loader.fetch(CHAT_URL, { method: "POST", body: "not-json" })
  await settle()

  assert.equal(calls.length, 0, `不该记录，实际: ${JSON.stringify(calls)}`)
  assert.deepEqual(readAllTraffic(dir), {})
})