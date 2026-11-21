// expired-verdict.test.mjs「登录失效」这类结论的端到端行为。
//
// # 为什么这条必须单独测
//
// magpie 把「session 过期」的号照样算成「可用」（真机：27 个可用里混着一批
// 登不上的号）。探测现在会给出第四种结论 `verdict:"expired"` /
// `reason:"session-expired"`，面板必须：
//   · 有**自己的文案**（不能并进「未检测」）；
//   · 计入「登录失效」而**不是**「可用」；
//   · 批量里当作已有结论跳过（省积分），并在汇总里单独报数。

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import { routeLabel, routeCostHint } from "../server.mjs"

test("routeLabel / routeCostHint 认得「登录失效」，且与「被限制」不同文案", () => {
  const expired = routeLabel({ verdict: "expired", reason: "session-expired" })
  const routed = routeLabel({ verdict: "routed", reason: "ledger-spark" })
  assert.notEqual(expired, routed)
  assert.match(expired, /登录已失效/)
  assert.match(expired, /已停用/)
  assert.match(expired, /重新登录/)
  assert.equal(routeCostHint({ verdict: "expired", reason: "session-expired" }), "免费判定")
  assert.equal(routeCostHint({ verdict: "routed", reason: "ledger-spark" }), "已扣 1 积分")
  // 只给 reason 也要认（服务端不同版本可能只填 reason）
  assert.equal(routeLabel({ reason: "session-expired" }), expired)
})

// ── 面板层：统计卡片 / 筛选 / 批量汇总 ──────────────────────────────────

const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")
const source = readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")

function attributes(text) {
  return Object.fromEntries([...text.matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].map((m) => [m[1], m[2] ?? m[3] ?? m[4] ?? ""]))
}

class Element {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toLowerCase()
    this.attrs = { ...attrs }
    this.id = attrs.id ?? ""
    this.dataset = Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value]))
    this.value = attrs.value ?? ""
    this.checked = "checked" in attrs
    this.hidden = "hidden" in attrs
    this.disabled = "disabled" in attrs
    this.className = attrs.class ?? ""
    this.textContent = ""
    this.children = []
    this.listeners = new Map()
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean))
        const on = force ?? !names.has(name)
        if (on) names.add(name)
        else names.delete(name)
        this.className = [...names].join(" ")
        return on
      },
      add: (name) => this.classList.toggle(name, true),
      remove: (name) => this.classList.toggle(name, false),
    }
  }
  set innerHTML(value) { this.markup = value; this.children = parse(value) }
  get innerHTML() { return this.markup ?? "" }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return this.attrs[name] ?? null }
  addEventListener(name, fn) {
    const list = this.listeners.get(name) ?? []
    list.push(fn)
    this.listeners.set(name, list)
  }
  emit(name, event = {}) { return Promise.all((this.listeners.get(name) ?? []).map((fn) => fn({ target: this, preventDefault() {}, ...event }))) }
  click() { if (!this.disabled) return this.emit("click") }
  focus() { this.focused = true }
  closest(selector) { return matches(this, selector) ? this : null }
}

function parse(markup) {
  const nodes = [...markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].map((m) => new Element(m[1], attributes(m[2])))
  for (const match of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const node = nodes.find((el) => el.id === attributes(match[1]).id)
    const options = [...match[2].matchAll(/<option\b([^>]*)>/g)].map((m) => attributes(m[1]))
    if (node) node.value = (options.find((o) => "selected" in o) ?? options[0])?.value ?? ""
  }
  return nodes
}

function matches(el, selector) {
  selector = selector.trim()
  if (selector.endsWith(":checked")) return el.checked && matches(el, selector.slice(0, -8))
  if (selector.startsWith("#")) return el.id === selector.slice(1)
  if (selector.startsWith(".")) return el.classList.contains(selector.slice(1))
  const attr = /^(\w+)?\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(selector)
  if (attr) return (!attr[1] || el.tagName === attr[1]) && attr[2] in el.attrs && (attr[3] === undefined || el.attrs[attr[2]] === attr[3])
  return el.tagName === selector
}

/** 6 个号：2 clean · 1 routed · 1 expired · 1 exhausted（积分不足）· 1 unknown。
 *  「从没测过」的号不在 `route-state` 里 —— 由 harness 额外放一个不带状态表的号。 */
function verdictAccounts() {
  const rows = []
  const push = (verdict, reason) => {
    const uid = `u${rows.length}`
    rows.push({ uid, phone: `p${uid}`, name: uid, firstLogin: true, cached: false, at: 0, verdict, reason })
  }
  push("clean", "ledger-deepseek")
  push("clean", "ledger-deepseek")
  push("routed", "ledger-spark")
  push("expired", "session-expired")
  push("exhausted", "no-quota")
  push("unknown", "ledger-unreadable")
  return rows
}

function harness(rows) {
  const nodes = parse(html)
  const all = () => nodes.flatMap((el) => [el, ...el.children])
  const document = {
    currentScript: { src: "https://panel.invalid/assets/app.js" },
    querySelectorAll: (selector) => all().filter((el) => selector.split(",").some((part) => matches(el, part))),
    querySelector: (selector) => document.querySelectorAll(selector)[0] ?? null,
  }
  const state = Object.fromEntries(rows.filter((r) => r.verdict).map((r) => [r.uid, {
    verdict: r.verdict,
    reason: r.reason,
    label: routeLabel({ verdict: r.verdict, reason: r.reason }),
    costHint: routeCostHint({ verdict: r.verdict, reason: r.reason }),
  }]))
  const accounts = rows.map(({ verdict, reason, ...rest }) => rest)
  // 再加一个「从没测过」的号：状态表里没有它 → 统计里算「未检测」
  accounts.push({ uid: "u-never", phone: "p-never", name: "never", firstLogin: true, cached: false, at: 0 })
  const calls = []
  const pending = new Set()
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    const call = { path: parsed.pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const task = (async () => {
      const data = call.path === "/api/accounts" ? { accounts, updatedAt: 1 }
        : call.path === "/api/route-state" ? { ok: true, state }
          : call.path === "/api/settings" ? { ok: true, settings: { accountConcurrency: 20, bindConcurrency: 20, batchConcurrency: 2, balanceConcurrency: 2, batchSkipChecked: true, ledgerReads: 3 }, defaults: {} }
            : call.path === "/api/tasks" ? { rows: [] }
              : call.path === "/api/invite" ? { rows: [] }
                : call.path === "/api/route-check-batch" ? (call.method === "POST"
                  ? { ok: true, jobId: "job-1", total: 1, skipped: ["u0", "u2", "u3", "u4"] }
                  : { ok: true, job: { jobId: "job-1", total: 2, done: 2, okCount: 2, failCount: 0, running: false, stopped: "", results: { u5: { verdict: "exhausted", reason: "no-quota", label: routeLabel({ verdict: "exhausted", reason: "no-quota" }), costHint: "免费判定" } } } })
                  : null
      if (data === null) throw new Error(`Unexpected request: ${url}`)
      return { ok: true, status: 200, json: async () => data }
    })()
    pending.add(task)
    try { return await task } finally { pending.delete(task) }
  }
  runInNewContext(source, {
    document, fetch, navigator: {}, localStorage: undefined, URL,
    console: { warn() {}, log() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {},
  }, { filename: "page/assets/app.js", timeout: 2000 })
  const settle = async () => {
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setImmediate(r))
      if (pending.size === 0 && !document.querySelector("#route-refresh").disabled) return
    }
    assert.fail("页面没有结束忙碌状态")
  }
  const get = (selector) => {
    const node = document.querySelector(selector)
    assert.ok(node, `缺少 DOM 元素: ${selector}`)
    return node
  }
  return { get, calls, settle, document }
}

test("统计卡片四档：健康 = clean，不健康 = routed + expired + exhausted（2 clean / 1 routed / 1 expired / 1 exhausted / 1 unknown）", async () => {
  const f = harness(verdictAccounts())
  await f.settle()
  // 7 个号（6 个有结论 + 1 个从没测过）：健康 2、不健康 3（routed 1 + expired 1 + exhausted 1）、另有 2 个未检测（u5 的 unknown + 没测过那个）
  assert.equal(f.get("#stat-healthy").textContent, "2")
  assert.equal(f.get("#stat-unhealthy").textContent, "3")
  assert.match(f.get("#stat-unhealthy-note").textContent, /积分不足/)
  assert.match(f.get("#stat-unhealthy-note").textContent, /另有 2 个未检测/)
  assert.equal(f.get("#stat-total").textContent, "7")
  for (const id of ["stat-init", "stat-tasks", "stat-bound", "account-route-filter"]) assert.equal(f.document.querySelector("#" + id), null, id)
})

test("「只看被限制 / 只看登录失效」筛选已按截图删除，搜索与邀请状态筛选保留", async () => {
  const f = harness(verdictAccounts())
  await f.settle()
  assert.equal(f.document.querySelector("#account-route-filter"), null)
  assert.ok(f.document.querySelector("#account-search"))
  assert.ok(f.document.querySelector("#account-filter"))
  await new Promise((r) => setImmediate(r))
  f.get("#account-search").value = "u4"
  await f.get("#account-search").emit("input")
  assert.match(f.get("#account-summary").textContent, /显示 1 \/ 7/)
})
test("批量：expired 也算已有结论被跳过，汇总里单独报「登录失效」", async () => {
  const f = harness(verdictAccounts())
  await f.settle()
  // 勾选 5 个：u0(clean) · u2(routed) · u3(expired) · u4(exhausted) · u5(unknown 要重测)
  const picked = ["u0", "u2", "u3", "u4", "u5"]
  // ⚠ 页面 `state.selected` 是**闭包内**的集合，只有真正「已勾选」的 change 事件才会写入。
  // 所以先改勾选框，再派发（顺序反了页面读到的是 checked=false，选择不会累积）。
  for (const uid of picked) {
    const box = f.get(`[data-select="${uid}"]`)
    box.checked = true
    await f.get("#accounts-list").emit("change", { target: box })
  }
  assert.match(f.get("#account-summary").textContent, /已选 5/)
  // 跳过 = routed + 2 expired + clean = 4，待测 = 1（unknown 那个要重测）
  assert.match(f.get("#route-batch-hint").textContent, /将检测 1 个（跳过 4 个已检测）/)
  await f.get("#route-check-selected").click()
  await f.settle()
  const hint = f.get("#route-batch-hint").textContent
  assert.match(hint, /检测完成/)
  assert.match(hint, /跳过 4 个已检测/)
  assert.match(hint, /正常 0|正常 \d/)
  assert.match(hint, /登录失效 0|登录失效 \d/)
})
