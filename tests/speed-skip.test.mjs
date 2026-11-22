// speed-skip.test.mjs —— 按速率跳过慢号（T-62 / 慢号不进模型目录）。
//
// # 这一集在钉什么
//
//   · 慢号在**该模型下还有非慢号**时，`provider.models` 里不报这个模型
//     ⇒ magpie 的路由只在这份目录里选模型 ⇒ 这个号拿不到该模型的活。
//   · 慢号是**该模型下唯一的号**时不跳（否则这个模型整体消失，等于自己砍掉能力）。
//   · unknown（缓存过期 / 没记录 / 没有 B）**一律不跳** —— 「未验证」≠「不可用」。
//   · 开关关掉 / 缓存缺失 / 缓存损坏 ⇒ **完全退回原行为**，且不抛。
//   · 这个钩子**零请求**：除了目录那一次上游调用，不许再发任何东西。
//
// ⚠ 速率的唯一来源是 magpie 自己的 usage/requests（见 src/speed.mjs），
//   本集自己一行都不测速。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeModelsHook, resetCatalogInflight, resetModelsWarned } from "../src/hooks/models.mjs"
import {
  SPEED_CACHE_FILE,
  speedCachePath,
  readSpeedCache,
  writeSpeedCache,
  readSpeedSkipSetting,
} from "../src/speed-cache.mjs"
import { buildSpeedTable } from "../src/speed.mjs"

const SESSION = "a".repeat(32)
const NOW = Date.parse("2026-11-22T16:00:00+08:00")

/** 假上游目录：两个模型，够判断「该模型还在不在」。 */
function fakeCatalog() {
  return async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "m1", name: "Model One", context_window: 1000, max_output_tokens: 100 },
          { id: "m2", name: "Model Two", context_window: 1000, max_output_tokens: 100 },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
}

/** 一条速度表条目（默认 slow，测什么改什么）。 */
const entry = (model, account, verdict, over = {}) => ({
  model,
  account,
  lastSpeed: verdict === "slow" ? 20 : verdict === "normal" ? 130 : null,
  lastAt: NOW - 60_000,
  avgSpeed: verdict === "slow" ? 20 : verdict === "normal" ? 130 : null,
  calls: 10,
  verdict,
  ...over,
})

/** 造一份缓存文件（用生产写入器，保证形状与线上一致）。 */
function seedSpeedCache(dir, accounts) {
  const table = { updatedAt: NOW, b: { m1: 100, m2: 100 }, accounts }
  const wrote = writeSpeedCache(dir, table)
  assert.ok(wrote.ok, `写速度缓存失败：${wrote.error}`)
  return table
}

async function fixture(t, { accounts = {}, speedSkip = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-speed-skip-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  resetCatalogInflight()
  resetModelsWarned()
  if (accounts) seedSpeedCache(dir, accounts)
  /** @type {any[]} */
  const calls = []
  const hook = makeModelsHook({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return fakeCatalog()(url, init)
    },
    log: { warn() {} },
    configDir: dir,
    speedSkip,
  })
  return { dir, calls, hook }
}

const authOf = (account) => ({ access: SESSION, accountId: account, uid: `uid-${account}` })

// ── 一、核心：慢号在有替代时让位 ────────────────────────────────────────

test("核心：慢号 + 该模型下还有 1 个 normal ⇒ 模型目录里不报 m1（只留 m2）", async (t) => {
  const f = await fixture(t, {
    accounts: {
      "m1|slowpoke": entry("m1", "slowpoke", "slow"),
      "m1|fast": entry("m1", "fast", "normal"),
    },
  })
  const out = await f.hook({ models: {} }, { auth: authOf("slowpoke") })
  assert.equal(out.m1, undefined, "还有别的号能接 ⇒ 慢号不报这个模型")
  assert.ok(out.m2, "无关的模型照常报")
})

test("核心：慢号 + 该模型下只有慢号 ⇒ 仍然报 m1（全慢就不许让，否则整个模型消失）", async (t) => {
  const f = await fixture(t, {
    accounts: {
      "m1|slowpoke": entry("m1", "slowpoke", "slow"),
      "m1|slow2": entry("m1", "slow2", "slow"),
    },
  })
  const out = await f.hook({ models: {} }, { auth: authOf("slowpoke") })
  assert.ok(out.m1, "该模型下没有非慢号 ⇒ 放回来（MIN_FAST=1）")
  assert.ok(out.m2)
})

test("unknown 号不被跳过（缓存过期 / 没有 B 都算未知，未知 ≠ 不可用）", async (t) => {
  const f = await fixture(t, {
    accounts: {
      "m1|stale": entry("m1", "stale", "unknown"),
      "m1|fast": entry("m1", "fast", "normal"),
    },
  })
  const out = await f.hook({ models: {} }, { auth: authOf("stale") })
  assert.ok(out.m1, "unknown 不是 slow，不许拿掉模型")
})

test("normal 号在任何情况下都不被跳过", async (t) => {
  const f = await fixture(t, {
    accounts: {
      "m1|fast": entry("m1", "fast", "normal"),
      "m1|slowpoke": entry("m1", "slowpoke", "slow"),
      "m1|slow2": entry("m1", "slow2", "slow"),
    },
  })
  const out = await f.hook({ models: {} }, { auth: authOf("fast") })
  assert.ok(out.m1)
})

// ── 二之前：B 被 `flow_ms≈1ms` 的行污染时，**一个号都不许摘** ─────────────
//
// 实测形态（DeepSeek-V4.1-Flash，34 号，16 个 A>2000，中位数 48000）：如果按
// 48000×0.7 去判，一批本来正常的号会被判 slow 并丢掉整个模型。`B_MAX` 把这种
// 「没有可用基准」的模型按 unknown 处理 —— 端到端的效果就是**模型目录一个字都不变**。

test("核心：B 被污染（中位数 48000 ⇒ 越过 B_MAX）⇒ 全员 unknown，models 钩子一个都不摘", async (t) => {
  const row = (account, out) => ({
    provider: "loomy",
    providerAccount: account,
    model: "m1",
    status: 200,
    out,
    flow_ms: 1000,
    t: new Date(NOW - 60_000).toISOString(),
  })
  // 三个「1ms 型爆表号」把中位数抬到 48000（43200 / 48000 / 52800 的中位数）
  const rows = [
    row("h0", 43200),
    row("h1", 48000),
    row("h2", 52800),
    // 正常速度的号：若 B=48000 被采用，阈值 33600 ⇒ 会被误判 slow 并丢掉 m1
    row("normal-ish", 30),
    // 另一个号：用来满足 MIN_FAST —— 如果判定真被触发，m1 一定会被摘
    row("h3", 900),
  ]
  const table = buildSpeedTable(rows, { now: NOW })
  assert.deepEqual(table.b, {}, "越过 B_MAX 的模型不许出现在 b 里（= 没有可用基准）")
  assert.equal(
    Object.values(table.accounts).every((e) => e.verdict === "unknown"),
    true,
    "没有基准 ⇒ 全员 unknown（不许判 slow）",
  )

  // 端到端：把这份表当缓存喂给真钩子，一个模型都不许摘
  const dir = mkdtempSync(join(tmpdir(), "loomy-speed-bmax-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.ok(writeSpeedCache(dir, table).ok)
  resetCatalogInflight()
  resetModelsWarned()
  const hook = makeModelsHook({ fetchImpl: fakeCatalog(), log: { warn() {} }, configDir: dir, speedSkip: true })
  for (const account of ["normal-ish", "h1"]) {
    const out = await hook({ models: {} }, { auth: authOf(account) })
    assert.deepEqual(Object.keys(out).sort(), ["m1", "m2"], `${account} 的模型目录必须一个字都不变`)
  }
})

// ── 二、退回原行为（开关关 / 缓存缺失 / 缓存损坏） ─────────────────────

test("speedSkip:false ⇒ 输出与「没有缓存」时完全一致", async (t) => {
  const off = await fixture(t, {
    speedSkip: false,
    accounts: {
      "m1|slowpoke": entry("m1", "slowpoke", "slow"),
      "m1|fast": entry("m1", "fast", "normal"),
    },
  })
  const noCache = await fixture(t, { accounts: null })
  const a = await off.hook({ models: {} }, { auth: authOf("slowpoke") })
  const b = await noCache.hook({ models: {} }, { auth: authOf("slowpoke") })
  assert.deepEqual(a, b, "开关关闭 = 完全原行为（模型目录一个字都不变）")
  assert.ok(a.m1)
})

test("缓存文件缺失 ⇒ 原行为，不抛", async (t) => {
  const f = await fixture(t, { accounts: null })
  const out = await f.hook({ models: {} }, { auth: authOf("slowpoke") })
  assert.ok(out.m1 && out.m2)
  assert.equal(existsSync(speedCachePath(f.dir)), false, "缺失的缓存不该被读操作创建出来")
})

test("缓存 JSON 损坏 ⇒ 原行为，不抛（缓存坏了不等于号坏了）", async (t) => {
  const f = await fixture(t, { accounts: null })
  writeFileSync(join(f.dir, SPEED_CACHE_FILE), "{ 这不是 json", "utf8")
  assert.equal(readSpeedCache(f.dir), null, "坏 JSON 读成 null（= 没有缓存）")
  const out = await f.hook({ models: {} }, { auth: authOf("slowpoke") })
  assert.ok(out.m1 && out.m2)
})

test("缓存结构不对（accounts 不是对象 / 条目没有 model）⇒ 当作没有缓存", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loomy-speed-skip-bad-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, SPEED_CACHE_FILE), JSON.stringify({ updatedAt: NOW, b: {}, accounts: [] }), "utf8")
  assert.equal(readSpeedCache(dir), null)

  writeFileSync(
    join(dir, SPEED_CACHE_FILE),
    JSON.stringify({
      updatedAt: NOW,
      b: { m1: 100 },
      accounts: {
        "m1|broken": { verdict: "slow" },
        "m1|x": { model: "m1", account: "x", verdict: "slow", lastAt: NOW, lastSpeed: 20 },
      },
    }),
    "utf8",
  )
  const table = readSpeedCache(dir)
  assert.ok(table, "有一条合法条目就仍然算有效缓存")
  assert.deepEqual(Object.keys(table.accounts), ["m1|x"], "缺字段的条目被丢掉，不参与判定")
})

// ── 三、零请求 ─────────────────────────────────────────────────────────

test("跳过判定本身**零请求**：整个钩子只打一次上游目录", async (t) => {
  const f = await fixture(t, {
    accounts: {
      "m1|slowpoke": entry("m1", "slowpoke", "slow"),
      "m1|fast": entry("m1", "fast", "normal"),
    },
  })
  await f.hook({ models: {} }, { auth: authOf("slowpoke") })
  assert.equal(f.calls.length, 1, `只许有目录那一次请求，实际 ${f.calls.map((c) => c.url).join(",")}`)
  assert.match(f.calls[0].url, /\/models$/)
})

// ── 四、缓存读写与面板开关 ─────────────────────────────────────────────

test("writeSpeedCache → readSpeedCache 往返一致，且是原子写（不留 .tmp）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loomy-speed-cache-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const table = buildSpeedTable(
    [
      { providerAccount: "a", model: "m1", out: 100, flow_ms: 1000, status: 200, t: new Date(NOW - 1000).toISOString() },
      { providerAccount: "b", model: "m1", out: 300, flow_ms: 1000, status: 200, t: new Date(NOW - 1000).toISOString() },
    ],
    { now: NOW },
  )
  assert.ok(writeSpeedCache(dir, table).ok)
  const back = readSpeedCache(dir)
  assert.equal(back.updatedAt, NOW)
  assert.equal(back.b.m1, 200)
  assert.equal(back.accounts["m1|b"].lastSpeed, 300)
  const files = readFileSync(speedCachePath(dir), "utf8")
  assert.doesNotMatch(files, /\.tmp/, "落盘内容里不该提到临时文件")
  // 目录里只该有这一个文件（没有残留 .tmp）
  assert.deepEqual(readdirSync(dir).sort(), [SPEED_CACHE_FILE])
})

test("readSpeedSkipSetting：缺文件 / 缺字段 / 非布尔 ⇒ 默认开；显式 false ⇒ 关", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loomy-speed-skip-setting-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(readSpeedSkipSetting(dir), true, "默认开（与 option(\"speedskip\", true) 同口径）")
  writeFileSync(join(dir, "loomy-panel-settings.json"), JSON.stringify({ gapMs: 300 }), "utf8")
  assert.equal(readSpeedSkipSetting(dir), true, "字段缺失 = 默认开")
  writeFileSync(join(dir, "loomy-panel-settings.json"), JSON.stringify({ speedSkip: "no" }), "utf8")
  assert.equal(readSpeedSkipSetting(dir), true, "类型不对就回默认，不猜")
  writeFileSync(join(dir, "loomy-panel-settings.json"), JSON.stringify({ speedSkip: false }), "utf8")
  assert.equal(readSpeedSkipSetting(dir), false, "显式 false 才是关")
})
