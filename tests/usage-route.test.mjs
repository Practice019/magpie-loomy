// usage-route.test.mjs 额度卡片上的**纯展示**说明：这个号为什么不能用。
//
// # 为什么不再伪造 100% 额度（真机事故后改的）
//
// 上一版给 routed 账号插一条 `used:100` 的全局窗口，想借助路由的额度排序
// 让 magpie 别选它。代价是卡片上显示「剩余 0」，用户以为这个号没额度了；
// 而真正「别选我」的表达已经改由 `provider.models` 返回空目录承担
// （目录空 ⇒ 这个号没有该模型 ⇒ 路由天生不派活，且**不产生任何错误**）。
//
// 所以这里只留一条 `aside: true` 的说明窗：`aside` 会被 `allowanceOf`
// 整条跳过（不参与路由排序），`display` 把原因写给用户看。
//
// 本文件钉住：
//	① routed → 出现 `{aside:true, display 含 servedModel}` 的窗口
//	② **不存在** `used === 100` 的窗口（不许伪造满额）
//	③ 原额度窗口一个不少、不被改写
//	④ 顶层无 `error`（AGENTS.md 坑 #17）
//	⑤ clean / unknown / 无判定 / 模块缺失 → 一条窗口都不多加

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeUsageHook } from "../src/hooks/usage.mjs"

const SESSION = "s".repeat(32)
const DS41 = "DeepSeek-V4.1-Flash"
/** 身份（状态文件按它落盘）。 */
const UID = "260911173523492332"
/** 显示名（打码手机号）—— 与 UID 不相等，这是真机凭证的实际形状。 */
const ACCOUNT_ID = "150****3411"

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
/** session 已过期（上游 `/models` 401 / `{"code":"100002"}`）。 */
const EXPIRED = entry("expired", { servedModel: "", reason: "session-expired" })
/** 团队积分余额不足（上游 402）。 */
const EXHAUSTED = entry("exhausted", { servedModel: "", reason: "no-quota" })

/** 假的积分网关，可指定账本数据。 */
function pointsReturning(data) {
  return async () =>
    new Response(JSON.stringify({ code: "000000", desc: "ok", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
}

/** 假积分网关：三个账本齐全。 */
function fakePoints() {
  return pointsReturning({ balance: 25000, dailyBalance: 1434, availableBalance: 26434 })
}

function usageWith({ state, fetchImpl = fakePoints(), routeStore, clientStoreDir, auth = { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }, log = { warn() {} } }) {
  const hook = makeUsageHook({
    baseUrl: "https://loomyad.xunfei.cn/api/v1",
    configDir: "D:/cfg",
    routeStore: routeStore === undefined ? stubStore(state ?? {}) : routeStore,
    fetchImpl,
    clientStoreDir,
    log,
  })
  return hook(async () => auth)
}

/**
 * 同一个 hook 实例调用**两次**，返回第二次的产出。
 *
 * 「判定变化 ⇒ signIn:"kept"」的发光只在**进程首次**给某个号出结论时发生
 * （见 usage.mjs 的说明）。所以本文件里有「不许出现 signIn」的断言一律取
 * **稳态**那一次 —— 首发的 kept 是给宿主的重读信号，不是本文件要验的语义。
 *
 * @param {{...}} args usageWith 的参数
 * @returns {Promise<any>} 第二次调用的产出
 */
async function usageSteady(args) {
  const hook = makeUsageHook({
    baseUrl: "https://loomyad.xunfei.cn/api/v1",
    configDir: "D:/cfg",
    routeStore: args.routeStore === undefined ? stubStore(args.state ?? {}) : args.routeStore,
    fetchImpl: args.fetchImpl ?? fakePoints(),
    clientStoreDir: args.clientStoreDir,
    log: args.log ?? { warn() {} },
  })
  const auth = args.auth ?? { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }
  const call = () => hook(async () => auth)
  await call()
  return call()
}

/**
 * 造一个**真实存在**的本机客户端缓存目录（leveldb 形态的最小文件）。
 *
 * 用途：证明「登录失效时**不**回落缓存」—— 缓存明明读得到，也不许用它。
 */
function cacheDirWithPoints(t) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-cache-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const wire = JSON.stringify({ balance: 5500, dailyBalance: 4950, updatedAt: "2026-11-19T01:00:00.000Z" })
  writeFileSync(join(dir, "000001.log"), `loomy-points-summary\x01${wire}`)
  return dir
}

/** 判据：那条「只说明原因、不参与路由」的窗口（名字固定为 `说明 · 上游限制`）。 */
function reasonWindow(windows) {
  return (windows ?? []).find((w) => w?.aside === true && String(w?.name ?? "").startsWith("说明 · 上游限制"))
}

/** 判据：登录失效的说明窗（`说明 · 登录失效`）。 */
function expiredWindow(windows) {
  return (windows ?? []).find((w) => w?.aside === true && String(w?.name ?? "").startsWith("说明 · 登录失效"))
}

test("routed 账号：出现 aside 的说明窗，且写清实际由谁服务", async () => {
  const u = await usageWith({ state: { [UID]: ROUTED } })

  const reason = reasonWindow(u.windows)
  assert.ok(reason, `缺少说明窗口，实际: ${JSON.stringify(u.windows)}`)
  assert.equal(reason.aside, true, "aside 才会被 allowanceOf 跳过、不参与路由排序")
  // T-37：模型名会变，window name 里禁带易变数据 —— 名字固定，模型名只进 display
  assert.equal(String(reason.name), "说明 · 上游限制", "名字里不许带模型名")
  assert.match(String(reason.display), /spark-x2\.6-low/, "模型名只出现在 display")
})

// ⚠ 第十九轮：routed 现在**故意**有一条 used:100 的停派窗（那不是「伪造额度」，
// 而是「立刻停派」的表达）。这里改为钉真正该守的语义：**真实额度窗不许被伪造**。
test("routed：不伪造「积分耗尽」额度窗；真实额度窗仍是真实值", async () => {
  const u = await usageWith({ state: { [UID]: ROUTED } })
  const fakeBroke = (u.windows ?? []).filter((w) => w?.used === 100 && String(w?.name ?? "").includes("积分耗尽"))
  assert.deepEqual(fakeBroke, [], "余额明明有值，不许报「积分不足」")
  assert.equal(reasonWindow(u.windows)?.used, undefined, "说明窗本身不参与路由")

  const daily = u.windows.find((w) => String(w.name).startsWith("额度 · 每日赠送"))
  assert.notEqual(daily.used, 100, "真实额度窗保留真实值，不许被改成 100")
})

test("顶层无 error，原额度窗口一个不少且不被改写", async () => {
  const u = await usageWith({ state: { [UID]: ROUTED } })

  assert.equal(u.error, undefined, "路由状态是附加信息，不是错误")
  assert.equal(u.windows.length, 5, "3 个原窗口 + 1 条停派满额窗 + 1 条说明窗")
  for (const name of ["额度 · 每日赠送", "说明 · 永久积分", "说明 · 可用总额"]) {
    assert.ok(u.windows.some((w) => String(w.name).startsWith(name)), `${name} 不能消失`)
  }
  const daily = u.windows.find((w) => String(w.name).startsWith("额度 · 每日赠送"))
  assert.equal(typeof daily.used, "number")
  assert.equal(daily.aside, undefined, "原窗口不许被改成 aside")
})

test("停派满额窗排最前，说明窗紧随其后（用户先看到「这个号不能用」）", async () => {
  const u = await usageWith({ state: { [UID]: ROUTED } })
  assert.equal(u.windows[0].used, 100)
  assert.match(String(u.windows[0].name), /上游改路由/)
  assert.equal(u.windows[1], reasonWindow([u.windows[1]]))
})

test("clean / unknown / 无判定 / 模块缺失：一条窗口都不多加", async () => {
  for (const args of [{ state: { [UID]: CLEAN } }, { state: { [UID]: entry("unknown") } }, { state: {} }, { routeStore: null }]) {
    const u = await usageWith(args)
    assert.equal(u.error, undefined)
    assert.equal(u.windows.length, 3, `不该多窗口: ${JSON.stringify(args)}`)
    assert.equal(reasonWindow(u.windows), undefined)
  }
})

// ── expired（登录失效）：原生 signIn 字段 ──────────────────────────────
//
// magpie 的 `internal/provider/plugin_usage.go` 认 `signIn: "expired"`，
// 会用它给账号打「登录已失效」的标记（notePluginLapseSince(401)）。
// ⚠ 这个字段**只能**在真的 expired 时写：写在好号身上等于把它标成过期。

test("expired 账号：返回 signIn === \"expired\"，并附一条 aside 说明窗", async () => {
  const u = await usageWith({ state: { [UID]: EXPIRED } })

  assert.equal(u.signIn, "expired", "magpie 的原生字段：账号应显示「登录已失效」")
  assert.equal(u.error, undefined, "别用 error 顶掉额度区")
  const reason = expiredWindow(u.windows)
  assert.ok(reason, `缺少登录失效说明窗，实际: ${JSON.stringify(u.windows)}`)
  assert.equal(String(reason.name), "说明 · 登录失效", "T-31 命名规范")
  assert.match(String(reason.display), /重新登录/)
  assert.equal(reason.used, undefined, "说明窗不参与路由排序")
})

test("expired：原额度窗口仍然一个不少（别因为登录失效把数据藏了）", async () => {
  const u = await usageWith({ state: { [UID]: EXPIRED } })
  assert.equal(u.windows.length, 4)
  for (const name of ["额度 · 每日赠送", "说明 · 永久积分", "说明 · 可用总额"]) {
    assert.ok(u.windows.some((w) => String(w.name).startsWith(name)), `${name} 不能消失`)
  }
})

test("routed 账号**不能**带 signIn：需要重新登录（expired），不是「缓存失效」（kept）", async () => {
  // 稳态：首发会有一次 kept（判定变化的信号），之后不该再带
  const u = await usageSteady({ state: { [UID]: ROUTED } })
  assert.equal(u.signIn, undefined)
  assert.ok(reasonWindow(u.windows), "routed 仍然要有它自己的说明窗")
})

test("clean / unknown / 无判定：稳态都不许出现 signIn", async () => {
  for (const args of [{ state: { [UID]: CLEAN } }, { state: { [UID]: entry("unknown") } }, { state: {} }, { routeStore: null }]) {
    const u = await usageSteady(args)
    assert.equal(u.signIn, undefined, `不该标过期: ${JSON.stringify(args)}`)
  }
})

// ── routed 立刻停派：满额窗 + 说明窗并存 ────────────────────────────────
//
// 真机痛点：`provider.models` 是列表缓存 —— 判定翻成 routed 之后，要等下一次
// 重拉列表才不派活，中间仍会继续把请求给它。`auth.usage` 是**每次读都生效**的，
// 所以在 routed 时补一条**可计入路由**的满额窗，下一次 usage 就跳过它。

/** 判据：「上游改路由」那条可计入路由的满额窗。 */
function routedStopWindow(windows) {
  return (windows ?? []).find(
    (w) =>
      w?.used === 100 &&
      w?.aside !== true &&
      w?.limit === undefined &&
      w?.amount === undefined &&
      String(w?.name ?? "").includes("上游改路由"),
  )
}

test("routed：既有 aside 说明窗，又有「上游改路由」满额窗（立刻停派）", async () => {
  const u = await usageSteady({ state: { [UID]: ROUTED } })

  const stop = routedStopWindow(u.windows)
  assert.ok(stop, `缺「上游改路由」满额窗，实际: ${JSON.stringify(u.windows)}`)
  assert.equal(stop.used, 100, "满额才会被路由跳过")
  assert.equal(stop.aside, undefined, "aside 会被 allowanceOf 整条跳过 —— 那就白报了")
  assert.equal(stop.limit, undefined)
  assert.equal(stop.amount, undefined)
  assert.match(String(stop.display), /spark-x2\.6-low/, "写清实际由谁服务")

  assert.ok(reasonWindow(u.windows), "aside 说明窗要保留（卡片上解释原因）")
})

test("clean：不出现「上游改路由」满额窗", async () => {
  const u = await usageSteady({ state: { [UID]: CLEAN } })
  assert.equal(routedStopWindow(u.windows), undefined)
})

test("exhausted 与 routed 互斥：只出现「积分耗尽」停用窗", async () => {
  const u = await usageSteady({ state: { [UID]: EXHAUSTED } })
  assert.equal(routedStopWindow(u.windows), undefined, "exhausted 不该报「上游改路由」")

  const broke = (u.windows ?? []).filter((w) => w?.used === 100 && String(w?.name ?? "").includes("积分耗尽"))
  assert.equal(broke.length, 1)
})

test("routed：原额度窗口内容不被改写，顶层无 error", async () => {
  const u = await usageSteady({ state: { [UID]: ROUTED } })

  assert.equal(u.error, undefined)
  const daily = u.windows.find((w) => String(w.name).startsWith("额度 · 每日赠送"))
  assert.equal(typeof daily.used, "number")
  assert.equal(daily.used, 71.32, "原窗口的 used 必须还是真实值")
  assert.ok(u.windows.some((w) => String(w.name).startsWith("说明 · 永久积分")))
  assert.ok(u.windows.some((w) => String(w.name).startsWith("说明 · 可用总额")))
})

// ── exhausted（积分不足）：只说明原因，不碰登录态 ──────────────────────

test("exhausted 账号：有 aside 说明窗、**没有** signIn、没有 error", async () => {
  const u = await usageSteady({ state: { [UID]: EXHAUSTED } })

  // ⚠ 用户给定的映射表要求 exhaust 出 **停用 · 积分耗尽**（`used:100`）+ **说明 · 余额为零**（aside）。
  //    这里只钉「有一条 aside 的说明窗」这一语义 —— 它叫什么不重要，重要的是它**不参与路由**。
  const reason = (u.windows ?? []).find(
    (w) => w?.aside === true && String(w?.name ?? "").startsWith("说明 · "),
  )
  assert.ok(reason, `缺少 aside 说明窗，实际: ${JSON.stringify(u.windows)}`)
  assert.equal(u.windows.length, 5, "3 个额度窗 + 1 条停用窗 + 1 条说明窗")
  assert.match(String(reason.display), /充值/)
  assert.equal(reason.used, undefined, "说明窗不参与路由排序")
  assert.equal(u.signIn, undefined, "余额不足不是登录问题：带 signIn 会把号误标成需要重登")
  assert.equal(u.error, undefined)
})

test("exhausted：原额度窗口仍然一个不少（余额数据本身要照常展示）", async () => {
  const u = await usageWith({ state: { [UID]: EXHAUSTED } })
  assert.equal(u.windows.length, 5, "3 个原窗口 + 1 条路由满额 + 1 条 aside 说明")
  for (const name of ["额度 · 每日赠送", "说明 · 永久积分", "说明 · 可用总额"]) {
    assert.ok(u.windows.some((w) => String(w.name).startsWith(name)), `${name} 不能消失`)
  }
})

// ── 余额为 0 必须 **自己** 报满额（路由跳过的唯一依据是 windows[].used）──
//
// 真机：账号 402「团队积分余额不足」，magpie 的 quotas.json 里 windows=null，
// 路由把「没有任何额度窗口的号」当成可用 → 派活 → 402 → 换号 → 又慢又乱。
// 所以这一条**不依赖状态文件**：只要余额是 0，就必须报一条可计入路由的满额窗。

/** 「可计入路由的满额窗口」判据：used=100 且不带 aside / limit / amount。 */
function fullWindow(windows) {
  return (windows ?? []).find(
    (w) =>
      w?.used === 100 &&
      w?.aside !== true &&
      w?.limit === undefined &&
      w?.amount === undefined &&
      String(w?.name ?? "").includes("积分耗尽"),
  )
}

test("availableBalance: 0 → 出现「停用 · 积分耗尽」窗（used=100，非 aside）", async () => {
  /** @type {string[]} */
  const logs = []
  const u = await usageWith({
    fetchImpl: pointsReturning({ balance: 0, dailyBalance: 0, availableBalance: 0 }),
    log: { warn: (m) => logs.push(String(m)) },
  })

  const full = fullWindow(u.windows)
  assert.ok(full, `缺满额窗口，实际: ${JSON.stringify(u.windows)}`)
  assert.equal(full.used, 100)
  assert.equal(full.aside, undefined, "aside 会被 allowanceOf 跳过 —— 那等于没报")
  assert.equal(full.limit, undefined, "limit/amount 会被 magpie 反算占比，可能又变成满额剩余")
  assert.match(String(full.display), /充值/)
  assert.ok(
    logs.some((m) => m.includes("余额为 0") && m.includes("路由将跳过")),
    `排障要能看到「余额为 0 已报满额」，实际: ${logs.join(" | ")}`,
  )
})

test("余额为 0 且状态文件里**没有判定** → 仍然报满额（不依赖 patrol）", async () => {
  const u = await usageWith({
    state: {},
    fetchImpl: pointsReturning({ balance: 0, dailyBalance: 0, availableBalance: 0 }),
  })
  assert.ok(fullWindow(u.windows), "patrol 还没跑过也必须拦住")
})

test("availableBalance: 34900 → 不出现「停用 · 积分耗尽」窗口", async () => {
  const u = await usageWith({
    fetchImpl: pointsReturning({ balance: 20000, dailyBalance: 14900, availableBalance: 34900 }),
  })
  assert.equal(fullWindow(u.windows), undefined)
  assert.ok(!u.windows.some((w) => String(w.name).includes("积分耗尽")))
})

test("verdict === exhausted → 满额窗出现且**只有一条**（与余额判断合并不重复）", async () => {
  // 这条同时具备两个触发条件：状态文件判 exhausted + 余额为 0
  const u = await usageWith({
    state: { [UID]: EXHAUSTED },
    fetchImpl: pointsReturning({ balance: 0, dailyBalance: 0, availableBalance: 0 }),
  })

  // ⚠ 只数「积分不足」那条：余额为 0 时「每日赠送」本来就是 used=100（真实数据），
  // 那不是重复的停用窗口。
  const full = (u.windows ?? []).filter((w) => w?.used === 100 && String(w?.name ?? "").includes("积分耗尽"))
  assert.equal(full.length, 1, `不能出现两条满额窗，实际: ${JSON.stringify(u.windows)}`)
  assert.match(String(full[0].name), /积分耗尽/)
})

test("没有 availableBalance，但 balance=0 且 dailyBalance=0 → 也判为无额度", async () => {
  const u = await usageWith({ fetchImpl: pointsReturning({ balance: 0, dailyBalance: 0 }) })
  assert.ok(fullWindow(u.windows), `缺满额窗口，实际: ${JSON.stringify(u.windows)}`)
})

test("凭证里没有任何键 → 不加说明窗（无判定 = 无行为）", async () => {
  const u = await usageWith({ state: { [UID]: ROUTED }, auth: { type: "oauth", access: SESSION } })
  assert.equal(u.windows.length, 3)
  assert.equal(reasonWindow(u.windows), undefined)
})

test("键一致性：状态按 uid 落盘、凭证里 accountId 也在 → 说明窗必须出现", async () => {
  const u = await usageWith({ state: { [UID]: ROUTED } })
  assert.ok(reasonWindow(u.windows), `按显示名查会漏，实际: ${JSON.stringify(u.windows)}`)
})

test("连额度都查不到时，路由状态不许把 error 顶掉", async () => {
  const bad = async () => new Response("boom", { status: 502 })
  const hook = makeUsageHook({
    baseUrl: "https://loomyad.xunfei.cn/api/v1",
    configDir: "D:/cfg",
    routeStore: stubStore({ [UID]: ROUTED }),
    fetchImpl: bad,
    clientStoreDir: "D:/definitely-not-a-real-dir-xyz",
    log: { warn() {} },
  })
  const u = await hook(async () => ({ type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }))

  assert.ok(typeof u.error === "string" && u.error.length > 0, "查不到额度时该如实说查不到")
  assert.ok(!u.error.includes("spark"), "路由状态不能占用 error 位")
})

// ── 积分网关自己说「登录失效」：100002 / 100003 ────────────────────────
//
// 来自 magpie 运行日志的真实证据：
//	[loomy] 积分网关查额度失败，尝试本机缓存: GET /points/records 返回 100003
//	[loomy] …                                    GET /points/records 返回 100002: 登录已失效
//
// 这类失败过去被当成普通错误 → 回落本机缓存 → 返回一份**正常的旧额度** →
// magpie 以为这个号还活着（「27 个可用」里就有它们），UI 上也看不出异常。
// 所以错误码本身就是判据，不必等探测结果。

function gatewayCode(code, desc) {
  return async () =>
    new Response(JSON.stringify({ code, desc }), { status: 200, headers: { "content-type": "application/json" } })
}

test("积分网关返回 100002（登录已失效）→ signIn:expired，且**不**回落本机缓存", async (t) => {
  const cache = cacheDirWithPoints(t)
  const u = await usageWith({ fetchImpl: gatewayCode("100002", "登录已失效"), clientStoreDir: cache })

  assert.equal(u.signIn, "expired", "必须标成需要重新登录")
  assert.match(String(u.error), /登录/)
  assert.deepEqual(u.windows, [], "登录失效时「只剩一句话」才是正确表达，不能捧出旧额度")
  assert.ok(!JSON.stringify(u).includes("缓存"), "缓存明明读得到，也不许用它")
})

test("积分网关返回 100003 → 同样 signIn:expired，不回落缓存", async (t) => {
  const cache = cacheDirWithPoints(t)
  const u = await usageWith({ fetchImpl: gatewayCode("100003", "session 无效"), clientStoreDir: cache })

  assert.equal(u.signIn, "expired")
  assert.deepEqual(u.windows, [])
  assert.ok(!JSON.stringify(u).includes("缓存"))
})

test("网络错误（ECONNRESET）→ 仍回落本机缓存，且**不**标 expired（别把网络问题当登录问题）", async (t) => {
  const cache = cacheDirWithPoints(t)
  const boom = async () => {
    throw new Error("ECONNRESET")
  }
  const u = await usageWith({ fetchImpl: boom, clientStoreDir: cache })

  assert.equal(u.signIn, undefined, "网络抖动不等于登录失效：标错会把健康号打成「需要重登」")
  assert.ok(Array.isArray(u.windows) && u.windows.length > 0, "缓存可用就该给窗口")
  // T-31：新鲜度进 **display**，不进 name（名字里带时间戳会让卡片每次刷新都「改名」）
  assert.ok(u.windows.some((w) => String(w.display).includes("缓存于")), "缓存数据要标明可能过期")
  assert.ok(u.windows.every((w) => !String(w.name).includes("缓存")), `窗口名不许带缓存标记: ${JSON.stringify(u.windows.map((w) => w.name))}`)
})

// ── T-31：窗口命名一致性（跨插件统一）────────────────────────────────────
//
// 规范 `magpie-plugins/UNIFIED-PLAN.md` §1.1：**每一个**窗口名都必须以三个前缀之一
// 开头 —— `额度 · ` / `停用 · ` / `说明 · `。这样用户一眼就能分出「哪条会影响路由」：
//
//	额度 · …  参与路由
//	停用 · …  `used:100` ⇒ 路由跳过该号（**唯一**手段，绝不能被改成 aside）
//	说明 · …  `aside:true` ⇒ 只解释，不参与路由
//
// 这里是**一致性**测试：把所有可独立触发的状态都跑一遍，把产出窗口的名字全收起来，
// 逐条查前缀。它不替代任何语义断言 —— 它只保证「名字没有漂回旧写法」。

test("T-31：所有窗口名都必须以「额度 · / 停用 · / 说明 · 」之一开头（且前缀与路由语义一致）", async (t) => {
  /** 前缀 ↔ 该前缀必须表达的字段语义（\`null\` = 不关心，但**禁止**同时出现两者） */
  const PREFIXES = ["额度 · ", "停用 · ", "说明 · "]

  // 缓存的窗口名也必须合规范 —— 用真实的缓存目录造一份（不是编的窗口）
  const cacheDir = cacheDirWithPoints(t)

  /** 全部触发条件 × 全部状态 → 一次跑齐 */
  const cases = [
    // 正常 / 缓存回落
    { label: "live", args: {} },
    { label: "cache", args: { fetchImpl: async () => { throw new Error("ECONNRESET") }, clientStoreDir: cacheDir } },
    // 路由判定
    { label: "clean", args: { state: { [UID]: CLEAN } } },
    { label: "routed", args: { state: { [UID]: ROUTED } } },
    { label: "expired", args: { state: { [UID]: EXPIRED } } },
    { label: "exhausted", args: { state: { [UID]: EXHAUSTED } } },
    { label: "unknown", args: { state: { [UID]: entry("unknown") } } },
    // 余额为 0（不依赖状态文件）
    { label: "broke", args: { fetchImpl: pointsReturning({ balance: 0, dailyBalance: 0, availableBalance: 0 }) } },
    { label: "broke+exhausted", args: { state: { [UID]: EXHAUSTED }, fetchImpl: pointsReturning({ balance: 0, dailyBalance: 0, availableBalance: 0 }) } },
  ]

  /** @type {any[]} */
  const seen = []
  for (const { label, args } of cases) {
    const u = await usageWith({ state: args.state ?? {}, fetchImpl: args.fetchImpl ?? fakePoints(), clientStoreDir: args.clientStoreDir })
    const windows = Array.isArray(u?.windows) ? u.windows : []
    assert.ok(windows.length > 0, `${label}：没有窗口可查`)
    seen.push(...windows.map((w) => ({ label, name: String(w?.name ?? ""), w })))
  }

  // ① 名字前缀
  for (const { label, name } of seen) {
    assert.ok(
      PREFIXES.some((p) => name.startsWith(p)),
      `[${label}] 窗口名「${name}」不符合 T-31 命名：必须以 ${PREFIXES.join(" / ")} 之一开头`,
    )
  }

  // ② 前缀与字段语义必须一致（名字骗人比没名字更糟）
  for (const { label, name, w } of seen) {
    if (name.startsWith("停用 · ")) {
      assert.equal(w.used, 100, `[${label}]「${name}」是停用窗 ⇒ used 必须是 100（路由跳过的唯一手段）`)
      assert.equal(w.aside, undefined, `[${label}]「${name}」是停用窗 ⇒ 绝不能带 aside（aside 会被整条跳过，等于白报）`)
      assert.equal(w.amount, undefined, `[${label}]「${name}」停用窗不带 amount`)
      assert.equal(w.limit, undefined, `[${label}]「${name}」停用窗不带 limit`)
    }
    if (name.startsWith("说明 · ")) {
      assert.equal(w.aside, true, `[${label}]「${name}」是说明窗 ⇒ 必须 aside:true`)
      assert.equal(w.used, undefined, `[${label}]「${name}」是说明窗 ⇒ 不许带 used（会进额度排序）`)
    }
  }

  // ③ 三个前缀在本文件的用例集合里都真的出现过（别让测试自己空转）
  for (const p of PREFIXES) {
    assert.ok(seen.some((s) => s.name.startsWith(p)), `本文件没有产出过「${p}…」窗口，一致性测试名存实亡`)
  }
})
