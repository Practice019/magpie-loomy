// loader-peek.test.mjs peek 的**读多少**与**不读**。
//
// # 为什么这组测试存在（真机事故 T-28）
//
// 上一版 loader 对**所有 200** 都 peek 登录态，而 peek 是 `clone().text()`
// 读到 EOF。`resp.clone()` 与原响应共享底层流 —— clone 读到 EOF ⇒ 原分支的
// chunk 被全部缓冲、在 magpie 开始读时一次性放出 ⇒ 首 token 与末 token 的
// 到达时间差 ≈ 0 ⇒ `decode_ms` / `decode_tps` 全算不出来。
// 实测：loomy 全部账号 `decode 均速 = （空）`，其它上游正常；`ttft` 不受影响。
//
// # T-29 修正：为什么不再测「限量读 + cancel」
//
// T-28 的修法是「clone 出来的分支只读 4 KB 然后 reader.cancel()」。真机跑出来
// 是死锁：`Response.clone()` 的两个分支**共享同一条底层流**，取消 clone 分支
// 的 reader 会波及原分支（上游 source 被 cancel），原响应从此产不出数据 ——
// 测试里 `out.text()` 永远等不到结束，15s 超时。
//
// 正确做法：能走到 peek 的响应（非 2xx / 200 + application/json）都有
// `Content-Length`、不是流，**整读是安全的**。所以本文件钉死六件事：
//
//	1. 200 + text/event-stream → **一次 clone 都不调**（流绝不能碰）
//	2. 200 + application/json → 会整读 peek，且 **原响应仍能完整读出来**
//	   （证明 clone 分支没有连坐原流）
//	3. 401 → 不读正文也返回 expired（只看状态码）
//	4. 有 4xx 错误体 → 读正文下结论，之后原响应仍可完整读取（不 cancel）
//	5. **核心回归**：流式 chunk 经过 loader 后仍逐块可见（时间轴不被压平）
//	6. Content-Type 缺失 → 视为非 JSON，不 peek

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeLoaderHook, peekVerdict, PEEK_LIMIT_BYTES } from "../src/hooks/loader.mjs"

const SESSION = "s".repeat(32)
const UID = "260911173523492332"
const CHAT_URL = "https://loomyad.xunfei.cn/api/v1/chat/completions"
const BODY = JSON.stringify({
  model: "DeepSeek-V4.1-Flash",
  stream: true,
  messages: [{ role: "user", content: "ping" }],
})

const enc = new TextEncoder()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一段 SSE 数据块（与上游真机形状一致：`data: {...}` + 空行）。 */
function sseChunk(i) {
  return enc.encode(`data: {"i":${i}}\n\n`)
}

/** 由固定分块组成的流；`gapMs > 0` 时每块之间真的等这么久（用来测时间轴）。 */
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

/** 造一个 loader，上游恒返回 `resp`（或由函数现造）。 */
function loaderWith(resp) {
  const hook = makeLoaderHook({
    // ⚠ 必须注入：默认实现用 `globalThis.fetch`，测试里被 network-guard 换成抛错
    fetchImpl: typeof resp === "function" ? resp : async () => resp,
    // ⚠ 必须注入：否则真去写流量文件（污染宿主机磁盘）
    recordTraffic: () => ({ ok: true, error: "" }),
    // 判定表：本文件只关心 peek，不需要 route-store
    routeStore: null,
    log: { warn() {} },
  })
  return hook(async () => ({ type: "oauth", access: SESSION, uid: UID }))
}

/** 给一个真 Response 装 clone 计数器（`clone()` 被调 = peek 发生了）。 */
function spyClone(resp) {
  const stats = { clones: 0 }
  resp.clone = function countedClone() {
    stats.clones += 1
    return Response.prototype.clone.call(this)
  }
  return stats
}

// ── 1. 200 + SSE：一次 clone 都不许调 ─────────────────────────────────

test("200 + text/event-stream：完全不 peek（clone 一次都不调）", async () => {
  const resp = new Response(streamOf([sseChunk(1)]), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
  const stats = spyClone(resp)
  const loader = await loaderWith(resp)

  const out = await loader.fetch(CHAT_URL, { method: "POST", body: BODY })

  assert.equal(stats.clones, 0, "流式 200 一旦被 clone 读，magpie 就测不出 decode_ms")
  assert.equal(out, resp, "流式响应必须原样交出，连包一层都不该包")
  assert.equal(await out.text(), 'data: {"i":1}\n\n')
})

// ── 2. 200 + JSON：会整读 peek，且原流毫发无损 ─────────────────────────
//
// 这一条就是 T-29 的回归：以前断言「只读 4 KB / cancel」，结果 cancel 连坐
// 原分支 → `out.text()` 永不到 EOF → 超时。现在断言的是反过来的东西：
// peek 之后**原响应仍能完整读出 1 MiB**。

test("200 + application/json：会 peek（整读），且原响应仍能完整读出 1 MiB", async () => {
  const CHUNK = 1024
  const TOTAL_CHUNKS = 1024 // 1 MiB
  const TOTAL = CHUNK * TOTAL_CHUNKS
  let produced = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (produced >= TOTAL_CHUNKS) {
        controller.close()
        return
      }
      produced += 1
      controller.enqueue(new Uint8Array(CHUNK).fill(0x20))
    },
  })

  const resp = new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
  const stats = spyClone(resp)
  const loader = await loaderWith(resp)

  const out = await loader.fetch(CHAT_URL, { method: "POST", body: BODY })

  assert.equal(stats.clones, 1, "200 + JSON 是唯一需要看正文的 200")
  assert.equal(out.status, 200)

  // 关键断言：peek 不能连坐原流。clone 分支只允许「整读」，允许 cancel 的
  // 写法会让这里永远等不到 EOF（T-29 真机就是 15s 超时）。
  const text = await out.text()
  assert.equal(text.length, TOTAL, `原响应应完整产出 ${TOTAL} 字节，实际 ${text.length}（原流被 cancel 了）`)
})

// ── 3. 401：不读正文也返回 expired ────────────────────────────────────

test("401：不读正文也返回 expired（只看状态码）", async () => {
  const bare = new Response("登录已失效，请重新登录", {
    status: 401,
    headers: { "content-type": "application/json" },
  })
  let clones = 0
  bare.clone = () => {
    clones += 1
    throw new Error("401 不该读 body")
  }

  assert.equal(await peekVerdict(bare), "expired")
  assert.equal(clones, 0, "401 的结论只来自状态码，正文一个字节都不该读")

  // 经过 loader 时要真的把结论写进头
  const resp = new Response("", { status: 401, headers: { "content-type": "application/json" } })
  const loader = await loaderWith(resp)
  const out = await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  assert.equal(out.status, 401)
  assert.equal(out.headers.get("x-magpie-sign-in"), "expired")
})

// ── 4. peek 之后原响应仍可完整读取（绝不 cancel）─────────────────────
//
// 旧断言是「读满 4 KB 就 reader.cancel()」，那正是 T-29 的 bug 本身：
// cancel 会连坐共享底层流的原分支。现在只允许整读，所以断言改成
// 「peek 拿到了正文里的语义」+「原响应此后仍读得出完整正文」。

test("4xx 错误体：peek 读到正文下结论，之后原响应仍能完整读取", async () => {
  const body = JSON.stringify({ code: "100002", desc: "登录已失效，请重新登录" })
  let cancelled = 0

  // ① peekVerdict 直接面对一个 stream 响应：整读之后不允许 cancel
  const resp = new Response(body, { status: 400, headers: { "content-type": "application/json" } })
  const realCancel = ReadableStream.prototype.cancel
  ReadableStream.prototype.cancel = function countedCancel(reason) {
    cancelled += 1
    return realCancel.call(this, reason)
  }
  try {
    await peekVerdict(resp)
  } finally {
    ReadableStream.prototype.cancel = realCancel
  }
  assert.equal(cancelled, 0, "clone 之后只能整读：cancel 会波及原分支，原响应再也产不出数据")
  // 整读的是 clone 分支，原分支仍然可用
  assert.equal(await resp.text(), body, "peek 不得消耗原分支的正文")

  // ② 经过 loader：结论写进头，且宿主仍能读到完整正文
  const live = new Response(body, { status: 400, headers: { "content-type": "application/json" } })
  const loader = await loaderWith(live)
  const out = await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  assert.equal(out.status, 400)
  assert.ok(out.headers.get("x-magpie-sign-in"), "4xx 错误体应被读出登录态并写进头")
  assert.equal(await out.text(), body, "peek 之后原响应必须仍能完整读出")
})

// ── 5. 核心回归：流式 chunk 逐块可见 ─────────────────────────────────

test("流式响应经过 loader 后 chunk 仍逐块可见（clone 不再压平时间轴）", async () => {
  const GAP = 60
  const chunks = [sseChunk(1), sseChunk(2), sseChunk(3)]
  const resp = new Response(streamOf(chunks, GAP), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
  const loader = await loaderWith(resp)

  const started = Date.now()
  const out = await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  const waited = Date.now() - started
  // 旧实现（clone 读到 EOF）会等到整条流结束 ≈ 2×GAP；现在必须立刻返回
  assert.ok(waited < GAP * 1.5, `loader 必须立刻交出响应，实际等了 ${waited}ms（说明它把流读到了 EOF）`)

  const reader = out.body.getReader()
  /** @type {number[]} */
  const stamps = []
  for (;;) {
    const { done } = await reader.read()
    stamps.push(Date.now())
    if (done) break
  }

  assert.equal(stamps.length, chunks.length + 1, `应读到 3 块 + 1 次 done，实际 ${stamps.length} 次`)
  const gap12 = stamps[1] - stamps[0]
  const gap23 = stamps[2] - stamps[1]
  assert.ok(gap12 >= GAP * 0.6, `第 1→2 块间隔 ${gap12}ms，应≈${GAP}ms（被压平说明 peek 读了整条流）`)
  assert.ok(gap23 >= GAP * 0.6, `第 2→3 块间隔 ${gap23}ms，应≈${GAP}ms（被压平说明 peek 读了整条流）`)
})

// ── 6. Content-Type 缺失 ⇒ 不当 JSON ─────────────────────────────────

test("Content-Type 缺失 → 视为非 JSON，不 peek", async () => {
  const resp = new Response(streamOf([enc.encode("{}")]), { status: 200 })
  assert.equal(resp.headers.get("content-type"), null, "前提：这个响应确实没有 Content-Type")
  const stats = spyClone(resp)
  const loader = await loaderWith(resp)

  const out = await loader.fetch(CHAT_URL, { method: "POST", body: BODY })

  assert.equal(stats.clones, 0, "认不出是不是 JSON 就别碰正文")
  assert.equal(out, resp)
  assert.equal(await out.text(), "{}")
})
