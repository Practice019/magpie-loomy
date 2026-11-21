import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")
const source = readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")
const css = readFileSync(new URL("../page/assets/style.css", import.meta.url), "utf8")

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
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }
  emit(name, event = {}) { return Promise.all((this.listeners.get(name) ?? []).map((listener) => listener({ target: this, preventDefault() {}, ...event }))) }
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

const accounts = [
  { uid: "u0", phone: "mock-phone-0", name: "Alpha", firstLogin: true, cached: true, at: 1795052000000, quota: { windows: [{ name: "可用总额", amount: 120 }, { name: "每日赠送", amount: 20 }, { name: "永久积分", amount: 100 }] } },
  { uid: "u1", phone: "mock-phone-1", name: "Beta", firstLogin: false, cached: false, at: 0 },
  { uid: "u2", phone: "mock-phone-2", name: "Gamma", firstLogin: null, cached: false, at: 0 },
]
const inviteRows = [
  { uid: "u0", activation: { activated: false }, codes: [{ code: "OWN-A", usedCount: 2, maxUses: 0 }] },
  { uid: "u1", activation: { activated: true, applied: "APPLIED-B" }, codes: [] },
  { uid: "u2", activation: {}, codes: [] },
]
const tick = () => new Promise((resolve) => setImmediate(resolve))

async function fixture(handler, navigator = {}, localStorage) {
  const nodes = parse(html)
  const all = () => nodes.flatMap((el) => [el, ...el.children])
  const document = {
    currentScript: { src: "https://panel.invalid/assets/app.js" },
    querySelectorAll: (selector) => all().filter((el) => selector.split(",").some((part) => matches(el, part))),
    querySelector: (selector) => document.querySelectorAll(selector)[0] ?? null,
  }
  const calls = []
  const pending = new Set()
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, "https://panel.invalid")
    const call = { path: parsed.pathname, uids: parsed.searchParams.get("uids"), init, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const task = (async () => {
      const custom = await handler?.(call)
      if (custom !== undefined) return custom
      const select = (rows) => call.uids === null ? rows : rows.filter((row) => call.uids.split(",").includes(row.uid))
      const data = call.path === "/api/settings" ? { accountConcurrency: 20, bindConcurrency: 20, ...call.body }
        : call.path === "/api/accounts" ? { accounts: select(accounts), updatedAt: 1795052000000 }: call.path === "/api/hello" ? { ok: true, since: 1795050000000, uptimeMs: 600000, pid: 4242 }: call.path === "/api/route-state" ? { ok: true, state: { u1: { verdict: "routed", reason: "ledger-spark", label: "已被上游限制 · 整号停用（实际 → spark-x2.6-low）", costHint: "已扣 1 积分" } } }
        : call.path === "/api/tasks" ? { rows: select(accounts.map((a) => ({ uid: a.uid, cached: true, at: 1795052000000, tasks: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`task${i}`, a.uid === "u0"])) }))) }
          : call.path === "/api/invite" ? { rows: select(inviteRows) }
            : call.path === "/api/do" ? { ok: true, bound: 1, failed: 0, requested: 1, unassigned: 0, results: [{ uid: "u0", code: "CODE", ok: true }] }
            : call.path === "/api/accounts-refresh" ? { ok: true, uid: "u0", balance: 120, at: 1795052000000 }
            : call.path === "/api/accounts-refresh-batch" ? (init.method === "POST" ? { ok: true, jobId: "job-1", total: (call.body?.uids ?? []).length || 1 } : { ok: true, job: { jobId: "job-1", total: 1, done: 1, okCount: 1, failCount: 0, running: false, stopped: "", results: {} } })
              : assert.fail(`Unexpected request: ${url}`)
      return response(data)
    })()
    pending.add(task)
    try { return await task } finally { pending.delete(task) }
  }
  runInNewContext(source, { document, fetch, navigator, localStorage, URL, console, setTimeout: () => 1, clearTimeout() {} }, { filename: "page/assets/app.js", timeout: 1000 })
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await tick()
      if (pending.size === 0 && !document.querySelector("#route-refresh").disabled) return
    }
    assert.fail("页面未结束忙碌状态")
  }
  await settle()
  const get = (selector) => {
    const node = document.querySelector(selector)
    assert.ok(node, `Missing DOM element: ${selector}`)
    return node
  }
  const input = async (selector, value) => { const node = get(selector); node.value = value; await node.emit("input") }
  const mode = async (value) => {
    for (const node of document.querySelectorAll('input[name="bindMode"]')) node.checked = node.value === value
    await get('input[name="bindMode"]:checked').emit("change")
  }
  return { get, document, calls, settle, input, mode }
}

function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => data } }

test("并发首屏默认 20、输入范围一致，服务端设置优先于本地缓存", async () => {
  const cache = new Map([["loomy.panel.accountConcurrency", "2"]])
  const localStorage = { getItem: (key) => cache.get(key), setItem: (key, value) => cache.set(key, value) }
  const defaults = await fixture()
  for (const selector of ["#setting-account-concurrency", "#bind-conc"]) {
    assert.equal(defaults.get(selector).value, "20")
    // ⚠ 并发输入**没有上限**（用户要求）：不再有 max 属性
    assert.equal(defaults.get(selector).getAttribute("max"), null)
    assert.equal(defaults.get(selector).getAttribute("min"), "1")
  }
  const f = await fixture((c) => c.path === "/api/settings" ? response({ accountConcurrency: 50, bindConcurrency: 1 }) : undefined, {}, localStorage)
  assert.equal(f.get("#setting-account-concurrency").value, "50")
  assert.equal(f.get("#bind-conc").value, "1")
  assert.equal(cache.get("loomy.panel.accountConcurrency"), "50")
  assert.equal(cache.get("loomy.panel.bindConcurrency"), "1")
})

test("两种并发仅 change 保存整数，刷新重开恢复且不丢邀请码输入", async () => {
  const cache = new Map()
  const localStorage = { getItem: (key) => cache.get(key), setItem: (key, value) => cache.set(key, value) }
  const settings = {}
  const handler = (c) => {
    if (c.path !== "/api/settings") return
    Object.assign(settings, c.body)
    return response(settings)
  }
  const f = await fixture(handler, {}, localStorage)
  await f.input("#bind-codes", "KEEP\nCODES")
  for (const [selector, value] of [["#setting-account-concurrency", "50"], ["#bind-conc", "1"]]) {
    await f.input(selector, value)
    await f.get(selector).emit("keyup")
    assert.equal(f.calls.filter((c) => c.body && c.path === "/api/settings").length, selector === "#bind-conc" ? 1 : 0)
    await f.get(selector).emit("change")
  }
  assert.deepEqual(settings, { accountConcurrency: 50, bindConcurrency: 1 })
  // 51 现在**合法**（无上限），只留真正非法的值
  for (const value of ["0", "1.5", "", "no"]) {
    await f.input("#bind-conc", value)
    await f.get("#bind-conc").emit("change")
  }
  assert.equal(f.calls.filter((c) => c.body && c.path === "/api/settings").length, 2)
  assert.equal(cache.get("loomy.panel.bindConcurrency"), "1")
  assert.equal(f.get("#bind-codes").value, "KEEP\nCODES")
  const reopened = await fixture(handler, {}, localStorage)
  assert.equal(reopened.get("#setting-account-concurrency").value, "50")
  assert.equal(reopened.get("#bind-conc").value, "1")
})

for (const unavailable of [false, true]) {
  test(`localStorage ${unavailable ? "抛错" : "缺失"} 时仍用后端保存并发`, async () => {
    const localStorage = unavailable ? { getItem() { throw new Error("SecurityError") }, setItem() { throw new Error("SecurityError") } } : undefined
    const f = await fixture(undefined, {}, localStorage)
    await f.input("#bind-codes", "KEEP")
    await f.input("#bind-conc", "50")
    await f.get("#bind-conc").emit("change")
    assert.deepEqual(f.calls.find((c) => c.path === "/api/settings" && c.body).body, { bindConcurrency: 50 })
    await f.get("#bind-run").click()
    await f.settle()
    assert.equal(f.calls.find((c) => c.path === "/api/do").body.concurrency, 50)
    assert.equal(f.get("#bind-codes").value, "KEEP")
  })
}

test("设置读取和保存失败明确提示，缓存回退且页面操作可用", async () => {
  const cache = new Map([["loomy.panel.accountConcurrency", "7"], ["loomy.panel.bindConcurrency", "bad"]])
  const localStorage = { getItem: (key) => cache.get(key), setItem: (key, value) => cache.set(key, value) }
  const f = await fixture((c) => c.path === "/api/settings" ? response({ error: "mock settings offline" }, 503) : undefined, {}, localStorage)
  assert.equal(f.get("#setting-account-concurrency").value, "7")
  assert.equal(f.get("#bind-conc").value, "20")
  assert.match(f.get("#toast").textContent, /并发设置读取失败/)
  await f.input("#bind-codes", "KEEP")
  await f.input("#bind-conc", "30")
  await f.get("#bind-conc").emit("change")
  assert.match(f.get("#toast").textContent, /并发设置保存失败/)
  assert.equal(f.get("#bind-codes").value, "KEEP")
  assert.equal(f.get("#bind-conc").value, "30")
  assert.equal(f.get("#bind-run").disabled, false)
  await f.get("#bind-run").click()
  await f.settle()
  assert.equal(f.calls.find((c) => c.path === "/api/do").body.concurrency, 30)
})

for (const concurrency of [1, 20, 50]) {
  test(`账号操作按输入并发 ${concurrency} 限制请求 worker`, async () => {
    let active = 0
    let peak = 0
    const many = Array.from({ length: 23 }, (_, i) => ({ uid: `worker-${i}`, name: `Worker${i}` }))
    const f = await fixture(async (c) => {
      if (c.path === "/api/accounts") return response({ accounts: many })
      if (c.path !== "/api/do") return
      active++
      peak = Math.max(peak, active)
      await tick()
      active--
      return response({ ok: true })
    })
    f.get("#select-all").checked = true
    await f.get("#accounts-list").emit("change", { target: f.get("#select-all") })
    await f.input("#setting-account-concurrency", String(concurrency))
    await f.get("#account-init").click()
    await f.settle()
    assert.equal(peak, Math.min(concurrency, 23))
    assert.equal(f.calls.filter((c) => c.path === "/api/do").length, 23)
    await f.input("#setting-account-concurrency", "0")
    await f.get("#account-init").click()
    await f.settle()
    assert.equal(f.calls.filter((c) => c.path === "/api/do").length, 23)
  })
}

test("真实 app 首屏加载 mock 账号、任务、积分与三态邀请字段", async () => {
  const f = await fixture()
  assert.deepEqual(f.calls.map((c) => c.path).sort(), ["/api/accounts", "/api/hello", "/api/invite", "/api/route-state", "/api/settings", "/api/tasks"])
  assert.equal(f.get("#account-summary").textContent, "显示 3 / 3 · 已选 0")
  const table = f.get("#accounts-list").innerHTML
  for (const label of ["手机号", "昵称", "初始化", "任务", "积分", "邀请", "操作", "Alpha", "mock-phone-0", "8/8", "每日 20", "永久 100", "已初始化", "未初始化", "未知"]) assert.ok(table.includes(label), label)
  assert.match(f.get("#invite-list").innerHTML, /OWN-A/)
  assert.match(f.get("#invite-list").innerHTML, /已绑定 APPLIED-B/)
  assert.match(f.get("#bind-pool").textContent, /可用未绑定账号 1 个/)
  assert.equal(f.get("#status").className, "status ok")
  // 统计卡片只剩三张：总数 / 健康 / 不健康（旧的 init/tasks/bound 已按截图删除）
  for (const id of ["stat-init", "stat-tasks", "stat-bound"]) assert.equal(f.document.querySelector(`#${id}`), null, id)
  assert.equal(f.get("#stat-total").textContent, "3")
  // mock 里 u1 是 routed → 健康 0、不健康 1、未检测 2
  assert.equal(f.get("#stat-healthy").textContent, "0")
  assert.equal(f.get("#stat-unhealthy").textContent, "1")
  assert.match(f.get("#stat-unhealthy-note").textContent, /另有 2 个未检测/)
})

test("五标签页及方向键、Home、End 切换与 ARIA 状态对应", async () => {
  const f = await fixture()
  assert.equal(f.document.querySelectorAll(".tab").length, 5)
  assert.equal(f.document.querySelectorAll(".pane").length, 5)
  const check = (active) => {
    for (const name of ["accounts", "invite", "assign", "logs", "settings"]) {
      const on = name === active
      assert.equal(f.get(`#pane-${name}`).hidden, !on)
      assert.equal(f.get(`#tab-${name}`).getAttribute("aria-selected"), String(on))
      if (f.get(`#tab-${name}`).tabIndex !== undefined) assert.equal(f.get(`#tab-${name}`).tabIndex, on ? 0 : -1)
      assert.equal(f.get(`#tab-${name}`).getAttribute("aria-controls"), `pane-${name}`)
      assert.equal(f.get(`#pane-${name}`).getAttribute("aria-labelledby"), `tab-${name}`)
    }
  }
  check("accounts")
  await f.get("#tab-invite").click()
  check("invite")
  for (const [from, key, to] of [["invite", "ArrowRight", "assign"], ["assign", "ArrowRight", "logs"], ["logs", "ArrowRight", "settings"], ["settings", "ArrowRight", "accounts"], ["accounts", "ArrowLeft", "settings"], ["logs", "Home", "accounts"], ["accounts", "End", "settings"], ["logs", "ArrowLeft", "assign"]]) {
    let prevented = false
    await f.get(`#tab-${from}`).emit("keydown", { key, preventDefault() { prevented = true } })
    check(to)
    assert.equal(prevented, true)
    assert.equal(f.get(`#tab-${to}`).focused, true)
  }
})

test("账号筛选、全选仅作用筛选结果且请求使用已选 UID", async () => {
  const f = await fixture()
  await f.input("#account-search", " alpha ")
  assert.match(f.get("#account-summary").textContent, /显示 1 \/ 3/)
  assert.doesNotMatch(f.get("#accounts-list").innerHTML, /mock-phone-1/)
  f.get("#select-all").checked = true
  await f.get("#accounts-list").emit("change", { target: f.get("#select-all") })
  await f.input("#account-search", "")
  assert.equal(f.get("#select-all").indeterminate, true)
  assert.match(f.get("#account-summary").textContent, /已选 1/)
  await f.get("#account-balance").click()
  await f.settle()
  assert.deepEqual(f.calls.find((c) => c.path === "/api/accounts-refresh-batch" && c.init.method === "POST").body.uids, ["u0"])
  for (const [filter, name] of [["bound", "Beta"], ["unbound", "Alpha"], ["unknown", "Gamma"]]) {
    await f.input("#account-filter", filter)
    assert.match(f.get("#account-summary").textContent, /显示 1 \/ 3/)
    assert.ok(f.get("#accounts-list").innerHTML.includes(name))
  }
  await f.input("#invite-search", "own-a")
  assert.match(f.get("#invite-summary").textContent, /显示 1 \/ 3/)
  await f.input("#invite-search", "")
  await f.input("#invite-filter", "bound")
  assert.match(f.get("#invite-list").innerHTML, /Beta/)
  assert.doesNotMatch(f.get("#invite-list").innerHTML, /Alpha/)
})

for (const mode of ["one-each", "one-many"]) {
  test(`批量 ${mode} 请求包含 mode/count 并刷新数据`, async () => {
    const f = await fixture()
    await f.mode(mode)
    assert.equal(f.get("#bind-count-wrap").hidden, mode !== "one-many")
    await f.input("#bind-codes", mode === "one-each" ? " A\nB " : " CODE ")
    await f.input("#bind-count", "4")
    await f.input("#bind-conc", "2")
    await f.get("#bind-run").click()
    await f.settle()
    const call = f.calls.find((c) => c.path === "/api/do")
    assert.deepEqual(call.body, { action: "bind-invite-bulk", mode, codes: mode === "one-each" ? "A\nB" : "CODE", count: mode === "one-many" ? 4 : 1, concurrency: 2 })
    assert.equal(call.init.method, "POST")
    assert.equal(call.init.headers["Content-Type"], "application/json")
    // ⚠ 绑定后刷新集合多了 tasks / route-state（都是只读缓存接口）
    // 绑定成功的「后续刷新」= 三个缓存型 GET（accounts / route-state / invite）。
    // ⚠ 不要用「最后 4 条」这种脆弱切片：绑定后的刷新集合可能随实现增减。
    const tail = f.calls.slice(f.calls.findIndex((c) => c.path === "/api/do")).map((c) => c.path)
    // 绑定后的刷新只涉及「账号余额 + 邀请码」两处缓存（路由状态属于检测任务，
    // 由 route-check / patrol 自己收尾时重读，不该被绑定动作顺手拉一次）
    for (const path of ["/api/accounts", "/api/invite"]) {
      assert.ok(tail.includes(path), `绑定后应刷新 ${path}：${tail.join(",")}`)
    }
    assert.ok(!tail.some((p) => p.endsWith("-refresh-batch")), "回调里不得启动新任务（会重复扣积分）")
    assert.match(f.get("#operation-log").textContent, /成功/)
  })
}

test("绑定参数无效时不发送请求", async () => {
  const f = await fixture()
  const check = async (codes, count, concurrency) => {
    await f.input("#bind-codes", codes)
    await f.input("#bind-count", count)
    await f.input("#bind-conc", concurrency)
    await f.get("#bind-run").click()
    await f.settle()
    assert.equal(f.calls.filter((c) => c.path === "/api/do").length, 0)
    assert.equal(f.get("#toast").classList.contains("bad"), true)
  }
  await f.mode("one-many")
  for (const codes of ["", "A\nB", "A\rB"]) await check(codes, "1", "3")
  for (const count of ["0", "1.5", "1000", "no"]) await check("CODE", count, "3")
  // 51 不再是非法值（并发无上限），只留 ≥1 之外与小数
  for (const concurrency of ["0", "1.5"]) await check("CODE", "1", concurrency)
})

for (const kind of ["HTTP", "error", "network", "JSON"]) {
  test(`${kind} 错误不显示绑定成功且解除忙碌`, async () => {
    const f = await fixture((call) => {
      if (call.path !== "/api/do") return
      if (kind === "network") throw new Error("mock offline")
      if (kind === "JSON") return { ok: true, json: async () => { throw new Error("mock invalid JSON") } }
      return response(kind === "error" ? { error: "mock rejected" } : {}, kind === "HTTP" ? 503 : 200)
    })
    await f.input("#bind-codes", "CODE")
    await f.get("#bind-run").click()
    await f.settle()
    assert.equal(f.get("#status").className, "status bad")
    assert.equal(f.get("#toast").classList.contains("bad"), true)
    assert.doesNotMatch(f.get("#toast").textContent, /绑定成功/)
    assert.equal(f.get("#bind-run").disabled, false)
    if (kind === "network") assert.match(f.get("#toast").textContent, /无法确认操作是否执行/)
  })
}

test("单账号绑定委托事件发送 UID 和去空格邀请码", async () => {
  const f = await fixture()
  f.get('[data-code-for="u0"]').value = " CODE "
  await f.get("#invite-list").emit("click", { target: f.get('[data-bind-uid="u0"]') })
  await f.settle()
  assert.deepEqual(f.calls.find((c) => c.path === "/api/do").body, { action: "bind-invite", uid: "u0", code: "CODE" })
  assert.deepEqual(f.calls.slice(-2).map((c) => c.uids), ["u0", "u0"])
})

test("忙碌时禁用操作且直接重复事件也不重发请求", async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const f = await fixture(async (call) => { if (call.path === "/api/do") await gate })
  await f.input("#bind-codes", "CODE")
  await f.get("#bind-run").click()
  try {
    for (const id of ["bind-run", "route-refresh", "invite-refresh", "account-repair"]) assert.equal(f.get(`#${id}`).disabled, true, id)
    await f.get("#bind-run").emit("click")
    await f.get("#route-refresh").emit("click")
    await f.get("#invite-list").emit("click", { target: f.get('[data-bind-uid="u0"]') })
    assert.equal(f.calls.filter((c) => c.path === "/api/do").length, 1)
    assert.equal(f.calls.length, 7)
  } finally { release() }
  await f.settle()
  assert.equal(f.get("#bind-run").disabled, false)
})

for (const bulk of [false, true]) {
  test(`${bulk ? "批量" : "单账号"}业务 ok:false 不应显示绑定成功`, async () => {
    const f = await fixture((call) => call.path === "/api/do" ? response({ ok: false, message: "mock rejected" }) : undefined)
    if (bulk) {
      await f.input("#bind-codes", "CODE")
      await f.get("#bind-run").click()
    } else {
      f.get('[data-code-for="u0"]').value = "CODE"
      await f.get("#invite-list").emit("click", { target: f.get('[data-bind-uid="u0"]') })
    }
    await f.settle()
    assert.equal(f.get("#toast").classList.contains("bad"), true)
    assert.equal(f.get("#status").className, "status bad")
    assert.doesNotMatch(f.get("#toast").textContent, /绑定成功/)
  })
}

test("邀请码直接显示次数、无限次数、耗尽和禁用状态", async () => {
  const codes = [
    { code: "SIX", usedCount: 6, maxUses: 20, status: "active" },
    { code: "FULL", usedCount: 20, maxUses: 20, status: "active" },
    { code: "UNLIMITED", usedCount: 99, maxUses: 0 },
    { code: "EXHAUSTED", usedCount: 1, maxUses: 20, status: "exhausted" },
    { code: "DISABLED", usedCount: 0, maxUses: 20, status: "disabled" },
    { code: "REVOKED", usedCount: 0, maxUses: 20, status: "revoked" },
  ]
  const f = await fixture((c) => c.path === "/api/invite" ? response({ rows: [{ uid: "u0", codes }] }) : undefined)
  const markup = f.get("#invite-list").innerHTML
  assert.match(markup, />使用6\/20 剩14</)
  assert.match(markup, />使用99\/不限 剩不限</)
  const blocks = [...markup.matchAll(/<span class="invite-code"[\s\S]*?<\/button><\/span>/g)].map((m) => m[0])
  assert.equal(blocks.length, codes.length)
  for (const block of blocks) {
    assert.doesNotMatch(block, /<(?:div|small|br)\b/)
    assert.match(block, /<code>[^<]+<\/code><span class="code-usage">[^<]+<\/span><span class="pill [^"]+">[^<]+<\/span><button/)
  }
  for (const [i, label] of ["可使用", "已耗尽", "可使用", "已耗尽", "已禁用", "已禁用"].entries()) assert.ok(blocks[i].includes(label))
  for (const i of [1, 3, 4, 5]) assert.doesNotMatch(blocks[i], /pill done/)
})

test("账号和邀请码表格无块级详情，多码横排且小屏保持紧凑可横滚", async () => {
  const f = await fixture()
  for (const id of ["accounts-list", "invite-list"]) assert.doesNotMatch(f.get(`#${id}`).innerHTML, /<(?:small|br)\b/)
  assert.match(f.get("#invite-list").innerHTML, /class="invite-codes"/)
  assert.match(f.get("#invite-list").innerHTML, /title="昵称：Alpha；用户 ID：u0"/)
  assert.match(f.get("#accounts-list").innerHTML, /class="quota-inline" title="每日 20 · 永久 100；截至 /)
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow:\s*auto/)
  assert.match(css, /table\s*\{[^}]*width:\s*max-content/)
  assert.match(css, /\.quota-inline, \.invite-codes, \.invite-code\s*\{[^}]*display:\s*inline-flex[^}]*flex-wrap:\s*nowrap/)
  assert.doesNotMatch(css, /\.invite-code[^{}]*\{[^}]*margin-top/)
  for (const rule of css.matchAll(/th, td\s*\{([^}]*)\}/g)) assert.match(rule[1], /padding:\s*4px [67]px/)
})

test("日志只在第三页聚合，包含时间来源，可复制和清空", async () => {
  const copied = []
  const f = await fixture(undefined, { clipboard: { writeText: async (text) => copied.push(text) } })
  assert.equal(f.document.querySelector("#account-log"), null)
  assert.equal(f.document.querySelector("#bind-log"), null)
  for (const name of ["accounts", "invite"]) {
    const pane = html.split(`id="pane-${name}"`)[1].split("</section>")[0]
    assert.doesNotMatch(pane, /<pre\b/)
  }
  await f.get("#accounts-list").emit("click", { target: f.get('[data-row-action="repair-tasks"]') })
  await f.settle()
  await f.input("#bind-codes", "CODE")
  await f.get("#bind-run").click()
  await f.settle()
  const text = f.get("#operation-log").textContent
  assert.match(text, /\[[^\]\n]+\] \[账号\] 开始补齐任务/)
  assert.match(text, /\[[^\]\n]+\] \[绑定\] 开始绑定/)
  // 首屏日志措辞已统一（T-35）：说清「只读了本地缓存、没发上游」（原来是「已读取本地缓存」）
  // 首屏日志措辞（T-49）：报清「几个账号 + 只读了缓存」。
  assert.match(text, /\[面板\] 首屏已载入本地缓存（3 个账号，未触发任何上游请求）/)
  await f.get("#logs-copy").click()
  assert.deepEqual(copied, [text])
  await f.get("#logs-clear").click()
  assert.equal(f.get("#operation-log").textContent, "")
  assert.equal(f.get("#logs-summary").textContent, "暂无日志")
  assert.equal(f.get("#logs-copy").disabled, true)
  assert.equal(f.get("#logs-clear").disabled, true)
})

test("日志限制条数和单条长度，保留最新结果且按文本输出", async () => {
  const results = Array.from({ length: 600 }, (_, i) => ({ uid: `log-${i}`, code: "CODE", ok: false, error: `<script>${"x".repeat(3000)}\nline` }))
  const f = await fixture((c) => c.path === "/api/do" ? response({ ok: false, failed: 600, results }) : undefined)
  await f.input("#bind-codes", "CODE")
  await f.get("#bind-run").click()
  await f.settle()
  const lines = f.get("#operation-log").textContent.split("\n")
  assert.equal(lines.length, 500)
  assert.ok(lines.every((line) => line.length < 2100))
  assert.doesNotMatch(lines.join("\n"), /log-0 →/)
  assert.match(lines.join("\n"), /log-599 →/)
  assert.match(lines.at(-1), /失败/)
  assert.equal(f.get("#operation-log").children.length, 0)
})

for (const kind of ["missing", "denied"]) {
  test(`日志复制 ${kind} 提示手动复制且保留日志`, async () => {
    const f = await fixture(undefined, kind === "missing" ? {} : { clipboard: { writeText: async () => { throw new Error("denied") } } })
    const text = f.get("#operation-log").textContent
    await f.get("#logs-copy").click()
    assert.match(f.get("#toast").textContent, /请在日志页手动选择复制/)
    assert.equal(f.get("#toast").classList.contains("bad"), true)
    assert.equal(f.get("#operation-log").textContent, text)
  })
}

test("失败后未绑定账号仍计入池，下批手动开始直接发送绑定", async () => {
  let attempts = 0
  const f = await fixture((c) => {
    if (c.path === "/api/do") {
      attempts++
      return response({ ok: attempts > 1, bound: attempts > 1 ? 1 : 0, failed: attempts > 1 ? 0 : 1, results: [{ uid: "u0", ok: attempts > 1, error: attempts === 1 ? "mock rejected" : undefined }] })
    }
  })
  await f.input("#bind-codes", "CODE")
  await f.get("#bind-run").click()
  await f.settle()
  assert.equal(attempts, 1)
  assert.equal(f.get("#status").className, "status bad")
  assert.match(f.get("#bind-pool").textContent, /可用未绑定账号 1 个/)
  assert.ok(f.document.querySelector('[data-bind-uid="u0"]'))
  await f.get("#bind-run").click()
  await f.settle()
  assert.equal(attempts, 2)
  assert.equal(f.get("#status").className, "status ok")
  assert.ok(f.calls.filter((c) => c.path === "/api/do").every((c) => c.body.action === "bind-invite-bulk"))
})

test("仅明确未绑定显示绑定入口，局部刷新保留其他账号状态", async () => {
  let posted = false
  const f = await fixture((c) => {
    if (c.path === "/api/do") { posted = true; return response({ ok: true }) }
    if (c.path === "/api/invite" && c.uids) return response({ rows: [{ uid: "u0", activation: { activated: true, applied: "CODE" }, codes: [] }] })
  })
  assert.equal(f.document.querySelectorAll("[data-bind-uid]").length, 1)
  assert.equal(f.document.querySelector('[data-bind-uid="u1"]'), null)
  assert.equal(f.document.querySelector('[data-bind-uid="u2"]'), null)
  f.get('[data-code-for="u0"]').value = "CODE"
  await f.get("#invite-list").emit("click", { target: f.get('[data-bind-uid="u0"]') })
  await f.settle()
  assert.equal(posted, true)
  assert.match(f.get("#bind-pool").textContent, /可用未绑定账号 0 个/)
  assert.equal(f.document.querySelectorAll("[data-bind-uid]").length, 0)
  assert.match(f.get("#invite-list").innerHTML, /已绑定 CODE/)
  assert.match(f.get("#invite-list").innerHTML, /已绑定 APPLIED-B/)
  assert.match(f.get("#invite-list").innerHTML, /请刷新确认状态/)
})

test("分页限制两个表格 DOM，跨页全选、切页和筛选保留选择", async () => {
  const many = Array.from({ length: 123 }, (_, i) => ({ uid: `mock-${i}`, phone: `phone-${i}`, name: `Name${i}` }))
  const f = await fixture((c) => c.path === "/api/accounts" ? response({ accounts: many }) : undefined)
  assert.equal(f.document.querySelectorAll("[data-select]").length, 50)
  assert.equal((f.get("#invite-list").innerHTML.match(/<tr>/g) ?? []).length, 51)
  assert.equal(f.get("#account-page-size").value, "50")
  f.get("#select-all").checked = true
  await f.get("#accounts-list").emit("change", { target: f.get("#select-all") })
  assert.match(f.get("#account-summary").textContent, /已选 123/)
  await f.get("#account-next").click()
  assert.match(f.get("#account-page-info").textContent, /51–100/)
  assert.equal(f.get("#select-all").checked, true)
  await f.get("#account-next").click()
  assert.equal(f.document.querySelectorAll("[data-select]").length, 23)
  assert.equal(f.get("#account-next").disabled, true)
  await f.input("#account-search", "Name122")
  assert.match(f.get("#account-page-info").textContent, /第 1 \/ 1 页/)
  assert.match(f.get("#account-summary").textContent, /已选 123/)
  await f.input("#account-search", "")
  f.get("#account-page-size").value = "25"
  await f.get("#account-page-size").emit("change")
  assert.equal(f.document.querySelectorAll("[data-select]").length, 25)
  f.get("#invite-page-size").value = "100"
  await f.get("#invite-page-size").emit("change")
  await f.get("#invite-next").click()
  assert.match(f.get("#invite-page-info").textContent, /101–123/)
})

test("复制邀请码成功、权限拒绝和不可用均给出准确提示", async () => {
  for (const kind of ["ok", "denied", "missing"]) {
    const copied = []
    const navigator = kind === "missing" ? {} : { clipboard: { writeText: async (code) => { if (kind === "denied") throw new Error("denied"); copied.push(code) } } }
    const f = await fixture(undefined, navigator)
    await f.get("#invite-list").emit("click", { target: f.get('[data-copy-code="OWN-A"]') })
    assert.equal(f.get("#toast").classList.contains("bad"), kind !== "ok")
    if (kind === "ok") assert.deepEqual(copied, ["OWN-A"])
    else assert.match(f.get("#toast").textContent, /请手动选择邀请码复制/)
    assert.equal(f.calls.length, 6)
  }
})

test("POST 成功后刷新失败保留操作结果且绝不重发 POST", async () => {
  let posted = false
  const f = await fixture((c) => {
    if (c.path === "/api/do") { posted = true; return response({ ok: true, message: "mock 已绑定" }) }
    if (posted && c.path === "/api/invite") throw new TypeError("Failed to fetch")
  })
  f.get('[data-code-for="u0"]').value = "CODE"
  await f.get("#invite-list").emit("click", { target: f.get('[data-bind-uid="u0"]') })
  await f.settle()
  assert.match(f.get("#toast").textContent, /mock 已绑定；后续刷新失败/)
  assert.match(f.get("#operation-log").textContent, /mock 已绑定/)
  assert.equal(f.calls.filter((c) => c.path === "/api/do").length, 1)
  assert.equal(f.get("#status").className, "status bad")
})

test("首次查询网络失败使用人话且不触发写操作", async () => {
  const f = await fixture(() => { throw new TypeError("Failed to fetch") })
  assert.match(f.get("#toast").textContent, /无法连接面板服务/)
  assert.doesNotMatch(f.get("#toast").textContent, /Failed to fetch/)
  assert.equal(f.calls.length, 3)
  assert.equal(f.get("#status").className, "status bad")
})

// ⚠ T-49：`/api/tasks` / `/api/invite` 也是**只读缓存**，行内 `error` 是上次真实查询
// 的原文，不是本次失败 —— 首屏不得因此标红、不得打「失败：」，但行内必须继续显示。
for (const path of ["/api/tasks", "/api/invite"]) {
  test(`${path} 缓存里的旧 error 不把首屏打成失败，但仍在行内显示`, async () => {
    const f = await fixture((c) => c.path === path ? response({ rows: [{ uid: "u0", error: "mock rejected", cached: true }] }) : undefined)
    assert.equal(f.get("#status").className, "status ok", "缓存里的历史错误不是本次失败")
    assert.doesNotMatch(f.get("#operation-log").textContent, /失败：/, "不得打「失败：」")
    assert.match(f.get("#operation-log").textContent, /\[面板\] 首屏已载入本地缓存（3 个账号，1 个账号有上次查询失败）/, "日志只说事实：几个账号、几个有上次失败")
    if (path === "/api/invite") {
      assert.match(f.get("#invite-list").innerHTML, /查询失败/, "行内仍要显示上次查询失败")
      assert.match(f.get("#invite-list").innerHTML, /title="mock rejected"/, "行内要能悬停看到原因")
    }
  })
}

test("真正发起刷新且失败仍然报错（别把真失败也吞了）", async () => {
  const f = await fixture((c) => c.path === "/api/invite-refresh-batch" ? response({ ok: false, error: "mock upstream reject" }, 500) : undefined)
  await f.get("#invite-refresh").click()
  await f.settle()
  assert.equal(f.get("#status").className, "status bad", "真失败必须报错")
  assert.match(f.get("#operation-log").textContent, /\[邀请码\] 失败：/, "真失败要进日志")
  assert.equal(f.get("#toast").classList.contains("bad"), true, "真失败要冒 toast")
})

test("/api/accounts 的缓存失败只作提示，不影响页面状态", async () => {
  const f = await fixture((c) => c.path === "/api/accounts" ? response({ accounts: [{ ...accounts[0], error: "mock rejected", cached: true }] }) : undefined)
  assert.equal(f.get("#status").className, "status ok")
  assert.match(f.get("#accounts-list").innerHTML, /上次查询失败/)
})

test("批量部分失败和 ok:false 携带 results 仍显示失败状态", async () => {
  const f = await fixture((c) => c.path === "/api/do" ? response({ ok: false, bound: 1, failed: 1, results: [{ uid: "u0", ok: true }, { uid: "u1", ok: false, error: "mock rejected" }] }) : undefined)
  await f.input("#bind-codes", "CODE")
  await f.get("#bind-run").click()
  await f.settle()
  assert.equal(f.get("#status").className, "status bad")
  assert.match(f.get("#toast").textContent, /成功 1，失败 1/)
  assert.match(f.get("#operation-log").textContent, /mock rejected/)
})

// ⚠ T-49 P2：保存设置必须**回读服务端**。POST 成功只说明服务端收下了，
// 不代表已落盘；回读不一致就要明确报错，并用服务端值覆盖界面（不留假象）。
test("设置保存后回读服务端；回读不一致时报失败并以服务端值为准", async () => {
  const server = { accountConcurrency: 20, bindConcurrency: 20, routeConcurrency: 2, batchConcurrency: 2, balanceConcurrency: 2, tasksConcurrency: 2, inviteConcurrency: 2, gapMs: 300, autoApply: true, magpiePath: "", batchSkipChecked: true, ledgerReads: 3, focusRefresh: false }
  const f = await fixture((c) => c.path === "/api/settings" ? response(c.body ? { ok: true, settings: server } : { ok: true, settings: server, defaults: server }) : undefined)
  await f.input("#setting-tasks-concurrency", "20")
  await f.get("#setting-tasks-concurrency").emit("change")
  await f.settle()
  assert.match(f.get("#settings-status").textContent, /保存失败/, "回读对不上就不得显示「已保存」")
  assert.match(f.get("#settings-status").textContent, /回读不一致/, "要能看出是回读不一致")
  assert.equal(f.get("#toast").classList.contains("bad"), true)
  assert.equal(f.get("#setting-tasks-concurrency").value, "2", "控件要回到服务端值，不留下“已经改了”的假象")
  const settingsCalls = f.calls.filter((c) => c.path === "/api/settings")
  assert.ok(settingsCalls.some((c) => c.body && c.body.tasksConcurrency === 20), "必须先发 POST")
  assert.ok(settingsCalls.some((c) => !c.body && c.body === undefined), "POST 之后必须再 GET 回读")
})
