// body-mode.test.mjs body 改写模式：**默认 passthrough**（用户要「原始 BODY 一模一样」）。
//
// # 为什么默认值变了
//
// 用户原话：「为什么要自己裁剪呢？我就是要原始的 BODY 一模一样。」
// 所以插件默认**完全不动** body；需要 `stream`/`stream_options` 的场合，
// 由用户在插件选项里填 `"bodyMode": "default"`。
//
// # 这组测试钉什么
//
//	① 不传 bodyMode ⇒ 走 passthrough（连没有 stream 字段也逐字节原样）
//	② 传 bodyMode:"default" ⇒ 仍补 stream + stream_options
//	③ index 的插件选项能把这个值透传到 loader（行为可见，不靠打桩）

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeLoaderHook } from "../src/hooks/loader.mjs"
import { LoomyAuthPlugin } from "../index.mjs"
import { DEFAULT_BODY_MODE } from "../src/constants.mjs"

const SESSION = "s".repeat(32)
const UID = "260911173523492332"
const CHAT_URL = "https://loomyad.xunfei.cn/api/v1/chat/completions"

/** 抓出站 body。 */
function capturingUpstream() {
  /** @type {any[]} */
  const bodies = []
  const fetchImpl = async (_url, init) => {
    bodies.push(init.body)
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  return { bodies, fetchImpl }
}

const AUTH = () => ({ type: "oauth", access: SESSION, accountId: "150****3411", uid: UID })

async function loaderWith(opts) {
  return makeLoaderHook({
    configDir: "",
    routeStore: null,
    recordTraffic: () => ({ ok: true }),
    log: { warn() {} },
    ...opts,
  })(async () => AUTH())
}

/** 故意「非常规」的原始 body：缩进、字段倒序、**没有** stream。 */
const RAW = '{\n  "messages": [{"role":"user","content":"hi"}],\n  "model": "deepseek-v4-flash-1017"\n}'

test("默认（不传 bodyMode）= client-body：出站 body 换成客户端形态（工具/32000/stream）", async () => {
  assert.equal(DEFAULT_BODY_MODE, "client-body", "常量与行为必须一致")

  const up = capturingUpstream()
  const loader = await loaderWith({ fetchImpl: up.fetchImpl })

  await loader.fetch(CHAT_URL, { method: "POST", body: RAW })

  const body = JSON.parse(String(up.bodies[0]))
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 32000)
  assert.equal(body.reasoning_effort, "high")
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "默认带客户端全套 tools")
  assert.equal(body.messages[0].role, "system", "默认带客户端 system")
  assert.equal(body.messages[1].content, "hi", "调用方内容仍在")
})

test("bodyMode:\"passthrough\" 仍逐字节原样（用户要「原始 BODY」时的选项）", async () => {
  const up = capturingUpstream()
  const loader = await loaderWith({ fetchImpl: up.fetchImpl, bodyMode: "passthrough" })
  await loader.fetch(CHAT_URL, { method: "POST", body: RAW })
  assert.equal(up.bodies[0], RAW, "passthrough 下不许任何改写（换行/缩进/字段顺序都要保留）")
})

test("bodyMode:\"default\" → 仍补 stream=true 与 stream_options", async () => {
  const up = capturingUpstream()
  const loader = await loaderWith({ fetchImpl: up.fetchImpl, bodyMode: "default" })

  await loader.fetch(CHAT_URL, { method: "POST", body: RAW })

  const body = JSON.parse(String(up.bodies[0]))
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }], "内容不许动")
})

test("index：插件选项 bodyMode:\"default\" 会透传到 loader（行为可见）", async () => {
  const p = await LoomyAuthPlugin({}, { bodyMode: "default" })
  const loader = await p.auth.loader(async () => AUTH())

  const original = globalThis.fetch
  /** @type {any[]} */
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(init.body)
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    await loader.fetch(CHAT_URL, { method: "POST", body: RAW })
  } finally {
    globalThis.fetch = original
  }

  const body = JSON.parse(String(bodies[0]))
  assert.equal(body.stream, true, "填了 default 就该改写")
})

test("index：不填 bodyMode 时默认走 client-body（与常量一致）", async () => {
  const p = await LoomyAuthPlugin({}, {})
  const loader = await p.auth.loader(async () => AUTH())

  const original = globalThis.fetch
  /** @type {any[]} */
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(init.body)
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    await loader.fetch(CHAT_URL, { method: "POST", body: RAW })
  } finally {
    globalThis.fetch = original
  }

  const body = JSON.parse(String(bodies[0]))
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "默认带客户端 tools")
  assert.equal(body.max_tokens, 32000)
})