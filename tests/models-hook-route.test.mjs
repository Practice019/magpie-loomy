// models-hook-route.test.mjs 「被上游限制的账号」= 这个号的目录**是空的**。
//
// # 这是 magpie 唯一不产生错误的「排除」方式（真机事故后定的结论）
//
// magpie 的 `plugin-providers.json` 里每个账号都有自己的 `models` 数组，
// 路由只在这份列表里选模型。实测：184 个号里有 90 个上游只下发
// `spark-x2.6-low / spark-x2.6-4b`，magpie 天生就不会给它们派 DS4.1。
//
// 所以「别把请求派给我」必须用**目录**表达，不能用 5xx：
// 5xx 会被当成账号故障 → 成批号被标记失败 / 禁用（上一版的真机事故）。
//
// 本文件钉住：
//	① routed → 返回 `{}`（一个模型都不给）
//	② clean / unknown / 无判定 / 模块缺失 → 原来的实时目录
//	③ 真 route-store 落盘后能读回（钉住动态 import 的相对路径与签名）

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeModelsHook } from "../src/hooks/models.mjs"
import { availableModels } from "../src/models.mjs"

const SESSION = "s".repeat(32)
const DS41 = "DeepSeek-V4.1-Flash"
const ALIAS = "deepseek-v4-flash-1017"
const UID = "260911173523492332"
const ACCOUNT_ID = "150****3411"
const OTHER_UID = "260911173523499999"
const CLEAN_UID = "260911173523488888"

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
/** session 已过期（上游 `/models` 401 或 `{"code":"100002"}`）。 */
const EXPIRED = entry("expired", { servedModel: "", reason: "session-expired" })
/** 团队积分余额不足（上游 402）。 */
const EXHAUSTED = entry("exhausted", { servedModel: "", reason: "no-quota" })

/** 假上游目录：DS4.1、它的异名兄弟，外加两个无关模型。 */
function fakeCatalog() {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: DS41, name: "DeepSeek V4.1 Flash(x2.0)", context_window: 1000, max_output_tokens: 100 },
          { id: ALIAS, name: "DeepSeek V4 Flash 1017(x2.0)", context_window: 1000, max_output_tokens: 100 },
          { id: "GLM-5.3-Flash", name: "GLM Flash（x0.8）", context_window: 2000, max_output_tokens: 200 },
          { id: "spark-x2.6", name: "Spark" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
}

function modelsWith({ state, fetchImpl = fakeCatalog(), routeStore, auth: authOverride, configDir = "D:/cfg", log = { warn() {} } }) {
  const hook = makeModelsHook({
    baseUrl: "https://loomyad.xunfei.cn/api/v1",
    configDir,
    // 与 loader 的测试同口径：不显式注入时用桩（`state` 即判定表）
    routeStore: routeStore === undefined ? stubStore(state ?? {}) : routeStore,
    fetchImpl,
    log,
  })
  const auth = authOverride ?? { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }
  return hook({ models: {} }, { auth })
}

// ── routed → 空目录 ────────────────────────────────────────────────────

test("routed 账号：目录是空的（一个模型都不给，magpie 就不会把请求派过来）", async () => {
  const out = await modelsWith({ state: { [UID]: ROUTED } })
  assert.deepEqual(out, {}, `被限制的号不该有任何模型，实际: ${Object.keys(out).join(",")}`)
  assert.equal(Object.keys(out).length, 0)
})

test("clean 账号：拿到原来的实时目录（含 DS4.1 与别名）", async () => {
  const out = await modelsWith({ state: { [UID]: CLEAN } })
  assert.equal(Object.keys(out).length, 4)
  for (const id of [DS41, ALIAS, "GLM-5.3-Flash", "spark-x2.6"]) assert.ok(out[id], `${id} 应在`)
})

test("unknown 判定：照常返回目录（没探到 ≠ 被限制，不能误伤）", async () => {
  const out = await modelsWith({ state: { [UID]: entry("unknown") } })
  assert.equal(Object.keys(out).length, 4)
  assert.ok(out[DS41])
})

// ── expired（登录失效）同样是空目录 ────────────────────────────────────

test("expired 账号：目录也是空的（session 过期 ⇒ 一个请求都不该再发过去）", async () => {
  const out = await modelsWith({ state: { [UID]: EXPIRED } })
  assert.deepEqual(out, {}, `登录失效的号不该有模型，实际: ${Object.keys(out).join(",")}`)
})

// ── exhausted（积分不足）同样不派活 ────────────────────────────────────

test("exhausted 账号：目录是空的（402 余额不足，发过去只会再 402）", async () => {
  const out = await modelsWith({ state: { [UID]: EXHAUSTED } })
  assert.deepEqual(out, {}, `积分不足的号不该有模型，实际: ${Object.keys(out).join(",")}`)
})

test("exhausted 与 clean 同 provider 并存：只有 exhausted 那个空", async () => {
  const hook = makeModelsHook({
    baseUrl: "https://loomyad.xunfei.cn/api/v1",
    configDir: "D:/cfg",
    routeStore: stubStore({ [UID]: EXHAUSTED, [CLEAN_UID]: CLEAN }),
    fetchImpl: fakeCatalog(),
    log: { warn() {} },
  })
  const auth = (id) => ({ type: "oauth", access: SESSION, accountId: `${id}-显示名`, uid: id })

  assert.deepEqual(await hook({ models: {} }, { auth: auth(UID) }), {})
  assert.equal(Object.keys(await hook({ models: {} }, { auth: auth(CLEAN_UID) })).length, 4)
})

test("routed 与 expired 两个号同时存在：两个都空，clean 仍满目录", async () => {
  const hook = makeModelsHook({
    baseUrl: "https://loomyad.xunfei.cn/api/v1",
    configDir: "D:/cfg",
    routeStore: stubStore({ [UID]: ROUTED, [OTHER_UID]: EXPIRED, [CLEAN_UID]: CLEAN }),
    fetchImpl: fakeCatalog(),
    log: { warn() {} },
  })
  const auth = (id) => ({ type: "oauth", access: SESSION, accountId: `${id}-显示名`, uid: id })

  assert.deepEqual(await hook({ models: {} }, { auth: auth(UID) }), {})
  assert.deepEqual(await hook({ models: {} }, { auth: auth(OTHER_UID) }), {})
  assert.equal(Object.keys(await hook({ models: {} }, { auth: auth(CLEAN_UID) })).length, 4)
})

test("同一个钩子两个账号：只有 routed 那个是空目录，另一个照旧", async () => {
  const hook = makeModelsHook({
    baseUrl: "https://loomyad.xunfei.cn/api/v1",
    configDir: "D:/cfg",
    routeStore: stubStore({ [UID]: ROUTED }),
    fetchImpl: fakeCatalog(),
    log: { warn() {} },
  })
  const routed = await hook({ models: {} }, { auth: { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID } })
  const clean = await hook({ models: {} }, { auth: { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: OTHER_UID } })

  assert.equal(Object.keys(routed).length, 0)
  assert.equal(Object.keys(clean).length, 4)
})

test("route-store 模块缺失 / 没有 configDir / 没有任何键 → 目录不受影响、不报错", async () => {
  const baseline = Object.keys(await modelsWith({ state: { [UID]: CLEAN } })).sort()
  const missing = Object.keys(await modelsWith({ routeStore: null })).sort()
  const noDir = Object.keys(await modelsWith({ state: { [UID]: ROUTED }, configDir: "" })).sort()
  const noKeys = Object.keys(await modelsWith({ state: { [UID]: ROUTED }, auth: { type: "oauth", access: SESSION } })).sort()

  assert.deepEqual(missing, baseline)
  assert.deepEqual(noDir, baseline, "没有 configDir 就没有判定 ⇒ 给正常目录")
  assert.deepEqual(noKeys, baseline)
})

test("静态兜底表本身不被判定污染（别的账号还要用它冷启动）", async () => {
  await modelsWith({ state: { [UID]: ROUTED } })
  assert.ok(availableModels().some((m) => m.id === DS41))
})

// ── 集成：走**真** src/route-store.mjs（不注入桩）─────────────────────

test("真 route-store（不注入桩）：routed → {}；clean → 满目录", async (t) => {
  const store = await import("../src/route-store.mjs")
  const dir = mkdtempSync(join(tmpdir(), "loomy-models-real-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const hook = makeModelsHook({ baseUrl: "https://loomyad.xunfei.cn/api/v1", configDir: dir, fetchImpl: fakeCatalog(), log: { warn() {} } })
  const auth = { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }

  // 先 clean
  store.writeRouteState(dir, UID, CLEAN)
  const clean = await hook({ models: {} }, { auth })
  assert.equal(Object.keys(clean).length, 4)

  // 再 routed
  store.writeRouteState(dir, UID, ROUTED)
  const routed = await hook({ models: {} }, { auth })
  assert.deepEqual(routed, {})
})