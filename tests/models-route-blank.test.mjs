// models-route-blank.test.mjs 「置空优先于缓存」—— T-44 的核心回归。
//
// # 真机现场（交叉分析 `provider-accounts` × `loomy-route-state.json`）
//
//	clean      有模型    71    ← 真正可用
//	routed     有模型   210    ← 问题：被判上游改路由，但模型列表仍非空
//	expired    无模型    19    ← 已正确置空
//	exhausted  无模型     1    ← 已正确置空
//
// `usage` 里 routed 号确实发了「停用 · 上游改路由」（`used:100`），但
// `provider.models` 不再读 route-state 来置空模型列表 ⇒ 面板显示 281 个可用号，
// 而实际健康号只有 71。
//
// 用户已拍板：**策略 A —— routed 号彻底不派活（模型列表置空）**。
//
// # 为什么单开一个文件
//
// `tests/models-hook-route.test.mjs` 钉的是「判定读到了就置空」，
// 但它的用例全部走**无缓存**路径（每个 hook 一个新的 configDir / 空缓存）。
// 真机的顺序问题恰恰在缓存之后：一旦 `loomy-models-cache.json` 里已经有一份
// 9 个模型的目录，`catalogOnce` 命中缓存就**直接返回**，判定那段若写在它后面
// 就永远轮不到 —— 这就是 T-38 删 by-turn 时被一并删掉的那一段。
//
// 本文件钉住（+6）：
//
//	1. routed 号 → `provider.models` 返回 `{}`
//	2. **routed 号即使有缓存也返回 `{}`**（核心回归）
//	3. `routecheck: false` 时 routed 号正常返回模型（开关真的生效）
//	4. expired 号 → `{}`（回归）
//	5. exhausted 号 → `{}`（回归）
//	6. clean 号 → 正常返回模型（不能误伤）
//
// ⚠ 网络：`network-guard` 下跑；需要上游响应的用例自己注 `fetchImpl`。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeModelsHook, resetCatalogInflight, resetModelsWarned } from "../src/hooks/models.mjs"
import { readCachedModels, writeModelsCache } from "../src/models-cache.mjs"

const BASE = "https://loomyad.xunfei.cn/api/v1"
const SESSION = "s".repeat(32)
const DS41 = "DeepSeek-V4.1-Flash"
const UID = "260911173523492332"
const ACCOUNT_ID = "150****3411"

/** 判定条目（契约同 `src/route-store.mjs` 的落盘形状）。 */
const entry = (verdict, extra = {}) => ({
  verdict,
  servedModel: verdict === "routed" ? "spark-x2.6-low" : verdict === "clean" ? DS41 : "",
  requested: DS41,
  checkedAt: "2026-11-19T00:00:00.000Z",
  ...extra,
})
const ROUTED = entry("routed")
const CLEAN = entry("clean")
const EXPIRED = entry("expired", { reason: "session-expired" })
const EXHAUSTED = entry("exhausted", { reason: "no-quota" })

/** route-store 桩（契约同 `src/route-store.mjs`，仅测试可见）。 */
function stubStore(state) {
  return {
    routeStatePath: () => "(stub)",
    readRouteState: () => ({ ok: true, data: state, error: "" }),
    writeRouteState() {},
    getAccountRoute: (_dir, uid) => (uid in state ? state[uid] : null),
    DS41_MODEL_ID: DS41,
  }
}

/** 假上游目录：9 个模型（真机缓存里那一份的形状）。 */
const CACHE_LIST = Array.from({ length: 9 }, (_, i) => ({
  id: i === 0 ? DS41 : `model-${i}`,
  name: i === 0 ? "DeepSeek V4.1 Flash(x2.0)" : `Model ${i}`,
  context_window: 1000,
  max_output_tokens: 100,
}))

/** 计数的假上游：被调用即说明「判定没拦住」。 */
function countingCatalog() {
  const stats = { calls: 0 }
  const fetchImpl = async () => {
    stats.calls += 1
    return Response.json({ code: "000000", data: CACHE_LIST })
  }
  return { stats, fetchImpl }
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-blank-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 跑一次 `provider.models`。
 *
 * @param {{state?: Record<string, any>, dir: string, routeCheck?: boolean,
 *   cache?: boolean, fetchImpl?: typeof fetch, logs?: string[]}} args
 */
async function modelsFor(args) {
  resetCatalogInflight()
  resetModelsWarned()
  if (args.cache !== false) writeModelsCache(args.dir, BASE, CACHE_LIST.slice())
  const up = countingCatalog()
  const hook = makeModelsHook({
    baseUrl: BASE,
    configDir: args.dir,
    routeStore: stubStore(args.state ?? {}),
    fetchImpl: args.fetchImpl ?? up.fetchImpl,
    log: { warn: (m) => args.logs?.push(String(m)) },
    ...(args.routeCheck === undefined ? {} : { routeCheck: args.routeCheck }),
  })
  const out = await hook({ models: {} }, { auth: { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID } })
  return { out, upstreamCalls: up.stats.calls }
}

const ids = (out) => Object.keys(out).sort()

// ── 1. routed → 空目录 ─────────────────────────────────────────────────

test("T44-1) routed 号：`provider.models` 返回 `{}`（一个模型都不给 = 不派活）", async (t) => {
  const { out } = await modelsFor({ dir: tempDir(t), state: { [UID]: ROUTED } })
  assert.deepEqual(out, {}, `被上游改路由的号不该有模型，实际: ${ids(out).join(",")}`)
})

// ── 2. 核心回归：缓存不能把置空填回来 ─────────────────────────────────

test("T44-2) routed 号**即使有缓存**也返回 `{}`（置空优先于缓存 —— 本次核心回归）", async (t) => {
  const dir = tempDir(t)
  const logs = []
  // ① 冷启动：判定还没写（空表）⇒ 真拉一次上游 ⇒ 缓存落盘
  const cold = await modelsFor({ dir, state: {}, cache: false, logs })
  assert.equal(ids(cold.out).length, 9, "前置条件：冷启动要拿到上游那 9 个模型")
  assert.equal(cold.upstreamCalls, 1, "前置条件：冷启动必须打一次上游")
  assert.ok(readCachedModels(dir, BASE), "前置条件：拉成功后缓存必须真的落盘（模拟真机那份 9 模型缓存）")

  // ② 探测出 routed，缓存**原封不动**留着
  const hit = await modelsFor({ dir, state: { [UID]: ROUTED }, cache: false, logs })
  assert.deepEqual(hit.out, {}, `缓存里的 9 个模型不许把它填回来，实际: ${ids(hit.out).join(",")}`)
  assert.equal(hit.upstreamCalls, 0, "置空是本地判定，不该为它打上游")
  assert.ok(
    logs.some((m) => m.includes("置空") && m.includes("spark-x2.6-low")),
    `置空要留一行日志并写明实际服务的模型，实际日志: ${JSON.stringify(logs)}`,
  )
})

// ── 3. 开关真的生效 ───────────────────────────────────────────────────

test("T44-3) `routecheck: false`：routed 号照常拿到模型（开关关掉 = 继续派活）", async (t) => {
  const dir = tempDir(t)
  const logs = []
  const { out, upstreamCalls } = await modelsFor({ dir, state: { [UID]: ROUTED }, routeCheck: false, logs })
  assert.equal(ids(out).length, 9, `关掉开关后必须照常返回目录，实际: ${ids(out).join(",")}`)
  assert.ok(out[DS41], "目录里要有上游给的模型")
  assert.equal(upstreamCalls, 0, "命中缓存 ⇒ 零上游")
  assert.ok(
    logs.some((m) => m.includes("routecheck")),
    `开关关掉时仍要留一句说明（否则「号还是被换模型」查不出线索），实际日志: ${JSON.stringify(logs)}`,
  )
})

// ── 4/5. expired / exhausted 回归 ────────────────────────────────────

test("T44-4) expired 号 → `{}`（回归：session 过期不派活）", async (t) => {
  const { out } = await modelsFor({ dir: tempDir(t), state: { [UID]: EXPIRED } })
  assert.deepEqual(out, {}, `登录失效的号不该有模型，实际: ${ids(out).join(",")}`)
})

test("T44-5) exhausted 号 → `{}`（回归：402 余额不足不派活）", async (t) => {
  const { out } = await modelsFor({ dir: tempDir(t), state: { [UID]: EXHAUSTED } })
  assert.deepEqual(out, {}, `积分不足的号不该有模型，实际: ${ids(out).join(",")}`)
})

// ── 6. 不能误伤 clean ────────────────────────────────────────────────

test("T44-6) clean 号 → 正常返回模型（不能误伤健康号）", async (t) => {
  const dir = tempDir(t)
  const logs = []
  const { out } = await modelsFor({ dir, state: { [UID]: CLEAN }, logs })
  assert.equal(ids(out).length, 9, `健康号必须有目录，实际: ${ids(out).join(",")}`)
  assert.ok(out[DS41], "健康号要拿到 DS4.1")
  assert.equal(logs.length, 0, `健康号不该产生置空日志，实际: ${JSON.stringify(logs)}`)
})