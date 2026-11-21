// usage-route.test.mjs 额度卡片上的**纯展示**说明：这个号为什么不能用。
//
// # T-54 之后的数据来源变了，但**判定语义一个都没变**
//
// 旧版每个账号在 `auth.usage` 里打一次积分网关（301 个号 = 301 次上游请求，
// 集中在启动瞬间 ⇒ 上游风控掉号）。现在 `auth.usage` **零上游**，额度只从
// `<configDir>/loomy-usage-cache.json` 读（面板「刷新额度」写的）。
//
// 所以本文件把「假网关」换成了「假缓存」，但下面这些**一个字都不能动**：
//
//	① routed → 停用 · 上游改路由（used:100）+ 说明 · 上游限制（aside）
//	② **不许**伪造「积分耗尽」（余额明明有值时报满额是造谣）
//	③ 缓存里的额度窗**原样**返回，不被改写
//	④ 顶层无 `error`（AGENTS.md 坑 #17）
//	⑤ clean / unknown / 无判定 / 模块缺失 → 除新鲜度说明外一条都不多加
//	⑥ 余额为 0（缓存读数）→ 停用 · 积分耗尽（路由跳过该号的唯一手段）
//	⑦ T-31：所有窗口名以 `额度 · / 停用 · / 说明 · ` 之一开头，且前缀与字段语义一致

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeUsageHook } from "../src/hooks/usage.mjs"
import { usageFromPoints } from "../src/usage.mjs"
import { USAGE_CACHE_FILE, AGE_NOTE, UNREAD_NOTE } from "../src/quota-cache.mjs"

const SESSION = "s".repeat(32)
const DS41 = "DeepSeek-V4.1-Flash"
/** 身份（状态文件与额度缓存都按它落盘）。 */
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
const EXPIRED = entry("expired", { servedModel: "", reason: "session-expired" })
const EXHAUSTED = entry("exhausted", { servedModel: "", reason: "no-quota" })

/** 一份「正常额度」的缓存记录（与面板刷新写盘同形状）。 */
const FULL_POINTS = { available: 26434, daily: 1434, dailyKnown: true, permanent: 25000, permanentKnown: true }

/**
 * 造一个**真实存在**的 configDir，并按需写入额度缓存。
 *
 * ⚠ 这正是本次改动的关键：额度来源是**文件**，不是假 fetch。只要这里没写缓存，
 *   `auth.usage` 就必须返回「额度未读」——一个上游请求都不许发。
 */
function cfgDir(t, points) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-usage-route-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  if (points) {
    // ⚠ `usageFromPoints()` 回的是 `{ windows }`（magpie 的 usage 形状），不是数组
    const { windows } = usageFromPoints(points)
    writeFileSync(
      join(dir, USAGE_CACHE_FILE),
      JSON.stringify({
        updatedAt: 1795053000000,
        accounts: { [UID]: { at: 1795053000000, windows, plan: "free", permanent: points.permanent, limited: false } },
      }),
    )
  }
  return dir
}

/**
 * 调一次 `auth.usage`。
 *
 * @param {{state?: object, dir?: string, routeStore?: any, auth?: any,
 *   log?: object, now?: number}} args
 */
async function usageWith(args = {}) {
  const hook = makeUsageHook({
    configDir: args.dir ?? currentDir,
    routeStore: args.routeStore === undefined ? stubStore(args.state ?? {}) : args.routeStore,
    log: args.log ?? { warn() {} },
    now: typeof args.now === "number" ? () => Number(args.now) : undefined,
  })
  const auth = args.auth ?? { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }
  return hook(async () => auth)
}

/**
 * 当前生效的 configDir。
 *
 * ⚠ 用模块级变量而不是「每个用例都传一遍」：`node:test` 在**同一个文件内**
 * 串行执行顶层用例（没有并发标记时），所以这里是确定性的。`withDir` 负责
 * 配对地设 / 复原，用例之间不会串味。
 */
let currentDir = ""

/**
 * 稳态的 `auth.usage`：**同一个 hook 实例**调两次，返回第二次。
 *
 * 「判定变化 ⇒ signIn:"kept"」只在进程首次给某个号出结论时发光一次
 * （`lastVerdict` 是 hook 闭包里的 Map）。所以凡是断言「不许出现 signIn」的
 * 用例都必须取稳态那一次 —— 首发的 kept 是给宿主的重读信号，不是要验的语义。
 *
 * ⚠ 必须同一个实例：两次 `makeUsageHook` 会各有一份空 Map，第二次仍是「首次」。
 */
async function steadyUsage(args = {}) {
  const hook = makeUsageHook({
    configDir: args.dir ?? currentDir,
    routeStore: args.routeStore === undefined ? stubStore(args.state ?? {}) : args.routeStore,
    log: args.log ?? { warn() {} },
  })
  const auth = args.auth ?? { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }
  const call = () => hook(async () => auth)
  await call()
  return call()
}

/** 包一层：先建目录（`points` 为 `null` = 不写缓存），再跑断言，最后清理。 */
async function withDir(t, points, fn) {
  const dir = cfgDir(t, points)
  const prev = currentDir
  currentDir = dir
  try {
    return await fn(dir)
  } finally {
    currentDir = prev
  }
}

/** 判据：那条「只说明原因、不参与路由」的窗口（名字固定为 `说明 · 上游限制`）。 */
function reasonWindow(windows) {
  return (windows ?? []).find((w) => w?.aside === true && String(w?.name ?? "").startsWith("说明 · 上游限制"))
}

/** 判据：登录失效的说明窗（`说明 · 登录失效`）。 */
function expiredWindow(windows) {
  return (windows ?? []).find((w) => w?.aside === true && String(w?.name ?? "").startsWith("说明 · 登录失效"))
}

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

/** 「可计入路由的满额窗口」判据（积分耗尽）。 */
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

/** 三个原始额度窗（缓存里那份）。 */
function quotaWindows(windows) {
  return (windows ?? []).filter((w) => String(w?.name ?? "").startsWith("额度 · ") || String(w?.name ?? "").startsWith("说明 · 永久积分") || String(w?.name ?? "").startsWith("说明 · 可用总额"))
}

test("routed 账号：出现 aside 的说明窗，且写清实际由谁服务", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: ROUTED } })
    const reason = reasonWindow(u.windows)
    assert.ok(reason, `缺少说明窗口，实际: ${JSON.stringify(u.windows)}`)
    assert.equal(reason.aside, true, "aside 才会被 allowanceOf 跳过、不参与路由排序")
    // T-37：模型名会变，window name 里禁带易变数据 —— 名字固定，模型名只进 display
    assert.equal(String(reason.name), "说明 · 上游限制", "名字里不许带模型名")
    assert.match(String(reason.display), /spark-x2\.6-low/, "模型名只出现在 display")
  })
})

test("routed：不伪造「积分耗尽」额度窗；真实额度窗仍是真实值", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: ROUTED } })
    const fakeBroke = (u.windows ?? []).filter((w) => w?.used === 100 && String(w?.name ?? "").includes("积分耗尽"))
    assert.deepEqual(fakeBroke, [], "余额明明有值，不许报「积分不足」")
    assert.equal(reasonWindow(u.windows)?.used, undefined, "说明窗本身不参与路由")

    const daily = u.windows.find((w) => String(w.name).startsWith("额度 · 每日赠送"))
    assert.notEqual(daily.used, 100, "真实额度窗保留真实值，不许被改成 100")
  })
})

test("顶层无 error，缓存里的额度窗口一个不少且不被改写", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: ROUTED } })

    assert.equal(u.error, undefined, "路由状态是附加信息，不是错误")
    // 3 个额度窗 + 1 条停派满额窗 + 1 条说明窗 + 1 条新鲜度说明
    assert.equal(u.windows.length, 6)
    for (const name of ["额度 · 每日赠送", "说明 · 永久积分", "说明 · 可用总额"]) {
      assert.ok(u.windows.some((w) => String(w.name).startsWith(name)), `${name} 不能消失`)
    }
    const daily = u.windows.find((w) => String(w.name).startsWith("额度 · 每日赠送"))
    assert.equal(typeof daily.used, "number")
    assert.equal(daily.aside, undefined, "原窗口不许被改成 aside")
    assert.equal(daily.used, 71.32, "缓存里的真实值原样返回")
  })
})

test("停派满额窗排最前，说明窗紧随其后（用户先看到「这个号不能用」）", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: ROUTED } })
    assert.equal(u.windows[0].used, 100)
    assert.match(String(u.windows[0].name), /上游改路由/)
    assert.equal(u.windows[1], reasonWindow([u.windows[1]]))
  })
})

test("clean / unknown / 无判定 / 模块缺失：除新鲜度说明外一条窗口都不多加", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    for (const args of [{ state: { [UID]: CLEAN } }, { state: { [UID]: entry("unknown") } }, { state: {} }, { routeStore: null }]) {
      const u = await usageWith(args)
      assert.equal(u.error, undefined)
      assert.equal(u.windows.length, 4, `3 个额度窗 + 1 条新鲜度说明: ${JSON.stringify(args)}`)
      assert.equal(reasonWindow(u.windows), undefined)
      assert.equal(u.windows.at(-1).name, AGE_NOTE, "最后一条是「额度读于 …」")
    }
  })
})

// ── expired（登录失效）：原生 signIn 字段 ──────────────────────────────
//
// magpie 的 `internal/provider/plugin_usage.go` 认 `signIn: "expired"`，
// 会用它给账号打「登录已失效」的标记（notePluginLapseSince(401)）。
// ⚠ 这个字段**只能**在真的 expired 时写：写在好号身上等于把它标成过期。

test("expired 账号：返回 signIn === \"expired\"，并附一条 aside 说明窗", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: EXPIRED } })

    assert.equal(u.signIn, "expired", "magpie 的原生字段：账号应显示「登录已失效」")
    assert.equal(u.error, undefined, "别用 error 顶掉额度区")
    const reason = expiredWindow(u.windows)
    assert.ok(reason, `缺少登录失效说明窗，实际: ${JSON.stringify(u.windows)}`)
    assert.equal(String(reason.name), "说明 · 登录失效", "T-31 命名规范")
    assert.match(String(reason.display), /重新登录/)
    assert.equal(reason.used, undefined, "说明窗不参与路由排序")
  })
})

test("expired：额度窗口仍然一个不少（别因为登录失效把数据藏了）", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: EXPIRED } })
    assert.equal(u.windows.length, 5, "3 个额度窗 + 1 条登录失效说明 + 1 条新鲜度")
    for (const name of ["额度 · 每日赠送", "说明 · 永久积分", "说明 · 可用总额"]) {
      assert.ok(u.windows.some((w) => String(w.name).startsWith(name)), `${name} 不能消失`)
    }
  })
})

test("routed 账号**不能**带 signIn：需要重新登录（expired），不是「缓存失效」（kept）", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    // 稳态：首发会有一次 kept（判定变化的信号），之后不该再带
    const dir = currentDir
    const hook = makeUsageHook({ configDir: dir, routeStore: stubStore({ [UID]: ROUTED }), log: { warn() {} } })
    const auth = { type: "oauth", access: SESSION, accountId: ACCOUNT_ID, uid: UID }
    await hook(async () => auth)
    const u = await hook(async () => auth)
    assert.equal(u.signIn, undefined)
    assert.ok(reasonWindow(u.windows), "routed 仍然要有它自己的说明窗")
  })
})

// ── routed 立刻停派：满额窗 + 说明窗并存 ────────────────────────────────
//
// 真机痛点：`provider.models` 是列表缓存 —— 判定翻成 routed 之后，要等下一次
// 重拉列表才不派活，中间仍会继续把请求给它。`auth.usage` 是**每次读都生效**的，
// 所以在 routed 时补一条**可计入路由**的满额窗，下一次 usage 就跳过它。

test("routed：既有 aside 说明窗，又有「上游改路由」满额窗（立刻停派）", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: ROUTED } })

    const stop = routedStopWindow(u.windows)
    assert.ok(stop, `缺「上游改路由」满额窗，实际: ${JSON.stringify(u.windows)}`)
    assert.equal(stop.used, 100, "满额才会被路由跳过")
    assert.equal(stop.aside, undefined, "aside 会被 allowanceOf 整条跳过 —— 那就白报了")
    assert.equal(stop.limit, undefined)
    assert.equal(stop.amount, undefined)
    assert.match(String(stop.display), /spark-x2\.6-low/, "写清实际由谁服务")

    assert.ok(reasonWindow(u.windows), "aside 说明窗要保留（卡片上解释原因）")
  })
})

test("clean：不出现「上游改路由」满额窗", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: CLEAN } })
    assert.equal(routedStopWindow(u.windows), undefined)
  })
})

test("exhausted 与 routed 互斥：只出现「积分耗尽」停用窗", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: EXHAUSTED } })
    assert.equal(routedStopWindow(u.windows), undefined, "exhausted 不该报「上游改路由」")

    const broke = (u.windows ?? []).filter((w) => w?.used === 100 && String(w?.name ?? "").includes("积分耗尽"))
    assert.equal(broke.length, 1)
  })
})

// ── exhausted（积分不足）：只说明原因，不碰登录态 ──────────────────────

test("exhausted 账号：有 aside 说明窗、**没有** signIn、没有 error", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await steadyUsage({ state: { [UID]: EXHAUSTED } })

    const reason = (u.windows ?? []).find((w) => w?.aside === true && String(w?.name ?? "").startsWith("说明 · 余额为零"))
    assert.ok(reason, `缺少 aside 说明窗，实际: ${JSON.stringify(u.windows)}`)
    assert.equal(u.windows.length, 6, "3 个额度窗 + 1 条停用窗 + 1 条说明窗 + 1 条新鲜度")
    assert.match(String(reason.display), /充值/)
    assert.equal(reason.used, undefined, "说明窗不参与路由排序")
    assert.equal(u.signIn, undefined, "余额不足不是登录问题：带 signIn 会把号误标成需要重登")
    assert.equal(u.error, undefined)
  })
})

test("exhausted：额度窗口仍然一个不少（余额数据本身要照常展示）", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: EXHAUSTED } })
    assert.equal(u.windows.length, 6)
    for (const name of ["额度 · 每日赠送", "说明 · 永久积分", "说明 · 可用总额"]) {
      assert.ok(u.windows.some((w) => String(w.name).startsWith(name)), `${name} 不能消失`)
    }
  })
})

// ── 余额为 0 必须 **自己** 报满额（路由跳过的唯一依据是 windows[].used）──
//
// 真机：账号 402「团队积分余额不足」，magpie 的 quotas.json 里 windows=null，
// 路由把「没有任何额度窗口的号」当成可用 → 派活 → 402 → 换号 → 又慢又乱。
// 所以这一条**不依赖状态文件**：只要缓存读数余额是 0，就必须报满额窗。
//
// ⚠ T-54：余额来自**缓存**（上次刷新额度那一刻的真实读数），不是现查。

test("缓存读数 availableBalance: 0 → 出现「停用 · 积分耗尽」窗（used=100，非 aside）", async (t) => {
  await withDir(t, { available: 0, daily: 0, dailyKnown: true, permanent: 0, permanentKnown: true }, async () => {
    /** @type {string[]} */
    const logs = []
    const u = await usageWith({ log: { warn: (m) => logs.push(String(m)) } })

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
})

test("余额为 0 且状态文件里**没有判定** → 仍然报满额（不依赖 patrol）", async (t) => {
  await withDir(t, { available: 0, daily: 0, dailyKnown: true, permanent: 0, permanentKnown: true }, async () => {
    const u = await usageWith({ state: {} })
    assert.ok(fullWindow(u.windows), "patrol 还没跑过也必须拦住")
  })
})

test("缓存读数 availableBalance: 34900 → 不出现「停用 · 积分耗尽」窗口", async (t) => {
  await withDir(t, { available: 34900, daily: 14900, dailyKnown: true, permanent: 20000, permanentKnown: true }, async () => {
    const u = await usageWith({})
    assert.equal(fullWindow(u.windows), undefined)
    assert.ok(!u.windows.some((w) => String(w.name).includes("积分耗尽")))
  })
})

test("verdict === exhausted → 满额窗出现且**只有一条**（与余额判断合并不重复）", async (t) => {
  await withDir(t, { available: 0, daily: 0, dailyKnown: true, permanent: 0, permanentKnown: true }, async () => {
    const u = await usageWith({ state: { [UID]: EXHAUSTED } })
    // ⚠ 只数「积分耗尽」那条：余额为 0 时「每日赠送」本来就是 used=100（真实数据）
    const full = (u.windows ?? []).filter((w) => w?.used === 100 && String(w?.name ?? "").includes("积分耗尽"))
    assert.equal(full.length, 1, `不能出现两条满额窗，实际: ${JSON.stringify(u.windows)}`)
  })
})

test("没有可用总额窗，但缓存 permanent=0 → 也判为无额度", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loomy-usage-route-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 只写一条窗口、不带「可用总额」，逼 budgetOf 走 permanent 那条腿
  writeFileSync(
    join(dir, USAGE_CACHE_FILE),
    JSON.stringify({ updatedAt: 1, accounts: { [UID]: { at: 1, windows: [{ name: "说明 · 永久积分", aside: true, display: "0 积分", amount: 0, unit: "积分" }], plan: "", permanent: 0, limited: false } } }),
  )
  const prev = currentDir
  currentDir = dir
  try {
    const u = await usageWith({})
    assert.ok(fullWindow(u.windows), `缺满额窗口，实际: ${JSON.stringify(u.windows)}`)
  } finally {
    currentDir = prev
  }
})

test("凭证里没有任何键 → 查不到缓存（额度未读），且不加任何判定窗", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    // ⚠ T-54：额度按 uid 落盘。凭证里一个键都没有 ⇒ 无从查起 ⇒「额度未读」。
    //    判定窗也一条都不加（无键 = 无判定 = 无行为）。
    const u = await usageWith({ state: { [UID]: ROUTED }, auth: { type: "oauth", access: SESSION } })
    assert.equal(u.error, undefined)
    assert.equal(u.windows.length, 1, "只剩「额度未读」")
    assert.equal(u.windows[0].name, UNREAD_NOTE)
    assert.equal(reasonWindow(u.windows), undefined)
    assert.equal(routedStopWindow(u.windows), undefined)
  })
})

test("键一致性：状态按 uid 落盘、凭证里 accountId 也在 → 说明窗必须出现", async (t) => {
  await withDir(t, FULL_POINTS, async () => {
    const u = await usageWith({ state: { [UID]: ROUTED } })
    assert.ok(reasonWindow(u.windows), `按显示名查会漏，实际: ${JSON.stringify(u.windows)}`)
  })
})

test("没有缓存时**零上游**：只有「额度未读」，绝不写 error", async (t) => {
  await withDir(t, null, async () => {
    const u = await usageWith({ state: { [UID]: ROUTED } })
    assert.equal(u.error, undefined, "「还没读过」不是错误，是初始状态")
    const unread = (u.windows ?? []).find((w) => String(w?.name ?? "") === UNREAD_NOTE)
    assert.ok(unread, `缺「额度未读」说明窗，实际: ${JSON.stringify(u.windows)}`)
    assert.equal(unread.aside, true, "不参与路由")
    assert.match(String(unread.display), /刷新额度/)
    // routed 的停派窗照旧生效（它不依赖额度数据）
    assert.ok(routedStopWindow(u.windows), "没有额度 ≠ 没有判定：routed 仍要停派")
  })
})

test("缓存损坏（不是合法 JSON）→ 退化成「额度未读」，不抛", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loomy-usage-route-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, USAGE_CACHE_FILE), "{broken")
  const prev = currentDir
  currentDir = dir
  try {
    const u = await usageWith({})
    assert.equal(u.error, undefined)
    assert.ok((u.windows ?? []).some((w) => String(w.name) === UNREAD_NOTE))
  } finally {
    currentDir = prev
  }
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
  const PREFIXES = ["额度 · ", "停用 · ", "说明 · "]

  const cases = [
    // 有缓存 / 没缓存（两种都要能出窗口）
    { label: "cache-full", points: FULL_POINTS, args: {} },
    { label: "cache-none", points: null, args: {} },
    // 路由判定
    { label: "clean", points: FULL_POINTS, args: { state: { [UID]: CLEAN } } },
    { label: "routed", points: FULL_POINTS, args: { state: { [UID]: ROUTED } } },
    { label: "expired", points: FULL_POINTS, args: { state: { [UID]: EXPIRED } } },
    { label: "exhausted", points: FULL_POINTS, args: { state: { [UID]: EXHAUSTED } } },
    { label: "unknown", points: FULL_POINTS, args: { state: { [UID]: entry("unknown") } } },
    // 余额为 0（缓存读数 —— 不依赖状态文件）
    { label: "broke", points: { available: 0, daily: 0, dailyKnown: true, permanent: 0, permanentKnown: true }, args: {} },
    {
      label: "broke+exhausted",
      points: { available: 0, daily: 0, dailyKnown: true, permanent: 0, permanentKnown: true },
      args: { state: { [UID]: EXHAUSTED } },
    },
  ]

  /** @type {any[]} */
  const seen = []
  for (const item of cases) {
    await withDir(t, item.points, async () => {
      const u = await usageWith(item.args)
      const windows = Array.isArray(u?.windows) ? u.windows : []
      assert.ok(windows.length > 0, `${item.label}：没有窗口可查`)
      seen.push(...windows.map((w) => ({ label: item.label, name: String(w?.name ?? ""), w })))
    })
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

  // ④ 缓存里的额度窗原样出现（别把 quotaWindows 判据写成空集）
  const routedCase = seen.filter((s) => s.label === "routed")
  assert.ok(routedCase.some((s) => s.name === "额度 · 每日赠送"), "缓存里的额度窗必须原样返回")
})