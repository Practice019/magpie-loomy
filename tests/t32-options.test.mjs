// t32-options.test.mjs —— T-32：`auth.options` 界面开关（loomy）
//
// # 钉什么
//
//	① 开关表的**形状**符合宿主 `optionsOf()` 的严格 schema（`host-acc034d984c6.js` ≈2360-2382）：
//	   key `^[a-z0-9_-]{1,40}$`（**全小写**，camelCase 会被整项静默跳过）、label 必填、
//	   default 只认布尔、最多 16 项。
//	② 两个开关**真的接线**（不是画上去好看）：
//	   `bodymode`   → loader 的请求体形态
//	   `routecheck` → `provider.models` 里「上游改路由 ⇒ 空目录 ⇒ 不派活」那条分支
//	③ 没有 `input.magpie`（OpenCode / 单测）时回落到 default，行为与改造前**完全一致**。
//
// ⚠ 网络：本文件的插件级用例会临时替换 `globalThis.fetch`（`node --test` 每个文件
//   独立进程，替换后立刻还原），绝不发真实请求。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LoomyAuthPlugin, AUTH_OPTIONS } from "../index.mjs"
import { DEFAULT_BODY_MODE } from "../src/constants.mjs"

const SESSION = "s".repeat(32)
const UID = "260911173523492332"
const CHAT_URL = "https://loomyad.xunfei.cn/api/v1/chat/completions"
const OPTION_KEY = /^[a-z0-9_-]{1,40}$/

/** 用户「非常规」的原始 body：缩进、无 stream —— 默认形态会把它换掉。 */
const RAW = '{\n  "messages": [{"role":"user","content":"hi"}],\n  "model": "deepseek-v4-flash-1017"\n}'

const AUTH = () => ({ type: "oauth", access: SESSION, accountId: "150****3411", uid: UID })

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-t32-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 临时换掉全局 fetch，抓出站 body（结束自动还原）。 */
function withFetch(t, respond) {
  const real = globalThis.fetch
  /** @type {any[]} */
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init })
    return respond(url, init)
  }
  t.after(() => {
    globalThis.fetch = real
  })
  return seen
}

// ── ① 形状（严格 schema）────────────────────────────────────────────

test("T32-L1) auth.options 形状合规：key 全小写、label 必填、default 是布尔、≤16 项", async () => {
  const p = await LoomyAuthPlugin({}, { log: { warn() {} } })
  assert.ok(Array.isArray(p.auth.options), "auth.options 必须是数组 —— 挂在顶层或给对象都会被静默忽略")

  const options = p.auth.options
  assert.ok(options.length > 0 && options.length <= 16, `开关数必须 1~16，实际 ${options.length}`)

  for (const o of options) {
    assert.match(o.key, OPTION_KEY, `key 不合规会被整项跳过: ${o.key}`)
    assert.equal(typeof o.label, "string", `label 必填（缺了整项消失）: ${o.key}`)
    assert.ok(o.label.trim().length > 0 && o.label.length <= 60, `label 长度 1~60: ${o.key}`)
    assert.equal(typeof o.default, "boolean", `default 只认布尔: ${o.key}`)
    assert.ok(!o.description || o.description.length <= 300, `description ≤300 字: ${o.key}`)
    if (o.labels) assert.equal(o.labels.zh, o.label, "老 magpie 只读 label：中文文案必须一致")
  }

  assert.deepEqual(
    options.map((o) => o.key),
    ["bodymode", "routecheck"],
    "key 一旦改名就等于把用户的设置清空 —— 名字也钉住",
  )
  assert.deepEqual(AUTH_OPTIONS.map((o) => o.key), options.map((o) => o.key))
})

test("T32-L2) routecheck 默认开（真机 90 个被换模型的号靠它不派活）", async () => {
  const p = await LoomyAuthPlugin({}, { log: { warn() {} } })
  const rc = p.auth.options.find((o) => o.key === "routecheck")
  assert.equal(rc.default, true, "默认必须是「检测」——否则改造前后行为变了")
  assert.equal(rc.filtersModels, true, "打开时模型列表会少号：编辑器要加注（filtersModels）")
})

// ── ② bodymode 真接线 ──────────────────────────────────────────────

test("T32-L3) bodymode 关（默认）：即使用户填了 bodyMode=passthrough，仍走 client-body", async (t) => {
  const seen = withFetch(t, () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
  const p = await LoomyAuthPlugin({}, { log: { warn() {} }, bodyMode: "passthrough" })
  const loader = await p.auth.loader(async () => AUTH())

  await loader.fetch(CHAT_URL, { method: "POST", body: RAW })

  const body = JSON.parse(String(seen[0].init.body))
  assert.equal(body.stream, true, "关闭时用默认形态（client-body 恒带 stream）")
  assert.equal(body.max_tokens, 32000, "默认形态是客户端模板")
})

test("T32-L4) bodymode 开：用 plugins.json 的 bodyMode（passthrough = 逐字节原样）", async (t) => {
  const seen = withFetch(t, () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
  const input = { magpie: { option: (_p, k) => k === "bodymode" } }
  const p = await LoomyAuthPlugin(input, { log: { warn() {} }, bodyMode: "passthrough" })
  const loader = await p.auth.loader(async () => AUTH())

  await loader.fetch(CHAT_URL, { method: "POST", body: RAW })

  assert.equal(String(seen[0].init.body), RAW, "开关打开 + passthrough ⇒ 原始 body 一个字都不改")
})

test("T32-L5) 没有 input.magpie（OpenCode / 单测）时行为与改造前一致", async (t) => {
  assert.equal(DEFAULT_BODY_MODE, "client-body")
  const seen = withFetch(t, () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
  const p = await LoomyAuthPlugin({}, { log: { warn() {} } })
  const loader = await p.auth.loader(async () => AUTH())

  await loader.fetch(CHAT_URL, { method: "POST", body: RAW })
  assert.equal(JSON.parse(String(seen[0].init.body)).stream, true)
})

// ── ③ routecheck 真接线（routed ⇒ 空目录）────────────────────────────

/** 假上游目录：一个模型就够，只要证明「目录非空」。 */
const catalogResponse = () =>
  new Response(
    JSON.stringify({
      data: [{ id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash(x2.0)", context_window: 1000, max_output_tokens: 100 }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )

/** 在 configDir 里写一份真实的 route-state：这个 uid 被上游改路由了。 */
function seedRouted(t) {
  const dir = tempDir(t)
  writeFileSync(
    join(dir, "loomy-route-state.json"),
    JSON.stringify(
      {
        [UID]: {
          verdict: "routed",
          servedModel: "spark-x2.6-low",
          requested: "DeepSeek-V4.1-Flash",
          checkedAt: "2026-11-19T00:00:00.000Z",
        },
      },
      null,
      2,
    ),
  )
  return dir
}

test("T32-L6) routecheck 开（默认）：routed 账号的目录是空的（不派活）", async (t) => {
  const dir = seedRouted(t)
  withFetch(t, () => catalogResponse())
  const p = await LoomyAuthPlugin({ directory: dir }, { log: { warn() {} } })

  const out = await p.provider.models({ models: {} }, { auth: AUTH() })
  assert.deepEqual(out, {}, `被换模型的号不该有目录，实际: ${Object.keys(out).join(",")}`)
})

test("T32-L7) routecheck 关：routed 账号仍拿到目录（开关真的生效，不是摆设）", async (t) => {
  const dir = seedRouted(t)
  withFetch(t, () => catalogResponse())
  const input = { directory: dir, magpie: { option: (_p, k) => (k === "routecheck" ? false : undefined) } }
  const p = await LoomyAuthPlugin(input, { log: { warn() {} } })

  const out = await p.provider.models({ models: {} }, { auth: AUTH() })
  assert.ok(Object.keys(out).length > 0, "关掉开关后必须照常返回目录")
  assert.ok(out["DeepSeek-V4.1-Flash"], `应含上游模型，实际: ${Object.keys(out).join(",")}`)
})