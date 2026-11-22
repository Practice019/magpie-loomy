// route-batch-page.test.mjs 面板层断言（批量检测按钮 / hint 文案）。
//
// 这里只做**最小 DOM 夹具**：解析 index.html 的元素、注入假的 fetch 与定时器，
// 然后照 app.js 的真实加载路径跑一遍。目的是钉死「勾选 0 个时按钮 disabled、
// hint 带跳过/约扣、批量完成后变成完成文案」—— 文案是用户唯一能看见的东西。
//
// ⚠ 首屏请求集合必须仍是那 4 个（accounts/settings/tasks/invite）：
// 页面**不得**在打开时自动触发任何刷新任务。

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

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
  addEventListener(name, listener) {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
  }
  emit(name, event = {}) { return Promise.all((this.listeners.get(name) ?? []).map((fn) => fn({ target: this, preventDefault() {}, ...event }))) }
  click() { if (!this.disabled) return this.emit("click") }
  focus() { this.focused = true }
  closest(selector) { return matches(this, selector) ? this : null }
}

function parse(markup) {
  return [...markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].map((m) => new Element(m[1], attributes(m[2])))
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

const tick = () => new Promise((r) => setImmediate(r))

const accounts = [
  { uid: "u0", phone: "p0", name: "甲号", firstLogin: true, cached: true, at: 1795052000000, quota: { windows: [{ name: "可用总额", amount: 10 }, { name: "每日赠送", amount: 5 }, { name: "永久积分", amount: 5 }] } },
  { uid: "u1", phone: "p1", name: "乙号", firstLogin: false, cached: false, at: 0 },
]

function harness(responses) {
  const nodes = parse(html)
  const all = () => nodes.flatMap((el) => [el, ...el.children])
  const document = {
    currentScript: { src: "https://panel.invalid/assets/app.js" },
    querySelectorAll: (selector) => all().filter((el) => selector.split(",").some((part) => matches(el, part))),
    querySelector: (selector) => document.querySelectorAll(selector)[0] ?? null,
  }
  const calls = []
  const pending = new Set()
  const warns = []
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    const call = { path: parsed.pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const task = (async () => {
      const custom = responses?.(call)
      if (custom !== undefined) return { ok: true, status: 200, json: async () => custom }
      const data = call.path === "/api/settings" ? { ok: true, settings: { accountConcurrency: 20, bindConcurrency: 20, batchConcurrency: 2, balanceConcurrency: 2, batchSkipChecked: true, ledgerReads: 3 }, defaults: {} }
        : call.path === "/api/hello" ? { ok: true, since: 1795050000000, uptimeMs: 600000, pid: 4242 }: call.path === "/api/accounts" ? { ok: true, accounts, updatedAt: 1795052000000 }: call.path === "/api/route-state" ? { ok: true, state: {} }
          : call.path === "/api/tasks" ? { ok: true, rows: [] }
            : call.path === "/api/invite" ? { ok: true, rows: [] }
              // 速率表（T-62）：首屏只读它（零请求）
              : call.path === "/api/speed" ? { ok: true, updatedAt: 0, b: {}, accounts: [] }
                : assert.fail(`Unexpected request: ${url}`)
      return { ok: true, status: 200, json: async () => data }
    })()
    pending.add(task)
    try { return await task } finally { pending.delete(task) }
  }
  runInNewContext(source, {
    document, fetch, navigator: {}, localStorage: undefined, URL,
    console: { warn: (...args) => warns.push(args.join(" ")), log() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {},
  }, { filename: "page/assets/app.js", timeout: 2000 })
  const settle = async () => {
    for (let i = 0; i < 60; i += 1) {
      await tick()
      if (pending.size === 0 && !document.querySelector("#route-refresh").disabled) return
    }
    assert.fail("页面没有结束忙碌状态")
  }
  const get = (selector) => {
    const node = document.querySelector(selector)
    assert.ok(node, `缺少 DOM 元素: ${selector}`)
    return node
  }
  return { get, calls, settle, warns, document }
}

test("首屏只读缓存：批量按钮初始 disabled，hint 写清「约扣 N 积分」", async () => {
  const f = await harness()
  await f.settle()
  // 首屏只读缓存的 6 个 GET（含 T-62 的速率表），且不得出现任何刷新/探测请求
  assert.deepEqual([...new Set(f.calls.map((c) => c.path))].sort(), ["/api/accounts", "/api/hello", "/api/invite", "/api/route-state", "/api/settings", "/api/speed", "/api/tasks"])
  const button = f.get("#route-check-selected")
  assert.equal(button.disabled, true, "没勾选时批量按钮必须 disabled")
  assert.match(button.textContent, /检测选中 \(0\)/)
  const hint = f.get("#route-batch-hint")
  assert.match(hint.textContent, /跳过/)
  assert.match(hint.textContent, /约扣 0 积分/)
  assert.equal(f.get("#accounts-cache-note").textContent.includes("数据截至"), true)
})

test("勾选后 hint 数字跟着变，批量完成后变「检测完成」", async () => {
  let jobPolls = 0
  const f = await harness((call) => {
    if (call.path === "/api/route-check-batch" && call.method === "POST") return { ok: true, jobId: "job-1", total: 1, skipped: ["u0"] }
    if (call.path === "/api/route-check-batch") {
      jobPolls += 1
      return {
        ok: true,
        job: {
          jobId: "job-1", total: 1, done: 1, okCount: 1, failCount: 0, running: false, stopped: "", skippedTotal: 1,
          results: { u1: { verdict: "clean", servedModel: "DeepSeek-V4.1-Flash", checkedAt: 1, label: "正常", costHint: "已扣 1 积分" } },
        },
      }
    }
    return undefined
  })
  await f.settle()
  f.get("#select-all").checked = true
  await f.get("#accounts-list").emit("change", { target: f.get("#select-all") })
  // 勾了 2 个、其中 u0 已有缓存结论但没有路由结论 → 跳过 0、待测 2
  assert.match(f.get("#route-batch-hint").textContent, /约扣 2 积分/)
  assert.equal(f.get("#route-check-selected").disabled, false)

  await f.get("#route-check-selected").click()
  await f.settle()
  assert.equal(jobPolls, 1)
  const hint = f.get("#route-batch-hint").textContent
  assert.match(hint, /检测完成 1\/1/)
  // 汇总按结论分类，不再用「成功 / 失败」两个粗粒度数字
  assert.match(hint, /正常 1 · 受限 0 · 登录失效 0 · 未检测 0/)
  assert.match(hint, /跳过 1 个已检测/)
})