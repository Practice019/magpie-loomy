// speed-panel.test.mjs —— 面板上的「速率」列 / 「刷新速率」按钮 / 设置开关（T-62）。
//
// # 这一集在钉什么
//
//   · 打开面板**只读** `GET /api/speed`（服务端只读缓存文件）：**零上游**，
//     而且**不**触发 `POST /api/speed/refresh`（那是「刷新速率」按钮的活）。
//   · 账号表新增「速率」列，三态显示：normal → `126.5 tok/s`；
//     slow → 红字 `24.0 tok/s ⚠️已跳过`；unknown → `—`。
//   · 点「刷新速率」→ `POST /api/speed/refresh` → 日志
//     `速率已更新：N 行 / M 个模型 / K 个慢号`。
//   · 设置页有「按速率跳过慢号」开关（`#setting-speed-skip`），改动即走 saveSetting。
//
// ⚠ 本集用真 HTML（`page/index.html`）+ 真 app.js，在 vm 里跑一遍首屏；
//   元素按选择器现造（不解析 DOM），只要行为对得上即可。

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"

const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")
const source = readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")

const NOW = Date.parse("2026-11-22T16:00:00+08:00")
const MODEL = "deepseek-v4-flash-1017"

/** 一个"什么都能写"的元素（id 就是它被查出来的选择器）。 */
function makeElement(selector) {
  const el = {
    selector,
    id: selector.startsWith("#") ? selector.slice(1) : "",
    markup: "",
    text: "",
    className: "",
    title: "",
    checked: false,
    disabled: false,
    dataset: {},
    attrs: {},
    children: [],
    listeners: new Map(),
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c) },
      remove(c) { this._set.delete(c) },
      contains(c) { return this._set.has(c) },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : Boolean(force)
        if (on) this._set.add(c)
        else this._set.delete(c)
        return on
      },
    },
    // `#account-filter` / `#invite-filter` 的真值来自 HTML 里的 <option selected>
    get value() {
      if (this.id === "account-filter" || this.id === "invite-filter") return "all"
      return this._value ?? ""
    },
    set value(v) { this._value = v },
    get innerHTML() { return this.markup },
    set innerHTML(v) { this.markup = String(v) },
    get textContent() { return this.text },
    set textContent(v) { this.text = String(v) },
    addEventListener(name, fn) {
      const list = this.listeners.get(name) ?? []
      list.push(fn)
      this.listeners.set(name, list)
    },
    async emit(name, event = {}) {
      const list = this.listeners.get(name) ?? []
      return Promise.all(list.map((fn) => fn({ target: this, preventDefault() {}, ...event })))
    },
    click() { return this.emit("click") },
    closest(selector) { return selector === this.selector ? this : null },
    querySelector(selector) { return makeElement(selector) },
    querySelectorAll() { return [] },
    appendChild() {},
    setAttribute(name, value) { this.attrs[name] = String(value) },
    getAttribute(name) { return this.attrs[name] ?? null },
  }
  return el
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * 在 vm 里跑一遍真 app.js。
 *
 * `handler(call)` 可以拦某个接口；返回 undefined 时走默认表。
 */
async function fixture(handler) {
  /** @type {Map<string, any>} */
  const elements = new Map()
  const el = (selector) => {
    if (!elements.has(selector)) elements.set(selector, makeElement(selector))
    return elements.get(selector)
  }
  const document = {
    currentScript: { src: "https://panel.invalid/assets/app.js" },
    visibilityState: "visible",
    querySelector: (selector) => el(selector),
    querySelectorAll: () => [],
    addEventListener() {},
  }
  const cache = new Map()
  const localStorage = {
    getItem: (key) => cache.get(key),
    setItem: (key, value) => cache.set(key, value),
  }

  /** @type {any[]} */
  const calls = []
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    const call = { origin: parsed.origin, path: parsed.pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const custom = await handler?.(call)
    if (custom !== undefined) return custom
    if (call.path === "/api/accounts") return json({ accounts: ACCOUNTS, updatedAt: NOW, cached: true })
    if (call.path === "/api/speed") return json(SPEED)
    if (call.path === "/api/speed/refresh" && call.method === "POST") return json(REFRESHED)
    if (call.path === "/api/settings") return json({ ok: true, settings: { ...call.body } })
    if (call.path === "/api/tasks") return json({ rows: ACCOUNTS.map((a) => ({ uid: a.uid, cached: false })) })
    if (call.path === "/api/invite") return json({ rows: ACCONTS_INVITES })
    if (call.path === "/api/route-state") return json({ ok: true, state: {} })
    if (call.path === "/api/hello") return json({ ok: true, since: NOW - 600000, uptimeMs: 600000, pid: 1 })
    assert.fail(`Unexpected request: ${call.method} ${call.path}`)
  }

  const sandbox = {
    document,
    fetch,
    localStorage,
    navigator: {},
    URL,
    console: { log() {}, warn() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setImmediate,
  }
  vm.runInNewContext(source, sandbox, { filename: "page/assets/app.js", timeout: 5000 })

  // 首屏：等账号表第一次画出来（速率列就绪即说明 /api/speed 已解析 + render 跑完）
  for (let i = 0; i < 200; i += 1) {
    await tick()
    if (el("#accounts-list").innerHTML.includes("速率")) break
  }
  return { el, calls, document }
}

const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })

const ACCOUNTS = [
  { uid: "u-normal", phone: "P-normal", name: "Normal 号", firstLogin: true, cached: false, at: 0 },
  { uid: "u-slow", phone: "P-slow", name: "Slow 号", firstLogin: true, cached: false, at: 0 },
  { uid: "u-unknown", phone: "P-unknown", name: "Unknown 号", firstLogin: true, cached: false, at: 0 },
]
const ACCONTS_INVITES = ACCOUNTS.map((a) => ({ uid: a.uid, activation: {}, codes: [] }))

const SPEED = {
  ok: true,
  updatedAt: NOW,
  b: { [MODEL]: 126.5 },
  accounts: [
    { model: MODEL, account: "P-normal", lastSpeed: 126.5, calls: 40, verdict: "normal", lastAt: NOW - 60_000 },
    { model: MODEL, account: "P-slow", lastSpeed: 24, calls: 9, verdict: "slow", lastAt: NOW - 120_000 },
    { model: MODEL, account: "P-unknown", lastSpeed: null, calls: 0, verdict: "unknown", lastAt: 0 },
  ],
}
const REFRESHED = { ok: true, rows: 120, models: 2, accounts: 5, slow: 1, b: { [MODEL]: 126.5 }, updatedAt: NOW }

// ── 一、静态：控件必须存在且接线 ────────────────────────────────────────

test("#speed-refresh 按钮存在，且绑到 POST /api/speed/refresh（唯一读 magpie 的入口）", () => {
  assert.match(html, /<button id="speed-refresh"[^>]*>刷新速率<\/button>/, "工具条必须有「刷新速率」按钮")
  assert.match(
    source,
    /#speed-refresh"?\)\?\.addEventListener\("click",[\s\S]{0,400}?api\("\/api\/speed\/refresh",\s*\{\}\)/,
    "按钮必须 POST /api/speed/refresh",
  )
  // 打开面板只读 `/api/speed`（不带 refresh），而且只在 speeds() 里发
  assert.match(source, /async function speeds\(\)[\s\S]{0,400}?api\("\/api\/speed"\)/, "首屏只读 /api/speed")
  assert.match(source, /await speeds\(\)\s*\n\s*render\(\)/, "首屏加载链路里要读速率表")
})

test("设置页有「按速率跳过慢号」开关（#setting-speed-skip），且改动即保存", () => {
  assert.match(html, /<input type="checkbox" id="setting-speed-skip"[^>]*>\s*按速率跳过慢号/, "设置页必须有这个开关")
  assert.match(
    source,
    /#setting-speed-skip"?\)\?\.addEventListener\("change"[\s\S]{0,120}?saveSetting\(\{\s*speedSkip:/,
    "复选框 change 必须走 saveSetting({ speedSkip })",
  )
  assert.match(source, /#setting-speed-skip[\s\S]{0,60}?checked\s*=\s*state\.panel\.speedSkip\s*!==\s*false/, "syncSettingsFields 要回填")
})

// ── 二、运行时：打开面板零上游、零刷新 ─────────────────────────────────

test("打开面板：零上游请求，且**不**触发 /api/speed/refresh（只读 /api/speed）", async () => {
  const f = await fixture()
  const upstream = f.calls.filter((c) => c.origin !== "https://panel.invalid")
  assert.deepEqual(upstream, [], `面板不许直连任何外部地址：${upstream.map((c) => c.origin).join(",")}`)
  assert.equal(
    f.calls.filter((c) => c.path === "/api/speed/refresh").length,
    0,
    "打开面板不许刷新速率（那是用户点了才做的事）",
  )
  assert.equal(f.calls.filter((c) => c.path === "/api/speed").length, 1, "首屏读一次速率表")
})

test("账号表「速率」列三态：normal / 红字已跳过 / unknown 显示 —", async () => {
  const f = await fixture()
  const table = f.el("#accounts-list").innerHTML
  assert.ok(table.includes("速率"), "表头必须有「速率」列")
  assert.ok(table.includes("126.5 tok/s"), `normal 显示 tok/s：${table.slice(0, 200)}`)
  assert.match(table, /<span class="error"[^>]*>24\.0 tok\/s ⚠️已跳过<\/span>/, "slow 必须是红字 + 已跳过")
  assert.doesNotMatch(table, /已跳过[^<]*<\/span><\/td><td[^>]*>已跳过/, "不能整表都标已跳过")
  assert.match(table, /title="没有可用的速率记录[^"]*">—<\/span>/, "unknown 显示 —")
})

test("点「刷新速率」→ 打一次 /api/speed/refresh，日志写清 N 行 / M 模型 / K 慢号", async () => {
  const f = await fixture()
  const before = f.calls.filter((c) => c.path === "/api/speed/refresh").length
  await f.el("#speed-refresh").emit("click")
  const posts = f.calls.filter((c) => c.path === "/api/speed/refresh")
  assert.equal(posts.length - before, 1, "点一次只许刷一次")
  assert.equal(posts.at(-1).method, "POST")
  assert.match(f.el("#operation-log").textContent, /速率已更新：120 行 \/ 2 个模型 \/ 1 个慢号/, "日志文案要被钉住")
  // 刷新后仍然只读 `/api/speed` 回填（不是把 refresh 的返回直接当表用）
  assert.equal(f.calls.filter((c) => c.path === "/api/speed").length, 2, "刷新后再读一次缓存表")
})

test("速率接口不可用（旧进程）时账号表照常出数据，速率列全是 —", async () => {
  const f = await fixture((call) => {
    if (call.path === "/api/speed") throw new TypeError("Failed to fetch")
  })
  const table = f.el("#accounts-list").innerHTML
  assert.ok(table.includes("P-normal"), "账号表必须照常渲染")
  assert.match(table, /title="没有可用的速率记录[^"]*">—<\/span>/, "读不到速率就显示 —")
  assert.doesNotMatch(table, /tok\/s/, "没有数据时不许编一个速率出来")
})
