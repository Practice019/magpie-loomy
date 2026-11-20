// page-focus.test.mjs —— 「切回窗口自动重读」改成**默认关闭**的开关，
// 并修掉三处误导性日志（假失败 / 重复刷屏 / 首屏措辞）。
//
// # 为什么要这一集
//
// 用户原话：「我希望禁止自动刷新 因为发请求都是有风险的」。
// 诊断结论：那次「自动重读」其实**只打 5 个本地缓存 GET**，从不碰上游；
// 但它写死常开，日志又说「自动重读失败：邀请码查询部分失败」——
// 失败是 `/api/invite` 从 `invite-cache.json` 里带回来的**上次真实查询**的原文，
// 不是这次请求的结果。用户看到的就是「面板在偷偷发请求且失败了」。
//
// 所以这里钉三件事，每条都能被源码 / 逻辑证明：
//   ① 开关默认关，且在 `refreshOnFocus()` 第一行早退；
//   ② 日志措辞区分「缓存里的旧错误」与「本次失败」；
//   ③ `refreshOnFocus()` 的调用链里**不存在**任何会打上游的端点。

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { PANEL_SETTINGS_DEFAULTS } from "../server.mjs"

const js = readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")
const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")

/** 取一个函数体源码：从 `header` 出现处，按花括号配平截到函数结束。 */
function functionBody(source, header) {
  const start = source.indexOf(header)
  assert.ok(start >= 0, `源码里找不到函数：${header}`)
  const open = source.indexOf("{", start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  assert.fail(`函数 ${header} 的花括号没有配平`)
}

const refreshOnFocusBody = () => functionBody(js, "async function refreshOnFocus(")
const renderServiceClockBody = () => functionBody(js, "async function renderServiceClock(")
const loadInitialBody = () => functionBody(js, "async function loadInitial(")
const loadSettingsBody = () => functionBody(js, "async function loadSettings(")
const saveSettingBody = () => functionBody(js, "async function saveSetting(")

// ── 1. 服务端默认值 ────────────────────────────────────────────────────
test("默认关闭：PANEL_SETTINGS_DEFAULTS.focusRefresh === false", () => {
  assert.equal(PANEL_SETTINGS_DEFAULTS.focusRefresh, false, "自动重读默认必须是关（发请求有风险）")
  // 默认值必须是**显式**存在的键，否则 `readPanelSettings` 的 `key in data` 过滤会把它丢掉
  assert.ok(Object.prototype.hasOwnProperty.call(PANEL_SETTINGS_DEFAULTS, "focusRefresh"), "focusRefresh 必须显式写进默认值对象")
})

// ── 2. 前端早退 ────────────────────────────────────────────────────────
test("开关关着时 refreshOnFocus 直接早退，且早退是函数体的第一条语句", () => {
  const body = refreshOnFocusBody()
  assert.match(body, /if\s*\(\s*!state\.panel\?\.focusRefresh\s*\)\s*return false/, "必须有 `if (!state.panel?.focusRefresh) return false` 早退")
  const firstStatement = body.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
  assert.match(firstStatement, /^if\s*\(\s*!state\.panel\?\.focusRefresh\s*\)\s*return false/, "早退必须排在节流 / 并发检查之前（开关关着就什么都不做）")
})

test("设置里的 focusRefresh 读进 state.panel：loadSettings / saveSetting 都接上，syncSettingsFields 也同步复选框", () => {
  assert.match(loadSettingsBody(), /focusRefresh\s*:\s*settings\.focusRefresh\s*===\s*true/, "loadSettings 必须只认严格的 true（缺字段 = 关）")
  assert.match(saveSettingBody(), /focusRefresh\s*:\s*settings\.focusRefresh\s*===\s*true/, "saveSetting 的回写也要跟服务端值走")
  const sync = functionBody(js, "function syncSettingsFields(")
  // 复选框要能被服务端「关」覆盖（不能用 `!== false`：那样 undefined 会变成勾上）
  assert.match(sync, /#setting-focus-refresh[\s\S]*?checked\s*=\s*state\.panel\.focusRefresh\s*===\s*true/, "syncSettingsFields 必须用 `=== true` 勾选")
  assert.match(js, /#setting-focus-refresh"?\)\?\.addEventListener\("change"[^\n]*saveSetting\(\{\s*focusRefresh:/, "复选框 change 必须走 saveSetting({ focusRefresh })")
})

// ── 3. HTML 开关 ───────────────────────────────────────────────────────
test("index.html 设置区有 setting-focus-refresh 复选框，且默认不勾", () => {
  const label = /<label class="check"><input type="checkbox" id="setting-focus-refresh">\s*切回窗口时重读缓存<\/label>\s*<small>只读本地缓存文件，不发任何上游请求；默认关闭。<\/small>/
  assert.match(html, label, "复选框与说明文案必须与需求一致")
  const tag = /<input type="checkbox" id="setting-focus-refresh"[^>]*>/.exec(html)
  assert.ok(tag, "找不到 setting-focus-refresh 的 input")
  assert.doesNotMatch(tag[0], /\bchecked\b/, "默认必须不勾（checked 会让首屏就是开着的）")
})

// ── 4. 日志措辞 ────────────────────────────────────────────────────────
test("日志区分「缓存里的旧错误」与「本次失败」，且三条文案都标明未触发上游", () => {
  const body = refreshOnFocusBody()
  assert.match(body, /已重读本地缓存（未触发任何上游请求）/, "成功路径文案要说清只读了本地缓存")
  assert.match(body, /缓存里有 \$\{failures\} 个账号的上次查询失败（不是本次请求）/, "旧错误要标成「上次查询失败（不是本次请求）」")
  assert.match(body, /重读本地缓存失败：\$\{e\.message\}（未触发任何上游请求）/, "catch 分支也要标明未触发上游")
  assert.doesNotMatch(body, /自动重读失败/, "「自动重读失败」这个假失败措辞必须消失")
  // 统计必须同时覆盖 invites 与 tasks（缓存里只有这两类行带 error）
  const counter = functionBody(js, "function cachedFailures(")
  assert.match(counter, /state\.invites\.values\(\)[\s\S]*?row\?\.error/, "cachedFailures 要扫 invites")
  assert.match(counter, /state\.tasks\.values\(\)[\s\S]*?row\?\.error/, "cachedFailures 要扫 tasks")
  // 路径上不许再出现 `queries(...)`：它会把「某行 error」抛成整体失败（就是假失败的根因）
  assert.doesNotMatch(body, /await queries\(/, "refreshOnFocus 不得再用 queries() 把旧错误当成本次失败")
})

// ── 5. 启动日志去重（源码 + 逻辑）────────────────────────────────────────
test("服务启动日志有 serviceLoggedSince 去重：同一次启动只打一次，服务重启才再打", async () => {
  assert.match(js, /serviceLoggedSince/, "必须有 state.serviceLoggedSince")
  const body = renderServiceClockBody()
  assert.match(body, /if\s*\(\s*state\.serviceLoggedSince\s*!==\s*since\s*\)\s*\{/, "打日志前必须比较 since")
  assert.match(body, /state\.serviceLoggedSince\s*=\s*since/, "打完必须记住 since")

  // 逻辑断言：把**源码里那一段去重逻辑原样摘出来**跑两轮，数「服务启动于」出现几次
  const guard = body.match(/if \(state\.serviceLoggedSince !== since\) \{[\s\S]*?\n\s*\}/)
  assert.ok(guard, "找不到去重代码块")
  const lines = []
  const state = { serviceLoggedSince: 0 }
  const probe = new Function("state", "log", "full", "age", "since", `${guard[0]}`)
  probe(state, (source, message) => lines.push(`${source}:${message}`), (ms) => String(ms), "1 小时", 1000)
  probe(state, (source, message) => lines.push(`${source}:${message}`), (ms) => String(ms), "1 小时", 1000)
  assert.equal(lines.length, 1, "同一个 since 连调两次只许打一行")
  assert.match(lines[0], /服务启动于/, "文案要保持「服务启动于 …」")
  assert.equal(state.serviceLoggedSince, 1000, "打完要记住 since")
  probe(state, (source, message) => lines.push(`${source}:${message}`), (ms) => String(ms), "2 小时", 2000)
  assert.equal(lines.length, 2, "服务重启（since 变了）才再打一次")
})

// ── 6. 不打上游（源码可证）───────────────────────────────────────────────
test("refreshOnFocus 的调用链里没有任何会打上游的端点", () => {
  const body = refreshOnFocusBody()
  for (const forbidden of ["refresh-batch", "/api/do", "route-check"]) {
    assert.ok(!body.includes(forbidden), `refreshOnFocus 里不得出现 ${forbidden}`)
  }
  // 允许的端点只有注释里写明的那 5 个缓存 GET
  const endpoints = [...body.matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1])
  for (const endpoint of endpoints) {
    assert.ok(["/api/accounts", "/api/settings", "/api/tasks", "/api/invite", "/api/route-state"].includes(endpoint), `出现了未知端点 ${endpoint}`)
  }

  // 顺着调用链走：refreshOnFocus → balances/tasks/invites/routeStates/loadSettings → 它们的 fetch 路径
  const reachableHeaders = ["async function balances(", "async function tasks(", "async function invites(", "async function routeStates(", "async function loadSettings(", "async function queries("]
  const chain = reachableHeaders.map((header) => functionBody(js, header)).join("\n")
  const chainEndpoints = [...chain.matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1])
  const allowed = ["/api/accounts", "/api/settings", "/api/tasks", "/api/invite", "/api/route-state"]
  for (const endpoint of chainEndpoints) {
    assert.ok(allowed.includes(endpoint), `调用链里出现了会打上游的端点 ${endpoint}`)
  }
  for (const forbidden of ["refresh-batch", "/api/do", "route-check"]) {
    assert.ok(!chain.includes(forbidden), `调用链里出现了会打上游的标记 ${forbidden}`)
  }
})

// ── 4b. 首屏日志：一行，说清只读缓存 ──────────────────────────────────────
test("首屏日志统一成「已载入本地缓存（未触发任何上游请求）」，且只有一行", () => {
  const body = loadInitialBody()
  assert.match(body, /log\("面板", "首屏已载入本地缓存（未触发任何上游请求）"\)/, "loadInitial 成功后必须有这一行")
  assert.doesNotMatch(body, /已读取本地缓存/, "旧的模糊文案要统一掉，不能并存两行")
  assert.equal((body.match(/首屏已载入本地缓存/g) ?? []).length, 1, "只允许打一次")
})

// ── 4c. 事件监听保留注册（运行时能开）────────────────────────────────────
test("两个事件监听仍然注册：开关可以运行时打开", () => {
  assert.match(js, /document\.addEventListener\("visibilitychange",[\s\S]{0,200}?refreshOnFocus\(\)/, "visibilitychange 仍要接 refreshOnFocus")
  assert.match(js, /addEventListener\("focus",[\s\S]{0,200}?refreshOnFocus\(\)/, "focus 仍要接 refreshOnFocus")
  assert.match(js, /const FOCUS_REFRESH_MS = 5000/, "开关打开时节流 5 秒仍要保留")
})