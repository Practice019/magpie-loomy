// usage-relist.test.mjs 判定变化 ⇒ 请求宿主**重读该账号的模型列表**。
//
// # 为什么需要这条（真机实测）
//
// `auth.usage` 判出 routed 之后，magpie **不会**重拉 `provider.models`：
// `plugin-providers.json` 里那个号仍挂着 9 个模型，请求继续派过去，延迟
// 11–27 秒（真 DeepSeek 号 0.8 秒）。只有「重新列表」（CLI `plugin list`
// 或重启 magpie）才生效。
//
// 所以我们用 magpie **原生**的 `signIn: "kept"` 当触发器：账号状态变化时
// 带一次 `kept`，宿主会清掉「该账号的上次读取」，下次请求前重新读一次。
// `provider.models` 那边已经做到 routed/expired/exhausted ⇒ `{}`，
// 所以只要宿主**重新调用一次** models，排除就生效。
//
// ⚠ 只在**判定变化那一刻**加一次 `kept`。每次都加会让宿主反复重读。
// ⚠ 不能用 CLI / 子进程（fork 一个 host、重载整个插件，代价大且抢资源）。
//
// # ⚠ 这条通道是 best-effort，不是权威通道
//
// **实测尚未确认**：`signIn: "kept"` 到底会不会让宿主重拉 models —— 没有可靠
// 证据（`plugin_usage.go` 里它只是「上次读取作废」的语义）。目前已确认有效的
// 权威通道是**面板的「应用判定」**（T-03 跑 `magpie plugin list`，实测改判后
// `order` 从 117 → 116、该号退出路由池、立即生效）。
//
// 所以本文件的断言只钉「我们确实在判定变化时输出了一次 kept」——
// 那是对我们**自身契约**的保证，不是对宿主行为的保证。

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeUsageHook } from "../src/hooks/usage.mjs"

const SESSION = "s".repeat(32)
const DS41 = "DeepSeek-V4.1-Flash"
const UID = "260911173523492332"
const ACCOUNT_ID = "150****3411"

/** 可变的 route-store 桩：测试中途改写判定，模拟「探测出了新结论」。 */
function liveStore(initial = {}) {
  const state = { ...initial }
  return {
    state,
    routeStatePath: () => "(stub)",
    readRouteState: () => ({ ok: true, data: state, error: "" }),
    writeRouteState: (_dir, uid, entry) => {
      state[uid] = entry
      return { ok: true }
    },
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
const EXPIRED = entry("expired", { servedModel: "", reason: "session-expired" })

/** 假积分网关：账本齐全（余额为正，避免「余额为 0」那条满额窗干扰）。 */
function fakePoints() {
  return async () =>
    new Response(
      JSON.stringify({ code: "000000", desc: "ok", data: { balance: 25000, dailyBalance: 1434, availableBalance: 26434 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
}

/** 同一个 hook 实例连续调用 = 同一个进程（内存 Map 在闭包里）。 */
function makeSession({ store, log = { warn() {} } }) {
  const hook = makeUsageHook({
    baseUrl: "https://loomyad.xunfei.cn/api/v1",
    configDir: "D:/cfg",
    routeStore: store,
    fetchImpl: fakePoints(),
    log,
  })
  return () => hook(async () => ({ type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }))
}

test("clean → routed：该次返回带 signIn:\"kept\"，日志写清判定变化", async () => {
  const store = liveStore({ [UID]: CLEAN })
  /** @type {string[]} */
  const logs = []
  const call = makeSession({ store, log: { warn: (m) => logs.push(String(m)) } })

  await call() // 第一次：clean，建立基线
  store.state[UID] = ROUTED
  const u = await call() // 第二次：判定变了

  assert.equal(u.signIn, "kept", "判定变化 ⇒ 请求宿主重读模型列表")
  assert.ok(
    logs.some((m) => m.includes("判定变化") && m.includes("clean") && m.includes("routed")),
    `日志要写清从什么变到什么，实际: ${logs.join(" | ")}`,
  )
})

test("连续两次同 verdict：只有变化那一次带 kept，第二次不带", async () => {
  const store = liveStore({})
  const call = makeSession({ store })

  const first = await call() // 无判定（初始无 record）
  assert.equal(first.signIn, undefined, "第一次没有「变化」可言")

  store.state[UID] = ROUTED
  const second = await call()
  assert.equal(second.signIn, "kept", "变化那一次要带")

  const third = await call()
  assert.equal(third.signIn, undefined, "同样的结论不该每次都让宿主重读（性能灾难）")
})

test("clean → expired：返回 signIn:\"expired\"（不是 kept —— 登录问题优先）", async () => {
  const store = liveStore({ [UID]: CLEAN })
  const call = makeSession({ store })

  await call()
  store.state[UID] = EXPIRED
  const u = await call()

  assert.equal(u.signIn, "expired", "过期要用户重登，不能用 kept 糊过去")
})

test("expired → clean（重登后恢复）：带一次 kept，随后不再带", async () => {
  const store = liveStore({ [UID]: EXPIRED })
  const call = makeSession({ store })

  const first = await call()
  assert.equal(first.signIn, "expired")

  store.state[UID] = CLEAN
  const second = await call()
  assert.equal(second.signIn, "kept", "恢复了也要让宿主重读一次（把模型加回来）")

  const third = await call()
  assert.equal(third.signIn, undefined)
})

test("verdict 无变化 + 没有状态文件：不加 signIn、不加窗口", async () => {
  const store = liveStore({})
  const call = makeSession({ store })

  for (let i = 0; i < 3; i += 1) {
    const u = await call()
    assert.equal(u.signIn, undefined)
    assert.equal(u.windows.length, 3, "没有判定就不该多窗口")
  }
})

test("变化触发 kept 的同时，窗口仍然按新判定走（routed ⇒ 说明窗）", async () => {
  const store = liveStore({ [UID]: CLEAN })
  const call = makeSession({ store })

  await call()
  store.state[UID] = ROUTED
  const u = await call()

  assert.equal(u.signIn, "kept")
  assert.ok(
    u.windows.some((w) => w.aside === true && String(w.name) === "说明 · 上游限制"),
    `新判定必须立刻生效（不能等宿主重读），实际: ${JSON.stringify(u.windows)}`,
  )
})