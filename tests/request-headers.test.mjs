// request-headers.test.mjs 让出站请求头与 **Loomy 客户端完全一致**。
//
// # 为什么这是「用一会儿号就卡死」的头号嫌疑（客户端源码 v0.9.39）
//
// 客户端 `request-headers.js` 在 `POST /api/v1/chat/completions` 上发的不止
// `Authorization`，还有 `traceparent` / `loomy-version` / `X-Loomy-Request-Purpose`
// 等一组头。客户端自己的注释写着：
//
//	「实测 Loomy iModel 缺 traceparent 时 chat/completions 会挂死直到超时。」
//
// 我们过去只发 `Authorization` —— 于是「能用一会儿」，然后卡在超时上。
//
// # 三条铁律
//
//	① `traceparent` **每次请求新生成**（客户端也是每请求一个新 ID）
//	② 只做 merge，**不删**宿主已有的头（宿主注入的 Authorization 值相同即覆盖）
//	③ 生图端点**不**带 traceparent（客户端生图链路自己发，别混）

import { test } from "node:test"
import assert from "node:assert/strict"

import { newTraceparent, chatHeaders, imageAuth } from "../src/auth-headers.mjs"
import { TRACEPARENT_PATTERN, REQUEST_PURPOSE_CHAT, DEFAULT_LOOMY_VERSION, CLIENT_USER_AGENT } from "../src/constants.mjs"
import { makeLoaderHook } from "../src/hooks/loader.mjs"

const SESSION = "s".repeat(32)
const UID = "260911173523492332"
const CHAT_URL = "https://loomyad.xunfei.cn/api/v1/chat/completions"
const IMAGE_URL = "https://loomyad.xunfei.cn/api/v1/images/generations"

// ── traceparent ────────────────────────────────────────────────────────

test("newTraceparent() 符合 W3C traceparent 格式，且每次都不一样", () => {
  const a = newTraceparent()
  const b = newTraceparent()

  assert.match(a, TRACEPARENT_PATTERN)
  assert.match(b, TRACEPARENT_PATTERN)
  assert.notEqual(a, b, "客户端是每请求一个新 ID：复用同一个等于没发")
  // 采样标志位固定 01（客户端常量）
  assert.ok(a.endsWith("-01"))
})

// ── chatHeaders ────────────────────────────────────────────────────────

test("chatHeaders() 装齐客户端的全部头（含 token 与 Authorization 同值）", () => {
  const h = new Headers()
  const trace = chatHeaders(h, { session: SESSION }, {})

  assert.equal(h.get("authorization"), `Bearer ${SESSION}`)
  assert.equal(h.get("token"), SESSION, "两个鉴权头都发（客户端 session 模式就是这样）")
  assert.equal(h.get("accept"), "*/*", "抓包实证：客户端发的是通配符，不是 application/json")
  assert.equal(h.get("content-type"), "application/json")
  assert.match(String(h.get("traceparent")), TRACEPARENT_PATTERN)
  assert.equal(h.get("loomy-version"), DEFAULT_LOOMY_VERSION)
  assert.equal(h.get("x-loomy-request-purpose"), REQUEST_PURPOSE_CHAT)
  // 返回同一个 Headers 实例，方便链式调用
  assert.equal(trace, h)
})

test("可选头：没传就不发（客户端也是「缺失是常态」）", () => {
  const h = new Headers()
  chatHeaders(h, { session: SESSION }, {})

  for (const name of ["chatid", "msgid", "turnid", "invokeorigin"]) {
    assert.equal(h.get(name), null, `${name} 不该凭空出现`)
  }
})

test("可选头：传了就原样带上（ChatId / MsgId / TurnId / InvokeOrigin / purpose / version）", () => {
  const h = new Headers()
  chatHeaders(h, { session: SESSION }, {
    chatId: "c-1",
    msgId: "m-1",
    turnId: "t-1",
    invokeOrigin: "user",
    purpose: "chat.message.custom",
    version: "0.9.40",
  })

  assert.equal(h.get("chatid"), "c-1")
  assert.equal(h.get("msgid"), "m-1")
  assert.equal(h.get("turnid"), "t-1")
  assert.equal(h.get("invokeorigin"), "user")
  assert.equal(h.get("x-loomy-request-purpose"), "chat.message.custom")
  assert.equal(h.get("loomy-version"), "0.9.40")
})

// ── loader 集成 ────────────────────────────────────────────────────────

/** 抓每次出站请求的 headers（与 body —— 用来断言 stream_options 不该出现在生图里）。 */
function capturingUpstream() {
  /** @type {Array<Headers>} */
  const sent = []
  /** @type {any[]} */
  const sentBodies = []
  const fetchImpl = async (_url, init) => {
    sent.push(new Headers(init.headers))
    sentBodies.push(init.body)
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  return { sent, sentBodies, fetchImpl }
}

function loadWith({ fetchImpl, auth = { type: "oauth", access: SESSION, accountId: "150****3411", uid: UID }, loomyVersion, userAgent, bodyMode }) {
  const hook = makeLoaderHook({
    configDir: "",
    routeStore: null,
    fetchImpl,
    recordTraffic: () => ({ ok: true }),
    loomyVersion,
    userAgent,
    bodyMode,
    log: { warn() {} },
  })
  return hook(async () => auth)
}

const BODY = JSON.stringify({ model: "DeepSeek-V4.1-Flash", messages: [] })

test("loader：每次 chat 请求都生成**新的** traceparent（连发 3 次三个值互不相同）", async () => {
  const up = capturingUpstream()
  const loader = await loadWith({ fetchImpl: up.fetchImpl })

  for (let i = 0; i < 3; i += 1) await loader.fetch(CHAT_URL, { method: "POST", body: BODY })

  const traces = up.sent.map((h) => h.get("traceparent"))
  assert.equal(traces.length, 3)
  for (const t of traces) assert.match(String(t), TRACEPARENT_PATTERN)
  assert.equal(new Set(traces).size, 3, `复用同一个 traceparent 会让上游挂死，实际: ${traces.join(",")}`)
})

test("loader：宿主已设的 Authorization 被覆盖成与 session 相同的值（不是追加重复头）", async () => {
  const up = capturingUpstream()
  const loader = await loadWith({ fetchImpl: up.fetchImpl })

  await loader.fetch(CHAT_URL, {
    method: "POST",
    body: BODY,
    headers: { Authorization: "Bearer stale-or-host-own", "X-Other": "keep-me" },
  })

  const h = up.sent[0]
  assert.equal(h.get("authorization"), `Bearer ${SESSION}`)
  assert.equal(h.get("token"), SESSION)
  assert.equal(h.get("x-other"), "keep-me", "宿主/调用方的头必须保留")
})

test("loader：chat 请求补齐 loomy-version 与 purpose；loomyVersion 可注入", async () => {
  const up = capturingUpstream()
  const loader = await loadWith({ fetchImpl: up.fetchImpl })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })
  assert.equal(up.sent[0].get("loomy-version"), DEFAULT_LOOMY_VERSION)
  assert.equal(up.sent[0].get("x-loomy-request-purpose"), REQUEST_PURPOSE_CHAT)

  const up2 = capturingUpstream()
  const loader2 = await loadWith({ fetchImpl: up2.fetchImpl, loomyVersion: "0.9.41" })
  await loader2.fetch(CHAT_URL, { method: "POST", body: BODY })
  assert.equal(up2.sent[0].get("loomy-version"), "0.9.41")
})

test("loader：生图端点只补 token，**不带** traceparent（别把两条链路混在一起）", async () => {
  const up = capturingUpstream()
  const loader = await loadWith({ fetchImpl: up.fetchImpl })

  await loader.fetch(IMAGE_URL, { method: "POST", body: JSON.stringify({ model: "doubao-seedream-5-lite", prompt: "cat" }) })

  const h = up.sent[0]
  assert.equal(h.get("token"), SESSION)
  assert.equal(h.get("traceparent"), null)
  assert.equal(h.get("x-loomy-request-purpose"), null)
})

// ── 与客户端 1:1：UA / Accept-Encoding ─────────────────────────────────
//
// 客户端是 Electron：不发 Node 默认的 `undici`，而是 Chromium 的 UA。
// 我们的请求走 Node，UA 是 `undici`/空 —— 这本身就是「不像客户端」的指纹。

test("loader：对话端点注入客户端 UA 与 Accept-Encoding（宿主没设时）", async () => {
  const up = capturingUpstream()
  const loader = await loadWith({ fetchImpl: up.fetchImpl })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })

  const h = up.sent[0]
  assert.equal(h.get("user-agent"), CLIENT_USER_AGENT)
  assert.match(String(h.get("accept-encoding")), /gzip/)
  assert.match(String(h.get("accept-encoding")), /br/)
  assert.match(String(h.get("accept-encoding")), /zstd/, "抓包实证：客户端接受 zstd")
  assert.equal(h.get("accept"), "*/*")
  assert.equal(h.get("content-type"), "application/json")
})

test("loader：宿主已设 User-Agent → 不覆盖（调用方优先）", async () => {
  const up = capturingUpstream()
  const loader = await loadWith({ fetchImpl: up.fetchImpl })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY, headers: { "User-Agent": "host-agent/1.0" } })

  assert.equal(up.sent[0].get("user-agent"), "host-agent/1.0")
})

test("loader：options.userAgent 可覆盖默认 UA", async () => {
  const up = capturingUpstream()
  const loader = await loadWith({ fetchImpl: up.fetchImpl, userAgent: "custom/9.9" })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })

  assert.equal(up.sent[0].get("user-agent"), "custom/9.9")
})

test("loader：生图端点也带客户端 UA，但不带 chat 头 / stream_options / traceparent", async () => {
  const up = capturingUpstream()
  const loader = await loadWith({ fetchImpl: up.fetchImpl })

  await loader.fetch(IMAGE_URL, { method: "POST", body: JSON.stringify({ model: "doubao-seedream-5-lite", prompt: "cat" }) })

  const h = up.sent[0]
  assert.equal(h.get("user-agent"), CLIENT_USER_AGENT)
  assert.equal(h.get("traceparent"), null)
  // 生图请求体原样发（没有 stream 概念，也就不该有 stream_options）
  const body = JSON.parse(String(up.sentBodies[0] ?? "{}"))
  assert.equal(body.stream_options, undefined)

  // 生图链路上不该出现对话专属的头
  for (const name of ["chatid", "msgid", "turnid", "invokeorigin", "x-session-affinity", "x-loomy-request-purpose"]) {
    assert.equal(h.get(name), null, `生图不该带 ${name}`)
  }
})

// ── 与客户端 1:1：ChatId / MsgId=TurnId / X-Session-Affinity（抓包实证）──

test("loader：MsgId 与 TurnId 用同一个值，形如 msg-<uuid>；ChatId 形如 chat-<uuid>", async () => {
  const up = capturingUpstream()
  const loader = await loadWith({ fetchImpl: up.fetchImpl })

  await loader.fetch(CHAT_URL, { method: "POST", body: BODY })

  const h = up.sent[0]
  assert.match(String(h.get("chatid")), /^chat-[0-9a-f-]{36}$/i)
  assert.match(String(h.get("msgid")), /^msg-[0-9a-f-]{36}$/i)
  assert.equal(h.get("msgid"), h.get("turnid"), "客户端 MsgId 与 TurnId 是同一个值")
  assert.equal(h.get("invokeorigin"), "user")
})

test("loader：X-Session-Affinity 形如 ses_<20 位>，同一 uid 稳定、不同 uid 不同", async () => {
  const up1 = capturingUpstream()
  const loader1 = await loadWith({ fetchImpl: up1.fetchImpl })
  await loader1.fetch(CHAT_URL, { method: "POST", body: BODY })
  await loader1.fetch(CHAT_URL, { method: "POST", body: BODY })
  const a1 = up1.sent[0].get("x-session-affinity")
  const a2 = up1.sent[1].get("x-session-affinity")

  assert.match(String(a1), /^ses_[A-Za-z0-9]{20}$/)
  assert.equal(a1, a2, "同一账号必须恒定（每请求随机会让上游看到「每次都是新会话」）")

  const up2 = capturingUpstream()
  const loader2 = await loadWith({
    fetchImpl: up2.fetchImpl,
    auth: { type: "oauth", access: SESSION, accountId: "150****3411", uid: "260911173523499999" },
  })
  await loader2.fetch(CHAT_URL, { method: "POST", body: BODY })
  const b1 = up2.sent[0].get("x-session-affinity")

  assert.match(String(b1), /^ses_[A-Za-z0-9]{20}$/)
  assert.notEqual(a1, b1, "不同账号必须不同（同一值等于所有人共用会话）")
})

test("imageAuth 仍是「两个鉴权头都发」，且不碰 traceparent", () => {
  const h = new Headers()
  imageAuth(h, { session: SESSION })
  assert.equal(h.get("authorization"), `Bearer ${SESSION}`)
  assert.equal(h.get("token"), SESSION)
  assert.equal(h.get("traceparent"), null)
})

// ── body 透传模式（用户要求「原始 BODY 一模一样」的验证开关）─────────

test("bodyMode:\"passthrough\" → 发出的 body 与入参**逐字节相同**（含空白与字段顺序）", async () => {
  const up = capturingUpstream()
  const loader = await loadWith({ fetchImpl: up.fetchImpl, bodyMode: "passthrough" })

  // 故意用「非常规」的排版：字段顺序倒置、换行缩进、没有 stream
  const original = '{\n  "messages": [{"role":"user","content":"hi"}],\n  "model": "DeepSeek-V4.1-Flash"\n}'
  await loader.fetch(CHAT_URL, { method: "POST", body: original })

  assert.equal(up.sentBodies[0], original, "passthrough 下不许任何改写（连 stream=true 都不加）")
  // 头仍然按客户端形态补齐（头与 body 是两件事）
  assert.match(String(up.sent[0].get("turnid")), /^msg-/)
})

test("bodyMode:\"default\" 仍会补 stream=true 与 stream_options；但**不**补 max_tokens / reasoning_effort", async () => {
  const up = capturingUpstream()
  // ⚠ 第十七轮起**默认**是 passthrough（用户要求原样发），
  //    所以要显式指定 `default` 才谈得上「补」。
  const loader = await loadWith({ fetchImpl: up.fetchImpl, bodyMode: "default" })

  await loader.fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "DeepSeek-V4.1-Flash", messages: [] }) })

  const body = JSON.parse(String(up.sentBodies[0]))
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.max_tokens, undefined, "不许补 max_tokens（用户要求原始 body）")
  assert.equal(body.reasoning_effort, undefined)
})