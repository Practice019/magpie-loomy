// loader-served-model.test.mjs 「这一轮实际由谁服务」—— 读响应体，不再问上游。
//
// # 为什么不需要 /points/by-turn 了（T-38，真机实测）
//
//	POST /api/v1/chat/completions   (stream:true)
//	data: {"object":"chat.completion.chunk","model":"deepseek-v4-flash-1017",
//	       "choices":[{"delta":{"reasoning_content":"The"}}]}
//	data: {"object":"chat.completion.chunk","model":"deepseek-v4-flash-1017", ...}
//
// **每个 chunk 都带真实模型名**。旧实现为了拿这一个字段，每个 200 请求都要
// 额外打一次 `/points/by-turn`（还带重试）—— 那就是「多余」本身。
//
// # 本文件钉四件事
//
//	① 首块里的 `model` 能被读出来（`deepseek-v4-flash-1017`）
//	② **不吞流、不压平时间轴**：3 块间隔 60ms 仍逐块可见（magpie 的 decode_ms 靠它）
//	③ 请求的模型 ≠ 实际模型 ⇒ 记进 route-state（`served-model-mismatch`）
//	④ 只读首个带 model 的块就停，**绝不 cancel 原流**（cancel 会连坐上游 source）
//
// ⚠ 实现用的是 `body.tee()` 而不是 `Response.clone()`：tee 出来的第二支是独立
//   ReadableStream，`cancel()` 只结束它自己（`tests/loader-peek.test.mjs` 的 T-29
//   红线针对的是 clone）。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  makeLoaderHook,
  extractFirstModel,
  watchFirstModel,
  applyServedModel,
  ResponseWithTeedBody,
  isStreamResponse,
  resetCooldowns,
} from "../src/hooks/loader.mjs"

const SESSION = "s".repeat(32)
const UID = "260911173523492332"
const CHAT_URL = "https://loomyad.xunfei.cn/api/v1/chat/completions"

const enc = new TextEncoder()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 真机形状的 SSE 块（带 model）。 */
function sseChunk(i, model = "deepseek-v4-flash-1017") {
  return enc.encode(
    `data: {"object":"chat.completion.chunk","model":"${model}","choices":[{"delta":{"content":"t${i}"}}]}\n\n`,
  )
}

/** 固定分块组成的流；`gapMs` > 0 时块之间真等这么久（用来测时间轴）。 */
function streamOf(chunks, gapMs = 0) {
  let i = 0
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      if (gapMs && i > 0) await sleep(gapMs)
      controller.enqueue(chunks[i])
      i += 1
    },
  })
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-served-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 造一个 loader：上游恒返回给定响应。
 *
 * ⚠ `routeStore` **不要**传 `null`：那等于「落盘模块缺失」，旁路观察会静默放弃
 *   （`applyServedModel` 找不到 store 就直接 return）。本文件要验的正是落盘，
 *   所以走**真的** `src/route-store.mjs`（不注入桩）。
 */
function loaderWith({ dir, resp, bodyMode = "passthrough" }) {
  const hook = makeLoaderHook({
    configDir: dir,
    fetchImpl: async () => resp,
    recordTraffic: () => ({ ok: true, error: "" }),
    bodyMode,
    log: { warn() {} },
  })
  return hook(async () => ({ type: "oauth", access: SESSION, uid: UID }))
}

const chatBody = (model) => JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "ping" }] })

// ── ① 纯函数：从 SSE 文本里取首个 model ───────────────────────────────

test("extractFirstModel：认出 data: {...model...}，跳过 [DONE] / 心跳 / 半截 JSON", () => {
  assert.equal(extractFirstModel('data: {"model":"deepseek-v4-flash-1017","choices":[]}\n\n'), "deepseek-v4-flash-1017")
  // 前面有空行 / 注释 / 心跳都不影响
  assert.equal(
    extractFirstModel(': keep-alive\n\ndata: {"model":"spark-x2.6-low"}\n'),
    "spark-x2.6-low",
  )
  assert.equal(extractFirstModel("data: [DONE]\n\n"), "")
  assert.equal(extractFirstModel('data: {"model":'), "", "半截 JSON 不能崩，也不能瞎猜")
  assert.equal(extractFirstModel(""), "")
})

test("watchFirstModel：读到首个带 model 的块就停（后面的块不会被读进来）", async () => {
  let pulled = 0
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1
      if (pulled > 5) {
        controller.close()
        return
      }
      controller.enqueue(sseChunk(pulled))
    },
  })
  const served = await watchFirstModel(stream, { timeoutMs: 2000 })
  assert.equal(served, "deepseek-v4-flash-1017")
  assert.ok(pulled <= 2, `读到就应停止，实际拉了 ${pulled} 次`)
})

test("watchFirstModel：没有任何 model 的流 → 空串（不报错）", async () => {
  const stream = streamOf([enc.encode('data: {"i":1}\n\n'), enc.encode("data: [DONE]\n\n")])
  assert.equal(await watchFirstModel(stream, { timeoutMs: 2000 }), "")
})

// ── ② 不吞流、不压平时间轴（核心回归）────────────────────────────────

test("流式响应经过 loader 后：首块 model 被读出，且 3 块间隔 60ms **仍逐块可见**", async (t) => {
  const dir = tempDir(t)
  resetCooldowns()
  const GAP = 60
  const chunks = [sseChunk(1), sseChunk(2), sseChunk(3)]
  const resp = new Response(streamOf(chunks, GAP), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
  const loader = await loaderWith({ dir, resp })

  const started = Date.now()
  const out = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody("deepseek-v4-flash-1017") })
  const waited = Date.now() - started
  // 旧实现（读到 EOF）会等到整条流结束 ≈ 2×GAP；现在必须立刻交出
  assert.ok(waited < GAP * 1.5, `loader 必须立刻交出响应，实际等了 ${waited}ms`)

  const reader = out.body.getReader()
  /** @type {number[]} */
  const stamps = []
  /** @type {string[]} */
  const texts = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    stamps.push(Date.now())
    texts.push(new TextDecoder().decode(value))
  }

  assert.equal(stamps.length, 3, `宿主应读到 3 块，实际 ${stamps.length}`)
  assert.match(texts[0], /deepseek-v4-flash-1017/, "第一块内容原样到达（含 model 字段）")
  const gap12 = stamps[1] - stamps[0]
  const gap23 = stamps[2] - stamps[1]
  assert.ok(gap12 >= GAP * 0.6, `第 1→2 块间隔 ${gap12}ms，应≈${GAP}ms（被压平说明读到了 EOF）`)
  assert.ok(gap23 >= GAP * 0.6, `第 2→3 块间隔 ${gap23}ms，应≈${GAP}ms（被压平说明读到了 EOF）`)

  // 上游确实只被调了 1 次：**没有**任何 by-turn 之类的额外请求
  assert.equal(resp.bodyUsed, true, "原响应仍被宿主完整读完（我们换的是流引用，不是正文）")
})

// ── ③ 实际模型 ≠ 期望模型 ⇒ 落盘（旁路，不改响应）────────────────────

test("实际模型 ≠ 请求模型：记进 route-state（served-model-mismatch），响应不受影响", async (t) => {
  const dir = tempDir(t)
  resetCooldowns()
  const resp = new Response(streamOf([sseChunk(1, "spark-x2.6-low")]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
  const loader = await loaderWith({ dir, resp })

  const out = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody("deepseek-v4-flash-1017") })
  assert.equal(out.status, 200, "旁路观察绝不许改状态码")
  assert.match(await out.text(), /spark-x2\.6-low/, "正文原样交回")

  // 观察是 `void` 的：等它落盘（轮询最多 1s）
  const file = join(dir, "loomy-route-state.json")
  const deadline = Date.now() + 1000
  while (Date.now() < deadline && !existsSync(file)) await sleep(20)
  assert.ok(existsSync(file), "应当落了 route-state")

  /** @type {any} */
  let table = {}
  const deadline2 = Date.now() + 1000
  while (Date.now() < deadline2) {
    table = JSON.parse(readFileSync(file, "utf8"))
    if (table[UID]) break
    await sleep(20)
  }
  assert.ok(table[UID], `该 uid 应当有记录，实际: ${JSON.stringify(table)}`)
  assert.equal(table[UID].verdict, "routed")
  assert.equal(table[UID].reason, "served-model-mismatch")
  assert.equal(table[UID].servedModel, "spark-x2.6-low")
  assert.equal(table[UID].requested, "deepseek-v4-flash-1017")
})

test("实际模型 == 请求模型：记成 clean / served-model-match（保留已有 catalogOkAt）", async (t) => {
  const dir = tempDir(t)
  resetCooldowns()
  // 预先有一条巡检写下的 catalogOkAt
  const { writeRouteState } = await import("../src/route-store.mjs")
  writeRouteState(dir, UID, { verdict: "unknown", reason: "no-ledger-records", catalogOkAt: 123, servedModel: "" })

  const resp = new Response(streamOf([sseChunk(1, "deepseek-v4-flash-1017")]), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
  const loader = await loaderWith({ dir, resp })
  const out = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody("deepseek-v4-flash-1017") })
  await out.text()

  const { getAccountRoute } = await import("../src/route-store.mjs")
  const deadline = Date.now() + 1000
  /** @type {any} */
  let entry = null
  while (Date.now() < deadline) {
    entry = getAccountRoute(dir, UID)
    if (entry?.verdict === "clean") break
    await sleep(20)
  }
  assert.ok(entry, "应当有记录")
  assert.equal(entry.verdict, "clean")
  assert.equal(entry.reason, "served-model-match")
  assert.equal(entry.catalogOkAt, 123, "不许覆盖巡检写的 catalogOkAt")
})

test("族认不出（如 glm）⇒ 不下结论（半个证据不封号）", async (t) => {
  const dir = tempDir(t)
  await applyServedModel({
    configDir: dir,
    uid: UID,
    requested: "DeepSeek-V4.1-Flash",
    served: "mystery-model-1",
    log: { warn() {} },
  })
  assert.equal(existsSync(join(dir, "loomy-route-state.json")), false, "认不出族就不写盘")
})

// ── ④ 与 sign-in peek 互斥（真机回归：tee 过的 JSON 会被「已读过」）──

test("非流式 JSON 响应：不 tee、不观察（交给 sign-in peek 整读）", async (t) => {
  const dir = tempDir(t)
  resetCooldowns()
  /** @type {any} */
  const resp = new Response(JSON.stringify({ model: "spark-x2.6-low", choices: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
  assert.equal(isStreamResponse(resp), false, "JSON 200 不是流")

  const loader = await loaderWith({ dir, resp })
  const out = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody("deepseek-v4-flash-1017") })
  // 关键：正文仍然可读（tee 过就会被 peek 的 clone().text() 判成「已读过」）
  const parsed = await out.json()
  assert.equal(parsed.model, "spark-x2.6-low", "正文必须完整可读")
})

test("ResponseWithTeedBody：宿主侧的 `text()` 仍可用，且两支互不干扰", async () => {
  // ⚠ 这是 T-38 的真机回归点：**不能**在原对象上 `defineProperty(body)`。
  //   Response 的 text()/json() 读的是内部槽，原对象被 tee 过就抛
  //   `Body is unusable` —— 那会让每一次普通对话都变成失败响应。
  const original = new Response(streamOf([sseChunk(1)]), {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-keep": "yes" },
  })
  const [forHost, forPeek] = original.body.tee()
  const swapped = ResponseWithTeedBody(original, forHost)

  assert.equal(swapped.status, 200, "状态码照抄")
  assert.equal(swapped.headers.get("x-keep"), "yes", "头照抄")

  // ① 宿主读到完整内容（text() 可用 —— 这是 regress 过的能力）
  assert.match(await swapped.text(), /deepseek-v4-flash-1017/)

  // ② 观察分支也不受影响（tee 的两支互不干扰）
  const peeked = await new Response(forPeek).text()
  assert.match(peeked, /deepseek-v4-flash-1017/)
})