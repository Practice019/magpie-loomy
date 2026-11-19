// importer-route.test.mjs 导入的**两件真机问题**：
//
// # Bug A：超过 100 条被静默丢掉
//
// magpie 单次最多收 100 条（`IMPORT_MOST`）。旧实现直接 `slice(0, 100)`：
// 117 条的文件只回 100 条成功，剩下 17 条**不报错、不提示**，用户永远导不进来
// （再导一次还是切前 100 条）。现在必须：
//	① 按已有账号去重（uid 或 session 相同 ⇒ 视为已导入，跳过）
//	② 去重后仍超限 ⇒ 回 100 条成功 **+ 一条 failed 说明还剩几条**（不许静默切片）
//	③ 于是「再选一次同一文件」就能导完剩下的 —— 分两次，但不丢数据
//
// # Bug B：导入的号没人探测，直接参与路由
//
// 新导入的号不在 `loomy-route-state.json` 里 ⇒ `provider.models` 判 unknown ⇒
// 给完整目录 ⇒ magpie 立刻派活过去，而它们其实可能是受限号。所以导入成功后
// 要在**后台**（`void`，绝不 await）跑探测：并发 2、相邻启动 300ms、
// 连续 3 次限流/失败熔断。探测失败不影响导入结果。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeImportHook, IMPORT_MOST } from "../src/importer.mjs"

/** 第 i 个账号的 session（32 位 hex，互不相同）。 */
const sess = (i) => i.toString(16).padStart(32, "0")

/** 造一个 configDir，里面写一份 magpie 的 plugin-auth.json。 */
function configDirWith(t, accounts = []) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-import-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  /** @type {Record<string, any>} */
  const auth = {}
  accounts.forEach((a, i) => {
    auth[i === 0 ? "loomy" : `loomy#${i}`] = {
      type: "oauth",
      access: a.session,
      accountId: a.accountId ?? a.uid,
      uid: a.uid,
      metadata: { uid: a.uid },
    }
  })
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth, null, 2))
  return dir
}

/** 让所有后台串行任务跑完（探测是 `void` 出去的，不 await）。 */
const settle = () => new Promise((r) => setTimeout(r, 60))

/** 一批账号的导入文本。 */
function textOf(from, count) {
  return JSON.stringify(Array.from({ length: count }, (_, i) => ({ session: sess(from + i), userid: `u${from + i}` })))
}

// ── Bug A：不许静默截断 ────────────────────────────────────────────────

test("已有 100 个号 + 文件里 117 条 ⇒ 100 条成功 + 一条 failed 说明还剩 17 条", async (t) => {
  // 「已有 100 个号」指的是池子里那些**别的**号（与文件里的 117 条不重叠）：
  // 它证明「池子规模本身不会让人被跳过」，截断纯粹来自 magpie 的 100 条上限。
  const existing = Array.from({ length: 100 }, (_, i) => ({ session: sess(1000 + i), uid: `pool-${i}` }))
  const dir = configDirWith(t, existing)

  const h = makeImportHook({ configDir: dir, probe: async () => ({ verdict: "clean" }), settleMs: 0 })
  const out = await h.import([textOf(0, 117)])

  assert.equal(out.filter((x) => x.type === "success").length, IMPORT_MOST, "先填满 magpie 的上限")
  const failed = out.filter((x) => x.type === "failed")
  assert.equal(failed.length, 1, "必须**有一条**说明，不能静默切片")
  assert.match(failed[0].error, /117/)
  assert.match(failed[0].error, /100/)
  assert.match(failed[0].error, /17/, "要写清还剩多少条")
  assert.match(failed[0].error, /再次选择同一文件|再选一次/, "要告诉用户怎么办")
})

test("再选一次同一文件：那 100 个已存在 → 只有剩下的 17 条成功，0 条 failed", async (t) => {
  // 第一次导入后，前 100 个已经进了 plugin-auth.json
  const existing = Array.from({ length: 100 }, (_, i) => ({ session: sess(i), uid: `u${i}` }))
  const dir = configDirWith(t, existing)

  const h = makeImportHook({ configDir: dir, probe: async () => ({ verdict: "clean" }), settleMs: 0 })
  const out = await h.import([textOf(0, 117)])

  assert.equal(out.filter((x) => x.type === "success").length, 17)
  assert.equal(out.filter((x) => x.type === "failed").length, 0, "没有超出上限，就不该有 failed")
})

test("已存在的账号不会被重复返回（uid 相同或 session 相同都算重复）", async (t) => {
  // 一个号按 uid 命中、另一个按 session 命中（uid 写的是别的值 —— 用 session 去重）
  const dir = configDirWith(t, [
    { session: sess(0), uid: "known-by-uid" },
    { session: sess(1), uid: "记录的 uid 与文件不同" },
  ])

  const h = makeImportHook({ configDir: dir, probe: async () => ({ verdict: "clean" }), settleMs: 0 })
  const out = await h.import([
    JSON.stringify([
      { session: sess(0), userid: "known-by-uid" },
      { session: sess(1), userid: "文件里另写的 uid" },
      { session: sess(2), userid: "brand-new" },
    ]),
  ])

  const ok = out.filter((x) => x.type === "success")
  assert.equal(ok.length, 1, "只有真正的新号该出现在结果里")
  assert.equal(ok[0].uid, "brand-new")
})

test("没有 configDir：不去重，仍按 100 收，但**带** failed 说明（不静默）", async () => {
  // 注入探测 + 假时钟：这条测的是「截断要说清」，不该顺带跑 117 次真实探测。
  let logical = 0
  const h = makeImportHook({
    settleMs: 0,
    clock: { now: () => logical, sleep: async (ms) => { logical += ms } },
    probe: async () => ({ verdict: "clean" }),
  })
  const out = await h.import([textOf(0, 117)])

  assert.equal(out.filter((x) => x.type === "success").length, IMPORT_MOST)
  const failed = out.filter((x) => x.type === "failed")
  assert.equal(failed.length, 1)
  assert.match(failed[0].error, /17/)
})

// ── Bug B：导入后后台自动探测 ──────────────────────────────────────────

test("导入成功后对每个新号跑一次探测（count = 新导入条数）", async (t) => {
  const dir = configDirWith(t)
  /** @type {string[]} */
  const probed = []
  const h = makeImportHook({
    configDir: dir,
    probe: async ({ session }) => {
      probed.push(session)
      return { verdict: "clean", servedModel: "DeepSeek-V4.1-Flash" }
    },
    gapMs: 0,
    settleMs: 0,
  })

  const out = await h.import([textOf(0, 3)])
  assert.equal(out.filter((x) => x.type === "success").length, 3, "探测是后台的，不能阻塞导入")

  await settle()
  assert.equal(probed.length, 3, `每个新号一次，实际: ${probed.join(",")}`)
  assert.deepEqual(probed.sort(), [sess(0), sess(1), sess(2)].sort())
})

test("探测失败不影响 import 的返回值（仍然全 success）", async (t) => {
  const dir = configDirWith(t)
  const h = makeImportHook({
    configDir: dir,
    probe: async () => {
      throw new Error("probe boom")
    },
    gapMs: 0,
    settleMs: 0,
  })

  const out = await h.import([textOf(0, 4)])
  assert.equal(out.filter((x) => x.type === "success").length, 4)

  await settle()
  // 探测失败只 warn，不抛；这里只断言导入结果没被污染
  assert.ok(out.every((x) => x.type === "success"))
})

test("探测写盘规则：clean/routed/expired 覆盖，unknown 不覆盖", async (t) => {
  const dir = configDirWith(t)
  /** @type {Array<{uid: string, verdict: string}>} */
  const written = []
  const h = makeImportHook({
    configDir: dir,
    probe: async ({ session }) => ({ verdict: session === sess(0) ? "unknown" : "routed", servedModel: "spark-x2.6-low" }),
    writeState: (_dir, uid, entry) => {
      written.push({ uid, verdict: entry.verdict })
      return { ok: true }
    },
    gapMs: 0,
    settleMs: 0,
  })

  await h.import([textOf(0, 2)])
  await settle()

  assert.deepEqual(
    written.map((w) => w.uid).sort(),
    ["u1"],
    "unknown 那次不许落盘（否则一次抖动会把有效结论抹成未检测）",
  )
  assert.equal(written[0].verdict, "routed")
})

test("节流与并发（假时钟）：相邻启动 ≥300ms，同时在跑的 ≤2", async (t) => {
  const dir = configDirWith(t)
  /** @type {number[]} */
  const starts = []
  let inFlight = 0
  let peak = 0

  // 假时钟：`sleep` 只推进逻辑时间，**不真的等** —— 否则 N 个号 × 300ms 会把
  // 整个测试套从 8 秒拖到 200 秒（真机踩过这个「测试变慢」的坑）。
  // 启动时刻取自闸门分配的 `onStart`，不是调用方自己再读一次 now() ——
  // 后者在并发 2 时会读到同一个时刻，把「间隔」测成 0。
  let logical = 0
  const clock = {
    now: () => logical,
    sleep: async (ms) => {
      logical += ms
    },
  }

  const h = makeImportHook({
    configDir: dir,
    settleMs: 0,
    clock,
    onStart: (at) => starts.push(at),
    probe: async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // 让出一次真实事件循环，制造并发重叠（不依赖真实时间长度）
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      return { verdict: "clean" }
    },
  })

  await h.import([textOf(0, 6)])
  await new Promise((r) => setTimeout(r, 200))

  assert.equal(starts.length, 6, `六个号都该被探测，实际 ${starts.length}`)
  assert.ok(peak <= 2, `并发必须 ≤2，实际峰值 ${peak}`)
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= 300, `相邻启动间隔太短：${starts[i] - starts[i - 1]}ms`)
  }
})

test("节流（真实时钟，只保留最小一条）：2 个号至少隔 300ms 才启动第二次", async (t) => {
  const dir = configDirWith(t)
  /** @type {number[]} */
  const starts = []
  const h = makeImportHook({
    configDir: dir,
    settleMs: 0,
    probe: async () => {
      starts.push(Date.now())
      return { verdict: "clean" }
    },
  })

  await h.import([textOf(0, 2)])
  await new Promise((r) => setTimeout(r, 500))

  assert.equal(starts.length, 2)
  assert.ok(starts[1] - starts[0] >= 290, `真实节流应生效，实际 ${starts[1] - starts[0]}ms`)
})

test("连续 3 次限流/失败就熔断：后面的号一次都不打", async (t) => {
  const dir = configDirWith(t)
  let calls = 0
  const h = makeImportHook({
    configDir: dir,
    probe: async () => {
      calls += 1
      throw new Error("HTTP 429 Too Many Requests")
    },
    // 生产用 300ms；这里用 10ms 保证「失败已被记下」先于「下一次放闸」，
    // 否则并发 2 时在飞的那次启动会多发一次（属正常电路熔断行为，不好钉）。
    gapMs: 10,
    settleMs: 0,
  })

  await h.import([textOf(0, 8)])
  await new Promise((r) => setTimeout(r, 400))

  assert.equal(calls, 3, `熔断后不许继续打，实际调了 ${calls} 次`)
})