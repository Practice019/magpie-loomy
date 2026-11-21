// usage-panel.test.mjs 面板「刷新额度」按钮：**存在**，且打开页面**不触发**。
//
// # 两个方向都要钉
//
//	① 按钮存在、接的是 `/api/usage/refresh`、能只刷勾选的账号
//	② 打开页面**不发**这个请求（用户原话：「不要让它自动打」）
//
// ② 用两种证据：
//   · 静态：`startJob("usage"` 只出现在 click 监听器里（没有顶层调用、没有定时器）
//   · 运行时：真的起一个面板服务，用计数器 fetch 请求首页与所有首屏 GET → 上游 0 次

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer } from "../server.mjs"

const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")
const js = readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")

test("① index.html 有「刷新额度」按钮（唯一的手动写入口）", () => {
  assert.match(html, /id="usage-refresh"/, "按钮必须存在，否则用户没有办法更新额度")
  assert.match(html, />刷新额度</, "按钮文案要写清是「刷新额度」")
  // 提示语要说明「不点就不查」（这是用户最关心的行为）
  const tag = /<button[^>]*id="usage-refresh"[^>]*>/.exec(html)?.[0] ?? ""
  assert.match(tag, /title="[^"]*不点就不查/, `按钮要说明「不点就不查」，实际: ${tag}`)
})

test("①′ app.js：额度进同一套 job 机制（JOB_PATH / JOB_LABEL / 轮询）", () => {
  assert.match(js, /usage:\s*"\/api\/usage\/refresh"/, "必须接 /api/usage/refresh")
  assert.match(js, /JOB_LABEL\s*=\s*\{[^}]*usage:/, "要有人话标签（进度条上显示「额度」）")
  assert.match(js, /jobs:\s*\{\s*balance:\s*null,\s*usage:\s*null/, "state.jobs 要留 usage 位")
})

test("② 打开页面**不触发**：`startJob(\"usage\"` 只出现在 click 监听里，没有自动调用", () => {
  const calls = [...js.matchAll(/startJob\("usage"/g)]
  assert.ok(calls.length >= 1, "按钮监听器里必须有这个调用（否则按钮是死的）")

  // 监听器位置
  const listenerAt = js.indexOf('$("#usage-refresh").addEventListener')
  assert.ok(listenerAt > 0, "必须有 #usage-refresh 的 click 监听器")

  for (const call of calls) {
    assert.ok(
      call.index > listenerAt,
      `startJob("usage") 出现在监听器之前，可能是加载即调用（第 ${call.index} 字符）`,
    )
  }

  // 不许用定时器 / 轮询在加载时自动跑（那等于「自动打上游」）
  for (const bad of [/setInterval\(/, /setTimeout\([^)]*startJob/, /^\s*await startJob\("usage"/m]) {
    assert.doesNotMatch(js, bad, `不许自动触发额度刷新：${bad}`)
  }

  // 没有勾选时**不替用户刷全部**（那正是要关掉的行为）
  const listener = js.slice(listenerAt, listenerAt + 900)
  assert.match(listener, /state\.selected/, "必须只看勾选的账号")
  assert.match(listener, /请先勾选/, "没勾选要提示，而不是刷新全部")
})

test("②′ 运行时证据：打开面板（首页 + 五个首屏 GET）→ 上游请求 0 次", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loomy-usage-panel-"))
  /** @type {Record<string, any>} */
  const auth = {}
  for (let i = 0; i < 3; i += 1) {
    auth[`loomy#${i}`] = { access: "s".repeat(32), metadata: { uid: `u${i}`, nickname: `号${i}` } }
  }
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(auth))

  let calls = 0
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://mock.invalid/api/v1",
    log: { warn() {} },
    fetchImpl: async () => {
      calls += 1
      return Response.json({ code: "000000", data: { balance: 1, dailyBalance: 1, availableBalance: 1 } })
    },
  })
  t.after(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const get = (path) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method: "GET" }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve({ status: res.statusCode, text }))
    })
    req.on("error", reject)
    req.end()
  })

  // 页面 + 静态资源 + 首屏全部 GET（app.js 打开时确实调的就是这几个）
  for (const path of ["/", "/assets/app.js", "/api/hello", "/api/settings", "/api/accounts", "/api/tasks", "/api/invite", "/api/route-state"]) {
    const res = await get(path)
    assert.equal(res.status, 200, `${path} 应当 200`)
  }
  assert.equal(calls, 0, `打开面板不许发任何上游请求（含额度），实际 ${calls} 次`)

  // 反向确认：**点了**之后才会走（证明计数器/链路是活的，不是永远 0）
  const posted = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path: "/api/usage/refresh", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on("error", reject)
    req.end(JSON.stringify({ uids: ["u0"] }))
  })
  assert.equal(posted.status, 200)
  assert.ok(posted.body.jobId, "点按钮后才会有任务")
})