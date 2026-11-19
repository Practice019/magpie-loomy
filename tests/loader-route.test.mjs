// loader-route.test.mjs `loader` **永不阻止请求**。
//
// # 为什么闸门被撤掉了（真机事故）
//
// 上一版对「被上游限制」的账号回 503，想让 magpie 换号。实际后果：
// magpie 把 5xx 当**账号故障信号** —— 每次选中这个号就吃一次 503，
// 于是一批号被标记失败 / 禁用（用户侧反馈「一直在试别的号、可用只剩 90 多」）。
//
// 正确做法不是错误码，而是「这个号没有这个模型」：`provider.models` 返回空
// 目录即可（见 models-hook-route.test.mjs）。所以本文件只钉两件事：
//
//	① routed 账号的请求**照常透传**（状态原样、上游 fetch 恰好 1 次）
//	② 真的收到请求时记一条 warn（只记录，不改行为）
//
// 唯一保留的「路由认知」是只读的判定查询（`accountKeys` / `accountRoute`），
// 它只用于日志。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeLoaderHook } from "../src/hooks/loader.mjs"

const SESSION = "s".repeat(32)
const DS41 = "DeepSeek-V4.1-Flash"
/** 身份（状态文件按它落盘）。 */
const UID = "260911173523492332"
/** 显示名（打码手机号）—— 与 UID 不相等，这是真机凭证的实际形状。 */
const ACCOUNT_ID = "150****3411"
const CHAT_URL = "https://loomyad.xunfei.cn/api/v1/chat/completions"
const IMAGE_URL = "https://loomyad.xunfei.cn/api/v1/images/generations"

/** 测试用最小 route-store 桩（契约同 src/route-store.mjs，仅测试可见）。 */
function stubStore(state) {
  return {
    routeStatePath: () => "(stub)",
    readRouteState: () => ({ ok: true, data: state, error: "" }),
    writeRouteState() {},
    getAccountRoute: (_dir, uid) => (uid in state ? state[uid] : null),
    DS41_MODEL_ID: DS41,
  }
}

const entry = (verdict, extra = {}) => ({
  verdict,
  servedModel: "spark-x2.6-low",
  requested: DS41,
  checkedAt: "2026-11-19T00:00:00.000Z",
  ...extra,
})
const ROUTED = entry("routed")
const CLEAN = entry("clean", { servedModel: DS41 })
/** session 已过期（上游 `/models` 401 / `{"code":"100002"}`）—— 同样只记录、不拦。 */
const EXPIRED = entry("expired", { servedModel: "", reason: "session-expired" })
/** 团队积分余额不足（上游 402）—— 同样只记录、不拦。 */
const EXHAUSTED = entry("exhausted", { servedModel: "", reason: "no-quota" })

/** 一个计数的假上游。 */
function fakeUpstream() {
  /** @type {Array<{url: string, init: any}>} */
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return { calls, fetchImpl }
}

function chatBody(model) {
  return JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "ping" }] })
}

function loadWith({ state, auth = { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }, routeStore, fetchImpl, configDir = "D:/cfg", log = { warn() {} } }) {
  const hook = makeLoaderHook({
    configDir,
    routeStore: routeStore === undefined ? stubStore(state ?? {}) : routeStore,
    fetchImpl,
    log,
    // ⚠ 必须注入：否则 loader 会用真的 `src/traffic.mjs` 往 `configDir`
    // （本测试固定 "D:/cfg"）写流量文件 —— 测试会污染宿主机磁盘。
    // 流量证据本身由 `tests/traffic.test.mjs` 专门验。
    recordTraffic: () => ({ ok: true, error: "" }),
  })
  return hook(async () => auth)
}

// ── 透传是唯一行为 ─────────────────────────────────────────────────────

test("routed 账号：请求照常透传（不再是 503），上游恰好被调 1 次", async () => {
  for (const model of [DS41, "GLM-5.3-Flash", "qwen3.8-flash", "deepseek-v4-flash-1017"]) {
    const up = fakeUpstream()
    const loader = await loadWith({ state: { [UID]: ROUTED }, fetchImpl: up.fetchImpl })

    const resp = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody(model) })

    assert.equal(resp.status, 200, `${model} 不该被拦：503 会让 magpie 把这个号标成故障`)
    assert.equal(up.calls.length, 1)
    assert.equal((await resp.json()).choices[0].message.content, "pong")
  }
})

test("routed 账号：上游的失败状态原样返回（我们不合成任何响应）", async () => {
  const up = {
    calls: [],
    fetchImpl: async (url, init) => {
      up.calls.push({ url, init })
      return new Response(JSON.stringify({ error: { type: "invalid_request_error" } }), { status: 400 })
    },
  }
  const loader = await loadWith({ state: { [UID]: ROUTED }, fetchImpl: up.fetchImpl })

  const resp = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody(DS41) })
  assert.equal(resp.status, 400, "状态码必须来自上游，不是我们编的")
  assert.equal(up.calls.length, 1)
})

test("routed 账号：真的收到请求时记一条 warn（只记录，不改行为）", async () => {
  const up = fakeUpstream()
  /** @type {string[]} */
  const logs = []
  const loader = await loadWith({ state: { [UID]: ROUTED }, fetchImpl: up.fetchImpl, log: { warn: (m) => logs.push(String(m)) } })

  const resp = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody("GLM-5.3-Flash") })

  assert.equal(resp.status, 200)
  assert.equal(logs.length, 1, `只应有一条提示，实际: ${logs.join(" | ")}`)
  assert.ok(logs[0].includes(UID), "日志要写命中键（排障要知道命中的是身份还是显示名）")
  assert.ok(logs[0].includes("GLM-5.3-Flash"), "日志要写请求的模型")
})

test("生图端点在 routed 账号下照常透传", async () => {
  const up = fakeUpstream()
  const loader = await loadWith({ state: { [UID]: ROUTED }, fetchImpl: up.fetchImpl })

  const resp = await loader.fetch(IMAGE_URL, {
    method: "POST",
    body: JSON.stringify({ model: "doubao-seedream-5-lite", prompt: "cat" }),
  })

  assert.equal(resp.status, 200)
  assert.equal(up.calls.length, 1)
})

test("expired 账号：请求照常透传，warn 文案换成「登录已失效」，且仍不拦", async () => {
  const up = fakeUpstream()
  /** @type {string[]} */
  const logs = []
  const loader = await loadWith({ state: { [UID]: EXPIRED }, fetchImpl: up.fetchImpl, log: { warn: (m) => logs.push(String(m)) } })

  const resp = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody(DS41) })

  assert.equal(resp.status, 200, "登录失效也不许在这里拦：拦了就是 5xx → 号被标记故障")
  assert.equal(up.calls.length, 1)
  assert.equal(logs.length, 1, `只应有一条提示，实际: ${logs.join(" | ")}`)
  assert.ok(logs[0].includes("登录已失效"), `文案要区分登录问题，实际: ${logs[0]}`)
  assert.ok(logs[0].includes(UID))
  assert.ok(logs[0].includes(DS41))
})

test("exhausted 账号：请求照常透传，warn 文案换成「积分不足」，且仍不拦", async () => {
  const up = fakeUpstream()
  /** @type {string[]} */
  const logs = []
  const loader = await loadWith({ state: { [UID]: EXHAUSTED }, fetchImpl: up.fetchImpl, log: { warn: (m) => logs.push(String(m)) } })

  const resp = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody(DS41) })

  assert.equal(resp.status, 200, "余额不足也不许在这里拦：拦了就是 5xx → 号被标记故障")
  assert.equal(up.calls.length, 1)
  assert.equal(logs.length, 1, `只应有一条提示，实际: ${logs.join(" | ")}`)
  assert.ok(logs[0].includes("积分不足"), `文案要区分余额问题，实际: ${logs[0]}`)
  assert.ok(logs[0].includes(UID))
  assert.ok(logs[0].includes(DS41))
})

// ── 没有判定时同样透传、且不打扰日志 ───────────────────────────────────

test("clean / unknown / 没有状态文件：透传且不写 warn", async () => {
  for (const state of [{ [UID]: CLEAN }, { [UID]: entry("unknown") }, {}]) {
    const up = fakeUpstream()
    /** @type {string[]} */
    const logs = []
    const loader = await loadWith({ state, fetchImpl: up.fetchImpl, log: { warn: (m) => logs.push(String(m)) } })

    const resp = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody(DS41) })
    assert.equal(resp.status, 200)
    assert.equal(up.calls.length, 1)
    assert.equal(logs.length, 0)
  }
})

test("route-store 模块缺失 → 透传、不报错、不写 warn", async () => {
  const up = fakeUpstream()
  const logs = []
  const loader = await loadWith({ routeStore: null, fetchImpl: up.fetchImpl, log: { warn: (m) => logs.push(String(m)) } })

  const resp = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody(DS41) })
  assert.equal(resp.status, 200)
  assert.equal(up.calls.length, 1)
  assert.equal(logs.length, 0)
})

test("凭证里没有任何键 → 透传、不写 warn", async () => {
  const up = fakeUpstream()
  const logs = []
  const loader = await loadWith({
    state: { [UID]: ROUTED },
    auth: { type: "oauth", access: SESSION },
    fetchImpl: up.fetchImpl,
    log: { warn: (m) => logs.push(String(m)) },
  })

  const resp = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody(DS41) })
  assert.equal(resp.status, 200)
  assert.equal(logs.length, 0)
})

test("makeLoaderHook() 无参仍然可用，且没有 configDir 时透传（向后兼容）", async () => {
  const loader = await makeLoaderHook()(async () => ({ type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }))
  assert.equal(loader.apiKey, SESSION)

  const real = globalThis.fetch
  let hits = 0
  globalThis.fetch = async () => {
    hits += 1
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    const resp = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody(DS41) })
    assert.equal(resp.status, 200)
    assert.equal(hits, 1)
  } finally {
    globalThis.fetch = real
  }
})

// ── 集成：走**真** src/route-store.mjs（不注入桩）─────────────────────
//
// 注入桩能证明逻辑对，但证明不了「动态 import 的相对路径对、真模块的
// getAccountRoute 签名对」。这两条错了，那条 warn 会静默缺席。

test("真 route-store：落盘 routed → 请求仍透传（这条就是「不再有 503」的证明）", async (t) => {
  const store = await import("../src/route-store.mjs").catch(() => null)
  assert.ok(store, "src/route-store.mjs 应当存在（T-01 的冻结契约）")

  const dir = mkdtempSync(join(tmpdir(), "loomy-route-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(store.writeRouteState(dir, UID, ROUTED).ok, true)

  const up = fakeUpstream()
  const logs = []
  const hook = makeLoaderHook({ configDir: dir, fetchImpl: up.fetchImpl, log: { warn: (m) => logs.push(String(m)) } })
  const loader = await hook(async () => ({ type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }))

  const resp = await loader.fetch(CHAT_URL, { method: "POST", body: chatBody("GLM-5.3-Flash") })

  assert.equal(resp.status, 200)
  assert.equal(up.calls.length, 1)
  assert.equal(logs.length, 1, "真模块能读回 routed 判定 ⇒ 应有一条 warn")
})