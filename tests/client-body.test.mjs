// client-body.test.mjs 真实调用与探测共用**抓包的完整客户端 body**（伪装成客户端）。
//
// # 用户要求（原话）
//
//	「完整的请求就直接用就行了，和客户端一样就行了呀，这样我们就不会被降级了。
//	  我们的目的就是伪装成客户端。」
//
// 所以不是「补几个字段」，而是**以抓包那份 121/171 KB 的 body 为底**：
//	tools / tool_choice / max_tokens / reasoning_effort / $comment / stream_options
// 全部保留模板值；只换 `model` 与调用方的 `messages`（system 追加而非替换）。

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { buildClientBody } from "../src/client-body.mjs"
import { CLIENT_BODY_TEMPLATE } from "../src/client-body-template.mjs"
import { DEFAULT_BODY_MODE } from "../src/constants.mjs"
import { makeLoaderHook } from "../src/hooks/loader.mjs"

const SESSION = "s".repeat(32)
const UID = "260911173523492332"
const BASE = "https://loomyad.xunfei.cn/api/v1"
const CHAT_URL = `${BASE}/chat/completions`

// ── 模板本身 ───────────────────────────────────────────────────────────

test("模板就是客户端那一份：$comment / 32000 / high / system / tools / stream 全在", () => {
  assert.equal(typeof CLIENT_BODY_TEMPLATE.$comment, "string")
  assert.ok(CLIENT_BODY_TEMPLATE.$comment.length > 0, "$comment 是客户端指纹的一部分，不许清理")
  assert.equal(CLIENT_BODY_TEMPLATE.max_tokens, 32000)
  assert.equal(CLIENT_BODY_TEMPLATE.reasoning_effort, "high")
  assert.equal(CLIENT_BODY_TEMPLATE.messages[0].role, "system")
  assert.ok(Array.isArray(CLIENT_BODY_TEMPLATE.tools) && CLIENT_BODY_TEMPLATE.tools.length > 0)
  assert.equal(CLIENT_BODY_TEMPLATE.stream, true)
  assert.deepEqual(CLIENT_BODY_TEMPLATE.stream_options, { include_usage: true })

  // 模板文件真的落在 JSON（可 diff），不是塞在代码里
  const raw = readFileSync(new URL("../src/client-body-template.json", import.meta.url))
  assert.ok(raw.length > 100_000, `模板体量应接近抓包（实际 ${raw.length} 字节）`)
})

// ── buildClientBody ────────────────────────────────────────────────────

test("messages 换成调用方的：客户端 system 在前，其后是调用方的 user；tools 与模板逐项相等", () => {
  const body = buildClientBody({ messages: [{ role: "user", content: "hi" }] })

  assert.equal(body.messages[0].role, "system")
  assert.equal(body.messages[0].content, CLIENT_BODY_TEMPLATE.messages[0].content, "system 用客户端的")
  assert.deepEqual(body.messages[1], { role: "user", content: "hi" })
  assert.deepEqual(body.tools, CLIENT_BODY_TEMPLATE.tools)
  assert.equal(body.max_tokens, CLIENT_BODY_TEMPLATE.max_tokens)
  assert.equal(body.reasoning_effort, CLIENT_BODY_TEMPLATE.reasoning_effort)
  assert.equal(body.$comment, CLIENT_BODY_TEMPLATE.$comment)
})

test("调用方自带 system：客户端 system 在前，调用方 system **追加其后**（不替换、不丢弃）", () => {
  const mine = { role: "system", content: "我的业务约束：只回答数字" }
  const body = buildClientBody({ messages: [mine, { role: "user", content: "1+1=?" }] })

  assert.equal(body.messages[0].content, CLIENT_BODY_TEMPLATE.messages[0].content, "客户端 system 必须在前")
  assert.deepEqual(body.messages[1], mine, "调用方 system 不许丢")
  assert.equal(body.messages[2].content, "1+1=?")
})

test("model 可替换，其余形态字段保持不变", () => {
  const a = buildClientBody({ model: "DeepSeek-V4.1-Flash", messages: [] })
  assert.equal(a.model, "DeepSeek-V4.1-Flash")
  assert.equal(a.max_tokens, 32000)
  assert.deepEqual(a.tools, CLIENT_BODY_TEMPLATE.tools)
  assert.equal(a.tool_choice, CLIENT_BODY_TEMPLATE.tool_choice)

  const b = buildClientBody({ messages: [] })
  assert.equal(b.model, CLIENT_BODY_TEMPLATE.model, "不给 model 就用模板的")
})

test("模板是冻结的：buildClientBody 改出来的对象不会污染模板", () => {
  const body = buildClientBody({ model: "X", messages: [{ role: "user", content: "hi" }] })
  body.messages.push({ role: "assistant", content: "x" })
  assert.equal(CLIENT_BODY_TEMPLATE.model, "deepseek-v4-flash-1017")
  assert.ok(Object.isFrozen(CLIENT_BODY_TEMPLATE))
})

// ── 接线：loader 默认 / 探测 ───────────────────────────────────────────

async function loaderWith(opts) {
  return makeLoaderHook({
    configDir: "",
    routeStore: null,
    recordTraffic: () => ({ ok: true }),
    log: { warn() {} },
    ...opts,
  })(async () => ({ type: "oauth", access: SESSION, accountId: "150****3411", uid: UID }))
}

function capture() {
  /** @type {any[]} */
  const bodies = []
  const fetchImpl = async (_url, init) => {
    bodies.push(init.body)
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  return { bodies, fetchImpl }
}

test("DEFAULT_BODY_MODE === \"client-body\"，且 loader 默认出站 body 与模板同形", async () => {
  assert.equal(DEFAULT_BODY_MODE, "client-body")

  const up = capture()
  const loader = await loaderWith({ fetchImpl: up.fetchImpl })
  const mine = [{ role: "user", content: "我的真实问题" }]
  await loader.fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "DeepSeek-V4.1-Flash", messages: mine }) })

  const body = JSON.parse(String(up.bodies[0]))
  assert.equal(body.model, "DeepSeek-V4.1-Flash", "模型用调用方的")
  assert.deepEqual(body.messages[1], mine[0], "调用方消息内容不变")
  assert.deepEqual(body.tools, CLIENT_BODY_TEMPLATE.tools, "tools 用客户端的")
  assert.equal(body.max_tokens, 32000)
  assert.equal(body.reasoning_effort, "high")
  assert.equal(body.stream, true)
})

// ── T-38：by-turn 探测整段删除，只留 loader 的出站形态 ──────────────────
//
// `probeByTurn` / `newTurnId` / `fetchTurnResult` 已随 `/points/by-turn` 一起删除：
// 响应体每个 chunk 自带真实 `model`，不必再发一次计费 chat 去回查（详见
// `tests/loader-served-model.test.mjs` 与 `src/hooks/loader.mjs` 的注释）。
//
// 但「出站 body 必须是客户端形态」这条结论**不依赖**任何探测通道，改用 loader
// 自己的出站头来钉：客户端是 `ChatId / MsgId / TurnId = msg-<uuid>` 三条同源。

test("loader 出站 body 与模板同形，且三类客户端头齐全（TurnId 与 MsgId 同值）", async () => {
  /** @type {any} */
  let chat = null
  const fetchImpl = async (_url, init) => {
    chat = init
    return Response.json({ choices: [] })
  }

  const loader = await loaderWith({ fetchImpl })
  await loader.fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "DeepSeek-V4.1-Flash", messages: [{ role: "user", content: "ping" }] }) })

  const body = JSON.parse(String(chat.body))
  assert.deepEqual(body.tools, CLIENT_BODY_TEMPLATE.tools)
  assert.equal(body.max_tokens, CLIENT_BODY_TEMPLATE.max_tokens)
  assert.equal(body.reasoning_effort, CLIENT_BODY_TEMPLATE.reasoning_effort)
  assert.equal(body.stream, true)
  assert.equal(body.messages[0].content, CLIENT_BODY_TEMPLATE.messages[0].content)

  const headers = new Headers(chat.headers)
  // 抓包实证：客户端 MsgId 与 TurnId 就是同一个 `msg-<uuid>`
  assert.match(String(headers.get("turnid")), /^msg-/, "TurnId 生成器默认给 msg-<uuid>，不是 turn_*")
  assert.equal(headers.get("msgid"), headers.get("turnid"), "MsgId 与 TurnId 同值")
  assert.match(String(headers.get("chatid")), /^chat-/)
})

test("passthrough 仍逐字节原样（回归）", async () => {
  const up = capture()
  const loader = await loaderWith({ fetchImpl: up.fetchImpl, bodyMode: "passthrough" })
  const raw = '{\n "model": "x",\n "messages": []\n}'
  await loader.fetch(CHAT_URL, { method: "POST", body: raw })
  assert.equal(up.bodies[0], raw)
})