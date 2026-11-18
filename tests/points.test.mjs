import { test } from "node:test"
import assert from "node:assert/strict"

import {
  firstLogin,
  pointsRoot,
  pointsCall,
  fetchPointsSnapshot,
  fetchTasks,
  completeTask,
  fetchActivation,
  fetchInvitationCodes,
  TASK_DEFS,
  taskPointsOf,
} from "../src/points.mjs"

const BASE = "https://loomyad.xunfei.cn/api/v1"
const AUTH = { session: "a".repeat(32) }

/** 造一个假 fetch：记录请求，返回给定 JSON 信封。 */
function fakeFetch(envelope, status = 200) {
  /** @type {any[]} */
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(envelope), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }
  fn.calls = calls
  return fn
}

function ok(data) {
  return { code: "000000", desc: "success", data }
}

test("积分默认30秒超时且与调用方取消合并", async (t) => {
  const original = AbortSignal.timeout
  const durations = []
  const timeout = new AbortController()
  t.mock.method(AbortSignal, "timeout", (ms) => { durations.push(ms); return timeout.signal })
  const caller = new AbortController()
  const fetchImpl = async (url, init) => {
    assert.notEqual(init.signal, caller.signal)
    timeout.abort(new DOMException("secret", "TimeoutError"))
    throw init.signal.reason
  }
  await assert.rejects(() => pointsCall({ baseUrl: BASE, auth: AUTH, method: "POST", path: "/x", signal: caller.signal, fetchImpl }), /POST \/x.*30秒/)
  assert.deepEqual(durations, [30_000])
  assert.equal(typeof original, "function")
})

test("调用方取消及读正文错误不泄漏凭证", async () => {
  const caller = new AbortController()
  caller.abort(new Error(AUTH.session))
  await assert.rejects(() => pointsCall({ baseUrl: BASE, auth: AUTH, method: "GET", path: "/x", signal: caller.signal, fetchImpl: async (url, init) => { throw init.signal.reason } }), /请求已取消/)
  await assert.rejects(() => pointsCall({ baseUrl: BASE, auth: AUTH, method: "GET", path: "/x", fetchImpl: async () => ({ text: async () => { throw new Error(AUTH.session) } }) }), /网络请求失败/)
})

test("HTTP、缺 code 和非 JSON 错误只含可定位信息", async () => {
  for (const response of [new Response(AUTH.session), Response.json({ data: { session: AUTH.session } }), Response.json(ok({}), { status: 503 }), Response.json({ code: "FAIL", desc: AUTH.session })]) {
    await assert.rejects(() => pointsCall({ baseUrl: BASE, auth: AUTH, method: "GET", path: "/x", fetchImpl: async () => response }), (e) => {
      assert.match(e.message, /GET \/x/)
      assert.equal(e.message.includes(AUTH.session), false)
      return true
    })
  }
})

test("firstLogin 纯 UUID 无邀请码并返回真实 data", async () => {
  const data = { alreadyProcessed: false, registerReward: 5000, balance: 5000 }
  const fetchImpl = fakeFetch(ok(data))
  assert.deepEqual(await firstLogin({ baseUrl: BASE, auth: AUTH, fetchImpl }), data)
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.deepEqual(Object.keys(body), ["deviceId"])
  assert.match(body.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("无效额度不当成零，任务非布尔不误标已完成", async () => {
  await assert.rejects(() => fetchPointsSnapshot({ baseUrl: BASE, auth: AUTH, fetchImpl: fakeFetch(ok({ balance: "unknown" })) }), /数值无效/)
  const tasks = await fetchTasks({ baseUrl: BASE, auth: AUTH, fetchImpl: fakeFetch(ok({ tasks: [{ key: "first_message", done: "false" }, { key: "pick_skill" }] })) })
  assert.deepEqual(tasks, {})
  await assert.rejects(() => fetchTasks({ baseUrl: BASE, auth: AUTH, fetchImpl: fakeFetch(ok(null)) }), /任务状态未知/)
})

test("未知激活状态不转换成 false", async () => {
  for (const data of [{}, { activated: "false" }, { activated: 0 }]) {
    await assert.rejects(() => fetchActivation({ baseUrl: BASE, auth: AUTH, fetchImpl: fakeFetch(ok(data)) }), /激活状态未知/)
  }
})

test("pointsRoot 去掉 /api/v1 后缀", () => {
  assert.equal(pointsRoot(BASE), "https://loomyad.xunfei.cn")
  assert.equal(pointsRoot("https://x.invalid"), "https://x.invalid")
  assert.equal(pointsRoot("https://x.invalid/"), "https://x.invalid")
})

test("pointsCall 用 token 头（不是 Authorization）", async () => {
  const fetchImpl = fakeFetch(ok({}))
  await pointsCall({ baseUrl: BASE, auth: AUTH, method: "GET", path: "/x", fetchImpl })
  const h = fetchImpl.calls[0].init.headers
  assert.equal(h.get("token"), AUTH.session)
  assert.equal(h.get("Authorization"), null)
})

test("pointsCall 的 URL = root + /api/v1 + path", async () => {
  const fetchImpl = fakeFetch(ok({}))
  await pointsCall({ baseUrl: BASE, auth: AUTH, method: "GET", path: "/points/records", fetchImpl })
  assert.equal(fetchImpl.calls[0].url, "https://loomyad.xunfei.cn/api/v1/points/records")
})

test("pointsCall 把非 000000 的 code 当失败（业务失败也是 200）", async () => {
  const fetchImpl = fakeFetch({ code: "100002", desc: "登录已失效，请重新登录" })
  await assert.rejects(
    () => pointsCall({ baseUrl: BASE, auth: AUTH, method: "GET", path: "/x", fetchImpl }),
    /100002.*登录已失效/,
  )
})

test("pointsCall 缺 session 抛错", async () => {
  await assert.rejects(
    () => pointsCall({ baseUrl: BASE, auth: {}, method: "GET", path: "/x", fetchImpl: fakeFetch(ok({})) }),
    /缺少 session/,
  )
})

test("pointsCall 非 JSON 抛错", async () => {
  const fetchImpl = async () => new Response("<html>", { status: 200 })
  await assert.rejects(
    () => pointsCall({ baseUrl: BASE, auth: AUTH, method: "GET", path: "/x", fetchImpl }),
    /不是合法 JSON/,
  )
})

// ── 额度 ───────────────────────────────────────────────────────────────

test("fetchPointsSnapshot 认三个账本并报 presence", async () => {
  const fetchImpl = fakeFetch(
    ok({ balance: 25000, dailyBalance: 1434, availableBalance: 26434 }),
  )
  const p = await fetchPointsSnapshot({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.deepEqual(p, {
    available: 26434,
    daily: 1434,
    dailyKnown: true,
    permanent: 25000,
    permanentKnown: true,
  })
})

test("fetchPointsSnapshot 缺 dailyBalance 时 dailyKnown=false（未知 ≠ 0）", async () => {
  const fetchImpl = fakeFetch(ok({ balance: 25000 }))
  const p = await fetchPointsSnapshot({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.equal(p.dailyKnown, false)
  assert.equal(p.permanentKnown, true)
  assert.equal(p.available, 25000) // 回落到 balance
})

test("fetchPointsSnapshot 认 {data:{…}} 那层", async () => {
  const fetchImpl = fakeFetch(ok({ data: { balance: 100, availableBalance: 120 } }))
  const p = await fetchPointsSnapshot({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.equal(p.available, 120)
})

test("fetchPointsSnapshot 三个字段都没有时抛错", async () => {
  const fetchImpl = fakeFetch(ok({ foo: 1 }))
  await assert.rejects(
    () => fetchPointsSnapshot({ baseUrl: BASE, auth: AUTH, fetchImpl }),
    /没有 balance/,
  )
})

// ── 新手任务 ───────────────────────────────────────────────────────────

test("TASK_DEFS 是 8 项共 10000 分", () => {
  assert.equal(TASK_DEFS.length, 8)
  assert.equal(TASK_DEFS.reduce((s, d) => s + d.points, 0), 10000)
})

test("taskPointsOf 未知 key 返回 0 不报错", () => {
  assert.equal(taskPointsOf("first_message"), 500)
  assert.equal(taskPointsOf("nope"), 0)
})

test("fetchTasks 认 {tasks:[…]} 形态", async () => {
  const fetchImpl = fakeFetch(
    ok({ tasks: [{ key: "first_message", done: true }, { key: "pick_skill", completed: false }] }),
  )
  const t = await fetchTasks({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.deepEqual(t, { first_message: true, pick_skill: false })
})

test("fetchTasks 认上游真实的 {tasks:{key:true}} 对象形态 —— 这是实测形态", async () => {
  // 2026-11-18 实测回执：
  // {"code":"000000","data":{"tasks":{"configure_remote":true,…},"earned":10000,"total":10000}}
  //
  // ⚠ 只认数组会把「8 项全完成」解析成 {}，界面显示 0/8 —— 看起来像功能没做。
  const fetchImpl = fakeFetch(
    ok({
      tasks: {
        configure_remote: true,
        create_soul: true,
        first_message: true,
        generate_ppt: true,
        install_skill: true,
        pick_skill: true,
        set_schedule: true,
        share_soul: true,
      },
      earned: 10000,
      total: 10000,
    }),
  )
  const t = await fetchTasks({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.equal(Object.keys(t).length, 8, "8 项任务都要解析出来")
  assert.ok(Object.values(t).every((v) => v === true))
  // ⚠ earned / total 是数字，不能被当成任务状态混进来
  assert.equal(t.earned, undefined)
  assert.equal(t.total, undefined)
})

test("fetchTasks 对象形态里的 false 也要保留（未完成的项）", async () => {
  const fetchImpl = fakeFetch(ok({ tasks: { first_message: true, pick_skill: false } }))
  const t = await fetchTasks({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.deepEqual(t, { first_message: true, pick_skill: false })
})

test("fetchTasks 认裸数组与纯字符串元素", async () => {
  const fetchImpl = fakeFetch(ok(["first_message", { taskKey: "pick_skill", finished: true }]))
  const t = await fetchTasks({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.deepEqual(t, { first_message: true, pick_skill: true })
})

test("completeTask 发 key 并回传积分", async () => {
  const fetchImpl = fakeFetch(ok({ points: 500 }))
  const r = await completeTask({ baseUrl: BASE, auth: AUTH, fetchImpl }, "first_message")
  assert.deepEqual(r, { ok: true, points: 500 })
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { key: "first_message" })
})

// ── 邀请码 ─────────────────────────────────────────────────────────────

test("fetchActivation 读激活状态", async () => {
  const fetchImpl = fakeFetch(ok({ activated: true, inviteCode: "ABC123" }))
  const a = await fetchActivation({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.deepEqual(a, { activated: true, applied: "ABC123" })
})

test("fetchInvitationCodes 认 inviteCode 字段（不是 code）—— 踩过的坑", async () => {
  const fetchImpl = fakeFetch(
    ok({
      list: [
        { inviteCode: "E3HRN8", usedCount: 1, maxUses: 1, status: "exhausted" },
        { inviteCode: "SSK5MC", usedCount: 0, maxUses: 1, status: "active" },
      ],
    }),
  )
  const list = await fetchInvitationCodes({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.deepEqual(list, [
    { code: "E3HRN8", usedCount: 1, maxUses: 1, status: "exhausted" },
    { code: "SSK5MC", usedCount: 0, maxUses: 1, status: "active" },
  ])
})

test("fetchInvitationCodes 也认 code 字段与 {data:{list}} 外层包装", async () => {
  const fetchImpl = fakeFetch(ok({ data: { list: [{ code: "X1" }] } }))
  const list = await fetchInvitationCodes({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.deepEqual(list.map((x) => x.code), ["X1"])
})

test("fetchInvitationCodes 认裸数组与纯字符串元素", async () => {
  const fetchImpl = fakeFetch(ok(["ABC123", { inviteCode: "DEF456" }]))
  const list = await fetchInvitationCodes({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.deepEqual(list.map((x) => x.code), ["ABC123", "DEF456"])
})

test("fetchInvitationCodes 空列表返回空数组", async () => {
  const fetchImpl = fakeFetch(ok({ list: [] }))
  assert.deepEqual(await fetchInvitationCodes({ baseUrl: BASE, auth: AUTH, fetchImpl }), [])
})

test("maxUses: 0 是「不限次数」，不能被吞成 1", async () => {
  const fetchImpl = fakeFetch(ok({ list: [{ inviteCode: "UNLIM", usedCount: 6, maxUses: 0, status: "active" }] }))
  const [c] = await fetchInvitationCodes({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.equal(c.maxUses, 0, "0 要原样保留 —— 吞成 1 会让不限次的码显示成已用完")
  assert.equal(c.usedCount, 6)
})

test("maxUses 缺失时保守按 1 处理", async () => {
  const fetchImpl = fakeFetch(ok({ list: [{ inviteCode: "NOMAX", usedCount: 0 }] }))
  const [c] = await fetchInvitationCodes({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.equal(c.maxUses, 1)
})

test("部分使用的码保持 active 状态（6/20 不该标成已用完）", async () => {
  const fetchImpl = fakeFetch(ok({ list: [{ inviteCode: "PART", usedCount: 6, maxUses: 20, status: "active" }] }))
  const [c] = await fetchInvitationCodes({ baseUrl: BASE, auth: AUTH, fetchImpl })
  assert.equal(c.status, "active")
  assert.equal(c.usedCount, 6)
  assert.equal(c.maxUses, 20)
})
