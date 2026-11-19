// html-structure.test.mjs 面板 HTML 结构 + 判据收敛 + 服务启动时间。
//
// # 为什么需要这一集
//
// 用户截图里的「三张卡被压成竖条、表格被挤走」**不是样式问题**：`index.html`
// 里 `<section class="stats">` 被复制成了两行，`<section` 比 `</section>` 多一个。
// 于是内层 `.stats` 成了外层的子节点，grid 只作用在内层 —— 结构错位看起来像
// 「布局崩了」。这类错误人眼只能靠截图发现，必须由 CI 拦住。
//
// 同时还钉两件与它同批交付的事：
//   ① 判据收敛到 verdict（reason 只负责文案）
//   ② 顶栏能显示服务端启动时间（区分旧进程）

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import { startServer } from "../server.mjs"

const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")
const js = readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")

const count = (text, pattern) => (text.match(pattern) ?? []).length

test("index.html：统计卡只有一份，标签全部闭合", () => {
  assert.equal(count(html, /<section class="stats"/g), 1, "`<section class=\"stats\">` 只能出现一次")
  assert.equal(count(html, /<section\b/g), count(html, /<\/section>/g), "`<section` 与 `</section>` 必须相等")
  assert.equal(count(html, /<div\b/g), count(html, /<\/div>/g), "`<div` 与 `</div>` 必须相等")
})

test("index.html：三张统计卡在同一个 .stats 里", () => {
  const start = html.indexOf('<section class="stats"')
  assert.ok(start >= 0)
  const end = html.indexOf("</section>", start)
  const block = html.slice(start, end)
  for (const id of ["stat-total", "stat-healthy", "stat-unhealthy"]) {
    assert.ok(block.includes(`id="${id}"`), `${id} 必须在同一个 .stats 区块内`)
  }
  // 内层再出现一次 .stats 就是结构错位（就是这次的事故形态）
  assert.ok(!block.slice(block.indexOf(">") + 1).includes('<section class="stats"'), ".stats 不得嵌套自身")
})

test("判据只看 verdict：routed + account-disabled 也算「不健康」并被跳过", async (t) => {
  // 服务端：splitRouteTargets 只认 verdict → 把这个「未来可能出现的组合」跳过
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { request } = await import("node:http")
  const dir = mkdtempSync(join(tmpdir(), "loomy-verdict-test-"))
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({
    loomy: { access: "a".repeat(32), metadata: { uid: "u0" } },
    "loomy#1": { access: "b".repeat(32), metadata: { uid: "u1" } },
  }))
  let probes = 0
  const store = {
    routeStatePath: (d) => join(d, "loomy-route-state.json"),
    readRouteState(d) {
      try { return { ok: true, data: JSON.parse(readFileSync(join(d, "loomy-route-state.json"), "utf8")) } } catch { return { ok: true, data: {} } }
    },
    writeRouteState(d, uid, entry) {
      const cur = this.readRouteState(d).data
      writeFileSync(join(d, "loomy-route-state.json"), JSON.stringify({ ...cur, [uid]: entry }))
      return { ok: true }
    },
    getAccountRoute(d, uid) { return this.readRouteState(d).data[uid] ?? null },
  }
  writeFileSync(join(dir, "loomy-route-state.json"), JSON.stringify({
    u0: { verdict: "routed", reason: "account-disabled" },
    u1: { verdict: "unknown", reason: "ledger-unreadable" },
  }))
  const server = await startServer({
    port: 0, configDir: dir, clientStoreDir: "", log: { warn() {} },
    routeModules: { probeRoute: async () => { probes += 1; return { verdict: "clean", checkedAt: 1 } }, ...store },
    fetchImpl: async () => { throw new Error("不该有上游请求") },
  })
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }) })
  const started = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path: "/api/route-check-batch", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve(JSON.parse(text)))
    })
    req.on("error", reject)
    req.end(JSON.stringify({ uids: ["u0", "u1"] }))
  })
  // u0 是 routed + account-disabled（reason 不认识也要跳过）；u1 是 unknown 要重测
  assert.equal(started.total, 1)
  assert.deepEqual(started.skipped, ["u0"])
})

test("判据只看 verdict：exhausted（积分不足）也算已有结论", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { request } = await import("node:http")
  const dir = mkdtempSync(join(tmpdir(), "loomy-exhausted-test-"))
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({
    loomy: { access: "a".repeat(32), metadata: { uid: "u0" } },
    "loomy#1": { access: "b".repeat(32), metadata: { uid: "u1" } },
  }))
  writeFileSync(join(dir, "loomy-route-state.json"), JSON.stringify({
    u0: { verdict: "exhausted", reason: "no-quota" },
    u1: { verdict: "unknown", reason: "ledger-unreadable" },
  }))
  const store = {
    routeStatePath: (d) => join(d, "loomy-route-state.json"),
    readRouteState(d) {
      try { return { ok: true, data: JSON.parse(readFileSync(join(d, "loomy-route-state.json"), "utf8")) } } catch { return { ok: true, data: {} } }
    },
    writeRouteState(d, uid, entry) {
      const cur = this.readRouteState(d).data
      writeFileSync(join(d, "loomy-route-state.json"), JSON.stringify({ ...cur, [uid]: entry }))
      return { ok: true }
    },
    getAccountRoute(d, uid) { return this.readRouteState(d).data[uid] ?? null },
  }
  const server = await startServer({
    port: 0, configDir: dir, clientStoreDir: "", log: { warn() {} },
    routeModules: { probeRoute: async () => ({ verdict: "clean", checkedAt: 1 }), ...store },
    fetchImpl: async () => { throw new Error("不该有上游请求") },
  })
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }) })
  const started = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path: "/api/route-check-batch", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve(JSON.parse(text)))
    })
    req.on("error", reject)
    req.end(JSON.stringify({ uids: ["u0", "u1"] }))
  })
  assert.deepEqual(started.skipped, ["u0"], "exhausted 必须被跳过（重测也是不足）")
  assert.equal(started.total, 1, "只有 unknown 需要重测")
})

test("前端 isSettled 只看 verdict（reason 不参与）", () => {
  const fn = js.slice(js.indexOf("function isSettled("), js.indexOf("}", js.indexOf("function isSettled(")) + 1)
  assert.ok(fn.includes("verdict"), "判据必须读 verdict")
  assert.ok(!/reason/.test(fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "判据不得读 reason")
  // 用 vm 跑同一段逻辑，验证三种 verdict
  const isSettled = new Function(`${fn}; return isSettled`)()
  assert.equal(isSettled({ verdict: "clean" }), true)
  assert.equal(isSettled({ verdict: "routed", reason: "account-disabled" }), true)
  assert.equal(isSettled({ verdict: "expired", reason: "session-expired" }), true)
  assert.equal(isSettled({ verdict: "exhausted", reason: "no-quota" }), true)
  assert.equal(isSettled({ verdict: "unknown" }), false)
  assert.equal(isSettled({}), false)
})

test("/api/hello 返回由 process.uptime() 反推的 since", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { request } = await import("node:http")
  const dir = mkdtempSync(join(tmpdir(), "loomy-hello-test-"))
  writeFileSync(join(dir, "plugin-auth.json"), "{}")
  const server = await startServer({ port: 0, configDir: dir, clientStoreDir: "", log: { warn() {} }, routeModules: null, fetchImpl: async () => { throw new Error("no net") } })
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }) })
  const hello = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path: "/api/hello" }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve(JSON.parse(text)))
    })
    req.on("error", reject)
    req.end()
  })
  assert.equal(typeof hello.since, "number")
  assert.ok(hello.since > 0)
  // since 必须早于「现在」，且与 uptimeMs 自洽（误差 5 秒内）
  assert.ok(Date.now() - hello.since >= hello.uptimeMs - 5000)
  assert.ok(typeof hello.uptimeMs === "number" && hello.uptimeMs >= 0)
})

test("面板渲染服务启动时间（启动 字样），且不覆盖 #status 正文", () => {
  assert.match(js, /async function renderServiceClock/)
  assert.match(js, /el\.dataset\.serviceLabel = `启动 /)
  assert.match(js, /process\.uptime|uptimeMs/, "服务端必须用 uptime 反推")
  // 只写 title/dataset/日志，不写 textContent（正文归状态机）
  const block = js.slice(js.indexOf("async function renderServiceClock"), js.indexOf("\n}\n", js.indexOf("async function renderServiceClock")))
  assert.ok(!block.includes("el.textContent"), "#status 正文由状态机负责，别在这里覆盖")
})

void runInNewContext