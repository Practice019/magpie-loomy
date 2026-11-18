const $ = (s) => document.querySelector(s)
const $$ = (s) => Array.from(document.querySelectorAll(s))
const BASE = new URL(document.currentScript.src).origin
const state = { accounts: [], tasks: new Map(), invites: new Map(), selected: new Set(), busy: false, accountPage: 1, invitePage: 1, accountSize: 50, inviteSize: 50 }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const num = (n) => n == null ? "—" : Number(n).toLocaleString("zh-CN")

async function api(path, body) {
  let response
  try {
    response = await fetch(BASE + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  } catch {
    throw new Error(body === undefined ? "无法连接面板服务，请检查服务是否运行或跨域配置后手动刷新。" : "请求连接中断，无法确认操作是否执行。请先刷新核实结果，不要直接重复操作。")
  }
  let result
  try { result = await response.json() } catch { throw new Error(`服务返回了无法解析的数据（HTTP ${response.status}），请刷新核实状态。`) }
  if (!result || typeof result !== "object") throw new Error("服务返回的数据格式不正确，请刷新核实状态。")
  if (!response.ok || result.error || (result.ok === false && (body === undefined || (!Array.isArray(result.results) && !Array.isArray(result.failed))))) throw new Error(result.error || result.message || `操作未完成（HTTP ${response.status}）`)
  return result
}

function toast(message, bad = false) {
  const el = $("#toast")
  el.textContent = message
  el.classList.toggle("bad", bad)
  el.classList.add("show")
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => el.classList.remove("show"), 4000)
}

const logEntries = []
const LOG_LIMIT = 500

function renderLogs() {
  const el = $("#operation-log")
  el.textContent = logEntries.join("\n")
  el.scrollTop = el.scrollHeight
  $("#logs-summary").textContent = logEntries.length ? `已保留 ${logEntries.length} / ${LOG_LIMIT} 条日志` : "暂无日志"
  $("#logs-copy").disabled = logEntries.length === 0
  $("#logs-clear").disabled = logEntries.length === 0
}

function log(source, message) {
  const text = String(message).replace(/[\r\n]+/g, " · ").slice(0, 2000)
  logEntries.push(`[${new Date().toLocaleString("zh-CN", { hour12: false })}] [${source}] ${text}`)
  if (logEntries.length > LOG_LIMIT) logEntries.splice(0, logEntries.length - LOG_LIMIT)
  renderLogs()
}

function badge(text, kind = "") {
  return `<span class="pill ${kind}">${esc(text)}</span>`
}

function activation(uid) {
  return state.invites.get(uid)?.activation
}

function binding(uid) {
  const value = activation(uid)
  if (value?.activated === true) return badge(`已绑定 ${value.applied || ""}`, "done")
  return value?.activated === false ? badge("未绑定", "fail") : badge("未知")
}

function matches(a, search, filter) {
  const inv = state.invites.get(a.uid)
  const text = [a.phone, a.name, a.uid, inv?.activation?.applied, ...(inv?.codes ?? []).map((c) => c.code)].join(" ").toLowerCase()
  const active = activation(a.uid)?.activated
  return text.includes(search.toLowerCase()) && (filter === "all" || (filter === "bound" ? active === true : filter === "unbound" ? active === false : active !== true && active !== false))
}

function filteredAccounts() {
  return state.accounts.filter((a) => matches(a, $("#account-search").value.trim(), $("#account-filter").value))
}

function quota(a) {
  const windows = a.quota?.windows ?? []
  const amount = (prefix) => windows.find((w) => String(w.name).startsWith(prefix))?.amount
  const detail = `每日 ${num(amount("每日赠送"))} · 永久 ${num(amount("永久积分"))}`
  return `<span class="quota-inline" title="${esc(a.error ? `${detail}；${a.error}` : detail)}"><strong>${num(amount("可用总额"))}</strong><span class="muted">${detail}</span>${a.error ? '<span class="error">查询失败</span>' : ""}</span>`
}

function pageRows(rows, type) {
  const size = state[type + "Size"]
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const page = state[type + "Page"] = Math.min(state[type + "Page"], pages)
  $("#" + type + "-page-info").textContent = `${rows.length ? (page - 1) * size + 1 : 0}–${Math.min(page * size, rows.length)} / ${rows.length} 条 · 第 ${page} / ${pages} 页`
  $("#" + type + "-prev").disabled = page <= 1
  $("#" + type + "-next").disabled = page >= pages
  return rows.slice((page - 1) * size, page * size)
}

function renderAccounts() {
  const rows = filteredAccounts()
  const visible = pageRows(rows, "account")
  $("#account-summary").textContent = `显示 ${rows.length} / ${state.accounts.length} · 已选 ${state.selected.size}`
  $("#bar-sub").textContent = `${state.accounts.length} 个账号`
  const all = rows.length > 0 && rows.every((a) => state.selected.has(a.uid))
  $("#accounts-list").innerHTML = `<table><thead><tr><th><input id="select-all" type="checkbox" aria-label="全选筛选结果" ${all ? "checked" : ""}></th><th>#</th><th>手机号</th><th>昵称</th><th>初始化</th><th>任务</th><th>积分</th><th>邀请</th><th>操作</th></tr></thead><tbody>${visible.map((a, i) => {
    const task = state.tasks.get(a.uid)
    const keys = task?.tasks ? Object.values(task.tasks) : []
    const done = keys.filter(Boolean).length
    const init = a.firstLogin === true ? badge("已初始化", "done") : a.firstLogin === false ? badge("未初始化", "fail") : badge("未知")
    return `<tr><td><input type="checkbox" data-select="${esc(a.uid)}" aria-label="选择 ${esc(a.phone || a.name)}" ${state.selected.has(a.uid) ? "checked" : ""}></td><td>${(state.accountPage - 1) * state.accountSize + i + 1}</td><td class="mono">${esc(a.phone || "—")}</td><td title="用户 ID：${esc(a.uid)}">${esc(a.name || "—")}</td><td>${init}</td><td title="${esc(task?.error || "")}">${!task || task.error ? badge("未知") : badge(`${done}/8`, done >= 8 ? "done" : "")}</td><td>${quota(a)}</td><td>${binding(a.uid)}</td><td class="row-actions"><button class="tiny" data-row-action="repair-tasks" data-uid="${esc(a.uid)}">补齐任务</button><button class="tiny" data-row-action="balance" data-uid="${esc(a.uid)}">查余额</button></td></tr>`
  }).join("") || '<tr><td colspan="9" class="empty">没有匹配账号；请在宿主供应商页面登录或导入 Loomy 账号。</td></tr>'}</tbody></table>`
  const selectAll = $("#select-all")
  selectAll.indeterminate = !all && rows.some((a) => state.selected.has(a.uid))
}

function isCodeExhausted(c) {
  return c.status === "exhausted" || (Number(c.maxUses) > 0 && Number(c.usedCount ?? 0) >= Number(c.maxUses))
}

function codeMarkup(c) {
  const exhausted = isCodeExhausted(c)
  const available = !exhausted && [undefined, null, "", "active", "available", "enabled", "valid"].includes(c.status)
  const used = Number(c.usedCount ?? 0)
  const max = Number(c.maxUses)
  const known = Number.isFinite(max) && max >= 0
  const limit = known ? max === 0 ? "不限" : num(max) : "未知"
  const remaining = known ? max === 0 ? "不限" : num(Math.max(0, max - used)) : "未知"
  return `<span class="invite-code" title="${esc(`邀请码 ${c.code}；已用 ${num(used)} / ${limit} · 剩余 ${remaining} 次；状态 ${c.status || "默认可用"}`)}"><code>${esc(c.code)}</code><span class="code-usage">使用${num(used)}/${limit} 剩${remaining}</span>${badge(exhausted ? "已耗尽" : available ? "可使用" : "已禁用", available ? "done" : "fail")}<button class="tiny text-button" data-copy-code="${esc(c.code)}" aria-label="复制邀请码 ${esc(c.code)}">复制</button></span>`
}

function renderInvite() {
  const rows = state.accounts.filter((a) => matches(a, $("#invite-search").value.trim(), $("#invite-filter").value))
  const visible = pageRows(rows, "invite")
  const pool = state.accounts.filter((a) => activation(a.uid)?.activated === false).length
  const bound = state.accounts.filter((a) => activation(a.uid)?.activated === true).length
  $("#bind-pool").textContent = `可用未绑定账号 ${pool} 个 / 共 ${state.accounts.length}`
  $("#stat-total").textContent = num(state.accounts.length)
  $("#stat-init").textContent = num(state.accounts.filter((a) => a.firstLogin === true).length)
  $("#stat-tasks").textContent = num(state.accounts.filter((a) => { const t = state.tasks.get(a.uid); return !t?.error && Object.values(t?.tasks ?? {}).filter(Boolean).length >= 8 }).length)
  $("#stat-bound").textContent = num(bound)
  $("#stat-pool").textContent = `${pool} 个账号可参与批量绑定`
  $("#invite-summary").textContent = `显示 ${rows.length} / ${state.accounts.length} · 已绑定 ${bound}`
  $("#invite-list").innerHTML = `<table><thead><tr><th>#</th><th>手机号</th><th>昵称 / 用户 ID</th><th>绑定状态</th><th>自有邀请码</th><th>操作</th></tr></thead><tbody>${visible.map((a, i) => {
    const row = state.invites.get(a.uid)
    const codes = (row?.codes ?? []).map(codeMarkup).join("")
    return `<tr><td>${(state.invitePage - 1) * state.inviteSize + i + 1}</td><td class="mono">${esc(a.phone || "—")}</td><td title="${esc(`昵称：${a.name || "—"}；用户 ID：${a.uid}`)}"><span>${esc(a.name || "—")}</span> <span class="muted mono">${esc(a.uid)}</span></td><td>${binding(a.uid)}</td><td><span class="invite-codes">${codes || "—"}${row?.error ? `<span class="error" title="${esc(row.error)}">查询失败</span>` : ""}</span></td><td>${activation(a.uid)?.activated === false ? `<div class="inline-bind"><input class="field-input" data-code-for="${esc(a.uid)}" aria-label="${esc(a.phone || a.name)}的邀请码" placeholder="邀请码"><button class="tiny" data-bind-uid="${esc(a.uid)}">绑定</button></div>` : activation(a.uid)?.activated === true ? "已绑定不可再绑" : "请刷新确认状态"}</td></tr>`
  }).join("") || '<tr><td colspan="6" class="empty">没有匹配账号</td></tr>'}</tbody></table>`
}

function render() {
  renderAccounts()
  renderInvite()
  $$("button[data-account-action], [data-row-action], [data-bind-uid], #bind-run, #bind-clear, #refresh, #invite-refresh").forEach((b) => { b.disabled = state.busy })
  $$("[data-select], #select-all, #bind-codes, #bind-count, #bind-conc, #account-concurrency, input[name=bindMode]").forEach((b) => { b.disabled = state.busy })
  $$("[data-account-action]").forEach((b) => { b.disabled = state.busy || state.selected.size === 0 })
}

const query = (uids) => uids ? `?uids=${encodeURIComponent(uids.join(","))}` : ""
async function balances(uids) {
  const result = await api("/api/accounts" + query(uids))
  if (!uids) {
    state.accounts = result.accounts ?? []
    const ids = new Set(state.accounts.map((a) => a.uid))
    state.selected = new Set([...state.selected].filter((uid) => ids.has(uid)))
  } else {
    const updates = new Map((result.accounts ?? []).map((a) => [a.uid, a]))
    state.accounts = state.accounts.map((a) => updates.get(a.uid) ?? a)
  }
  if ((result.accounts ?? []).some((a) => a.error)) throw new Error("余额查询部分失败，请查看账号积分栏错误。")
}
async function tasks(uids) {
  const result = await api("/api/tasks" + query(uids))
  if (!uids) state.tasks.clear()
  for (const row of result.rows ?? []) state.tasks.set(row.uid, row)
  if ((result.rows ?? []).some((row) => row.error)) throw new Error("任务查询部分失败，失败账号显示未知，请稍后刷新。")
}
async function invites(uids) {
  const result = await api("/api/invite" + query(uids))
  if (!uids) state.invites.clear()
  for (const row of result.rows ?? []) state.invites.set(row.uid, row)
  if ((result.rows ?? []).some((row) => row.error)) throw new Error("邀请码查询部分失败，已保留可用结果；请查看表格错误。")
}

async function queries(work) {
  const results = await Promise.allSettled(work)
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason.message)
  if (errors.length) throw new Error([...new Set(errors)].join("；"))
}

async function afterOperation(work, summary, bad = false, target = "绑定") {
  log(target, summary)
  try {
    await queries(work)
  } catch (e) {
    throw new Error(`${summary}；后续刷新失败：${e.message} 操作未自动重发，请手动刷新。`)
  }
  toast(summary, bad)
  if (bad) throw new Error(summary)
}

async function busy(work, source = "面板") {
  if (state.busy) return
  state.busy = true
  render()
  $("#status").textContent = "处理中…"
  $("#status").className = "status"
  try {
    await work()
    $("#status").textContent = `已更新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`
    $("#status").className = "status ok"
  } catch (e) {
    log(source, `失败：${e.message}`)
    toast(e.message, true)
    $("#status").textContent = "操作失败：" + e.message
    $("#status").className = "status bad"
  } finally {
    state.busy = false
    render()
  }
}

async function refresh() {
  await busy(async () => {
    await balances()
    render()
    await queries([tasks(), invites()])
    log("刷新", "全部账号、任务与邀请码已刷新")
  }, "刷新")
}

function integer(selector, max) {
  const value = Number($(selector).value)
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`请输入 1–${max} 之间的整数`)
  return value
}

const concurrencyFields = { accountConcurrency: "#account-concurrency", bindConcurrency: "#bind-conc" }
const changedConcurrency = new Set()
let settingsSave = Promise.resolve()

function cachedConcurrency(key) {
  try {
    const value = Number(localStorage.getItem("loomy.panel." + key))
    return Number.isInteger(value) && value >= 1 && value <= 50 ? value : 20
  } catch { return 20 }
}

function cacheConcurrency(key, value) {
  try { localStorage.setItem("loomy.panel." + key, String(value)) } catch {}
}

async function loadSettings() {
  try {
    const settings = await api("/api/settings")
    for (const [key, selector] of Object.entries(concurrencyFields)) {
      const value = settings[key] === undefined ? 20 : settings[key]
      if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error("服务端并发设置无效")
      if (!changedConcurrency.has(key)) {
        $(selector).value = String(value)
        cacheConcurrency(key, value)
      }
    }
  } catch (e) {
    return `并发设置读取失败，使用本地缓存或默认 20：${e.message}`
  }
}

for (const [key, selector] of Object.entries(concurrencyFields)) {
  $(selector).value = String(cachedConcurrency(key))
  $(selector).addEventListener("input", () => changedConcurrency.add(key))
  $(selector).addEventListener("change", () => {
    changedConcurrency.add(key)
    let value
    try { value = integer(selector, 50) } catch (e) { toast(`并发设置未保存：${e.message}`, true); return }
    cacheConcurrency(key, value)
    settingsSave = settingsSave.then(async () => {
      try { await api("/api/settings", { [key]: value }) }
      catch (e) { toast(`并发设置保存失败，当前输入仍可使用：${e.message}`, true) }
    })
    return settingsSave
  })
}

async function accountAction(action, uids) {
  if (!uids.length) return toast("请先勾选账号", true)
  await busy(async () => {
    if (action === "balance" || action === "tasks") {
      log("账号", `开始${action === "balance" ? "查询余额" : "查询任务"}，共 ${uids.length} 个账号`)
      await (action === "balance" ? balances(uids) : tasks(uids))
      log("账号", `${action === "balance" ? "余额" : "任务"}查询完成，共 ${uids.length} 个账号`)
    }
    else {
      const concurrency = integer("#account-concurrency", 50)
      let cursor = 0
      let failed = 0
      log("账号", `开始${action === "repair-tasks" ? "补齐任务" : "补初始化"}，共 ${uids.length} 个账号`)
      await Promise.all(Array.from({ length: Math.min(concurrency, uids.length) }, async () => {
        while (cursor < uids.length) {
          const uid = uids[cursor++]
          const a = state.accounts.find((r) => r.uid === uid)
          try {
            const result = await api("/api/do", { action, uid })
            if (result.ok === false || result.failed?.length) failed++
            log("账号", `${a?.phone || a?.name || uid}：${result.message || (result.ok === false ? "未全部完成" : "已完成")}`)
            for (const item of result.failed ?? []) log("账号", `${item.key}：${item.error}`)
          } catch (e) {
            failed++
            log("账号", `${a?.phone || uid}：失败，${e.message}`)
          }
        }
      }))
      await afterOperation([balances(uids), tasks(uids), invites(uids)], `处理完成：${uids.length - failed} 个成功，${failed} 个未全部完成`, failed > 0, "账号")
    }
  }, "账号")
}

$$(".tab").forEach((tab, index, tabs) => {
  const activate = () => {
    tabs.forEach((t) => {
      const on = t === tab
      t.classList.toggle("is-on", on)
      t.setAttribute("aria-selected", String(on))
      t.tabIndex = on ? 0 : -1
    })
    $$(".pane").forEach((p) => {
      const on = p.id === "pane-" + tab.dataset.tab
      p.classList.toggle("is-on", on)
      p.hidden = !on
    })
  }
  tab.addEventListener("click", activate)
  tab.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return
    e.preventDefault()
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
    tabs[next].click()
    tabs[next].focus()
  })
})
$("#refresh").addEventListener("click", refresh)
$("#invite-refresh").addEventListener("click", () => busy(async () => {
  await invites()
  log("邀请码", "邀请码已刷新")
}, "邀请码"))
$("#logs-clear").addEventListener("click", () => { logEntries.length = 0; renderLogs() })
$("#logs-copy").addEventListener("click", async () => {
  if (!logEntries.length) return toast("暂无日志可复制")
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("unavailable")
    await navigator.clipboard.writeText(logEntries.join("\n"))
    toast("日志已复制")
  } catch { toast("复制失败，剪贴板不可用或权限被拒绝，请在日志页手动选择复制。", true) }
})
for (const type of ["account", "invite"]) {
  for (const suffix of ["search", "filter"]) $("#" + type + "-" + suffix).addEventListener("input", () => { state[type + "Page"] = 1; render() })
  $("#" + type + "-page-size").addEventListener("change", (e) => {
    const size = Number(e.target.value)
    if (![25, 50, 100].includes(size)) return
    state[type + "Size"] = size
    state[type + "Page"] = 1
    render()
  })
  for (const [suffix, delta] of [["prev", -1], ["next", 1]]) $("#" + type + "-" + suffix).addEventListener("click", () => { state[type + "Page"] = Math.max(1, state[type + "Page"] + delta); render() })
}
$$("[data-account-action]").forEach((b) => b.addEventListener("click", () => accountAction(b.dataset.accountAction, [...state.selected])))
$("#accounts-list").addEventListener("change", (e) => {
  if (state.busy) return
  if (e.target.id === "select-all") filteredAccounts().forEach((a) => e.target.checked ? state.selected.add(a.uid) : state.selected.delete(a.uid))
  else if (e.target.dataset.select) e.target.checked ? state.selected.add(e.target.dataset.select) : state.selected.delete(e.target.dataset.select)
  render()
})
$("#accounts-list").addEventListener("click", (e) => {
  const button = e.target.closest("[data-row-action]")
  if (button) accountAction(button.dataset.rowAction, [button.dataset.uid])
})
$("#invite-list").addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-copy-code]")
  if (copy) {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("unavailable")
      await navigator.clipboard.writeText(copy.dataset.copyCode)
      toast("邀请码已复制")
    } catch { toast("复制失败，剪贴板不可用或权限被拒绝，请手动选择邀请码复制。", true) }
    return
  }
  const button = e.target.closest("[data-bind-uid]")
  if (!button) return
  const uid = button.dataset.bindUid
  const input = $$('[data-code-for]').find((el) => el.dataset.codeFor === uid)
  const code = input?.value.trim()
  if (!code) return toast("请填写邀请码", true)
  busy(async () => {
    const account = state.accounts.find((a) => a.uid === uid)
    log("绑定", `${account?.phone || account?.name || uid} → ${code}：开始绑定`)
    const result = await api("/api/do", { action: "bind-invite", uid, code })
    const bad = result.ok === false || !!result.failed?.length
    await afterOperation([invites([uid]), balances([uid])], result.message || (bad ? "绑定未完成" : "已绑定"), bad)
  }, "绑定")
})
const bindMode = () => $('input[name="bindMode"]:checked').value
function syncMode() {
  const many = bindMode() === "one-many"
  $("#bind-count-wrap").hidden = !many
  $("#bind-codes").placeholder = many ? "只填一个邀请码（不能换行）" : "一行一个邀请码，每个码绑定 1 个账号"
  $("#bind-hint").textContent = many ? "方式二：将同一个邀请码分配给指定数量的不同账号。" : "方式一：先选择不同账号，再将每行邀请码各分配给一个账号。"
}
$$('input[name="bindMode"]').forEach((r) => r.addEventListener("change", syncMode))
$("#bind-clear").addEventListener("click", () => { $("#bind-codes").value = "" })
$("#bind-run").addEventListener("click", () => {
  const codes = $("#bind-codes").value.trim()
  const mode = bindMode()
  if (!codes) return toast("请填写邀请码", true)
  if (mode === "one-many" && /[\r\n]/.test(codes)) return toast("方式二只能填写一个邀请码", true)
  busy(async () => {
    const concurrency = integer("#bind-conc", 50)
    const count = mode === "one-many" ? integer("#bind-count", 999) : 1
    log("绑定", "开始绑定，仅分配已确认未绑定的账号，每批每个账号分配一次")
    const result = await api("/api/do", { action: "bind-invite-bulk", mode, codes, count, concurrency })
    for (const one of result.results ?? []) log("绑定", `${one.name || one.uid} → ${one.code}：${one.ok ? "成功" : one.error || "失败"}`)
    log("绑定", `${result.message || "完成"}；请求 ${result.requested ?? 0}，未分配 ${result.unassigned ?? 0}`)
    const bad = result.ok === false || !!result.failed || !!result.unassigned || (result.results ?? []).some((r) => r.ok !== true)
    await afterOperation([invites(), balances()], `绑定结果：成功 ${result.bound ?? 0}，失败 ${result.failed ?? 0}，未分配 ${result.unassigned ?? 0}`, bad)
  }, "绑定")
})
renderLogs()
syncMode()
const settingsReady = loadSettings()
;(async () => {
  await refresh()
  const error = await settingsReady
  if (error) toast(error, true)
})()
