const $ = (s) => document.querySelector(s)
const $$ = (s) => Array.from(document.querySelectorAll(s))
const BASE = new URL(document.currentScript.src).origin
const state = { accounts: [], tasks: new Map(), invites: new Map(), route: new Map(), selected: new Set(), busy: false, accountPage: 1, invitePage: 1, accountSize: 50, inviteSize: 50,
  // 面板设置（服务端权威值；`batchSkipChecked` 决定批量是否跳号）
  // ⚠ `focusRefresh` 本地初值必须是 false：服务端没读到之前，切窗口一律不重读。
  // ⚠ `synced` 只有「`GET /api/settings` 真的读成功」才置 true：首屏那一次
  //    `syncSettingsFields()` 不许把 localStorage 里的并发缓存冲成默认值。
  // ⚠ 设置 tab 的**每一个**控件都必须在这里有同名键，否则 syncSettingsFields()
  //    无从回填，页面就一直显示 HTML 里写死的初值（用户报的「下次启动又回默认」）。
  panel: {
    routeConcurrency: 2, batchConcurrency: 2, balanceConcurrency: 2, tasksConcurrency: 2, inviteConcurrency: 2,
    accountConcurrency: 20, bindConcurrency: 20,
    gapMs: 300, autoApply: true, magpiePath: "",
    batchSkipChecked: true, ledgerReads: 3, focusRefresh: false, synced: false,
  },
  // 上次已经打过「服务启动于 …」的那个 `since`（同一个进程只打一次，重启才再打）
  serviceLoggedSince: 0,
  // 一次批量检测的状态机：idle → running → (finished | stopped)
  batch: { jobId: "", running: false, finished: false, total: 0, done: 0, okCount: 0, failCount: 0, skipped: new Set(), failed: [], stopped: "" },
  // 三个刷新任务（余额 / 任务 / 邀请）：共用服务端并发槽
  jobs: { balance: null, tasks: null, invite: null },
  // 余额缓存的时间戳（服务端 updatedAt）
  cacheAt: 0,
  // 路由状态的时间戳（服务端 /api/route-state 的 fetchedAt）
  routeAt: 0 }
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
  // 只按搜索 + 邀请状态筛（用户明确删掉了「路由结论」筛选那道口子）
  return state.accounts.filter((a) => matches(a, $("#account-search").value.trim(), $("#account-filter").value))
}

/**
 * 路由结论的分类统计（统计卡片用）。
 *
 * 卡片口径只看「是否被上游限制」，不看任务/邀请状态：
 *   健康   = clean
 *   不健康 = routed + expired（改路由 / 登录失效）
 *   未检测 = unknown / 没记录 —— 只作为「不健康」卡右下角的一行小字，
 *            不单独占一张卡（用户明确画过的版式）。
 */
function routeCounts(accounts) {
  const out = { total: accounts.length, clean: 0, routed: 0, expired: 0, exhausted: 0, unknown: 0 }
  for (const a of accounts) {
    const verdict = state.route.get(a.uid)?.verdict
    if (verdict === "clean") out.clean += 1
    else if (verdict === "routed") out.routed += 1
    else if (verdict === "expired") out.expired += 1
    else if (verdict === "exhausted") out.exhausted += 1
    else out.unknown += 1
  }
  out.healthy = out.clean
  out.unhealthy = out.routed + out.expired + out.exhausted
  return out
}

/** 统计卡片：总数 / 健康 / 不健康（+ 未检测小字）。纯本地统计，不发请求。 */
function renderStats() {
  const rc = routeCounts(state.accounts)
  const set = (selector, value) => {
    const el = $(selector)
    if (el) el.textContent = value
  }
  set("#stat-total", num(rc.total))
  set("#stat-healthy", num(rc.healthy))
  set("#stat-unhealthy", num(rc.unhealthy))
  const note = $("#stat-unhealthy-note")
  if (note) note.textContent = `上游改路由 / 登录失效 / 积分不足${rc.unknown ? ` · 另有 ${rc.unknown} 个未检测` : ""}`
  renderRouteFreshness()
}

/**
 * 「路由状态截至 HH:mm:ss」——让「数字是不是旧的」变成看得见的事实。
 *
 * 超过 10 分钟就变灰并提示去点「刷新路由状态」，这样就不会再出现
 * 「统计说 20 个未检测、文件里其实 0 个」却没人察觉的情况。
 */
const ROUTE_STALE_MS = 10 * 60 * 1000

function renderRouteFreshness() {
  const el = $("#stat-route-at")
  if (!el) return
  const at = Number(state.routeAt) || 0
  if (!at) {
    el.textContent = "路由状态：读取中…"
    el.className = "muted"
    return
  }
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, "0")
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const stale = Date.now() - at > ROUTE_STALE_MS
  el.textContent = stale ? `路由状态截至 ${hms}（较旧，点「刷新路由状态」更新）` : `路由状态截至 ${hms}`
  el.className = stale ? "muted" : ""
  el.dataset.routeAt = String(at)
}

/** 毫秒时间戳 → `MM-dd HH:mm`（面板只显示到分钟）。 */
function clock(at) {
  if (!Number(at)) return ""
  const d = new Date(Number(at))
  const pad = (n) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 积分列：**只显示缓存**。
 *
 * 面板不再自动查余额 —— `a.cached === false` 时显示灰色的「未查询」，
 * 用户点「查询余额(选中) / 查余额」才会有数据。
 */
function quota(a) {
  if (a.cached !== true || !a.quota) return '<span class="muted" title="还没查询过；选中后点「查询余额(选中)」获取">未查询</span>'
  const windows = a.quota?.windows ?? []
  // ⚠ 窗口名带类型前缀（T-31：`额度 · 每日赠送` / `说明 · 永久积分` / `说明 · 可用总额`），
  //   但**旧缓存**里的名字没有前缀。所以比对前先剥掉前缀 —— 否则升级后的第一次渲染
  //   会读到 undefined，整列显示成「—」。
  const bare = (w) => String(w?.name ?? "").replace(/^(额度|停用|说明) · /, "")
  const amount = (needle) => windows.find((w) => bare(w).startsWith(needle))?.amount
  const detail = `每日 ${num(amount("每日赠送"))} · 永久 ${num(amount("永久积分"))}`
  const at = a.at ? `截至 ${clock(a.at)}` : ""
  const title = [detail, at, a.error ? a.error : ""].filter(Boolean).join("；")
  return `<span class="quota-inline" title="${esc(title)}"><strong>${num(amount("可用总额"))}</strong><span class="muted">${detail}</span>${at ? `<span class="code-usage">${esc(at)}</span>` : ""}${a.error ? '<span class="error">上次查询失败</span>' : ""}</span>`
}

// ── DS4.1 路由（账号级结论） ────────────────────────────────────────────
//
// 上游对**被限制的账号**会把 DeepSeek-V4.1-Flash 实际落到 spark-x2.6-low，
// `/models` 与 chat 响应都看不出来 —— 唯一权威信号是积分账本，判定在
// `src/route.mjs`（探测），面板只显示结论、并按需触发一次探测。
//
// ⚠ 文案的**权威版本在 server.mjs 的 `routeLabel()`**：接口把 `label` 挂在
// 每条 entry 上（`/api/route-state` 与 `/api/route-check` 都给），页面只用它，
// 绝不在这里再写一遍「正常 / 整号停用 / 检测不完整」。
// 下面的 `ROUTE_NONE` 只是「压根没有这条记录」的占位，与 unknown 的
// 「检测不完整」刻意区分：一个没测过，一个测了但没测清。
//
// ⚠ 首屏**不**拉 `/api/route-state`：首屏请求集合被既有用例钉死
// （accounts / settings / tasks / invite 四条），路由状态一律按需拉。
const ROUTE_NONE = "未检测"

function routeKind(entry) {
  // 「登录失效」也必须显示成异常色：它和「被限制」一样，都是**这个号不能用**
  return entry?.verdict === "clean" ? "done" : isSettled(entry) && entry?.verdict !== "clean" ? "fail" : ""
}

function routeMarkup(uid) {
  const entry = state.route.get(uid)
  // 本次批量里被跳过（已有结论）：淡色标记，仅批量期间显示，不落盘
  if (state.batch.running && state.batch.skipped.has(uid)) {
    return `<span class="row-actions"><span title="已有结论，本次批量跳过（省积分）">${badge("已跳过（有结论）")}</span></span>`
  }
  const title = [
    entry?.servedModel ? `实际落地：${entry.servedModel}` : "",
    entry?.costHint ? String(entry.costHint) : "",
    entry?.checkedAt ? `检测于 ${entry.checkedAt}` : "",
    entry?.reason ? String(entry.reason) : "",
    entry?.error ? `失败：${entry.error}` : "",
  ].filter(Boolean).join("；")
  // 成本提示只有 HTML 里那一条（`#route-hint`），按钮直接引用它，
  // 不在 JS 里再抄一遍文案。
  const cost = $("#route-hint")?.textContent?.trim() || ""
  return `<span class="row-actions"><span title="${esc(title || "还没检测过")}">${badge(entry?.label || ROUTE_NONE, routeKind(entry))}</span><button class="tiny" data-route-check="${esc(uid)}" title="${esc(cost)}">检测</button></span>`
}

/**
 * 拉一次已落盘的结论（**只读本地文件，零上游**）。
 *
 * ⚠ 这是「数字对不对」的唯一来源：状态文件可能被外部（别的窗口 / curl / magpie）
 * 改过，页面每次拿到都要更新 `routeAt`（服务端 `fetchedAt`），并把统计卡旁边
 * 的「路由状态截至 HH:mm:ss」一起刷新。
 *
 * @returns {Promise<number>} 本次拿到的账号条数
 */
async function routeStates() {
  const result = await api("/api/route-state")
  state.route = new Map(Object.entries(result.state ?? {}))
  state.routeAt = Number(result.fetchedAt) || Date.now()
  render()
  return state.route.size
}

/**
 * 数据新鲜度的一览：路由状态 + 余额 / 任务 / 邀请缓存。
 *
 * 全部只读缓存接口，**绝不触发上游**。`visibilitychange` 与批量结束都走这里。
 *
 * @param {{light?: boolean}} [opts] `light: true` 只重读路由状态（批量检测结束后用）
 */
async function refreshLocalViews({ light = false } = {}) {
  await routeStates()
  if (!light) await queries([balances(), tasks(), invites()])
}

/** 触发一次探测（**会真实调用上游并扣 1 积分**，按钮旁有说明）。 */
async function checkRoute(uid) {
  await busy(async () => {
    const account = state.accounts.find((a) => a.uid === uid)
    // ⚠ 绝对地址由 api() 的 BASE 保证（AGENTS.md 坑 #20：被导航进来的页面
    // `location.origin` 可能是 "null"，相对路径 fetch 会直接失败）
    const result = await api("/api/route-check", { uid })
    if (result.entry) state.route.set(uid, result.entry)
    render()
    const label = result.entry?.label || ROUTE_NONE
    log("路由", `${account?.phone || account?.name || uid}：${label}`)
    toast(`${account?.name || uid} DS4.1 路由：${label}`, routeKind(result.entry) === "fail")
  }, "路由")
}

// ── 批量检测（勾选后一键检测；184 个号也不把页面锁死） ──────────────────
//
// 真实账号池是 ~184 个号，每号 1 次探测、每次扣 1 积分。所以：
//   · 服务端**立刻**回 jobId，检测在后台队列里跑（并发 2 + 300ms 节流 + 熔断）；
//   · 页面每 2 秒 `GET` 一次进度，把已完成的结论就地合并进表格；
//   · 已有结论（clean/routed）的号默认跳过（设置里可关），省积分；
//   · 批量期间单行「检测」与「检测选中」都禁用，避免重复扣费。
//
// ⚠ 用 `setTimeout` 链而不是 `setInterval`：慢请求不会叠起来打爆进度接口。
// ⚠ 定时器句柄要能被 `clearTimeout` 清掉（跑完/失败都要清），否则页面
// 关掉之后还在轮询 —— 面板是本地服务，那种空转没有意义。
const BATCH_POLL_MS = 2000
let batchTimer = 0

/** 勾选里**本地已知道结论**的号（与服务端 skipChecked 判据一致：clean / routed / expired）。 */
function localSkipped() {
  if (!state.panel.batchSkipChecked) return []
  return [...state.selected].filter((uid) => isSettled(state.route.get(uid)))
}

/** 「已有结论」：正常 / 被限制 / 登录失效。`unknown` 不算（这次没测清，要重测）。 */
function isSettled(entry) {
  const verdict = entry?.verdict
  return verdict === "clean" || verdict === "routed" || verdict === "expired" || verdict === "exhausted"
}

function batchFailures(job) {
  return Object.entries(job?.results ?? {}).filter(([, entry]) => entry && entry.error).map(([uid]) => uid)
}

function batchPending() {
  return Math.max(0, state.selected.size - localSkipped().length)
}

/** 一次批量结果按结论分类（面板只做统计，文案仍来自服务端 label）。 */
function batchCounts(job) {
  const out = { clean: 0, routed: 0, expired: 0, exhausted: 0, unknown: 0 }
  for (const entry of Object.values(job?.results ?? {})) {
    if (!entry || typeof entry !== "object") continue
    const verdict = entry.error ? "unknown" : entry.verdict
    if (verdict in out) out[verdict] += 1
    else out.unknown += 1
  }
  return out
}

function batchText() {
  const b = state.batch
  if (b.running) return `检测中 ${b.done}/${b.total} · 成功 ${b.okCount} · 失败 ${b.failCount}`
  if (b.stopped) return `上游限流，已停止（请稍后再试）· 已完成 ${b.done}/${b.total}`
  if (b.finished) {
    const c = b.counts ?? batchCounts(b)
    const skipped = b.skipped.size ? ` · 跳过 ${b.skipped.size} 个已检测` : ""
    // ⚠ 分类数字要和 label 对得上：受限含 routed，登录失效单独一档
    const synced = b.synced ? " · 已同步最新检测状态" : ""
    return `检测完成 ${b.done}/${b.total} · 正常 ${c.clean} · 受限 ${c.routed} · 登录失效 ${c.expired} · 未检测 ${c.unknown}${skipped}${synced}${b.failed.length ? "（点击查看失败）" : ""}`
  }
  const skipped = localSkipped().length
  return `将检测 ${batchPending()} 个（跳过 ${skipped} 个已检测）· 约扣 ${batchPending()} 积分`
}

function renderBatch() {
  const button = $("#route-check-selected")
  if (button) {
    button.textContent = `检测选中 (${batchPending()})`
    button.disabled = state.busy || state.batch.running || batchPending() === 0
  }
  const hint = $("#route-batch-hint")
  if (hint) hint.textContent = batchText()
}

function scheduleBatchPoll(delay = BATCH_POLL_MS) {
  clearTimeout(batchTimer)
  batchTimer = setTimeout(() => { void pollBatch() }, delay)
}

async function checkBatchSelected() {
  if (state.busy || state.batch.running) return
  const uids = [...state.selected]
  if (!uids.length) return toast("请先勾选账号", true)
  try {
    const started = await api("/api/route-check-batch", { uids })
    // ⚠ 自愈：服务端返回的 `skipped` 是**按最新状态文件**算的。如果它与本地
    //    算出来的「已检测数」不一致，说明本地快照过期（别的窗口 / API 改过文件），
    //    这时立刻重读 route-state 再渲染 —— 否则按钮 N 与服务端对不上。
    const localSkippedCount = localSkipped().length
    const serverSkipped = (started.skipped ?? []).length
    if (serverSkipped !== localSkippedCount) {
      try { await routeStates() } catch {}
      log("路由", `已同步最新检测状态（本地算 ${localSkippedCount} 个已检测，服务端 ${serverSkipped} 个）`)
    }
    if (!started.jobId) {
      // 全都被「已有结论」跳过：不建任务、不扣积分
      state.batch = { jobId: "", running: false, finished: true, total: 0, done: 0, okCount: 0, failCount: 0, skipped: new Set(started.skipped ?? []), failed: [], stopped: "", synced: serverSkipped !== localSkippedCount }
      log("路由", started.message || "没有需要检测的账号")
      render()
      return
    }
    state.batch = {
      jobId: started.jobId,
      running: true,
      finished: false,
      total: started.total,
      done: 0,
      okCount: 0,
      failCount: 0,
      skipped: new Set(started.skipped ?? []),
      failed: [],
      stopped: "",
      counts: { clean: 0, routed: 0, expired: 0, unknown: 0 },
      synced: serverSkipped !== localSkippedCount,
    }
    log("路由", `批量检测开始：${started.total} 个账号，跳过 ${state.batch.skipped.size} 个已有结论的（每个号 1 次调用，扣 1 积分）`)
    render()
    void pollBatch()
  } catch (e) {
    log("路由", `批量检测没有启动：${e.message}`)
    toast(e.message, true)
  }
}

async function pollBatch() {
  const current = state.batch
  if (!current.running || !current.jobId) return
  let job
  try {
    job = (await api("/api/route-check-batch?jobId=" + encodeURIComponent(current.jobId))).job
  } catch (e) {
    state.batch = { ...current, running: false, finished: false }
    log("路由", `批量检测进度查询失败：${e.message}`)
    toast(`批量检测进度查询失败：${e.message}`, true)
    render()
    return
  }
  // 只合并**已完成**的号（服务端的 results 本来就不含进行中的）
  for (const [uid, entry] of Object.entries(job?.results ?? {})) {
    if (entry && typeof entry === "object") state.route.set(uid, entry)
  }
  state.batch = {
    jobId: job.jobId,
    running: Boolean(job.running),
    finished: false,
    total: job.total,
    done: job.done,
    okCount: job.okCount,
    failCount: job.failCount,
    skipped: current.skipped,
    counts: batchCounts(job),
    failed: batchFailures(job),
    stopped: job.stopped || "",
  }
  if (state.batch.running) {
    render()
    scheduleBatchPoll()
    return
  }
  void finishBatch(state.batch)
}

/**
 * 批量结束：重读状态文件后再渲染，并核对「按钮 N / skipped」是否自洽。
 *
 * # 为什么要回头重读（真机现象）
 *
 * 统计卡显示「另有 20 个未检测」，但服务端已经 0 unknown（别人用 API 跑完了）。
 * 页面拿的是加载时的旧快照，于是按钮上的数字也是旧的。所以任务一结束就
 * `await routeStates()`，数字立刻回到与服务端文件一致。
 */
async function finishBatch(job) {
  clearTimeout(batchTimer)
  state.batch = { ...job, running: false, finished: !job.stopped }
  render()
  log("路由", job.stopped
    ? `批量检测被熔断停止：${job.done}/${job.total}（上游限流，剩余账号未调用）`
    : `批量检测完成：${job.done}/${job.total}，成功 ${job.okCount}，失败 ${job.failCount}，跳过 ${job.skipped.size}`)
  // 失败清单只进控制台 + hint（不弹窗打断正在做的事）
  if (job.failed.length) console.warn("[loomy] DS4.1 批量检测失败账号：", job.failed.join(", "))

  // ⚠ 强制重读状态文件：任务期间别人（或 API）可能改过它，统计卡与按钮 N
  //    必须重新对齐，否则就会出现「统计说 20 个未检测、服务端却全跳过」。
  //    这一步**只读本地文件**，零上游、零积分。
  try {
    const before = state.route.size
    await routeStates()
    if (before !== state.route.size) log("路由", `已同步最新检测状态（${before} → ${state.route.size} 条）`)
  } catch (e) {
    log("路由", `重读路由状态失败：${e.message}`)
  }
}

// ── 应用判定（`magpie plugin list`） ────────────────────────────────────
//
// 判定写进状态文件 ≠ magpie 生效：实测只读命令 `magpie plugin list` 会重写
// `plugin-providers.json`，运行中的 magpie 随之重拉模型列表。这里给一个手动
// 入口，并在巡检/检测结束后自动触发（`autoApply` 可关）。
function applyText(result) {
  if (!result) return ""
  if (result.ok) return `已应用（耗时 ${(result.ms / 1000).toFixed(1)}s）`
  return `应用失败：${result.error}（可手动点『应用判定』）`
}

async function applyJudgement() {
  const hint = $("#apply-hint")
  const button = $("#route-apply")
  if (button?.disabled) return
  if (button) button.disabled = true
  if (hint) hint.textContent = "应用中…"
  try {
    const result = await api("/api/apply-route", {})
    const text = applyText(result)
    if (hint) hint.textContent = text
    log("应用", result.ok ? `已应用（耗时 ${(result.ms / 1000).toFixed(1)}s）` : `应用失败：${result.error}`)
    toast(text, !result.ok)
  } catch (e) {
    if (hint) hint.textContent = `应用失败：${e.message}`
    toast(`应用失败：${e.message}`, true)
  } finally {
    if (button) button.disabled = false
  }
}
// ── 刷新任务：打开面板只读缓存，刷新必须用户点 ──────────────────────────
//
// 打开面板**绝不**自动查余额/任务/邀请码（184 个号全量打上游 = 限流 = 成批失败）。
// 三个数据源共用一套任务形状与一套全局并发槽（总并发 ≤ 设置值，而不是 3×设置）。
// ⚠ T-49：「刷新全部（余额·任务·邀请）」按钮**已删除**（危险：一下点就把三个队列
//    全量打上游）。刷新入口只剩用户主动点的独立按钮：
//      `查询余额(选中)` / `查询任务(选中)` / `刷新邀请码` / `刷新路由状态`，
//    外加单行 `查余额` / `检测`。
const JOB_POLL_MS = 2000
const JOB_LABEL = { balance: "余额", tasks: "任务", invite: "邀请" }
const JOB_PATH = {
  balance: "/api/accounts-refresh-batch",
  tasks: "/api/tasks-refresh-batch",
  invite: "/api/invite-refresh-batch",
}
const jobTimers = { balance: 0, tasks: 0, invite: 0 }

function jobRunning() {
  return Object.values(state.jobs).some((job) => job?.running)
}

function refreshProgressText() {
  const parts = ["balance", "tasks", "invite"]
    .map((kind) => {
      const job = state.jobs[kind]
      if (!job) return ""
      const tail = job.stopped ? "（限流停止）" : ""
      return `${JOB_LABEL[kind]} ${job.done}/${job.total}${tail}`
    })
    .filter(Boolean)
  return parts.join(" · ")
}

function renderJobs() {
  const hint = $("#balance-batch-hint")
  if (hint) hint.textContent = refreshProgressText()
  const note = $("#accounts-cache-note")
  if (note) {
    const at = Number(state.cacheAt) || 0
    if (!at) {
      note.textContent = "还没有余额数据：勾选账号后点「查询余额(选中)」获取（每个号一次调用，请勿频繁操作）"
      note.className = "muted"
    } else {
      const stale = Date.now() - at > 24 * 3600 * 1000
      note.textContent = `数据截至 ${clock(at)}${stale ? "（较旧，点「查询余额(选中)」更新）" : ""}`
      note.className = stale ? "muted" : ""
    }
  }
}

function scheduleJobPoll(kind, delay = JOB_POLL_MS) {
  clearTimeout(jobTimers[kind])
  jobTimers[kind] = setTimeout(() => { void pollJob(kind) }, delay)
}

/** 启动一个刷新任务（`uids` 省略 = 全部账号）。 */
async function startJob(kind, uids) {
  const started = await api(JOB_PATH[kind], uids && uids.length ? { uids } : {})
  state.jobs[kind] = { jobId: started.jobId, running: true, done: 0, total: started.total, okCount: 0, failCount: 0, stopped: "" }
  log(JOB_LABEL[kind], `开始刷新 ${started.total} 个账号（服务端限速：并发 2 + 每次 300ms）`)
  render()
  void pollJob(kind)
  return started
}

async function pollJob(kind) {
  const current = state.jobs[kind]
  if (!current?.running || !current.jobId) return
  let job
  try {
    job = (await api(JOB_PATH[kind] + "?jobId=" + encodeURIComponent(current.jobId))).job
  } catch (e) {
    state.jobs[kind] = { ...current, running: false, jobId: "" }
    log(JOB_LABEL[kind], `进度查询失败：${e.message}`)
    toast(`${JOB_LABEL[kind]}刷新进度查询失败：${e.message}`, true)
    render()
    return
  }
  state.jobs[kind] = {
    ...current,
    running: Boolean(job.running),
    done: job.done,
    total: job.total,
    okCount: job.okCount,
    failCount: job.failCount,
    stopped: job.stopped || "",
  }
  if (state.jobs[kind].running) {
    render()
    scheduleJobPoll(kind)
    return
  }
  clearTimeout(jobTimers[kind])
  // 结束后只**读缓存**回填（不再发上游）。
  // ⚠ `strict` 只在「本次刷新确实报了失败」时打开：缓存里的历史 error 不抛，
  //    这次真失败的才报错（T-49 P1：旧错误不当成本次失败，但真失败也不吞）。
  const failed = Number(state.jobs[kind].failCount) || 0
  try {
    if (kind === "balance") await balances()
    else if (kind === "tasks") await tasks(undefined, { strict: failed > 0 })
    else await invites(undefined, { strict: failed > 0 })
  } catch (e) {
    log(JOB_LABEL[kind], `失败：${e.message}`)
    toast(`${JOB_LABEL[kind]}刷新失败：${e.message}`, true)
  }
  log(JOB_LABEL[kind], state.jobs[kind].stopped
    ? `刷新被熔断停止：${state.jobs[kind].done}/${state.jobs[kind].total}（上游限流，剩余账号未调用）`
    : `刷新完成：成功 ${state.jobs[kind].okCount}，失败 ${state.jobs[kind].failCount}`)
  state.jobs[kind] = { ...state.jobs[kind], running: false, jobId: "" }
  render()
}

/** 单行「查余额」：进同一个队列，只查这一个号。 */
async function refreshOneAccount(uid) {
  const account = state.accounts.find((a) => a.uid === uid)
  try {
    const started = await api("/api/accounts-refresh", { uid })
    state.jobs.balance = { jobId: started.jobId, running: true, done: 0, total: 1, okCount: 0, failCount: 0, stopped: "" }
    render()
    void pollJob("balance")
    log("余额", `${account?.phone || account?.name || uid}：已进入刷新队列`)
  } catch (e) {
    log("余额", `${account?.phone || account?.name || uid}：刷新失败，${e.message}`)
    toast(`查余额失败：${e.message}`, true)
  }
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
  $("#accounts-list").innerHTML = `<table><thead><tr><th><input id="select-all" type="checkbox" aria-label="全选筛选结果" ${all ? "checked" : ""}></th><th>#</th><th>手机号</th><th>昵称</th><th>初始化</th><th>任务</th><th>积分</th><th>邀请</th><th>DS4.1 路由</th><th>操作</th></tr></thead><tbody>${visible.map((a, i) => {
    const task = state.tasks.get(a.uid)
    const keys = task?.tasks ? Object.values(task.tasks) : []
    const done = keys.filter(Boolean).length
    // 任务列：只显示缓存；没查过就灰着「未查询」（面板不再自动查）
    const taskCell = task?.cached !== true
      ? '<span class="muted">未查询</span>'
      : `<span class="quota-inline" title="${esc(task.error || "")}">${badge(`${done}/8`, done >= 8 ? "done" : "")}${task.at ? `<span class="code-usage">截至 ${clock(task.at)}</span>` : ""}${task.error ? '<span class="error">上次失败</span>' : ""}</span>`
    const init = a.firstLogin === true ? badge("已初始化", "done") : a.firstLogin === false ? badge("未初始化", "fail") : badge("未知")
    return `<tr><td><input type="checkbox" data-select="${esc(a.uid)}" aria-label="选择 ${esc(a.phone || a.name)}" ${state.selected.has(a.uid) ? "checked" : ""}></td><td>${(state.accountPage - 1) * state.accountSize + i + 1}</td><td class="mono">${esc(a.phone || "—")}</td><td title="用户 ID：${esc(a.uid)}">${esc(a.name || "—")}</td><td>${init}</td><td>${taskCell}</td><td>${quota(a)}</td><td>${binding(a.uid)}</td><td>${routeMarkup(a.uid)}</td><td class="row-actions"><button class="tiny" data-row-action="repair-tasks" data-uid="${esc(a.uid)}">补齐任务</button><button class="tiny" data-row-action="row-balance" data-uid="${esc(a.uid)}">查余额</button></td></tr>`
  }).join("") || '<tr><td colspan="10" class="empty">没有匹配账号；请在宿主供应商页面登录或导入 Loomy 账号。</td></tr>'}</tbody></table>`
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
  renderStats()
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
  $$("button[data-account-action], [data-row-action], [data-route-check], [data-bind-uid], #bind-run, #bind-clear, #invite-refresh, #route-refresh").forEach((b) => { b.disabled = state.busy })
  $$("[data-select], #select-all, #bind-codes, #bind-count, #bind-conc, input[name=bindMode]").forEach((b) => { b.disabled = state.busy })
  $$("[data-account-action]").forEach((b) => { b.disabled = state.busy || state.selected.size === 0 })
  // 批量检测跑着的时候，单行「检测」也禁用（每个号都真扣积分，不许重复点）
  $$("[data-route-check]").forEach((b) => { b.disabled = state.busy || state.batch.running })
  // 刷新任务进行中：刷新入口一律禁用（避免重复触发、重复扣积分）
  const running = state.batch.running || jobRunning()
  $$("#account-balance, #account-tasks, #invite-refresh").forEach((b) => { b.disabled = state.busy || running })
  renderBatch()
  renderJobs()
}

const query = (uids) => uids ? `?uids=${encodeURIComponent(uids.join(","))}` : ""
async function balances(uids) {
  // ⚠ 这个接口现在只读**服务端缓存**，不会再打上游（AGENTS.md 坑：自动全量刷新
  // 会把 184 个号一起打到限流）。真正的查询由 refresh 任务完成。
  const result = await api("/api/accounts" + query(uids))
  if (!uids) {
    state.accounts = result.accounts ?? []
    state.cacheAt = Number(result.updatedAt) || 0
    const ids = new Set(state.accounts.map((a) => a.uid))
    state.selected = new Set([...state.selected].filter((uid) => ids.has(uid)))
  } else {
    const updates = new Map((result.accounts ?? []).map((a) => [a.uid, a]))
    state.accounts = state.accounts.map((a) => updates.get(a.uid) ?? a)
  }
  // 查询失败是「缓存里的上次失败」，不再当成页面级错误（缓存数据仍然有效）
}
async function tasks(uids, { strict = false } = {}) {
  const result = await api("/api/tasks" + query(uids))
  if (!uids) state.tasks.clear()
  for (const row of result.rows ?? []) state.tasks.set(row.uid, row)
  // ⚠ 缓存里的 `error` 是**上次真实查询**留下的原文，不是本次请求的失败：
  //    默认不抛（只留在行内）；`strict` 仅用于「本次真的发起了刷新」的路径。
  if (strict) {
    const failed = (result.rows ?? []).filter((row) => row.error)
    if (failed.length) throw new Error(`本次刷新有 ${failed.length} 个账号未成功（原因见表格行内）`)
  }
}
async function invites(uids, { strict = false } = {}) {
  const result = await api("/api/invite" + query(uids))
  if (!uids) state.invites.clear()
  for (const row of result.rows ?? []) state.invites.set(row.uid, row)
  // ⚠ 打开页面走的就是这里，而它**一个上游请求都不发**：
  //    所以行内 `error` 必然是历史值（server.mjs 从 invite-cache.json 原样带回）。
  //    默认不抛，只进表格行内；只有本次真发起了刷新（strict）才算失败。
  if (strict) {
    const failed = (result.rows ?? []).filter((row) => row.error)
    if (failed.length) throw new Error(`本次刷新有 ${failed.length} 个账号未成功（原因见表格行内）`)
  }
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

async function loadSettings() {
  try {
    const result = await api("/api/settings")
    // ⚠ 兼容两种形状：新接口是 `{ok,settings,defaults}`，旧 mock/旧服务端是扁平对象
    const settings = result.settings ?? result
    state.panel = {
      ...state.panel,
      routeConcurrency: Number(settings.routeConcurrency) || Number(settings.batchConcurrency) || 2,
      batchConcurrency: Number(settings.batchConcurrency) || Number(settings.routeConcurrency) || 2,
      balanceConcurrency: Number(settings.balanceConcurrency) || 2,
      tasksConcurrency: Number(settings.tasksConcurrency) || 2,
      inviteConcurrency: Number(settings.inviteConcurrency) || 2,
      gapMs: Number.isInteger(Number(settings.gapMs)) && Number(settings.gapMs) >= 0 ? Number(settings.gapMs) : 300,
      autoApply: settings.autoApply !== false,
      magpiePath: String(settings.magpiePath ?? ""),
      batchSkipChecked: settings.batchSkipChecked !== false,
      ledgerReads: Number(settings.ledgerReads) || 3,
      // 严格 `=== true`：字段缺失 / 旧服务端 → 关（宁可不动，也不偷偷重读）
      focusRefresh: settings.focusRefresh === true,
    }
    for (const [key, selector] of Object.entries(concurrencyFields)) {
      const value = settings[key] === undefined ? 20 : settings[key]
      if (!Number.isInteger(value) || value < 1) throw new Error("服务端并发设置无效")
      if (!changedConcurrency.has(key)) {
        $(selector).value = String(value)
        cacheConcurrency(key, value)
      }
      state.panel[key] = Number($(selector).value) || 20
    }
    // ⚠ 只有**读成功**才允许 syncSettingsFields 回填老两个并发控件；
    //    否则首屏那一次同步会把 localStorage 里的值冲成默认 20。
    state.panel.synced = true
    syncSettingsFields()
  } catch (e) {
    state.panel.synced = false
    return `并发设置读取失败，使用本地缓存或默认 20：${e.message}`
  }
}

function integer(selector, max) {
  const value = Number($(selector).value)
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`请输入 1–${max} 之间的整数`)
  return value
}

const concurrencyFields = { accountConcurrency: "#setting-account-concurrency", bindConcurrency: "#bind-conc" }
const changedConcurrency = new Set()
let settingsSave = Promise.resolve()

function cachedConcurrency(key) {
  try {
    const value = Number(localStorage.getItem("loomy.panel." + key))
    return Number.isInteger(value) && value >= 1 ? value : 20
  } catch { return 20 }
}

function cacheConcurrency(key, value) {
  try { localStorage.setItem("loomy.panel." + key, String(value)) } catch {}
}

for (const [key, selector] of Object.entries(concurrencyFields)) {
  $(selector).value = String(cachedConcurrency(key))
  $(selector).addEventListener("input", () => changedConcurrency.add(key))
  $(selector).addEventListener("change", () => {
    changedConcurrency.add(key)
    let value
    try { value = integer(selector) } catch (e) { toast(`并发设置未保存：${e.message}`, true); return }
    cacheConcurrency(key, value)
    settingsSave = settingsSave.then(async () => {
      try {
        await api("/api/settings", { [key]: value })
        // 回读确认落盘（与 saveSetting 同一口径：POST 成功 ≠ 已落盘）
        const readBack = await api("/api/settings")
        const saved = Number((readBack.settings ?? readBack)?.[key])
        if (saved !== value) throw new Error(`回读不一致（提交 ${value}，服务端 ${Number.isNaN(saved) ? "缺失" : saved}）`)
        state.panel[key] = value
        state.panel.synced = true
      } catch (e) { toast(`并发设置保存失败，当前输入仍可使用：${e.message}`, true) }
    })
    return settingsSave
  })
}

async function accountAction(action, uids) {
  if (!uids.length) return toast("请先勾选账号", true)
  // 单行「查余额」：只查这一个号（不顺手刷新别的号）
  if (action === "row-balance") {
    await busy(async () => { await refreshOneAccount(uids[0]) }, "余额")
    return
  }
  await busy(async () => {
    if (action === "balance") {
      // 勾选的号 → 余额刷新任务（服务端限速；进度由 pollJob 自己轮询）
      log("余额", `开始查询余额，共 ${uids.length} 个账号`)
      await startJob("balance", uids)
    }
    else if (action === "tasks") {
      // 同上：查询任务也进队列（读缓存 + 手动刷新）
      log("任务", `开始查询任务，共 ${uids.length} 个账号`)
      await startJob("tasks", uids)
    }
    else {
      const concurrency = integer("#setting-account-concurrency")
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
// ⚠ T-49：「刷新全部（余额·任务·邀请）」按钮已删除（一下点就会把三个队列全量打上游）。
// 刷新入口只剩下面这些用户主动点的独立按钮，各自只能动自己那一条数据。
// 邀请码页的刷新：有勾选就只跑勾选的号，否则整池（两者都进同一个刷新队列）
$("#invite-refresh").addEventListener("click", () => busy(async () => {
  const uids = [...state.selected]
  await startJob("invite", uids.length ? uids : undefined)
  log("邀请码", uids.length ? `开始刷新 ${uids.length} 个账号的邀请码` : "开始刷新全部账号的邀请码")
}, "邀请码"))
// 只读：把已落盘的路由结论拉回来（不触发探测、不花积分）
$("#route-refresh").addEventListener("click", () => busy(async () => {
  await routeStates()
  log("路由", `路由状态已刷新，共 ${state.route.size} 条记录`)
}, "路由"))
$("#logs-clear").addEventListener("click", () => { logEntries.length = 0; renderLogs() })
$("#logs-copy").addEventListener("click", async () => {
  if (!logEntries.length) return toast("暂无日志可复制")
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("unavailable")
    await navigator.clipboard.writeText(logEntries.join("\n"))
    toast("日志已复制")
  } catch { toast("复制失败，剪贴板不可用或权限被拒绝，请在日志页手动选择复制。", true) }
})
// ⚠ 危险操作：先二次确认。清空的只是**检测结果**（不会碰 magpie 的账号数据）
$("#route-apply").addEventListener("click", () => { void applyJudgement() })
$("#route-reset").addEventListener("click", () => {
  const total = state.route.size || state.accounts.length
  // confirm 在测试/无头环境里可能不存在：不存在就当「未确认」，绝不静默清空
  const ok = typeof confirm === "function"
    ? confirm(`将清空全部 ${total} 条检测结果（不影响 magpie 的账号数据），确定吗？`)
    : false
  if (!ok) return
  void busy(async () => {
    const result = await api("/api/route-state/reset", {})
    state.route = new Map()
    state.batch = { ...state.batch, finished: false, failed: [] }
    log("路由", `已清空检测结果：删除 ${result.removed} 条，剩余 ${result.remaining} 条`)
    toast(`已清空 ${result.removed} 条检测结果`)
    render()
  }, "路由")
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
  // 「检测」是每次点都真的打上游（扣积分），所以不并入批量动作
  const routeButton = e.target.closest("[data-route-check]")
  if (routeButton) {
    checkRoute(routeButton.dataset.routeCheck)
    return
  }
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
    const concurrency = integer("#bind-conc")
    const count = mode === "one-many" ? integer("#bind-count", 999) : 1
    log("绑定", "开始绑定，仅分配已确认未绑定的账号，每批每个账号分配一次")
    const result = await api("/api/do", { action: "bind-invite-bulk", mode, codes, count, concurrency })
    for (const one of result.results ?? []) log("绑定", `${one.name || one.uid} → ${one.code}：${one.ok ? "成功" : one.error || "失败"}`)
    log("绑定", `${result.message || "完成"}；请求 ${result.requested ?? 0}，未分配 ${result.unassigned ?? 0}`)
    const bad = result.ok === false || !!result.failed || !!result.unassigned || (result.results ?? []).some((r) => r.ok !== true)
    await afterOperation([invites(), balances()], `绑定结果：成功 ${result.bound ?? 0}，失败 ${result.failed ?? 0}，未分配 ${result.unassigned ?? 0}`, bad)
  }, "绑定")
})
// ── 邀请码分配（健康码的码池 → 未绑账号）───────────────────────────
//
// 三条硬约束（T-50 / T-52）：
//   ① 打开页面**零上游**：这里只读 `GET /api/invite/pool`，而且只在**点开这个 tab**
//      或用户点按钮时才读；首屏那 5 个 GET 的集合一个字不改。
//   ② **汇总零上游**：码池与绑定状态本来就在 `loomy-invite-cache.json` 里，
//      「汇总」= 本地算术（`left = maxUses - usedCount`、`activation.activated`），
//      一个上游请求都不发；只有「开始分配」才逐号发 1 次绑定请求。
//   ③ 分配前先干跑，把「会发多少次绑定请求」写在确认框里，不让用户盲点。
const assignState = { loaded: false, at: 0, codes: [], unbound: [], totals: { poolLeft: 0, unboundCount: 0 }, source: "", cacheAt: 0, missing: 0, job: null }
let assignTimer = 0
const ASSIGN_POLL_MS = 1500

// 邀请码分配 tab：**只在用户点开它时**读一次码池缓存（零上游，首屏一个字节不多）
$("#tab-assign").addEventListener("click", () => {
  void api("/api/invite/pool").then(applyPool).catch(() => {})
})

// ── 邀请码分配 · 执行（点按钮才发请求；打开页面一律不触发）────────────

function renderAssign() {
  const t = assignState.totals ?? {}
  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text }
  const left = Number(t.poolLeft) || 0
  const unboundCount = Number(t.unboundCount) || 0
  const unlimitedCount = assignState.codes.filter((c) => c?.unlimited).length
  // 可配对 = min(码池, 未绑)：不限次的码自己就够配下所有未绑号
  const pairs = Math.min(left + (unlimitedCount > 0 ? unboundCount : 0), unboundCount)
  if (!assignState.loaded) {
    setText("#stat-assign-pool", "—")
    setText("#stat-assign-unbound", "—")
    setText("#stat-assign-pairs", "—")
  } else {
    setText("#stat-assign-pool", unlimitedCount > 0 ? `${num(left)}+（含 ${unlimitedCount} 个不限次）` : num(left))
    setText("#stat-assign-unbound", num(unboundCount))
    setText("#stat-assign-pairs", num(pairs))
  }
  setText("#assign-codes-summary", assignState.codes.length ? `${assignState.codes.length} 个码` : "")
  setText("#assign-unbound-summary", assignState.unbound.length ? `${assignState.unbound.length} 个号` : "")
  setText("#assign-at", assignState.at ? `汇总于 ${clock(assignState.at)}（读「邀请」页缓存；点「汇总」才重算）` : "还没汇总过")
  // 扫描按钮旁那一行字：说清「读自哪、会不会打上游、缺几个号」
  const missing = Number(assignState.missing) || 0
  if (!assignState.loaded) {
    setText("#assign-scan-hint", "全部读自「邀请」页缓存，零上游请求")
  } else {
    const live = assignState.source === "cache+live"
    setText("#assign-scan-hint", [
      live ? "码池读自「邀请」页缓存（刚补拉过缺的号）" : "全部读自「邀请」页缓存",
      assignState.cacheAt ? `缓存于 ${clock(assignState.cacheAt)}` : "",
      live ? "" : "零上游请求",
      missing > 0 ? `${missing} 个号缺数据（先到「邀请」页读一次）` : "",
    ].filter(Boolean).join(" · "))
  }

  const job = assignState.job
  const running = job?.running === true
  const scan = $("#assign-scan"); if (scan) scan.disabled = running
  const run = $("#assign-run"); if (run) run.disabled = running || pairs === 0
  const stop = $("#assign-stop"); if (stop) stop.disabled = !running
  if (job) {
    const tail = job.stopped === "stopped-by-user" ? "（已手动停止）" : job.stopped ? "（上游限流，已停止）" : ""
    setText("#assign-hint", `${job.kind === "scan" ? "汇总" : "分配"}中 ${job.done}/${job.total} · 成功 ${job.okCount} · 失败 ${job.failCount}${tail}`)
  } else {
    setText("#assign-hint", "")
  }

  const codesEl = $("#assign-codes")
  if (codesEl) {
    codesEl.innerHTML = assignState.codes.length
      ? `<table><thead><tr><th>邀请码</th><th>所属账号</th><th>已用 / 上限</th><th>剩余</th><th>状态</th></tr></thead><tbody>${assignState.codes.map((c) => `<tr><td class="mono">${esc(c.code)}</td><td title="${esc(c.ownerUid)}">${esc(c.ownerName || c.ownerUid)}</td><td class="mono">${num(c.usedCount)} / ${c.unlimited ? "不限" : num(c.maxUses)}</td><td class="mono">${c.unlimited ? "不限" : num(c.left)}</td><td>${badge(c.unlimited ? "不限次" : "可用", "done")}</td></tr>`).join("")}</tbody></table>`
      : '<div class="empty">还没有汇总过：点上面的「汇总」（只读本地缓存，零上游）</div>'
  }

  const unboundEl = $("#assign-unbound")
  if (unboundEl) {
    const results = job?.results ?? {}
    unboundEl.innerHTML = assignState.unbound.length
      ? `<table><thead><tr><th>手机号 / 昵称</th><th>状态</th><th>结果</th></tr></thead><tbody>${assignState.unbound.map((u) => {
          const r = results[u.uid]
          const cell = !r
            ? '<span class="muted">待绑定</span>'
            : r.status === "bound"
              ? badge(`已绑 ${r.code || ""}`, "done")
              : r.status === "already-activated"
                ? badge("已绑过，跳过")
                : `<span class="error">${esc(r.error || r.status || "失败")}</span>`
          const label = u.verdict === "clean" ? "健康" : u.verdict === "expired" ? "登录失效" : u.verdict === "routed" ? "被限制" : u.verdict === "exhausted" ? "积分不足" : "未检测"
          return `<tr><td title="${esc(u.uid)}">${esc(u.name || u.uid)}</td><td>${badge(label, u.verdict === "clean" ? "done" : "fail")}</td><td>${cell}</td></tr>`
        }).join("")}</tbody></table>`
      : '<div class="empty">还没有未绑账号的数据：先汇总一次（零上游）</div>'
  }
}

async function poolState() {
  applyPool(await api("/api/invite/pool"))
  return assignState
}

function applyPool(result) {
  assignState.at = Number(result.at) || 0
  assignState.codes = Array.isArray(result.codes) ? result.codes : []
  assignState.unbound = Array.isArray(result.unbound) ? result.unbound : []
  assignState.totals = result.totals ?? { poolLeft: 0, unboundCount: 0 }
  assignState.source = String(result.source ?? "")
  assignState.cacheAt = Number(result.cacheAt) || 0
  assignState.missing = Number(result.missing) || 0
  assignState.loaded = true
  renderAssign()
}

function scheduleAssignPoll(kind, jobId) {
  clearTimeout(assignTimer)
  assignTimer = setTimeout(async () => {
    try {
      const path = kind === "scan" ? "/api/invite/pool/scan" : "/api/invite/assign"
      const result = await api(`${path}?jobId=${encodeURIComponent(jobId)}`)
      const job = result.job
      assignState.job = job
      renderAssign()
      if (job?.running) return scheduleAssignPoll(kind, jobId)
      assignState.job = { ...job, running: false }
      renderAssign()
      log("分配", kind === "scan"
        ? `码池汇总完成：${job.done}/${job.total}，缺数据 ${job.missing ?? 0}，失败 ${job.failCount}（零上游请求）`
        : `分配完成：成功 ${job.okCount}，失败 ${job.failCount}`)
      if (job.stopped && job.stopped !== "stopped-by-user") toast("上游限流，任务已停止", true)
      await poolState()
    } catch (e) {
      assignState.job = null
      renderAssign()
      log("分配", `进度查询失败：${e.message}`)
      toast(`分配进度查询失败：${e.message}`, true)
    }
  }, ASSIGN_POLL_MS)
}

$("#assign-scan")?.addEventListener("click", () => busy(async () => {
  const started = await api("/api/invite/pool/scan", {})
  if (!started.jobId) {
    log("分配", started.message || "没有需要汇总的账号")
    await poolState()
    return
  }
  assignState.job = { kind: "scan", jobId: started.jobId, total: started.total, done: 0, okCount: 0, failCount: 0, running: true, stopped: "", results: {} }
  log("分配", `开始汇总码池：${started.total} 个账号（只读「邀请」页缓存，零上游）`)
  renderAssign()
  scheduleAssignPoll("scan", started.jobId)
}, "分配"))

$("#assign-stop")?.addEventListener("click", () => busy(async () => {
  const jobId = assignState.job?.jobId
  if (!jobId) return
  await api("/api/invite/assign", { stop: true, jobId })
  log("分配", "已请求停止（当前这一步跑完就停）")
}, "分配"))

$("#assign-run")?.addEventListener("click", () => busy(async () => {
  // 干跑：先拿「会配多少对」，用户确认后才真的发绑定请求
  const plan = await api("/api/invite/assign", { dryRun: true })
  if (!plan.total) return toast("没有可配对的账号：先汇总码池", true)
  const ok = typeof confirm === "function"
    ? confirm(`将向 ${plan.total} 个未绑账号发起绑定请求（每个号 1 次，绑定后不可撤销）。继续？`)
    : true
  if (!ok) return log("分配", `已取消（计划 ${plan.total} 对）`)
  const started = await api("/api/invite/assign", {})
  if (!started.jobId) return log("分配", started.message || "没有可配对的账号")
  assignState.job = { kind: "assign", jobId: started.jobId, total: started.total, done: 0, okCount: 0, failCount: 0, running: true, stopped: "", results: {} }
  log("分配", `开始分配：${started.total} 对（并发/间隔取设置）`)
  renderAssign()
  scheduleAssignPoll("assign", started.jobId)
}, "分配"))

// ── 设置 tab：改动即保存（校验在服务端，非法值 400 不改状态） ──────────
//
// ⚠ 每个控件都必须在 `state.panel` 里有同名键，并由 `syncSettingsFields()` 回填：
//    只把值写进 localStorage / 只渲染一半控件，就会出现「设了没作用、下次启动回默认」。
function syncSettingsFields() {
  const setValue = (selector, value) => {
    const el = $(selector)
    if (el) el.value = String(value)
  }
  setValue("#setting-batch-concurrency", state.panel.batchConcurrency)
  setValue("#setting-balance-concurrency", state.panel.balanceConcurrency)
  setValue("#setting-tasks-concurrency", state.panel.tasksConcurrency)
  setValue("#setting-invite-concurrency", state.panel.inviteConcurrency)
  setValue("#setting-gap-ms", state.panel.gapMs)
  setValue("#setting-ledger-reads", state.panel.ledgerReads)
  // 老两个并发（账号列表类 / 绑定）另有 localStorage 缓存与 `changedConcurrency` 护栏，
  // 只在服务端读成功后才由服务端值覆盖它们，否则首屏同步会把缓存值冲成默认 20。
  if (state.panel.synced) {
    if (!changedConcurrency.has("accountConcurrency")) setValue("#setting-account-concurrency", state.panel.accountConcurrency)
    if (!changedConcurrency.has("bindConcurrency")) setValue("#bind-conc", state.panel.bindConcurrency)
  }
  const skip = $("#setting-batch-skip")
  if (skip) skip.checked = state.panel.batchSkipChecked !== false
  const autoApply = $("#setting-auto-apply")
  if (autoApply) autoApply.checked = state.panel.autoApply === true
  const magpiePath = $("#setting-magpie-path")
  if (magpiePath) magpiePath.value = String(state.panel.magpiePath ?? "")
  const focusRefresh = $("#setting-focus-refresh")
  if (focusRefresh) focusRefresh.checked = state.panel.focusRefresh === true
}

/** 把服务端返回的设置并进 `state.panel`（loadSettings / saveSetting 共用口径）。 */
function mergePanelSettings(settings) {
  if (!settings || typeof settings !== "object") return
  const gap = Number(settings.gapMs)
  state.panel = {
    ...state.panel,
    batchConcurrency: Number(settings.batchConcurrency) || Number(settings.routeConcurrency) || state.panel.batchConcurrency,
    routeConcurrency: Number(settings.routeConcurrency) || Number(settings.batchConcurrency) || state.panel.routeConcurrency,
    balanceConcurrency: Number(settings.balanceConcurrency) || state.panel.balanceConcurrency,
    tasksConcurrency: Number(settings.tasksConcurrency) || state.panel.tasksConcurrency,
    inviteConcurrency: Number(settings.inviteConcurrency) || state.panel.inviteConcurrency,
    gapMs: Number.isInteger(gap) && gap >= 0 ? gap : state.panel.gapMs,
    autoApply: settings.autoApply === undefined ? state.panel.autoApply : settings.autoApply === true,
    magpiePath: settings.magpiePath === undefined ? state.panel.magpiePath : String(settings.magpiePath),
    batchSkipChecked: settings.batchSkipChecked === undefined ? state.panel.batchSkipChecked : settings.batchSkipChecked === true,
    ledgerReads: Number(settings.ledgerReads) || state.panel.ledgerReads,
    accountConcurrency: Number(settings.accountConcurrency) || state.panel.accountConcurrency,
    bindConcurrency: Number(settings.bindConcurrency) || state.panel.bindConcurrency,
  }
}

async function saveSetting(patch) {
  const status = $("#settings-status")
  let readBackOk = false
  try {
    await api("/api/settings", patch)
    // ⚠ **回读**：POST 成功只说明服务端收下了，不代表落盘成功（别名归一 / 并发写 /
    //    旧进程只改内存，都会造成「界面显示已保存、重启又回默认」）。所以再 GET 一次，
    //    逐个核对这次提交的键；对不上就明确报错，不假装保存成功。
    const readBack = await api("/api/settings")
    readBackOk = true
    const settings = readBack.settings ?? readBack
    mergePanelSettings(settings)
    // 开关只认严格 true（与 loadSettings 同一口径）
    state.panel = { ...state.panel, focusRefresh: settings.focusRefresh === true }
    for (const [key, want] of Object.entries(patch)) {
      const got = settings?.[key]
      const same = typeof want === "number" ? Number(got) === want : got === want
      if (!same) throw new Error(`${key} 回读不一致（提交 ${want}，服务端 ${got ?? "缺失"}）`)
    }
    state.panel.synced = true
    if (status) status.textContent = "已保存"
    syncSettingsFields()
    render()
  } catch (e) {
    // 回读已经拿到了 → 界面回到服务端真值，不把用户留在“看起来改成了”的假象里；
    // 回读没拿到（POST 就失败 / 网络断）→ 保留用户输入，仅提示失败。
    if (readBackOk) syncSettingsFields()
    if (status) status.textContent = `保存失败：${e.message}`
    toast(`设置保存失败：${e.message}`, true)
  }
}

function numberSetting(selector, min, max, key) {
  const el = $(selector)
  if (!el) return
  el.addEventListener("change", () => {
    const value = Number(el.value)
    if (!Number.isInteger(value) || value < min || value > max) {
      toast(`请输入 ${min}–${max} 之间的整数`, true)
      syncSettingsFields()
      return
    }
    void saveSetting({ [key]: value })
  })
}

numberSetting("#setting-batch-concurrency", 1, undefined, "batchConcurrency")
numberSetting("#setting-balance-concurrency", 1, undefined, "balanceConcurrency")
numberSetting("#setting-tasks-concurrency", 1, undefined, "tasksConcurrency")
numberSetting("#setting-invite-concurrency", 1, undefined, "inviteConcurrency")
// 间隔是「保护」不是并发：0 = 不等待，上限 5000ms
numberSetting("#setting-gap-ms", 0, 5000, "gapMs")
numberSetting("#setting-ledger-reads", 1, 5, "ledgerReads")
$("#setting-batch-skip")?.addEventListener("change", (e) => { void saveSetting({ batchSkipChecked: e.target.checked === true }) })
$("#setting-focus-refresh")?.addEventListener("change", (e) => { void saveSetting({ focusRefresh: e.target.checked === true }) })
$("#setting-auto-apply")?.addEventListener("change", (e) => { void saveSetting({ autoApply: e.target.checked === true }) })
$("#setting-magpie-path")?.addEventListener("change", (e) => { void saveSetting({ magpiePath: String(e.target.value ?? "").trim() }) })
// 「只看被限制」：纯前端筛选，不发请求
// 批量检测入口
$("#route-check-selected")?.addEventListener("click", () => { void checkBatchSelected() })
$("#route-batch-hint")?.addEventListener("click", () => {
  const failed = state.batch?.failed ?? []
  if (failed.length) console.warn("[loomy] DS4.1 批量检测失败账号：", failed.join(", "))
})

/**
 * 首屏：**只读缓存**的 5 个 GET（accounts / settings / tasks / invite / route-state），
 * 一个上游请求都不发，也不触发任何刷新或探测。
 *
 * ⚠ 缓存行里的 `error` 是**上次真实查询**的原文，不是本次失败（`tasks()` / `invites()`
 *    默认不因此抛），这里只把它数成「有上次查询失败」，仍按正常日志记一行。
 */
async function loadInitial() {
  await busy(async () => {
    await balances()
    render()
    await queries([tasks(), invites(), routeStates()])
    const loaded = state.accounts.length
    const failures = cachedFailures()
    log("面板", failures > 0
      ? `首屏已载入本地缓存（${loaded} 个账号，${failures} 个账号有上次查询失败）`
      : `首屏已载入本地缓存（${loaded} 个账号，未触发任何上游请求）`)
  }, "账号")
}

/**
 * 顶栏「服务启动时间」：以后一眼看出面板跑的是不是**旧进程**。
 *
 * 之前被坑过一次：进程没重启，浏览器里看到的还是旧模块的行为，但页面本身
 * 是新 HTML —— 光看界面分不出来。`/api/hello` 的 `since` 由服务端用
 * `process.uptime()` 反推，是真实启动时刻，比页面里任何时间都可信。
 */
async function renderServiceClock() {
  try {
    const hello = await api("/api/hello")
    const since = Number(hello.since) || 0
    const uptime = Number(hello.uptimeMs) || 0
    const el = $("#status")
    if (!el || !since) return
    const hhmm = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })
    const full = (ms) => new Date(ms).toLocaleString("zh-CN", { hour12: false })
    const mins = Math.round(uptime / 60000)
    const age = mins < 60 ? `${mins} 分钟` : `${(mins / 60).toFixed(1)} 小时`
    // 只写 title / dataset / 日志，**不覆盖** `#status` 正文：
    // 正文属于「连接中 / 已更新 / 操作失败」那套状态机，两件事不该抢同一处。
    el.title = `服务启动 ${full(since)}（已运行 ${age}，PID ${hello.pid ?? "?"}）`
    el.dataset.serviceSince = String(since)
    el.dataset.serviceLabel = `启动 ${hhmm(since)}`
    // 只有 `since` 变了（服务真的重启）才再打一行：这个函数会被反复调用，
    // 每调一次打一行等于把日志刷成噪音，用户根本看不到别的记录。
    if (state.serviceLoggedSince !== since) {
      log("面板", `服务启动于 ${full(since)}，已运行 ${age}`)
      state.serviceLoggedSince = since
    }
  } catch (e) {
    log("面板", `服务启动时间未知：${e.message}`)
  }
}

/**
 * 窗口重新获得焦点时（`visibilitychange` / `focus`）：重读**5 个缓存型 GET**。
 *
 * 目的：别人（或 API / 别的窗口）改了状态文件后，用户切回来数字就对了。
 * 四条硬约束：
 *   ⓪ **默认关闭**：`state.panel.focusRefresh` 不为 true 就在第一行早退。
 *      用户原话「禁止自动刷新，因为发请求都有风险」—— 这一步由用户自己决定；
 *      两个事件监听照样注册，所以打开开关**运行时立即生效**。
 *   ① 只打 `/api/accounts|settings|tasks|invite|route-state`，**绝不触发上游**
 *      （这五个 GET 在 server.mjs 顶部有注释：只读本地缓存文件）；
 *   ② 两次自动重读间隔 ≥ `FOCUS_REFRESH_MS`（5 秒），切来切去不会抖；
 *   ③ 批量/刷新任务正在跑时不插队（那会打乱进度轮询的节奏）。
 *
 * ⚠ 缓存里的 `error` 是**上次真实查询**留下的原文（`/api/invite` 从
 * `invite-cache.json` 原样带回），不是本次请求的失败 —— 所以这里不再沿用
 * 「自动重读失败：邀请码查询部分失败」那种措辞，只把条数说清楚。
 *
 * @returns {Promise<boolean>} 这次是否真的重读了
 */
const FOCUS_REFRESH_MS = 5000
let lastFocusRefreshAt = 0
let focusRefreshInFlight = false

/** 缓存里「上次真实查询失败」的账号条数（invites + tasks，按 uid 去重）。 */
function cachedFailures() {
  const uids = new Set()
  for (const row of state.invites.values()) if (row?.error) uids.add(row.uid)
  for (const row of state.tasks.values()) if (row?.error) uids.add(row.uid)
  return uids.size
}

async function refreshOnFocus() {
  if (!state.panel?.focusRefresh) return false
  const now = Date.now()
  if (focusRefreshInFlight) return false
  if (now - lastFocusRefreshAt < FOCUS_REFRESH_MS) return false
  if (state.busy || state.batch.running || jobRunning()) return false
  focusRefreshInFlight = true
  lastFocusRefreshAt = now
  try {
    await balances()
    // `queries` 会把「某行 error」当成整体失败 —— 那是缓存里的旧错误，
    // 这里用 allSettled 收住，先渲染出数据，再单独统计条数。
    await Promise.allSettled([tasks(), invites(), routeStates()])
    // `render()` 里会按需重读一次设置（同一份本地缓存）——直接把那个「警告文案」
    // 接在同一个 promise 上，不要在没有 catch 的调用后面 `await` 一个新 promise。
    const settingsReady = render()
    const warning = await loadSettings()
    await settingsReady
    if (warning) log("面板", warning)
    log("面板", "窗口回到前台，已重读本地缓存（未触发任何上游请求）")
    const failures = cachedFailures()
    if (failures > 0) log("面板", `缓存里有 ${failures} 个账号的上次查询失败（不是本次请求）`)
    return true
  } catch (e) {
    log("面板", `重读本地缓存失败：${e.message}（未触发任何上游请求）`)
    return false
  } finally {
    focusRefreshInFlight = false
  }
}

// 两个事件都接：`visibilitychange` 覆盖切标签页，`focus` 覆盖切窗口。
// ⚠ 用 `void`：事件回调不能 await，也不该把异常抛回浏览器。
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshOnFocus()
  })
}
if (typeof globalThis !== "undefined" && globalThis.addEventListener) {
  globalThis.addEventListener("focus", () => { void refreshOnFocus() })
}

renderLogs()
syncMode()
syncSettingsFields()
renderAssign()
const settingsReady = loadSettings()
const clockReady = renderServiceClock()
;(async () => {
  await loadInitial()
  const error = await settingsReady
  if (error) toast(error, true)
  await clockReady
})()
