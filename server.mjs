// server.mjs 插件自带的本地服务 —— 管理面板的后端。
//
// # 为什么需要它
//
// magpie 的插件页是**沙盒 iframe**（`sandbox="allow-scripts"`，
// CSP `connect-src 'none'`）：页面内不能 fetch、不能 WebSocket。
// 所以「新手任务批量完成 / 邀请码 / 批量导入」这些需要实时数据的界面
// **不可能**画在沙盒页里。
//
// 解法是 magpie 官方支持的 `magpie.page.service`：页面只是「带路页」，
// 把自己**导航**到这个服务上。导航之后就在我们自己的 origin 里，
// 沙盒 CSP 不再适用 —— 表格、按钮、SSE 全都能用。
//
// # 它读什么、写什么
//
//	读  magpie 的 plugin-auth.json   —— 拿已登录的 loomy 账号 session
//	读  Loomy 客户端的 Local Storage —— 兜底（本机那个号）
//	写  magpie 的 plugin-auth.json   —— **批量导入**（写前备份）
//	写  <configDir>/loomy-*.json     —— 缓存与任务状态（见「缓存与任务」一节）
//
// ⚠ plugin-auth.json 的格式**不在 magpie 的插件契约里**。直接写它属于
// 钻实现细节，所以：① 写前一定备份；② 只增不删；③ 写完提示用户
// 在插件管理里关掉再打开（宿主才会重读账号）。
//
// # 一条贯穿全文件的规则：打开面板**零上游请求**
//
// 用户的明确要求是「所有刷新的功能全部需要用户手动操作」。所以
// `/api/accounts`、`/api/tasks`、`/api/invite`、`/api/route-state`、
// `/api/settings` 这五个 GET **只读本地缓存**；任何真实调用都只能通过
// 用户点击触发的 refresh 任务（`*refresh-batch`）或单次探测发生。
// 每条链路都有「fetchImpl 调用数 = 0」的测试钉死。

import { createServer } from "node:http"
import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { PROVIDER, DEFAULT_BASE_URL } from "./src/constants.mjs"
import { shortUID, deriveUID } from "./src/credential.mjs"
import {
  PointsError,
  TASK_DEFS,
  fetchPointsSnapshot,
  fetchTasks,
  completeTask,
  fetchActivation,
  bindInvite,
  bindInviteDetailed,
  fetchInvitationCodes,
  firstLogin,
} from "./src/points.mjs"
import { readLocalAuth, readLocalPoints, defaultClientStoreDir } from "./src/client-store.mjs"
import { usageFromPoints, tasksSummary, DAILY_RESET_AMOUNT } from "./src/usage.mjs"
import { USAGE_CACHE_FILE, usageCacheEntry } from "./src/quota-cache.mjs"
import { makeRateGate, RATE_GATE_CAPACITY, RATE_GATE_REFILL_MS } from "./src/rate-gate.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

/** 默认监听端口（可用插件选项 `port` 覆盖）。 */
export const DEFAULT_PORT = 4391

/**
 * 本进程内已经起来的实例（同一端口只 listen 一次）。
 *
 * # 为什么需要它
 *
 * magpie 可能在**同一个进程里**多次加载插件（更新、开关、重载），
 * 而 `LoomyPage` 每次都会被调用。重复 `listen` 同一端口会 EADDRINUSE。
 *
 * @type {Map<number, {port: number, close: () => Promise<void>}>}
 */
const running = new Map()

/**
 * 启动服务。
 *
 * @param {{port?: number, host?: string, configDir?: string, baseUrl?: string,
 *   fetchImpl?: typeof fetch, log?: object, retry?: boolean, routeModules?: any}} [opts]
 *   `retry: true` 时端口被占用会**反复重试**（最多 ~30 秒），而不是顺延到
 *   邻近端口 —— 这是页面服务的语义：端口由 magpie 指定，插件不该改。
 *   `routeModules`：DS4.1 检测模块的注入点（测试桩 / 排障用；`undefined` = 运行时
 *   动态 import 真实模块，`null` = 明确「未就绪」）。
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const wantPort = opts.port ?? DEFAULT_PORT

  // 同一进程里已经在跑 → 直接复用（幂等）
  const existing = running.get(wantPort)
  if (existing) return existing

  const baseUrl = String(opts.baseUrl ?? DEFAULT_BASE_URL)
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = opts.log ?? console
  const configDir = opts.configDir ?? process.env.MAGPIE_CONFIG_DIR ?? ""

  const ctx = {
    baseUrl,
    fetchImpl: doFetch,
    log,
    configDir,
    clientStoreDir: opts.clientStoreDir ?? defaultClientStoreDir(),
    startedAt: Date.now(),
    binding: false,
    state: readPanelState(configDir),
    // DS4.1 路由检测（见「DS4.1 路由」一节）
    //	undefined → 运行时按需动态 import（生产路径）
    //	null      → 明确「检测模块未就绪」（降级测试用，且与「没传」区分开）
    //	object    → 注入（测试桩 / 排障）
    routeModules: opts.routeModules === undefined ? undefined : Promise.resolve(opts.routeModules),
    // 同一 uid 的探测合并（in-flight）：面板连点、多人同时点都只打一次上游
    routePending: new Map(),
    // 批量检测任务：jobId → {jobId,total,running,stopped,skipped,results}
    routeJobs: new Map(),
    // 刷新任务（余额 / 任务 / 邀请码共用）：jobId → {kind,total,running,stopped,results}
    refreshJobs: new Map(),
    // 邀请码分配任务（扫描 / 绑定）：jobId → {kind,total,done,running,stopped,results}
    inviteJobs: new Map(),
    // 进程级并发槽 + 启动节流（三个全量任务共享，总并发不超过设置值）
    slotActive: 0,
    slotWaiters: [],
    slotLimit: 0,
    refreshGateFn: null,
    // 进程级令牌桶（T-54）：**任何**上游调用都要先过闸。容量跟着设置走
    // （`balanceConcurrency`，默认 20）——它不是并发上限，是「防意外爆发」。
    // ⚠ 放在 ctx 上而不是模块级单例：同一进程里可能起多个面板实例（测试夹具、
    //   多端口），单例会互相串味；生产里一个进程通常只有一个实例，
    //   效果与「进程级」等价。
    rateGate: null,
    rateGateCapacity: 0,
    // 判定 → 生效（`magpie plugin list`）：spawn 可注入，便于测试与排障
    spawnImpl: opts.spawnImpl ?? spawn,
    // 应用判定的超时（毫秒）；测试可注入更小的值
    applyTimeoutMs: Number(opts.applyTimeoutMs) > 0 ? Number(opts.applyTimeoutMs) : 120000,
    // 全局 in-flight：同时只跑一次 `plugin list`（并发请求复用同一个 Promise）
    applyInFlight: null,
  }

  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((e) => {
      const error = panelError(e)
      log.warn?.(`loomy panel: ${error} <<${String(e?.stack ?? e?.message ?? e).split("\n").slice(0, 3).join(" / ")}>>`)
      sendJson(res, 500, { error })
    })
  })

  const port = opts.retry
    ? await listenRetrying(server, wantPort, opts.host ?? "127.0.0.1", log)
    : await listen(server, wantPort, opts.host ?? "127.0.0.1")

  /** @type {{port: number, close: () => Promise<void>}} */
  const inst = {
    port,
    close: async () => {
      running.delete(port)
      await new Promise((resolve) => {
        server.close(() => resolve())
        // 有 keep-alive 连接时不等它自己断
        server.closeAllConnections?.()
      })
    },
  }
  running.set(port, inst)
  return inst
}

/**
 * 监听指定端口；被占用时**每 500ms 重试一次，最多 30 秒**。
 *
 * # 为什么是重试而不是顺延
 *
 * 页面服务的端口是 **magpie 指定的**（`options.port`）。改成邻近端口会让
 * magpie 记的地址与实际监听的不一致 → 页面导航到 404/拒绝连接。
 *
 * 而端口被占用是**正常的竞争**：magpie 的 app 宿主与命令行宿主可能同时加载
 * 本插件，命令行那边会把 port 挪走（见 magpie 源码 `hostOptions`），
 * 但 app 宿主占着真正的那个口。此时等一会儿，占用的那个会释放或已经在服务。
 *
 * @param {import("node:http").Server} server
 * @param {number} port
 * @param {string} host
 * @param {object} log
 * @returns {Promise<number>}
 */
async function listenRetrying(server, port, host, log) {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener("listening", onListening)
          reject(err)
        }
        const onListening = () => {
          server.removeListener("error", onError)
          resolve(undefined)
        }
        server.once("error", onError)
        server.once("listening", onListening)
        server.listen(port, host)
      })
      return port
    } catch (err) {
      if (err?.code !== "EADDRINUSE" || Date.now() > deadline) {
        throw new Error(`端口 ${port} 已被另一个程序占用（${err?.code ?? err?.message}）`)
      }
      log.warn?.(`[loomy] 端口 ${port} 被占用，500ms 后重试…`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

/**
 * 监听；端口被占用时按 magpie 其它插件的惯例**顺延**（最多 +9），
 * 再不行让系统挑。
 *
 * ⚠ 绝不「往上无限扫端口」：那会把别人的服务撞掉。
 */
function listen(server, wantPort, host) {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const tryPort = (p) => {
      const onError = (err) => {
        server.removeListener("listening", onListening)
        if (err.code === "EADDRINUSE" && attempt < 9) {
          attempt += 1
          tryPort(wantPort + attempt)
          return
        }
        if (err.code === "EADDRINUSE") {
          // 顺延失败：让系统挑一个
          server.once("error", reject)
          server.listen(0, host, () => resolve(server.address().port))
          return
        }
        reject(err)
      }
      const onListening = () => {
        server.removeListener("error", onError)
        resolve(server.address().port)
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(p, host)
    }
    tryPort(wantPort)
  })
}

// ── 路由 ────────────────────────────────────────────────────────────────

async function handle(req, res, ctx) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
  const path = url.pathname

  if (path.startsWith("/api/") && req.method === "OPTIONS") {
    const headers = { ...commonHeaders(res.socket?.localPort), Vary: "Access-Control-Request-Private-Network" }
    if (req.headers["access-control-request-private-network"] === "true") {
      headers["Access-Control-Allow-Private-Network"] = "true"
    }
    res.writeHead(204, headers)
    return res.end()
  }

  // 面板页面与静态资源
  if (path === "/" || path === "/index.html") return sendFile(res, join(HERE, "page", "index.html"), "text/html; charset=utf-8")
  if (path.startsWith("/assets/")) {
    // ⚠ 只允许 page/assets/ 下的文件：`..` 跳出目录会把整个仓库暴露出去
    const rel = path.slice("/assets/".length)
    if (rel.includes("..") || rel.includes("\\")) return sendJson(res, 400, { error: "bad path" })
    return sendFile(res, join(HERE, "page", "assets", rel), guessType(path))
  }

  // API —— 这五个列表 GET 全部只读缓存（零上游请求）
  // ⚠ `since` 必须由 **process.uptime() 反推**，不能用 startServer 时的 Date.now()：
  // 前者在模块被缓存复用（旧进程）时仍然是真实启动时刻，后者只会是「这次 listen」。
  if (path === "/api/hello") {
    return sendJson(res, 200, {
      ok: true,
      provider: PROVIDER,
      since: Date.now() - Math.round(process.uptime() * 1000),
      uptimeMs: Math.round(process.uptime() * 1000),
      pid: process.pid,
      startedAt: ctx.startedAt,
      // 令牌桶可观测（T-54）：排障时一眼看出「是闸在排队，还是上游本身慢」
      gate: rateGateFor(ctx).snapshot(),
    })
  }
  if (path === "/api/settings" && req.method === "GET") return getPanelSettings(res, ctx)
  if (path === "/api/settings" && req.method === "POST") return savePanelSettings(req, res, ctx)
  if (path === "/api/accounts") return sendJson(res, 200, await listAccounts(ctx, url.searchParams))
  if (path === "/api/tasks") return sendJson(res, 200, await tasksForAll(ctx, url.searchParams))
  if (path === "/api/invite") return sendJson(res, 200, await inviteForAll(ctx, url.searchParams))
  if (path === "/api/do" && req.method === "POST") return sendJson(res, 200, await act(req, ctx))

  // DS4.1 路由：读状态 / 清空结果 / 单检 / 批量检测（异步任务）
  if (path === "/api/route-state" && req.method === "GET") return routeState(res, ctx)
  if (path === "/api/route-state/reset" && req.method === "POST") return routeStateReset(req, res, ctx)
  if (path === "/api/route-check" && req.method === "POST") return routeCheck(req, res, ctx)
  if (path === "/api/route-check-batch" && req.method === "POST") return routeCheckBatchStart(req, res, ctx)
  if (path === "/api/route-check-batch" && req.method === "GET") return routeCheckBatchState(res, ctx, url.searchParams)
  // 判定 → 生效：跑一次 `magpie plugin list`（实测唯一能让运行中 magpie 重拉模型列表的通道）
  if (path === "/api/apply-route" && req.method === "POST") return applyRouteRoute(res, ctx)

  // 余额：单行只刷这一个号；批量是「刷新全部」的全量入口
  if (path === "/api/accounts-refresh" && req.method === "POST") return accountRefreshOne(req, res, ctx)
  if (path === "/api/accounts-refresh-batch" && req.method === "POST") return accountsRefreshStart(req, res, ctx)
  if (path === "/api/accounts-refresh-batch" && req.method === "GET") return accountsRefreshState(res, ctx, url.searchParams)
  // 额度：`auth.usage` 唯一的**写入口**（用户在面板点「刷新额度」才走这里）
  if (path === "/api/usage/refresh" && req.method === "POST") return usageRefreshStart(req, res, ctx)
  if (path === "/api/usage/refresh" && req.method === "GET") return readRefreshJob(res, ctx, url.searchParams, "usage")
  // 任务 / 邀请码同理（打开面板读缓存，刷新必须用户点）
  if (path === "/api/tasks-refresh-batch" && req.method === "POST") return tasksRefreshStart(req, res, ctx)
  if (path === "/api/tasks-refresh-batch" && req.method === "GET") return tasksRefreshState(res, ctx, url.searchParams)
  if (path === "/api/invite-refresh-batch" && req.method === "POST") return inviteRefreshStart(req, res, ctx)
  if (path === "/api/invite-refresh-batch" && req.method === "GET") return inviteRefreshState(res, ctx, url.searchParams)
  // 邀请码分配：码池读缓存（零上游）；扫描 / 绑定都是用户点出来的 job
  if (path === "/api/invite/pool" && req.method === "GET") return invitePoolState(res, ctx)
  if (path === "/api/invite/pool/scan" && req.method === "POST") return invitePoolScanStart(req, res, ctx)
  if (path === "/api/invite/pool/scan" && req.method === "GET") return readInviteJob(res, ctx, url.searchParams, "scan")
  if (path === "/api/invite/assign" && req.method === "POST") return inviteAssignStart(req, res, ctx)
  if (path === "/api/invite/assign" && req.method === "GET") return readInviteJob(res, ctx, url.searchParams, "assign")

  sendJson(res, 404, { error: "not found" })
}

// ── 账号列表（纯读缓存） ────────────────────────────────────────────────

/**
 * 列出 magpie 里已登录的 loomy 账号 —— **纯读缓存，零网络**。
 *
 * # 为什么这里绝不能发请求（真机事故）
 *
 * 打开面板原本会对 184 个号全量查积分（`fetchPointsSnapshot` × 184）。上游
 * 直接限流 → 大面积「发送失败」、一批号被标成不可用。用户的原话是「所有
 * 刷新的功能全部需要用户手动操作」。
 *
 * 所以这里的输入**只有**本地文件：`plugin-auth.json`（账号清单）+
 * `loomy-accounts-cache.json`（上次查询的结果）。真实查询走
 * `POST /api/accounts-refresh-batch`（用户点「刷新全部」才有）。
 *
 * @param {any} ctx
 * @param {URLSearchParams} params
 */
async function listAccounts(ctx, params) {
  const accounts = selectedAccounts(ctx, params)
  const cache = readAccountsCache(ctx.configDir)
  const out = accounts.map((a) => {
    const entry = cache.accounts[a.uid]
    const cached = isPlainObject(entry)
    return {
      uid: a.uid,
      name: a.nickname || shortUID(a.uid),
      phone: a.phone,
      firstLogin: ctx.state.accounts[a.uid]?.firstLogin === true ? true : a.firstLogin,
      quota: cached ? quotaFromCache(entry) : null,
      // 上次查询失败的原因（有就带上；**不**因为 error 去重查）
      error: cached ? String(entry.error ?? "") : "",
      cached,
      at: cached ? Number(entry.at) || 0 : 0,
    }
  })
  return { accounts: out, total: out.length, updatedAt: cache.updatedAt, cached: out.some((row) => row.cached) }
}

/** 把一条缓存条目还原成面板的 `quota`（usageFromPoints 的窗口形状）。 */
function quotaFromCache(entry) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined)
  const daily = num(entry.daily)
  const permanent = num(entry.permanent)
  const balance = num(entry.balance)
  return usageFromPoints(
    {
      dailyKnown: daily !== undefined,
      daily: daily ?? 0,
      permanentKnown: permanent !== undefined,
      permanent: permanent ?? 0,
      available: balance,
    },
    { source: "cache", now: Number(entry.at) || undefined },
  )
}

/**
 * 所有账号的新手任务状态 —— **纯读缓存，零上游请求**（与余额同口径）。
 *
 * 真实查询走 `POST /api/tasks-refresh-batch`（用户点按钮才有）。
 */
async function tasksForAll(ctx, params) {
  const accounts = selectedAccounts(ctx, params)
  const cache = readTasksCache(ctx.configDir)
  /** @type {any[]} */
  const rows = accounts.map((a) => {
    const entry = cache.tasks[a.uid]
    const cached = isPlainObject(entry)
    const tasks = cached && isPlainObject(entry.tasks) ? entry.tasks : {}
    return {
      uid: a.uid,
      name: a.nickname || shortUID(a.uid),
      tasks,
      summary: tasksSummary(tasks),
      error: cached ? String(entry.error ?? "") : "",
      cached,
      at: cached ? Number(entry.at) || 0 : 0,
    }
  })
  return { defs: TASK_DEFS, rows, updatedAt: cache.updatedAt, cached: rows.some((r) => r.cached) }
}

/**
 * 所有账号的邀请码与激活状态 —— **纯读缓存，零上游请求**。
 *
 * 真实查询走 `POST /api/invite-refresh-batch`（用户点按钮才有）。
 */
async function inviteForAll(ctx, params) {
  const accounts = selectedAccounts(ctx, params)
  const cache = readInviteCache(ctx.configDir)
  const rows = accounts.map((a) => {
    const entry = cache.codes[a.uid]
    const cached = isPlainObject(entry)
    return {
      uid: a.uid,
      name: a.nickname || shortUID(a.uid),
      codes: cached && Array.isArray(entry.codes) ? entry.codes : [],
      activation: cached && isPlainObject(entry.activation) ? entry.activation : null,
      error: cached ? String(entry.error ?? "") : "",
      cached,
      at: cached ? Number(entry.at) || 0 : 0,
    }
  })
  return { rows, updatedAt: cache.updatedAt, cached: rows.some((r) => r.cached) }
}

// ── 动作（完成任务 / 绑定邀请码 / 补首登） ──────────────────────────────

/** 执行一个动作（完成单个任务 / 一键全做 / 绑定邀请码 / 补首登）。 */
async function act(req, ctx) {
  const body = await readBody(req, 1 << 20)
  /** @type {any} */
  let input
  try {
    input = JSON.parse(body)
  } catch {
    return { error: "动作参数不是合法 JSON" }
  }

  if (input?.action === "bind-invite-bulk") return bulkBind(ctx, input)

  let session
  try {
    session = await resolveSession(ctx, input?.uid)
  } catch (e) {
    // ⚠ 绝不静默换号（见 resolveSession）：缺 uid / 找不到账号都要把原因说出来
    return { ok: false, error: String(e?.message ?? e) }
  }

  const base = { baseUrl: ctx.baseUrl, auth: { session }, fetchImpl: ctx.fetchImpl }

  switch (input?.action) {
    case "complete-task": {
      const key = String(input?.key ?? "")
      if (!key) return { error: "缺 key" }
      const r = await completeTask(base, key)
      return { ok: true, ...r, message: `已完成「${key}」+${r.points} 积分` }
    }
    case "complete-all": {
      // 逐个完成，单个失败不中断（有的任务需要用户真的做过某件事）
      const done = []
      const failed = []
      for (const def of TASK_DEFS) {
        try {
          const r = await completeTask(base, def.key)
          done.push({ key: def.key, points: r.points })
        } catch (e) {
          failed.push({ key: def.key, error: panelError(e) })
        }
      }
      const points = done.reduce((s, d) => s + d.points, 0)
      return { ok: true, done, failed, points, message: `完成 ${done.length}/${TASK_DEFS.length} 项，+${points} 积分` }
    }
    case "bind-invite": {
      const code = String(input?.code ?? "").trim()
      if (!code) return { error: "缺邀请码" }
      if (ctx.binding) return { ok: false, error: "绑定正在运行" }
      ctx.binding = true
      try {
        const activation = await fetchActivation(base)
        if (activation.activated !== false) return { ok: false, error: "账号已绑定或状态未知" }
        const account = readMagpieAuth(ctx.configDir).find((a) => a.session === session)
        return await bindAccount(ctx, account, code)
      } finally {
        ctx.binding = false
      }
    }
    case "first-login":
    case "repair-tasks": {
      const account = readMagpieAuth(ctx.configDir).find((a) => a.session === session)
      let receipt
      try {
        receipt = safeReceipt(await firstLogin(base), session)
        updatePanelState(ctx, (state) => {
          state.accounts[account.uid] ??= {}
          state.accounts[account.uid].firstLogin = true
        })
      } catch (e) {
        return { ok: false, failed: [{ key: "first-login", error: panelError(e) }] }
      }
      if (input.action === "first-login") return { ok: true, firstLogin: true, receipt }
      let tasks
      try {
        tasks = await fetchTasks(base)
      } catch (e) {
        return { ok: false, firstLogin: true, done: [], failed: [{ key: "fetch-tasks", error: panelError(e) }] }
      }
      const done = []
      const failed = []
      const skipped = []
      for (const def of TASK_DEFS) {
        if (tasks[def.key] === true) {
          skipped.push(def.key)
          continue
        }
        try {
          const result = await completeTask(base, def.key)
          done.push({ key: def.key, points: result.points })
        } catch (e) {
          failed.push({ key: def.key, error: panelError(e) })
        }
      }
      return { ok: failed.length === 0, firstLogin: true, receipt, done, failed, skipped, points: done.reduce((sum, d) => sum + d.points, 0) }
    }
    case "probe-local": {
      const dir = ctx.clientStoreDir
      if (!dir) return { ok: false, message: "本机没有找到 Loomy 客户端的数据目录" }
      const { credential, source } = readLocalAuth(dir)
      const points = readLocalPoints(dir)
      return {
        ok: Boolean(credential),
        dir,
        source,
        account: credential ? { uid: credential.uid, name: credential.nickname } : null,
        cachedPoints: points,
        message: credential ? "读到了本机登录态" : "目录里没有完整的登录态记录",
      }
    }
    default:
      return { error: `未知动作: ${input?.action}` }
  }
}

// ── magpie 账号存储 ─────────────────────────────────────────────────────

/**
 * 读 magpie 的 `plugin-auth.json`，取出 loomy 的账号。
 *
 * ⚠ 这是**钻实现细节**（该文件的格式不在插件契约里）。所以：
 * 读失败一律当「没有账号」，绝不让面板整页报错。
 *
 * @param {string} configDir
 * @returns {Array<{session: string, uid: string, accountId: string, nickname: string, phone: string, firstLogin: boolean|null}>}
 */
export function readMagpieAuth(configDir) {
  if (!configDir) return []
  const file = join(configDir, "plugin-auth.json")
  if (!existsSync(file)) return []

  /** @type {any} */
  let all
  try {
    all = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return []
  }

  /** @type {Array<{session: string, uid: string, accountId: string, nickname: string, phone: string, firstLogin: boolean|null}>} */
  const out = []
  for (const [key, value] of Object.entries(all ?? {})) {
    // 键形态：`loomy` 或 `loomy#xxxxxx`（多账号）
    if (key !== PROVIDER && !key.startsWith(PROVIDER + "#")) continue
    const v = /** @type {any} */ (value)
    // 两种形态都认：oauth 的 access，以及早期写法的 api/key
    const session = String(v?.access ?? v?.key ?? "").trim()
    if (!session) continue
    const meta = v?.metadata ?? {}
    const uid = String(meta.uid ?? v?.uid ?? "").trim() || deriveUID(session)
    // accountId 也要留着：面板/用户可能拿手机号来指代账号（见 resolveSession）
    const accountId = String(v?.accountId ?? meta.accountId ?? "").trim()
    out.push({
      session,
      uid,
      accountId,
      nickname: String(meta.nickname ?? v?.accountId ?? "").trim(),
      phone: String(meta.phone ?? "").trim(),
      firstLogin: typeof meta.firstLogin === "boolean" ? meta.firstLogin : null,
    })
  }
  return out
}

// ── DS4.1 路由 ──────────────────────────────────────────────────────────
//
// # 这一块在解什么问题
//
// 上游对**被限制的账号**会把 `DeepSeek-V4.1-Flash` 实际落到 `spark-x2.6-low`，
// 而 `/models` 与 chat 响应都看不出来 —— 唯一权威信号是积分账本
// `GET /points/records`（头 `token:<session>`）里每条 `{createdAt, modelName}`。
// 判定逻辑不写在这里：它属于 `src/route.mjs`（T-01），落盘属于
// `src/route-store.mjs`。面板只做：**读状态**、**受控地跑探测**、**清空结果**。
//
// 结论是**账号级**的。verdict 与 reason 的组合：
//	clean                              正常
//	routed  + catalog-missing-ds41     目录里没有 DS4.1（免费判定）
//	routed  + ledger-spark / -other    账本证明被换模型（扣 1 积分）
//	expired + session-expired          登录失效（免费判定）
//	expired + account-disabled         账号被上游封禁（免费判定）
//	unknown                            没测清
//
// ⚠ 探测有真实成本（1 次计费调用，扣 1 积分），所以：
//   · 面板文案写明成本（`ROUTE_COST_HINT` / `routeCostHint`）；
//   · 同一 uid 并发只跑一次（`ctx.routePending`）；
//   · 失败与 `unknown` **不覆盖**已有结论（clean/routed/expired 才覆盖）。
//
// ⚠ `src/route.mjs` / `src/route-store.mjs` 在并行开发期可能不存在：
// 一律 `import(...).catch(() => null)`，缺失 = 优雅降级（503），
// **绝不**在本文件里伪造这两个模块的实现。
//
// ⚠ 面板服务**不** import `src/hooks/` 下的任何模块（钩子是 magpie 宿主侧）。

/**
 * 结论文案：**唯一一份**。面板不自己写文案，直接用入口返回的 `label`。
 *
 * @param {{verdict?: string, reason?: string, servedModel?: string}|null|undefined} entry
 * @returns {string}
 */
export function routeLabel(entry) {
  // 「账号已停用」：上游 100003（封禁），与 100002（登录失效）不是一回事
  if (entry?.reason === "account-disabled") return "账号已停用（上游封禁，无法恢复）"
  if (entry?.reason === "no-quota" || entry?.verdict === "exhausted") return "积分不足 · 已停用（充值后自动恢复）"
  if (entry?.verdict === "expired" || entry?.reason === "session-expired") return "登录已失效 · 已停用（重新登录后恢复）"
  if (entry?.verdict === "clean") return "正常"
  if (entry?.verdict !== "routed") return "未检测 / 检测不完整"
  const reason = String(entry?.reason ?? "")
  if (reason === "catalog-missing-ds41") return "已被上游限制 · 目录无 DS4.1（仅 spark-x2.6-low / 4b）"
  if (reason === "ledger-other-family") return `已被上游限制 · 被换到其它厂商（→ ${entry?.servedModel || "其它模型"}）`
  return "已被上游限制 · 整号停用（实际 → spark-x2.6-low）"
}

/**
 * 这条结论花了多少积分（前端直接显示）。
 *
 * 只看 `/models` 的判定（目录缺失 / 登录失效 / 账号封禁）**免费**；
 * 只有账本探测才真的发过一次 chat、扣 1 积分。
 *
 * @param {{reason?: string}|null|undefined} entry
 * @returns {string}
 */
export function routeCostHint(entry) {
  const reason = String(entry?.reason ?? "")
  const free = reason === "catalog-missing-ds41" || reason === "session-expired" || reason === "account-disabled" || reason === "no-quota"
  return free ? "免费判定" : "已扣 1 积分"
}

/**
 * 探测成本提示：面板按钮旁的小字（**只此一份**）。
 *
 * ⚠ 单条结论的成本看 `routeCostHint()`（目录/登录/封禁类判定是免费的），
 * 这个常量说的是「按一次检测按钮最坏会花多少积分」。
 */
export const ROUTE_COST_HINT = "检测会真实调用 1 次，扣 1 积分"

// ── 判定 → 生效：`magpie plugin list` ────────────────────────────────────
//
// # 为什么是这条命令
//
// 实测：magpie **不会**自己重拉模型列表（`plugin-providers.json` 的 mtime 两分钟
// 不动），但执行一次 `magpie plugin list` 会重写它，**并且运行中的 magpie 随之
// 生效**（把某号改成 routed 后跑该命令，magpie trace 里该号即从路由池消失）。
// 所以「判定写了文件」≠「生效」，必须显式跑这一下。

/** 找到 magpie 可执行文件：设置里的 `magpiePath` 优先，否则走候选列表。 */
export function resolveMagpieExecutable(settings = {}, env = process.env) {
  const configured = String(settings?.magpiePath ?? "").trim()
  if (configured && existsSync(configured)) return configured
  const candidates = [
    "D:\\software\\magpie-windows-amd64\\magpie-windows-amd64.exe",
    join(env.LOCALAPPDATA ?? "", "Programs", "magpie", "magpie-windows-amd64.exe"),
    join(env.ProgramFiles ?? "", "magpie", "magpie-windows-amd64.exe"),
    String(env.MAGPIE_BIN ?? "").trim(),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return ""
}

/**
 * 跑一次 `magpie plugin list`，让运行中的 magpie 重拉模型列表。
 *
 * ⚠ **全局 in-flight 复用**：同一时刻只允许一个（并发请求拿同一个 Promise），
 *   否则两个重拉会互相覆盖 `plugin-providers.json`。
 *
 * @param {any} ctx
 * @returns {Promise<{ok: true, ms: number, path: string} | {ok: false, error: string, code?: number}>}
 */
export function applyRoute(ctx) {
  const settings = readPanelSettings(ctx.configDir).data
  const exe = resolveMagpieExecutable(settings)
  if (!exe) {
    return Promise.resolve({ ok: false, error: "找不到 magpie 可执行文件，请在设置里填 magpie 路径" })
  }
  if (ctx.applyInFlight) return ctx.applyInFlight

  const timeoutMs = Number(ctx.applyTimeoutMs) > 0 ? Number(ctx.applyTimeoutMs) : 120000
  const startedAt = Date.now()
  ctx.applyInFlight = new Promise((resolve) => {
    /** @type {any} */
    let child
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 让下一个请求能重新触发（复用只覆盖「正在跑」的那段时间）
      ctx.applyInFlight = null
      if (result.ok) ctx.log?.warn?.("[应用] 已重拉 magpie 模型列表")
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child?.kill?.() } catch {}
      finish({ ok: false, error: "magpie plugin list 超时（120s），已中止" })
    }, timeoutMs)
    timer.unref?.()

    try {
      child = ctx.spawnImpl(exe, ["plugin", "list"], { windowsHide: true, stdio: "ignore" })
    } catch (e) {
      finish({ ok: false, error: `无法启动 magpie：${String(e?.message ?? e).slice(0, 200)}` })
      return
    }
    child.on("error", (e) => finish({ ok: false, error: `无法启动 magpie：${String(e?.message ?? e).slice(0, 200)}` }))
    child.on("close", (code) => {
      const ms = Date.now() - startedAt
      if (code === 0) finish({ ok: true, ms, path: exe })
      else finish({ ok: false, error: `magpie plugin list 退出码 ${code}`, code })
    })
  })
  return ctx.applyInFlight
}

/** `POST /api/apply-route`：手动触发一次（面板按钮）。 */
async function applyRouteRoute(res, ctx) {
  const result = await applyRoute(ctx)
  return sendJson(res, result.ok ? 200 : 500, result)
}

/** job 收尾时的自动应用（只在 `autoApply` 为真时做，失败只记日志）。 */
function scheduleAutoApply(ctx, job) {
  if (!job) return
  const settings = readPanelSettings(ctx.configDir).data
  if (settings.autoApply !== true) {
    job.applied = false
    return
  }
  void applyRoute(ctx)
    .then((result) => {
      if (result.ok) {
        job.applied = true
        job.applyError = ""
        ctx.log?.warn?.(`[应用] 已重拉 magpie 模型列表（${result.ms}ms）`)
      } else {
        job.applied = false
        job.applyError = result.error
        ctx.log?.warn?.(`[应用] 重拉失败：${result.error}`)
      }
    })
    .catch((e) => {
      job.applied = false
      job.applyError = String(e?.message ?? e).slice(0, 200)
    })
}
/** 批量检测的边界。
 *
 * # 并发默认 2，**没有上限**（用户要求）
 *
 * 每个号一次探测 = 1 次真实计费调用。真正的保护是「相邻两次启动 ≥300ms」
 * 与「连续 3 次限流熔断」，而不是悄悄截断用户的输入。
 *
 * ⚠ 一次能传多少个账号**也没有上限**：传 1000、10000 都接受。
 */
export const ROUTE_BATCH_CONCURRENCY = 2

/** 完成的任务在内存里保留多久（毫秒）。 */
export const ROUTE_JOB_TTL_MS = 30 * 60 * 1000


/** 批量里相邻两次探测的**启动**间隔（节流，不是纯并发上限）。 */
export const ROUTE_BATCH_GAP_MS = 300

/** 连续这么多个号被判限流就熔断整个任务。 */
export const ROUTE_BATCH_BREAKER = 3

/** 余额/任务/邀请刷新复用同一套节流与熔断参数（两处必须一致）。 */
const BATCH_GAP_MS = ROUTE_BATCH_GAP_MS
const BATCH_BREAKER = ROUTE_BATCH_BREAKER

/**
 * 取探测模块；没就绪返回 null。
 *
 * 结果按实例缓存（`ctx.routeModules`），失败也缓存：一次 import 失败之后
 * 每个请求都重试没有意义，模块若被补上，magpie 重载插件会换新实例。
 *
 * @param {any} ctx
 * @returns {Promise<null | {probeRoute: Function, readRouteState: Function,
 *   writeRouteState: Function, getAccountRoute?: Function, routeStatePath?: Function}>}
 */
function ensureRouteModules(ctx) {
  ctx.routeModules ??= loadRouteModules()
  return ctx.routeModules
}

/** 动态加载 `src/route.mjs` 与 `src/route-store.mjs`（缺失即 null）。 */
async function loadRouteModules() {
  const [probe, store] = await Promise.all([
    import("./src/route.mjs").catch(() => null),
    import("./src/route-store.mjs").catch(() => null),
  ])
  if (typeof probe?.probeRoute !== "function") return null
  if (typeof store?.readRouteState !== "function" || typeof store?.writeRouteState !== "function") return null
  return {
    /**
     * 面板「检测」的唯一通道：**只读判定**（`probeRoute`）。
     *
     * 目录 + 账本 + 余额，**0 积分**。原来还有一条 by-turn 通道（发一次计费
     * chat、再用 TurnId 回查），T-38 整段删除：响应体每个 chunk 自带 `model`，
     * 而「这一轮实际由谁服务」由 loader 旁路读取（见 `noteServedModel`），
     * 不必再为它额外打一次上游。
     */
    probeRoute: probe.probeRoute,
    readRouteState: store.readRouteState,
    writeRouteState: store.writeRouteState,
    getAccountRoute: store.getAccountRoute,
    // 清空要用「落盘模块自己认的那个路径」，不在这里硬编码文件名
    routeStatePath: typeof store.routeStatePath === "function" ? store.routeStatePath : undefined,
  }
}

/**
 * `GET /api/route-state` → `{ok:true, state:{[uid]:entry+label+costHint}}`。
 *
 * 状态文件不存在 / 还没有任何检测结果时，`state` 就是 `{}` —— 面板据此
 * 显示「未检测」。读失败不让整页报错：回 `state:{}` 加一条 `error` 说明。
 */
async function routeState(res, ctx) {
  const mods = await ensureRouteModules(ctx)
  if (!mods) return sendJson(res, 503, { ok: false, error: "检测模块未就绪" })
  if (!ctx.configDir) return sendJson(res, 503, { ok: false, error: "未设置 configDir，无法读取路由状态" })

  try {
    const read = mods.readRouteState(ctx.configDir)
    if (read && read.ok === false) {
      ctx.log.warn?.(`loomy panel: 路由状态读取失败: ${String(read.error ?? "").slice(0, 200)}`)
      return sendJson(res, 200, { ok: true, state: {}, fetchedAt: Date.now(), error: "路由状态文件读取失败" })
    }
    // 兼容「返回 {ok,data}」与「直接返回对象」两种落盘模块写法
    const raw = read && typeof read === "object" && "data" in read ? read.data : read
    /** @type {Record<string, object>} */
    const state = {}
    if (isPlainObject(raw)) {
      for (const [uid, entry] of Object.entries(raw)) {
        if (!isPlainObject(entry)) continue
        state[uid] = withLabel(entry)
      }
    }
    // fetchedAt 让页面能说清「路由状态截至什么时候」—— 状态文件可能刚被外部改过，
    // 页面必须能区分「这份数据是刚刚读的」还是「加载时的旧快照」。
    return sendJson(res, 200, { ok: true, state, fetchedAt: Date.now() })
  } catch (e) {
    ctx.log.warn?.(`loomy panel: 路由状态读取异常: ${String(e?.message ?? e).slice(0, 200)}`)
    return sendJson(res, 200, { ok: true, state: {}, fetchedAt: Date.now(), error: "路由状态文件读取失败" })
  }
}

/**
 * `POST /api/route-state/reset {uids?}` → 清空检测结果。
 *
 * # 为什么需要它（真机痛点）
 *
 * 旧判据跑出来的 `unknown` 会一直挂在表上；「跳过已有结论」只跳
 * clean/routed/expired，unknown 本该重测，但用户看到的是旧的错误分类。
 * 所以给一个**显式的清空**：删掉 route-state 里对应 uid 的记录，让它们回到
 * 「未检测」，再由用户手动重测。
 *
 * ⚠ 只动 `<configDir>/loomy-route-state.json`：
 *   不碰 `plugin-auth.json`、不碰 magpie 的账号/额度、不碰三个缓存文件。
 *   路径从落盘模块的 `routeStatePath()` 取（那是它自己的权威路径）。
 */
async function routeStateReset(req, res, ctx) {
  /** @type {any} */
  let input
  try {
    const raw = await readBody(req, 1 << 20)
    input = raw ? JSON.parse(raw) : {}
  } catch {
    return sendJson(res, 400, { ok: false, error: "参数不是合法 JSON" })
  }
  if (!isPlainObject(input)) return sendJson(res, 400, { ok: false, error: "参数必须是 JSON 对象" })

  const mods = await ensureRouteModules(ctx)
  if (!mods) return sendJson(res, 503, { ok: false, error: "检测模块未就绪" })
  if (!ctx.configDir) return sendJson(res, 503, { ok: false, error: "未设置 configDir，无法定位路由状态文件" })

  /** @type {string[]|null} */
  let targets = null
  if (input.uids !== undefined && input.uids !== null) {
    if (!Array.isArray(input.uids)) return sendJson(res, 400, { ok: false, error: "uids 必须是数组" })
    /** @type {string[]} */
    const list = []
    for (const raw of input.uids) {
      if (typeof raw !== "string") return sendJson(res, 400, { ok: false, error: "uids 的每个元素都必须是字符串" })
      const uid = raw.trim()
      if (uid) list.push(uid)
    }
    if (!list.length) return sendJson(res, 400, { ok: false, error: "uids 不能为空（省略该字段表示清空全部）" })
    targets = list
  }

  const read = mods.readRouteState(ctx.configDir)
  if (read && read.ok === false) {
    return sendJson(res, 500, { ok: false, error: "路由状态文件读取失败，未做任何修改" })
  }
  /** @type {Record<string, any>} */
  const data = isPlainObject(read?.data) ? read.data : {}

  const path = typeof mods.routeStatePath === "function" ? mods.routeStatePath(ctx.configDir) : ""
  if (!path) return sendJson(res, 503, { ok: false, error: "落盘模块没有暴露状态文件路径，无法清空" })

  const remove = targets ? new Set(targets) : null
  /** @type {Record<string, any>} */
  const next = {}
  let removed = 0
  for (const [uid, entry] of Object.entries(data)) {
    if (!remove || remove.has(uid)) {
      removed += 1
      continue
    }
    next[uid] = entry
  }

  try {
    const temp = path + "." + randomUUID() + ".tmp"
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 })
      renameSync(temp, path)
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
  } catch (e) {
    ctx.log.warn?.(`loomy panel: 清空路由状态失败: ${String(e?.message ?? e).slice(0, 200)}`)
    return sendJson(res, 500, { ok: false, error: "清空失败，状态文件未修改" })
  }

  ctx.log.warn?.(`loomy panel: 清空路由检测结果 ${removed} 条（剩余 ${Object.keys(next).length} 条）`)
  return sendJson(res, 200, { ok: true, removed, remaining: Object.keys(next).length })
}

/**
 * `POST /api/route-check {uid}` → 跑一次探测并落盘。
 *
 * ⚠ 受控：同一 uid 的并发请求合并成**一次**探测（`ctx.routePending`）。
 * 每次探测都是一次真实计费调用。
 */
async function routeCheck(req, res, ctx) {
  /** @type {any} */
  let input
  try {
    input = JSON.parse(await readBody(req, 4096))
  } catch {
    return sendJson(res, 400, { ok: false, error: "参数不是合法 JSON" })
  }
  const uid = String(input?.uid ?? "").trim()
  if (!uid) return sendJson(res, 400, { ok: false, error: "缺 uid" })

  const mods = await ensureRouteModules(ctx)
  if (!mods) return sendJson(res, 503, { ok: false, error: "检测模块未就绪" })
  if (!ctx.configDir) return sendJson(res, 503, { ok: false, error: "未设置 configDir，无法读取账号" })

  // session 只从 plugin-auth.json 取（`loomy` / `loomy#<id>` 两种键都认）
  const account = readMagpieAuth(ctx.configDir).find((a) => a.uid === uid)
  if (!account) return sendJson(res, 200, { ok: false, uid, error: "找不到这个账号的 session" })

  try {
    const { entry, stored, kept } = await probeAccountRoute(ctx, mods, uid, account.session)
    const body = { ok: true, uid, entry: withLabel(entry) }
    if (kept) body.note = "检测不完整，已保留上一次的结论"
    else if (!stored) body.note = "检测完成，但结论未落盘"
    return sendJson(res, 200, body)
  } catch (e) {
    const error = routeError(e, account.session)
    ctx.log.warn?.(`loomy panel: DS4.1 路由检测失败（${uid}）: ${error}`)
    return sendJson(res, 200, { ok: false, uid, error })
  }
}

/**
 * `POST /api/route-check-batch {uids, concurrency?, skipChecked?}` → 立刻回 jobId。
 *
 * 校验（先校验再启任务：不合法的请求不花任何积分）：
 *	uids        非空数组、元素必须 string（非字符串元素 → 400）；去重后为空 → 400；
 *	             **长度不限**（1000 / 10000 都接受）
 *	skipChecked 省略则取设置里的 `batchSkipChecked`
 *	concurrency 省略取设置；给了就必须是 ≥1 的整数（**无上限**）
 */
async function routeCheckBatchStart(req, res, ctx) {
  /** @type {any} */
  let input
  try {
    input = JSON.parse(await readBody(req, 1 << 20))
  } catch {
    return sendJson(res, 400, { ok: false, error: "参数不是合法 JSON" })
  }
  if (!isPlainObject(input)) return sendJson(res, 400, { ok: false, error: "参数必须是 JSON 对象" })
  if (!Array.isArray(input.uids)) return sendJson(res, 400, { ok: false, error: "uids 必须是非空数组" })

  /** @type {string[]} */
  const uids = []
  const seen = new Set()
  for (const raw of input.uids) {
    if (typeof raw !== "string") return sendJson(res, 400, { ok: false, error: "uids 的每个元素都必须是字符串" })
    const uid = raw.trim()
    if (!uid || seen.has(uid)) continue
    seen.add(uid)
    uids.push(uid)
  }
  if (!uids.length) return sendJson(res, 400, { ok: false, error: "uids 不能为空" })

  const settings = readPanelSettings(ctx.configDir).data
  let skipChecked = settings.batchSkipChecked
  if (input.skipChecked !== undefined && input.skipChecked !== null) {
    if (typeof input.skipChecked !== "boolean") return sendJson(res, 400, { ok: false, error: "skipChecked 必须是布尔值" })
    skipChecked = input.skipChecked
  }

  // 路由判定只用自己那条设置（routeConcurrency；兼容旧别名 batchConcurrency）
  let concurrency = concurrencyFor("route", settings)
  if (input.concurrency !== undefined && input.concurrency !== null) {
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
      return sendJson(res, 400, { ok: false, error: "concurrency 必须是 ≥1 的整数" })
    }
    // ⚠ 不截断：用户要求「并发不要上限」。真正的保护是 300ms 节流 + 熔断
    concurrency = input.concurrency
  }

  const mods = await ensureRouteModules(ctx)
  if (!mods) return sendJson(res, 503, { ok: false, error: "检测模块未就绪" })
  if (!ctx.configDir) return sendJson(res, 503, { ok: false, error: "未设置 configDir，无法读取账号" })

  // 已有决定性结论（clean/routed/expired）的号可以先跳过；`unknown` 不算结论
  const { skipped, pending } = splitRouteTargets(ctx, mods, uids, skipChecked)
  if (!pending.length) {
    // 一个都不需要测：不建任务、不打上游、不扣积分
    return sendJson(res, 200, { ok: true, jobId: "", total: 0, skipped, skippedTotal: skipped.length, message: "没有需要检测的账号（已有结论的都跳过了）" })
  }

  const jobId = randomUUID()
  const job = {
    jobId,
    total: pending.length,
    running: true,
    stopped: "",
    skipped,
    skippedTotal: skipped.length,
    results: /** @type {Record<string, object>} */ ({}),
  }
  ctx.routeJobs.set(jobId, job)

  // ⚠ 不 await：队列在后台跑，响应立刻返回
  void runRouteBatch(ctx, mods, job, pending, concurrency)

  return sendJson(res, 200, { ok: true, jobId, total: job.total, skipped, skippedTotal: skipped.length })
}

/**
 * 把请求里的 uid 分成「已有结论，可跳过」与「待测」两组。
 *
 * ⚠ 只认 `clean` / `routed` / `expired` 三个决定性结论：`unknown` 表示上次
 * 没测清，必须重测（否则一个从没成功过的号会永远被跳过）。
 */
function splitRouteTargets(ctx, mods, uids, skipChecked) {
  if (!skipChecked) return { skipped: [], pending: uids }
  /** @type {string[]} */
  const skipped = []
  /** @type {string[]} */
  const pending = []
  for (const uid of uids) {
    // ⚠ 只看 verdict：reason（catalog-missing / ledger-spark / session-expired /
    // account-disabled …）只负责文案与成本提示。上游以后若把某个新 reason 配到
    // routed 上，这里也不会因为它「不认识」而漏跳。
    const verdict = storedVerdict(mods, ctx.configDir, uid)
    if (isSettledVerdict(verdict)) skipped.push(uid)
    else pending.push(uid)
  }
  return { skipped, pending }
}

/** 「已有结论」的唯一判据：verdict 三档。`unknown`/空 都要重测。 */
function isSettledVerdict(verdict) {
  // ⚠ 四个 verdict 都算「已有结论」：exhausted（积分不足）重测也是不足，跳过省积分
  return verdict === "clean" || verdict === "routed" || verdict === "expired" || verdict === "exhausted"
}

/** 状态文件里这个 uid 的 verdict（没有就空串）。 */
function storedVerdict(mods, configDir, uid) {
  try {
    const entry = typeof mods.getAccountRoute === "function"
      ? mods.getAccountRoute(configDir, uid)
      : (() => {
          const read = mods.readRouteState(configDir)
          return read?.ok && isPlainObject(read.data) ? read.data[uid] : null
        })()
    return String(entry?.verdict ?? "")
  } catch {
    return ""
  }
}

/**
 * 后台队列：`concurrency` 个 worker 从同一个游标取号，**每次启动前过闸**。
 *
 * 三个防限流措施（真机踩过）：
 *  ① 并发上限来自设置；
 *  ② **节流**：相邻两次探测启动至少间隔 `ROUTE_BATCH_GAP_MS`；
 *  ③ **熔断**：连续 `ROUTE_BATCH_BREAKER` 个号被判限流/发送失败 →
 *     立刻停掉整个 job，剩下的号**一次都不打**。
 */
async function runRouteBatch(ctx, mods, job, uids, concurrency) {
  // 路由批量同样吃 gapMs 设置（0 = 不等待）；默认 300ms
  const gate = makeThrottle(gapFor(readPanelSettings(ctx.configDir).data))
  let cursor = 0
  let consecutiveRateLimit = 0
  const worker = async () => {
    for (;;) {
      if (job.stopped) return
      const index = cursor++
      if (index >= uids.length) return
      const uid = uids[index]
      await gate()
      // T-54：探测也是真实上游调用 —— 同样要过进程级令牌桶
      await passRateGate(ctx)
      // 放闸后再确认一次：同一批的另一个 worker 可能刚刚触发熔断
      if (job.stopped) return
      // 每个号的结果在**完成时**一次性写入 ⇒ 进行中的号不会出现在 results 里
      const result = await routeOneResult(ctx, mods, uid)
      job.results[uid] = result
      if (isRateLimitFailure(result)) {
        consecutiveRateLimit += 1
        if (consecutiveRateLimit >= ROUTE_BATCH_BREAKER) {
          job.stopped = "upstream-rate-limited"
          ctx.log.warn?.(`loomy panel: 批量检测连续 ${consecutiveRateLimit} 个号被判限流，已停止任务 ${job.jobId}`)
        }
      } else {
        consecutiveRateLimit = 0
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, uids.length) }, worker))
  } catch (e) {
    ctx.log.warn?.(`loomy panel: 批量检测异常收尾: ${String(e?.message ?? e).slice(0, 200)}`)
  } finally {
    job.running = false
    // 判定写完了 → 自动让 magpie 重拉模型列表（utoApply 关掉时只记 applied:false）
    scheduleAutoApply(ctx, job)
    const timer = setTimeout(() => { ctx.routeJobs.delete(job.jobId) }, ROUTE_JOB_TTL_MS)
    timer.unref?.()
  }
}

/**
 * 批量里的单个号：永不抛（失败也返回一条带 `error` 的结果）。
 *
 * 复用单检那套 `probeAccountRoute`：同 uid 正在跑的话会**并进同一个
 * in-flight Promise**，所以面板上连点/批量重叠都不会重复扣积分。
 */
async function routeOneResult(ctx, mods, uid) {
  let session = ""
  try {
    const account = readMagpieAuth(ctx.configDir).find((a) => a.uid === uid)
    if (!account) throw new Error("找不到这个账号的 session")
    session = account.session
    const { entry } = await probeAccountRoute(ctx, mods, uid, session)
    return withLabel(entry)
  } catch (e) {
    const error = routeError(e, session)
    ctx.log.warn?.(`loomy panel: 批量检测失败（${uid}）: ${error}`)
    return {
      verdict: "unknown",
      servedModel: "",
      checkedAt: Date.now(),
      label: routeLabel({ verdict: "unknown" }),
      error,
    }
  }
}

/**
 * `GET /api/route-check-batch?jobId=…` → 进度 + 已完成结果。
 *
 * `done` 由 `results` 现算，保证 `done === okCount + failCount`。
 */
function routeCheckBatchState(res, ctx, params) {
  const jobId = String(params.get("jobId") ?? "").trim()
  const job = jobId ? ctx.routeJobs.get(jobId) : null
  if (!job) return sendJson(res, 404, { ok: false, error: "没有这个检测任务" })

  let okCount = 0
  let failCount = 0
  for (const entry of Object.values(job.results)) {
    if (isPlainObject(entry) && entry.error) failCount += 1
    else okCount += 1
  }
  return sendJson(res, 200, {
    ok: true,
    job: {
      jobId: job.jobId,
      total: job.total,
      done: okCount + failCount,
      okCount,
      failCount,
      running: job.running,
      stopped: job.stopped || "",
      skippedTotal: job.skippedTotal ?? 0,
      // 判定写完后是否已让 magpie 重拉（`autoApply` 关掉时恒为 false）
      applied: job.applied === true,
      applyError: job.applyError || "",
      results: job.results,
    },
  })
}

/**
 * 同 uid 只跑一次探测；并发调用共享同一个 Promise。
 *
 * ⚠ 落盘规则：
 *   · `clean` / `routed` / `expired` 是**决定性结论** → 无条件写；
 *   · `unknown` 是「这次没测清」 → 已有记录时**不写**（保留上一次的有效结论），
 *     一条记录都没有时才写；
 *   · 探测抛异常 → 根本不进写盘（调用方回 `ok:false`）。
 */
/**
 * 「账本采样次数」设置（`ledgerReads`，1..5，默认 3）。
 *
 * 读设置失败（文件损坏 / configDir 缺失）时回默认值 —— 一个设置项读不出来，
 * 不该把整次探测弄挂。
 */
function probeLedgerReads(ctx) {
  try {
    const n = Number(readPanelSettings(ctx.configDir).data.ledgerReads)
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 3
  } catch { return 3 }
}

function probeAccountRoute(ctx, mods, uid, session) {
  const key = String(uid)
  const inflight = ctx.routePending.get(key)
  if (inflight) return inflight

  const task = (async () => {
    // 唯一通道：只读判定（`probeRoute`：目录 + 账本 + 余额，0 积分）。
    // by-turn 那条通道（发一次计费 chat 再回查）T-38 已整段删除。
    // ⚠ T-49：`ledgerReads`（设置里的「账本采样次数」）以前**存了却从未传下去**，
    //    改了不生效；这里按最新设置传给探测模块。
    const ledgerReads = probeLedgerReads(ctx)
    const entry = await mods.probeRoute({ baseUrl: ctx.baseUrl, session, fetchImpl: ctx.fetchImpl, ledgerReads })
    if (!entry || typeof entry !== "object") throw new Error("探测模块没有返回结果")
    const kept = entry.verdict === "unknown" && hasStoredRoute(mods, ctx.configDir, uid)
    let stored = !kept
    if (stored) {
      try {
        await mods.writeRouteState(ctx.configDir, uid, entry)
      } catch (e) {
        stored = false
        ctx.log.warn?.(`loomy panel: 路由结论落盘失败（${uid}）: ${String(e?.message ?? e).slice(0, 200)}`)
      }
    }
    return { entry, stored, kept }
  })()

  ctx.routePending.set(key, task)
  const done = () => {
    if (ctx.routePending.get(key) === task) ctx.routePending.delete(key)
  }
  task.then(done, done)
  return task
}

/** 给 entry 挂上共享文案（不改原字段；只出现在响应里，不写进状态文件）。 */
function withLabel(entry) {
  return { ...entry, label: routeLabel(entry), costHint: routeCostHint(entry) }
}

/** 这个 uid 已经有落盘结论了吗（落盘模块可只给 readRouteState）。 */
function hasStoredRoute(mods, configDir, uid) {
  const key = String(uid)
  try {
    if (typeof mods.getAccountRoute === "function") return !!mods.getAccountRoute(configDir, key)
    const read = mods.readRouteState(configDir)
    return !!(read?.ok && isPlainObject(read.data) && isPlainObject(read.data[key]))
  } catch {
    return false
  }
}

/** 面板错误信息：去掉 session，别把凭证写进日志或响应。 */
function routeError(error, session) {
  const text = String(error?.message ?? error ?? "").trim() || "未知错误"
  const masked = session ? text.replaceAll(String(session), "[redacted]") : text
  return `路由探测失败：${masked.slice(0, 200)}`
}

// ── 缓存与任务 ──────────────────────────────────────────────────────────
//
// 三种列表（余额 / 任务 / 邀请码）完全同构：
//	GET 只读缓存 → 刷新必须用户点 → 异步 job（并发槽 + 300ms 节流 + 熔断）
//
// 缓存文件（都在 configDir 下，缺文件/损坏都当空缓存，不抛）：
//	loomy-accounts-cache.json  {updatedAt, accounts:{uid:{balance,daily,...}}}
//	loomy-tasks-cache.json     {updatedAt, tasks:{uid:{tasks:{...}, at, error}}}
//	loomy-invite-cache.json    {updatedAt, codes:{uid:{codes:[...], activation, at, error}}}

const ACCOUNTS_CACHE_FILE = "loomy-accounts-cache.json"
const TASKS_CACHE_FILE = "loomy-tasks-cache.json"
const INVITE_CACHE_FILE = "loomy-invite-cache.json"

/**
 * 读「一个键 → 一张表」的缓存。
 *
 * @param {string} [configDir]
 * @param {string} file
 * @param {string} key `accounts` / `tasks` / `codes`
 */
function readKeyedCache(configDir, file, key) {
  const empty = { updatedAt: 0, [key]: {} }
  if (!configDir) return empty
  const path = join(configDir, file)
  if (!existsSync(path)) return empty
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return empty // 损坏的文件当空缓存：它是缓存，重建比报错更有用
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed[key])) return empty
  /** @type {Record<string, any>} */
  const table = {}
  for (const [uid, entry] of Object.entries(parsed[key])) {
    if (isPlainObject(entry)) table[uid] = entry
  }
  return { updatedAt: Number(parsed.updatedAt) || 0, [key]: table }
}

/** 原子写一条（**合并**其它 uid，不整表覆盖）。 */
function writeKeyedCache(configDir, file, key, uid, entry) {
  if (!configDir) throw new Error("未设置 configDir，无法保存缓存")
  const k = String(uid ?? "").trim()
  if (!k) throw new Error("uid 不能为空")
  const current = readKeyedCache(configDir, file, key)
  const table = { ...current[key] }
  // ⚠ 用 defineProperty：键来自 uid，万一叫 `__proto__` 普通赋值会改原型
  Object.defineProperty(table, k, { value: entry, enumerable: true, configurable: true, writable: true })
  const data = { updatedAt: Date.now(), [key]: table }
  const path = join(configDir, file)
  const temp = path + "." + randomUUID() + ".tmp"
  try {
    mkdirSync(String(configDir), { recursive: true })
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return data
}

export function readAccountsCache(configDir) {
  return readKeyedCache(configDir, ACCOUNTS_CACHE_FILE, "accounts")
}
export function readTasksCache(configDir) {
  return readKeyedCache(configDir, TASKS_CACHE_FILE, "tasks")
}
export function readInviteCache(configDir) {
  return readKeyedCache(configDir, INVITE_CACHE_FILE, "codes")
}

/**
 * 进程级令牌桶：容量**跟着设置走**，不写死任何上限。
 *
 * # 三条纪律（用户明确要求）
 *
 *	① 容量至少是 `RATE_GATE_CAPACITY`（20，与「余额刷新并发」的常态量级一致），
 *	   并且**不低于**用户任何一种并发设置。用户调到 60，闸就是 60；
 *	   **绝不**在代码里写死 3 / 6 之类「替用户限速」的数字。
 *	② `refillMs` 只管「突发之后补多快」，同样不影响用户设定的并发。
 *	③ 它是**防意外爆发**的闸（比如某条新代码路径在循环里连打 300 次），
 *	   不是给正常用量设上限 —— 所以容量必须 ≥ 用户能配出来的并发。
 *
 * ⚠ 为什么取「各并发里的最大值」而不是 `balanceConcurrency` 一个：
 *   路由批量走 `routeConcurrency`、任务走 `tasksConcurrency`。只看余额那个键，
 *   用户把路由并发调到 16 时就会被闸悄悄截断 —— 那正是「偷偷加了个上限」。
 *
 * @param {any} ctx
 * @returns {ReturnType<typeof makeRateGate>}
 */
function rateGateFor(ctx) {
  const settings = readPanelSettings(ctx.configDir).data
  const capacity = Math.max(
    RATE_GATE_CAPACITY,
    concurrencyFor("route", settings),
    concurrencyFor("balance", settings),
    concurrencyFor("usage", settings),
    concurrencyFor("tasks", settings),
    concurrencyFor("invite", settings),
  )
  if (!ctx.rateGate || ctx.rateGateCapacity !== capacity) {
    ctx.rateGate = makeRateGate({ capacity, refillMs: RATE_GATE_REFILL_MS })
    ctx.rateGateCapacity = capacity
  }
  return ctx.rateGate
}

/**
 * 过闸：拿不到令牌就排队等。
 *
 * ⚠ 必须在**真正发请求之前**调用，且**不要**把它当成并发上限来用 —— 并发由
 *   设置里的各类 concurrency 决定，闸只负责把「意外的爆发」摊平。
 *
 * @param {any} ctx
 * @returns {Promise<void>}
 */
function passRateGate(ctx) {
  return rateGateFor(ctx).acquire()
}

/**
 * 进程级并发槽：所有刷新任务共享 `ctx.slotLimit`。
 *
 * 三个全量任务同时启动时，总并发不会超过设置值（而不是 3 × 设置值）。
 *
 * ⚠ T-54：**过槽之前先过闸**。这里是所有刷新类上游调用的唯一咽喉
 *   （余额 / 额度 / 任务 / 邀请码 / 邀请码池补拉 / 分配），把闸放在这里
 *   就不会漏掉任何一条未来的新路径。
 */
async function withSlot(ctx, fn) {
  await passRateGate(ctx)
  const limit = Math.max(1, Number(ctx.slotLimit) || ROUTE_BATCH_CONCURRENCY)
  if (ctx.slotActive < limit) {
    ctx.slotActive += 1
  } else {
    await new Promise((resolve) => { ctx.slotWaiters.push(resolve) })
    ctx.slotActive += 1
  }
  try {
    return await fn()
  } finally {
    ctx.slotActive -= 1
    const next = ctx.slotWaiters.shift()
    if (next) next()
  }
}

/** 共享的启动节流（相邻两次真实调用间隔 = 设置里的 `gapMs`，默认 300ms）。 */
function refreshGate(ctx) {
  // ⚠ gapMs 可在设置里改（0 = 不等待）。按**最新设置**建闸并缓存，
  //   用户改完设置后下一次真实调用立即生效（不需要重启面板）。
  const gap = gapFor(readPanelSettings(ctx.configDir).data)
  if (!ctx.refreshGateFn || ctx.refreshGateGap !== gap) {
    ctx.refreshGateFn = makeThrottle(gap)
    ctx.refreshGateGap = gap
  }
  return ctx.refreshGateFn()
}

/**
 * 全局启动闸：保证「相邻两次真实调用开始」至少间隔 `gapMs`。
 *
 * 用闸而不是「每个 worker 自己 sleep」：多 worker 同时 sleep 之后再齐发，
 * 等于把节流抵消掉。
 *
 * @param {number} gapMs
 * @returns {() => Promise<void>}
 */
function makeThrottle(gapMs) {
  let next = 0
  return async () => {
    const now = Date.now()
    const at = Math.max(now, next)
    next = at + gapMs
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now))
  }
}

/**
 * 启动一个刷新任务（余额 / 任务 / 邀请码通用）。
 *
 * @param {any} ctx
 * @param {"balance"|"tasks"|"invite"} kind
 * @param {string[]} uids 已校验、已去重
 * @param {number} concurrency
 * @param {(uid: string) => Promise<object>} work
 */
function startRefreshJob(ctx, kind, uids, concurrency, work) {
  const jobId = randomUUID()
  const job = { jobId, kind, total: uids.length, running: true, stopped: "", results: /** @type {Record<string, object>} */ ({}) }
  ctx.refreshJobs.set(jobId, job)
  ctx.slotLimit = Math.max(Number(ctx.slotLimit) || 0, Math.max(1, concurrency))
  void runRefreshJob(ctx, job, uids, Math.min(concurrency, uids.length), work)
  return job
}

async function runRefreshJob(ctx, job, uids, workers, work) {
  let cursor = 0
  let consecutiveRateLimit = 0
  const worker = async () => {
    for (;;) {
      if (job.stopped) return
      const index = cursor++
      if (index >= uids.length) return
      const uid = uids[index]
      await refreshGate(ctx)
      if (job.stopped) return
      const result = await withSlot(ctx, () => work(uid))
      job.results[uid] = result
      if (isRateLimitFailure(result)) {
        consecutiveRateLimit += 1
        if (consecutiveRateLimit >= BATCH_BREAKER) job.stopped = "upstream-rate-limited"
      } else {
        consecutiveRateLimit = 0
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, workers) }, worker))
  } catch (e) {
    ctx.log.warn?.(`loomy panel: ${job.kind} 刷新任务异常收尾: ${String(e?.message ?? e).slice(0, 200)}`)
  } finally {
    job.running = false
    const timer = setTimeout(() => { ctx.refreshJobs.delete(job.jobId) }, ROUTE_JOB_TTL_MS)
    timer.unref?.()
  }
}

/** 读任务进度（按 kind 校验，防止拿余额 jobId 去查邀请码进度）。 */
function readRefreshJob(res, ctx, params, kind) {
  const jobId = String(params.get("jobId") ?? "").trim()
  const job = jobId ? ctx.refreshJobs.get(jobId) : null
  if (!job || job.kind !== kind) return sendJson(res, 404, { ok: false, error: "没有这个刷新任务" })
  let okCount = 0
  let failCount = 0
  for (const entry of Object.values(job.results)) {
    if (isPlainObject(entry) && entry.error) failCount += 1
    else okCount += 1
  }
  return sendJson(res, 200, {
    ok: true,
    job: {
      jobId: job.jobId,
      kind: job.kind,
      total: job.total,
      done: okCount + failCount,
      okCount,
      failCount,
      running: job.running,
      stopped: job.stopped || "",
      results: job.results,
    },
  })
}

/** 查一个号的积分并写缓存；失败保留旧余额、只写 `error`。 */
async function refreshOneAccount(ctx, uid) {
  const prior = readAccountsCache(ctx.configDir).accounts[uid]
  /** @type {string} */
  let session = ""
  try {
    const account = readMagpieAuth(ctx.configDir).find((a) => String(a.uid) === String(uid))
    if (!account) throw new Error("找不到这个账号的 session")
    session = account.session
    const pts = await fetchPointsSnapshot({ baseUrl: ctx.baseUrl, auth: { session }, fetchImpl: ctx.fetchImpl })
    // fetchPointsSnapshot 给的是 available / daily / permanent（**没有** balance 字段）
    const entry = {
      balance: Number(pts.available) || 0,
      daily: pts.dailyKnown ? Number(pts.daily) || 0 : 0,
      permanent: pts.permanentKnown ? Number(pts.permanent) || 0 : 0,
      dailyLimit: DAILY_RESET_AMOUNT,
      at: Date.now(),
      error: "",
    }
    writeKeyedCache(ctx.configDir, ACCOUNTS_CACHE_FILE, "accounts", uid, entry)
    return { balance: entry.balance, daily: entry.daily, permanent: entry.permanent, dailyLimit: entry.dailyLimit, at: entry.at }
  } catch (e) {
    const error = sanitizeError(e, session)
    try {
      // 失败也要留痕（面板要显示「上次查询失败」），但**旧余额不删**
      writeKeyedCache(ctx.configDir, ACCOUNTS_CACHE_FILE, "accounts", uid, { ...(isPlainObject(prior) ? prior : {}), error })
    } catch {}
    return { error: error || "查询失败" }
  }
}

/**
 * 查一个号的额度并**写进两处缓存**：`loomy-usage-cache.json`（`auth.usage` 读它）
 * 与 `loomy-accounts-cache.json`（面板「积分」列读它）。
 *
 * # 为什么两处都写
 *
 * 这是一次真实上游读数的**唯一时刻**。分成两条独立链路（各写一份）只会让
 * 「面板显示 100、卡片显示 120」这种自相矛盾出现。同一次读数写两处，
 * 两边永远一致 —— 而且都**不再二次请求**。
 *
 * ⚠ 失败时**保留旧额度**，只写 `error`：一次网络抖动不该把用户已有的读数抹掉。
 *
 * @param {any} ctx
 * @param {string} uid
 * @returns {Promise<{at: number, windows: number, plan: string}|{error: string}>}
 */
async function refreshUsageOne(ctx, uid) {
  const prior = readUsageCacheTable(ctx.configDir).accounts[uid]
  /** @type {string} */
  let session = ""
  try {
    const account = readMagpieAuth(ctx.configDir).find((a) => String(a.uid) === String(uid))
    if (!account) throw new Error("找不到这个账号的 session")
    session = account.session

    // ⚠ 这是**整个插件里唯一**因为额度而打上游的地方（用户点了按钮才走到这里）
    const pts = await fetchPointsSnapshot({ baseUrl: ctx.baseUrl, auth: { session }, fetchImpl: ctx.fetchImpl })
    const { windows } = usageFromPoints(pts)
    const entry = usageCacheEntry({
      windows,
      permanent: pts.permanentKnown ? Number(pts.permanent) || 0 : 0,
      plan: String(/** @type {any} */ (pts)?.plan ?? ""),
      limited: false,
      at: Date.now(),
    })

    // ① `auth.usage` 的数据源
    writeKeyedCache(ctx.configDir, USAGE_CACHE_FILE, "accounts", uid, entry)
    // ② 面板「积分」列的数据源（同一次读数，不重复请求）
    writeKeyedCache(ctx.configDir, ACCOUNTS_CACHE_FILE, "accounts", uid, {
      balance: Number(pts.available) || 0,
      daily: pts.dailyKnown ? Number(pts.daily) || 0 : 0,
      permanent: pts.permanentKnown ? Number(pts.permanent) || 0 : 0,
      dailyLimit: DAILY_RESET_AMOUNT,
      at: entry.at,
      error: "",
    })

    return { at: entry.at, windows: windows.length, plan: entry.plan }
  } catch (e) {
    const error = sanitizeError(e, session)
    // 失败也要留痕（面板要显示「上次查询失败」），但**旧额度不删**
    try {
      const accountsPrior = readAccountsCache(ctx.configDir).accounts[uid]
      writeKeyedCache(ctx.configDir, ACCOUNTS_CACHE_FILE, "accounts", uid, { ...(isPlainObject(accountsPrior) ? accountsPrior : {}), error })
    } catch {}
    // 额度缓存只在「本来就没读过」时写一条占位（有旧读数就原样留着）
    if (!isPlainObject(prior)) {
      try {
        writeKeyedCache(ctx.configDir, USAGE_CACHE_FILE, "accounts", uid, usageCacheEntry({ windows: [], at: Date.now() }))
      } catch {}
    }
    return { error }
  }
}

/**
 * `POST /api/usage/refresh {uids?, concurrency?}` → 立刻回 jobId。
 *
 * # 这是额度**唯一的写入入口**
 *
 * `auth.usage` 现在只读缓存、零上游（见 `src/hooks/usage.mjs`）。所以用户想看到
 * 最新额度，只能点面板的「刷新额度」按钮 → 走这里。
 *
 * 参数沿用 `startListRefresh` 那一套（同一份校验、同一套并发设置、同一套
 * 节流与熔断）：
 *
 *	uids         省略 = 全部账号；「只刷选中的账号」就是传面板勾选出来的 uid 列表
 *	concurrency  省略 = 设置里的 `balanceConcurrency`（默认 20，**无上限**）
 *
 * 保护（用户可调，代码里不写死上限）：
 *	· 并发 = 设置值
 *	· 相邻两次启动 ≥ `gapMs`（默认 300ms）
 *	· 连续 3 个号被判风控 → **立即停止**，剩下的号一次都不打
 */
function usageRefreshStart(req, res, ctx) {
  return startListRefresh(req, res, ctx, "usage", (uid) => refreshUsageOne(ctx, uid))
}

/** 读 `loomy-usage-cache.json`（与 `auth.usage` 读的是同一个文件、同一个形状）。 */
function readUsageCacheTable(configDir) {
  return readKeyedCache(configDir, USAGE_CACHE_FILE, "accounts")
}

/**
 * `POST /api/accounts-refresh {uid}` → **也走刷新任务**（1 个 uid 的 job）。
 *
 * 用户会狂点不同行的「查余额」。以前每次都直接发一次上游请求 —— 连点 20 行
 * 就是 20 个并发请求，一样会被限流。现在统一进队列：全局并发槽 + 相邻启动
 * 间隔 ≥300ms；行为对用户不变（点了就查那个号），只是被节流。
 */
async function accountRefreshOne(req, res, ctx) {
  /** @type {any} */
  let input
  try {
    input = JSON.parse((await readBody(req, 4096)) || "{}")
  } catch {
    return sendJson(res, 400, { ok: false, error: "参数不是合法 JSON" })
  }
  const uid = String(input?.uid ?? "").trim()
  if (!uid) return sendJson(res, 400, { ok: false, error: "缺 uid" })
  if (!ctx.configDir) return sendJson(res, 503, { ok: false, error: "未设置 configDir，无法保存余额缓存" })
  const settings = readPanelSettings(ctx.configDir).data
  const concurrency = concurrencyFor("balance", settings)
  const job = startRefreshJob(ctx, "balance", [uid], concurrency, (one) => refreshOneAccount(ctx, one))
  return sendJson(res, 200, { ok: true, uid, jobId: job.jobId, total: 1 })
}

/**
 * 通用列表刷新入口：校验 uids/concurrency → 启动 job → 立刻回 jobId。
 *
 * `uids` 省略 = 全部账号（「刷新全部」）。规则与路由批量同口径：
 * 非空数组、元素字符串、去重，**条数不限**；并发取设置（整数 ≥1，**没有上限**），
 * 保护靠 300ms 节流 + 连续 3 次限流熔断。
 */
async function startListRefresh(req, res, ctx, kind, work) {
  /** @type {any} */
  let input
  try {
    input = JSON.parse((await readBody(req, 1 << 20)) || "{}")
  } catch {
    return sendJson(res, 400, { ok: false, error: "参数不是合法 JSON" })
  }
  if (!isPlainObject(input)) return sendJson(res, 400, { ok: false, error: "参数必须是 JSON 对象" })
  if (!ctx.configDir) return sendJson(res, 503, { ok: false, error: "未设置 configDir，无法读取账号" })

  const all = selectedAccounts(ctx, new URLSearchParams()).map((a) => a.uid)
  /** @type {string[]} */
  let uids
  if (input.uids === undefined || input.uids === null) {
    uids = all
  } else {
    if (!Array.isArray(input.uids)) return sendJson(res, 400, { ok: false, error: "uids 必须是非空数组" })

    /** @type {string[]} */
    const list = []
    const seen = new Set()
    for (const raw of input.uids) {
      if (typeof raw !== "string") return sendJson(res, 400, { ok: false, error: "uids 的每个元素都必须是字符串" })
      const uid = raw.trim()
      if (!uid || seen.has(uid)) continue
      seen.add(uid)
      list.push(uid)
    }
    uids = list
  }
  if (!uids.length) return sendJson(res, 400, { ok: false, error: "没有需要刷新的账号" })

  const settings = readPanelSettings(ctx.configDir).data
  // 每个 job 种类读**自己那条**设置（balance / tasks / invite 互不复用、不写死 2）
  let concurrency = concurrencyFor(kind, settings)
  if (input.concurrency !== undefined && input.concurrency !== null) {
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
      return sendJson(res, 400, { ok: false, error: "concurrency 必须是 ≥1 的整数" })
    }
    // ⚠ 不截断（用户要求无上限）；节流与熔断仍在，见 runRefreshJob
    concurrency = input.concurrency
  }
  concurrency = Math.max(1, concurrency)

  const job = startRefreshJob(ctx, kind, uids, concurrency, work)
  return sendJson(res, 200, { ok: true, jobId: job.jobId, total: job.total })
}

/** `POST /api/accounts-refresh-batch`：余额全量/选中刷新。 */
function accountsRefreshStart(req, res, ctx) {
  return startListRefresh(req, res, ctx, "balance", (uid) => refreshOneAccount(ctx, uid))
}

/** `POST /api/tasks-refresh-batch`：新手任务刷新。 */
function tasksRefreshStart(req, res, ctx) {
  return startListRefresh(req, res, ctx, "tasks", async (uid) => {
    const account = readMagpieAuth(ctx.configDir).find((a) => String(a.uid) === String(uid))
    if (!account) return { error: "找不到这个账号的 session" }
    try {
      const map = await fetchTasks({ baseUrl: ctx.baseUrl, auth: { session: account.session }, fetchImpl: ctx.fetchImpl })
      const entry = { tasks: map, at: Date.now(), error: "" }
      writeKeyedCache(ctx.configDir, TASKS_CACHE_FILE, "tasks", uid, entry)
      return { tasks: map, at: entry.at }
    } catch (e) {
      const error = sanitizeError(e, account.session)
      try {
        const prior = readTasksCache(ctx.configDir).tasks[uid] ?? {}
        writeKeyedCache(ctx.configDir, TASKS_CACHE_FILE, "tasks", uid, { ...prior, error })
      } catch {}
      return { error }
    }
  })
}

/** `POST /api/invite-refresh-batch`：邀请码 + 激活状态刷新。 */
function inviteRefreshStart(req, res, ctx) {
  return startListRefresh(req, res, ctx, "invite", async (uid) => {
    const account = readMagpieAuth(ctx.configDir).find((a) => String(a.uid) === String(uid))
    if (!account) return { error: "找不到这个账号的 session" }
    const base = { baseUrl: ctx.baseUrl, auth: { session: account.session }, fetchImpl: ctx.fetchImpl }
    try {
      const codes = await fetchInvitationCodes(base)
      let activation = null
      try { activation = await fetchActivation(base) } catch {}
      const entry = { codes, activation, at: Date.now(), error: "" }
      writeKeyedCache(ctx.configDir, INVITE_CACHE_FILE, "codes", uid, entry)
      return { codes, activation, at: entry.at }
    } catch (e) {
      const error = sanitizeError(e, account.session)
      try {
        const prior = readInviteCache(ctx.configDir).codes[uid] ?? {}
        writeKeyedCache(ctx.configDir, INVITE_CACHE_FILE, "codes", uid, { ...prior, error })
      } catch {}
      return { error }
    }
  })
}

function accountsRefreshState(res, ctx, params) {
  return readRefreshJob(res, ctx, params, "balance")
}

function tasksRefreshState(res, ctx, params) {
  return readRefreshJob(res, ctx, params, "tasks")
}

function inviteRefreshState(res, ctx, params) {
  return readRefreshJob(res, ctx, params, "invite")
}

// ── 邀请码分配（健康码的码池 → 未绑账号）──────────────────────────────
//
// # 要解决的事
//
// 一个号只能绑一次邀请码（永久不可改），绑谁的码就决定了**谁拿那 5K**。
// 让废号的码被绑，等于把奖励发给一个已经不能用的号。所以这里只允许
// 「健康（verdict === "clean"）账号的码」进池，让未绑的号去绑它们。
//
// # 三条铁律
//
//   ① 打开面板**零上游**：`GET /api/invite/pool` 只读 `loomy-invite-pool.json`；
//   ② 扫描 / 分配都是**用户点按钮**才发的 job（并发 = inviteConcurrency，间隔 = gapMs）；
//   ③ 已绑过的号**不重复扫**：`loomy-activation-cache.json` 里 `activated: true`
//      永久复用（一个号绑一次就不会变），`activated: false` 只复用 10 分钟。
//
// 缓存文件：
//   `loomy-invite-pool.json`     {at, codes:[{code,ownerKey,ownerUid,ownerName,maxUses,usedCount,left,unlimited,status}], unbound:[{key,uid,name,verdict}], source, cacheAt, missing, warnings}
//   `loomy-activation-cache.json` {updatedAt, entries:{uid:{activated,code,at}}}
//
// # T-52：扫描 = **纯本地汇总**，零上游
//
// 「邀请」页刷新时会把 `{codes, activation, at, error}` 整条写进
// `loomy-invite-cache.json`，也就是说**码池和绑定状态本来就已经在本地了**。
// 所以「汇总」这一步不得调 `fetchInvitationCodes` / `fetchActivation`：
//   · 码池：`cache.codes[uid].codes` → `left = maxUses - usedCount`（`exhausted` 不计）；
//   · 未绑：`cache.codes[uid].activation.activated === false`（分配写的那条更晚就用它）。
// 缺数据的号默认**跳过 + 记 warnings**（不静默补拉）；要补拉必须显式 `refreshMissing`。

const INVITE_POOL_FILE = "loomy-invite-pool.json"
const ACTIVATION_CACHE_FILE = "loomy-activation-cache.json"

function readActivationCache(configDir) {
  // ⚠ 键名是 `entries`（与写出端、用例、面板三方对齐）：uid → {activated, code, at}
  return readKeyedCache(configDir, ACTIVATION_CACHE_FILE, "entries")
}

/**
 * 本地能确定的绑定状态（`null` = 本地没有，得补拉）。
 *
 * 两个本地来源，**谁更晚用谁**：
 *   ① `loomy-invite-cache.json` 的 `activation`（「邀请」页刷新写的）；
 *   ② `loomy-activation-cache.json`（分配成功那一刻写的，比 ① 新）。
 *
 * ⚠ 不给 `activated: false` 加 TTL：本地记录就是权威——绑过的号只有
 *   `runAssign` 能把它改回 `true`，而它同时会把这里更新掉。按过期当"不知道"
 *   会让大半账号凭空变成"缺数据"，反而逼着去发上游请求。
 */
function localActivation(inviteEntry, activationEntry) {
  const fromInvite = isPlainObject(inviteEntry?.activation) && typeof inviteEntry.activation.activated === "boolean"
    ? { activated: inviteEntry.activation.activated, code: String(inviteEntry.activation.applied ?? inviteEntry.activation.code ?? ""), at: Number(inviteEntry.at) || 0 }
    : null
  const fromBind = isPlainObject(activationEntry) && typeof activationEntry.activated === "boolean"
    ? { activated: activationEntry.activated, code: String(activationEntry.code ?? ""), at: Number(activationEntry.at) || 0 }
    : null
  if (fromInvite && fromBind) return fromInvite.at >= fromBind.at ? fromInvite : fromBind
  return fromInvite ?? fromBind
}

/** 读邀请码池（缺文件 / 损坏 / 形状不对 → 空池，绝不抛）。 */
export function readInvitePool(configDir) {
  const empty = { at: 0, codes: [], unbound: [], source: "cache", cacheAt: 0, missing: 0, warnings: [] }
  if (!configDir) return empty
  const path = join(configDir, INVITE_POOL_FILE)
  if (!existsSync(path)) return empty
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return empty
  }
  if (!isPlainObject(parsed)) return empty
  const codes = (Array.isArray(parsed.codes) ? parsed.codes : []).filter(isPlainObject).map((c) => {
    const unlimited = c.unlimited === true
    return {
      code: String(c.code ?? "").trim(),
      ownerKey: String(c.ownerKey ?? ""),
      ownerUid: String(c.ownerUid ?? ""),
      ownerName: String(c.ownerName ?? ""),
      maxUses: Number(c.maxUses) || 0,
      usedCount: Number(c.usedCount) || 0,
      status: String(c.status ?? ""),
      unlimited,
      // ⚠ 不限次的码也用**有限数**表达余量（至少 1）：`left: null` 会让所有
      //    `left > 0 / left - 1` 的算术把它当成 0，「不限次」的码反而永远配不出去。
      left: unlimited ? Math.max(1, Number(c.left) || 1) : Math.max(0, Number(c.left) || 0),
    }
  }).filter((c) => c.code)
  const unbound = (Array.isArray(parsed.unbound) ? parsed.unbound : []).filter(isPlainObject).map((u) => ({
    // `key` = 账号的**显示身份**（昵称/手机号，面板第一列）；`uid` 才是机器标识。
    // 两者别混：混了以后表格左边出现 `loomy#3`，用户完全认不出是哪个号。
    key: String(u.key ?? u.name ?? u.uid ?? ""),
    uid: String(u.uid ?? ""),
    name: String(u.name ?? u.key ?? ""),
    authKey: String(u.authKey ?? ""),
    verdict: String(u.verdict ?? "unknown"),
  })).filter((u) => u.uid)
  // 来源标记：让面板能写「码池读自缓存（多久前）、缺几个号」。
  const source = parsed.source === "cache+live" ? "cache+live" : "cache"
  const warnings = (Array.isArray(parsed.warnings) ? parsed.warnings : []).filter((w) => typeof w === "string")
  return {
    at: Number(parsed.at) || 0,
    codes,
    unbound,
    source,
    cacheAt: Number(parsed.cacheAt) || 0,
    missing: Math.max(0, Number(parsed.missing) || 0),
    warnings,
  }
}

function writeInvitePool(configDir, data) {
  if (!configDir) throw new Error("未设置 configDir，无法保存邀请码池")
  const path = join(configDir, INVITE_POOL_FILE)
  const temp = path + "." + randomUUID() + ".tmp"
  try {
    mkdirSync(String(configDir), { recursive: true })
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return data
}

/**
 * 码池汇总（统计卡片用）。
 *
 * `left: null` = 不限次数（`maxUses: 0`），不能当成 0；`capacity` 把不限次
 * 的码折算成“够不够配下所有未绑号”，避免在 JSON 里出现 Infinity。
 */
export function invitePoolTotals(pool) {
  const codes = Array.isArray(pool?.codes) ? pool.codes : []
  const unboundCount = Array.isArray(pool?.unbound) ? pool.unbound.length : 0
  let poolLeft = 0
  for (const c of codes) poolLeft += Math.max(0, Number(c?.left) || 0)
  // ⚠ 形状就这两个键：面板第三张卡（可配对）由页自己算 min(码池,未绑)，
  //    多返回字段等于把契约多开一道口子（用例是 deepEqual）。
  return { poolLeft, unboundCount }
}

/** 一个账号自己生成的码 → 进池的条目（已耗尽 / 已用完的不进）。 */
function poolCodesOf(owner, list) {
  const out = []
  for (const item of list ?? []) {
    const code = String(item?.code ?? "").trim()
    if (!code) continue
    const status = String(item?.status ?? "")
    if (status === "exhausted") continue
    const maxUses = Number(item?.maxUses) || 0
    const usedCount = Number(item?.usedCount) || 0
    const base = { code, ownerKey: owner.key, ownerUid: owner.uid, ownerName: owner.name, maxUses, usedCount, status }
    if (maxUses === 0) {
      // 0 = 不限次数。`left` 表达成「至少还能绑 1 次」的有限数：
      // 面板/配对都要用 `left` 做比较，给 null 或 Infinity 迟早会把它算成 0
      // 或被 JSON.stringify 变成 null，于是「不限次的大码」被当成用完的码。
      // `unlimited: true` 才是「真的不限」的权威标记。
      out.push({ ...base, unlimited: true, left: Math.max(1, Number(item?.capacity) || 1) })
      continue
    }
    const left = Math.max(0, maxUses - usedCount)
    if (left === 0) continue
    out.push({ ...base, unlimited: false, left })
  }
  return out
}

/** uid → plugin-auth 里的键（`loomy` / `loomy#3`），只用于展示与回写。 */
function authKeyByUid(configDir) {
  const map = new Map()
  if (!configDir) return map
  const file = join(configDir, "plugin-auth.json")
  if (!existsSync(file)) return map
  /** @type {any} */
  let all
  try {
    all = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return map
  }
  for (const [key, value] of Object.entries(all ?? {})) {
    if (key !== PROVIDER && !key.startsWith(PROVIDER + "#")) continue
    const meta = /** @type {any} */ (value)?.metadata ?? {}
    const uid = String(meta.uid ?? /** @type {any} */ (value)?.uid ?? "").trim()
    if (uid) map.set(uid, key)
  }
  return map
}

/** 读已落盘的路由结论（读不出来就当全未检测，不影响扫描）。 */
async function routeVerdicts(ctx) {
  try {
    const mods = await ensureRouteModules(ctx)
    if (!mods || typeof mods.readRouteState !== "function") return {}
    const read = mods.readRouteState(ctx.configDir)
    return read?.ok && isPlainObject(read.data) ? read.data : {}
  } catch {
    return {}
  }
}

function startInviteJob(ctx, kind, items) {
  const jobId = randomUUID()
  const job = {
    jobId, kind, total: items.length, done: 0, okCount: 0, failCount: 0, skipCount: 0,
    running: true, stopped: "", results: /** @type {Record<string, object>} */ ({}),
    codes: [], unbound: [],
    // 数据来源标记（T-52）：「汇总」只读 `loomy-invite-cache.json`，
    // `source` 默认 `cache`；只有显式 `refreshMissing` 补拉过才变 `cache+live`。
    source: "", cacheAt: 0, missing: 0, warnings: /** @type {string[]} */ ([]),
  }
  ctx.inviteJobs.set(jobId, job)
  return job
}

function finishInviteJob(ctx, job) {
  job.running = false
  const timer = setTimeout(() => { ctx.inviteJobs.delete(job.jobId) }, ROUTE_JOB_TTL_MS)
  timer.unref?.()
}

/** `GET /api/invite/pool` → 只读缓存，零上游。 */
function invitePoolState(res, ctx) {
  const pool = ctx.configDir ? readInvitePool(ctx.configDir) : readInvitePool("")
  return sendJson(res, 200, {
    ok: true,
    at: pool.at,
    codes: pool.codes,
    unbound: pool.unbound,
    totals: invitePoolTotals(pool),
    source: pool.source,
    cacheAt: pool.cacheAt,
    missing: pool.missing,
    warnings: pool.warnings,
  })
}

/**
 * `POST /api/invite/pool/scan`：把「码池 + 绑定状态」汇总成池，job 化。
 *
 * **零上游**：数据全部来自 `loomy-invite-cache.json`（「邀请」页刷新时写的
 * `{codes, activation, at, error}`），这里只做汇总算术。
 *
 * body:
 *   · `includeExpired: true` → 连 `expired` 的号也一起看（默认跳过：号已死）；
 *   · `refreshMissing: true` → 本地缺数据的号才补拉（走并发槽 + 节流），
 *     默认**不补**：缺就跳过并记 `warnings`，绝不静默打上游。
 */
async function invitePoolScanStart(req, res, ctx) {
  /** @type {any} */
  let input
  try {
    input = JSON.parse((await readBody(req, 1 << 16)) || "{}")
  } catch {
    return sendJson(res, 400, { ok: false, error: "参数不是合法 JSON" })
  }
  if (!isPlainObject(input)) return sendJson(res, 400, { ok: false, error: "参数必须是 JSON 对象" })
  if (!ctx.configDir) return sendJson(res, 503, { ok: false, error: "未设置 configDir，无法保存邀请码池" })

  const accounts = [...new Map(readMagpieAuth(ctx.configDir).map((a) => [a.uid, a])).values()]
  const wanted = Array.isArray(input.uids) ? new Set(input.uids.map((u) => String(u).trim()).filter(Boolean)) : null
  const list = wanted ? accounts.filter((a) => wanted.has(a.uid)) : accounts
  if (!list.length) return sendJson(res, 200, { ok: true, jobId: "", total: 0, message: "没有需要汇总的账号" })

  const settings = readPanelSettings(ctx.configDir).data
  const concurrency = Math.max(1, Math.min(concurrencyFor("invite", settings), list.length))
  const job = startInviteJob(ctx, "scan", list)
  void runPoolScan(ctx, job, list, {
    includeExpired: input.includeExpired === true,
    refreshMissing: input.refreshMissing === true,
    concurrency,
  })
  return sendJson(res, 200, { ok: true, jobId: job.jobId, total: job.total })
}

/**
 * 汇总一次码池：**纯本地计算，零上游**（只有 `refreshMissing` 才补拉）。
 *
 * 数据来源只有一个：`loomy-invite-cache.json`（「邀请」页刷新写的
 * `{codes, activation, at, error}`）；绑定成功那一刻的记录在
 * `loomy-activation-cache.json`，两者谁更晚用谁（见 `localActivation`）。
 *
 * @param {any} ctx
 * @param {any} job
 * @param {any[]} list
 * @param {{ includeExpired?: boolean, refreshMissing?: boolean, concurrency?: number }} [options]
 */
async function runPoolScan(ctx, job, list, options = {}) {
  const includeExpired = options.includeExpired === true
  const refreshMissing = options.refreshMissing === true
  const concurrency = Math.max(1, Number(options.concurrency) || 1)
  const verdicts = await routeVerdicts(ctx)
  const inviteCache = readInviteCache(ctx.configDir)
  const activations = readActivationCache(ctx.configDir).entries
  const keys = authKeyByUid(ctx.configDir)
  let cursor = 0
  let consecutiveRateLimit = 0
  let missing = 0
  let liveFetches = 0
  const worker = async () => {
    for (;;) {
      if (job.stopped) return
      const index = cursor++
      if (index >= list.length) return
      const account = list[index]
      const entry = isPlainObject(verdicts[account.uid]) ? verdicts[account.uid] : {}
      const verdict = String(entry.verdict ?? "unknown")
      // 健康 = clean + 实际落地不是降级模型（routed 的另一种表现，双保险）
      const healthy = verdict === "clean" && String(entry.servedModel ?? "") !== "spark-x2.6-low"
      const owner = { key: account.nickname || account.phone || shortUID(account.uid), uid: account.uid, name: account.nickname || shortUID(account.uid), authKey: keys.get(account.uid) ?? "" }
      const inviteEntry = isPlainObject(inviteCache.codes[account.uid]) ? inviteCache.codes[account.uid] : {}
      let error = ""
      // ① 码池：本地缓存 → 纯算术（`left = maxUses - usedCount`，`exhausted` 不计）。
      //    只有「健康号 + 本地没有 codes + 显式 refreshMissing」才补拉一次。
      let codeList = []
      let codesMissing = false
      if (healthy) {
        const cachedCodes = Array.isArray(inviteEntry.codes) ? inviteEntry.codes : null
        if (cachedCodes) {
          codeList = poolCodesOf(owner, cachedCodes)
        } else if (refreshMissing) {
          await refreshGate(ctx)
          if (job.stopped) return
          try {
            const live = await withSlot(ctx, () => fetchInvitationCodes({ baseUrl: ctx.baseUrl, auth: { session: account.session }, fetchImpl: ctx.fetchImpl }))
            liveFetches += 1
            codeList = poolCodesOf(owner, live)
            try {
              writeKeyedCache(ctx.configDir, INVITE_CACHE_FILE, "codes", account.uid, { ...inviteEntry, codes: live, at: Date.now(), error: "" })
            } catch {}
          } catch (e) {
            error = sanitizeError(e, account.session)
            codesMissing = true
          }
        } else {
          codesMissing = true
        }
      }
      // ② 绑定状态：同样只读本地（两个缓存谁更晚用谁）。
      const skipExpired = verdict === "expired" && !includeExpired
      let activation = localActivation(inviteEntry, activations[account.uid])
      let activationMissing = false
      if (!activation) {
        if (skipExpired) {
          // 号已死：不查、不补、也不记警告（别浪费请求，这是老行为）
        } else if (refreshMissing) {
          await refreshGate(ctx)
          if (job.stopped) return
          try {
            const got = await withSlot(ctx, () => fetchActivation({ baseUrl: ctx.baseUrl, auth: { session: account.session }, fetchImpl: ctx.fetchImpl }))
            liveFetches += 1
            activation = { activated: got.activated === true, code: String(got.applied ?? "") }
            try {
              writeKeyedCache(ctx.configDir, ACTIVATION_CACHE_FILE, "entries", account.uid, { activated: activation.activated, code: activation.code, at: Date.now() })
            } catch {}
            try {
              writeKeyedCache(ctx.configDir, INVITE_CACHE_FILE, "codes", account.uid, { ...inviteEntry, activation: { activated: activation.activated, applied: activation.code }, at: Date.now(), error: "" })
            } catch {}
          } catch (e) {
            error = error || sanitizeError(e, account.session)
            activationMissing = true
          }
        } else {
          activationMissing = true
        }
      }
      // ③ 缺数据：跳过 + 记一句人话。**绝不静默补拉**（补拉要用户显式开关）。
      const notes = []
      if (codesMissing) notes.push(`账号 ${account.uid} 缺邀请码缓存，请先在「邀请」页读一次`)
      if (activationMissing) notes.push(`账号 ${account.uid} 缺绑定状态，请先在「邀请」页读一次`)
      if (notes.length) {
        missing += 1
        for (const note of notes) job.warnings.push(note)
      }
      for (const c of codeList) job.codes.push(c)
      // ⚠ 未绑号**不限健康与否**：积分归「码的持有者」，不是「谁去绑」。
      //    健康号之间互相绑定同样有效（A 绑 B 的码 ⇒ B 拿 5000），所以健康的
      //    未绑号也是可用被邀请者——把它们排除，等于白少一批可配对。
      //    唯一排除的是 `expired`（号已死，绑了也白烧一个码），`includeExpired` 才放行。
      //    `key` 就用 uid（面板与用例都按 uid 指代账号）。
      if (activation && activation.activated === false && !skipExpired) {
        job.unbound.push({ key: account.uid, uid: account.uid, name: owner.name, verdict })
      }
      job.done += 1
      if (error) job.failCount += 1
      else job.okCount += 1
      if (isRateLimitFailure({ error })) {
        consecutiveRateLimit += 1
        if (consecutiveRateLimit >= BATCH_BREAKER) job.stopped = "upstream-rate-limited"
      } else {
        consecutiveRateLimit = 0
      }
      job.results[account.uid] = {
        ok: !error, healthy, verdict,
        activation: activation ? activation.activated : null,
        codes: codeList.length, error,
        missing: notes.length > 0,
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, worker))
  } catch (e) {
    ctx.log.warn?.(`loomy panel: 邀请码池汇总异常收尾: ${String(e?.message ?? e).slice(0, 200)}`)
  } finally {
    job.source = liveFetches > 0 ? "cache+live" : "cache"
    job.cacheAt = liveFetches > 0
      ? Number(readInviteCache(ctx.configDir).updatedAt) || 0
      : Number(inviteCache.updatedAt) || 0
    job.missing = missing
    try {
      const dedup = new Map()
      for (const c of job.codes) dedup.set(`${c.ownerUid}:${c.code}`, c)
      const codes = [...dedup.values()].sort((a, b) => a.ownerUid.localeCompare(b.ownerUid) || a.code.localeCompare(b.code))
      const unbound = [...new Map(job.unbound.map((u) => [u.uid, u])).values()].sort((a, b) => a.uid.localeCompare(b.uid))
      writeInvitePool(ctx.configDir, {
        at: Date.now(), codes, unbound,
        source: job.source, cacheAt: job.cacheAt, missing: job.missing,
        warnings: job.warnings.slice(0, 100),
      })
    } catch (e) {
      ctx.log.warn?.(`loomy panel: 邀请码池写盘失败: ${String(e?.message ?? e).slice(0, 200)}`)
    }
    finishInviteJob(ctx, job)
  }
}

/**
 * 配对策略：**优先消耗 left 最大的码**（让老号的大码先用完，小码不浪费）。
 *
 * 排序规则（唯一一份，别在别处再过一遍）：
 *   ① 有限次数的码优先于不限次的码 —— 小码不先消耗掉，高峰期会被风控卡在
 *      「大码没用完、小码过期」的尴尬状态；
 *   ② 同为有限次数时，`left` 大的优先；
 *   ③ 同一个码可以连续配给多个未绑号（按 `left` 递减）。
 */
export function planInviteAssignments(pool, wantedUids) {
  const unbound = Array.isArray(pool?.unbound) ? pool.unbound : []
  const codes = (Array.isArray(pool?.codes) ? pool.codes : []).filter((c) => c?.unlimited || (Number(c?.left) || 0) > 0)
  const targets = wantedUids ? unbound.filter((u) => wantedUids.has(u.uid)) : unbound
  const sorted = [...codes].sort((a, b) => {
    if (Boolean(a.unlimited) !== Boolean(b.unlimited)) return a.unlimited ? 1 : -1
    return (Number(b.left) || 0) - (Number(a.left) || 0)
  })
  const left = new Map(sorted.map((c) => [c.code, c.unlimited ? Number.POSITIVE_INFINITY : Math.max(0, Number(c.left) || 0)]))
  const pairs = []
  for (const target of targets) {
    const pick = sorted.find((c) => (left.get(c.code) ?? 0) > 0)
    if (!pick) break
    left.set(pick.code, left.get(pick.code) - 1)
    pairs.push({ uid: target.uid, key: target.key, name: target.name, authKey: target.authKey ?? "", verdict: target.verdict, code: pick.code, ownerUid: pick.ownerUid, ownerKey: pick.ownerKey })
  }
  return pairs
}

/** 绑定成功后扣一次码余量（不限次的只加 usedCount）。 */
function consumePoolCode(configDir, code) {
  try {
    const pool = readInvitePool(configDir)
    const hit = pool.codes.find((c) => c.code === code)
    if (!hit) return
    hit.usedCount = (Number(hit.usedCount) || 0) + 1
    if (!hit.unlimited) hit.left = Math.max(0, (Number(hit.left) || 0) - 1)
    writeInvitePool(configDir, pool)
  } catch {}
}

function dropPoolCode(configDir, code) {
  try {
    const pool = readInvitePool(configDir)
    const hit = pool.codes.find((c) => c.code === code)
    if (!hit || hit.unlimited) return
    hit.left = 0
    writeInvitePool(configDir, pool)
  } catch {}
}

/**
 * `POST /api/invite/assign`：按策略配对并执行绑定。
 *
 * body: `{ uids?, dryRun?, stop?, jobId? }`
 *   · `dryRun: true` → 只回配对方案，一个上游请求都不发（默认建议先干跑）；
 *   · `stop: true`   → 停掉指定 job（`jobId`）；
 *   · 其余情况 → 启动绑定 job，立刻回 jobId。
 */
async function inviteAssignStart(req, res, ctx) {
  /** @type {any} */
  let input
  try {
    input = JSON.parse((await readBody(req, 1 << 16)) || "{}")
  } catch {
    return sendJson(res, 400, { ok: false, error: "参数不是合法 JSON" })
  }
  if (!isPlainObject(input)) return sendJson(res, 400, { ok: false, error: "参数必须是 JSON 对象" })
  if (!ctx.configDir) return sendJson(res, 503, { ok: false, error: "未设置 configDir，无法分配邀请码" })

  if (input.stop === true) {
    const job = ctx.inviteJobs.get(String(input.jobId ?? "").trim())
    if (!job || job.kind !== "assign") return sendJson(res, 404, { ok: false, error: "没有这个分配任务" })
    job.stopped = job.stopped || "stopped-by-user"
    return sendJson(res, 200, { ok: true, jobId: job.jobId, stopped: true })
  }

  const pool = readInvitePool(ctx.configDir)
  const wanted = Array.isArray(input.uids) ? new Set(input.uids.map((u) => String(u).trim()).filter(Boolean)) : null
  const pairs = planInviteAssignments(pool, wanted)
  if (input.dryRun === true) {
    return sendJson(res, 200, { ok: true, dryRun: true, total: pairs.length, pairs: pairs.slice(0, 500), totals: invitePoolTotals(pool) })
  }
  if (!pairs.length) {
    return sendJson(res, 200, { ok: true, jobId: "", total: 0, pairs: [], message: "没有可配对的账号（先扫描码池）" })
  }

  const settings = readPanelSettings(ctx.configDir).data
  const job = startInviteJob(ctx, "assign", pairs)
  void runAssign(ctx, job, pairs, Math.max(1, Math.min(concurrencyFor("invite", settings), pairs.length)))
  return sendJson(res, 200, { ok: true, jobId: job.jobId, total: job.total, plan: pairs.slice(0, 200) })
}

async function runAssign(ctx, job, pairs, concurrency) {
  const accounts = new Map(readMagpieAuth(ctx.configDir).map((a) => [a.uid, a]))
  let cursor = 0
  const worker = async () => {
    for (;;) {
      if (job.stopped) return
      const index = cursor++
      if (index >= pairs.length) return
      const pair = pairs[index]
      await refreshGate(ctx)
      if (job.stopped) return
      const account = accounts.get(pair.uid)
      if (!account) {
        job.done += 1
        job.failCount += 1
        job.results[pair.uid] = { status: "failed", kind: "other", code: pair.code, error: "找不到账号 session" }
        continue
      }
      const base = { baseUrl: ctx.baseUrl, auth: { session: account.session }, fetchImpl: ctx.fetchImpl }
      let result
      try {
        const detail = await withSlot(ctx, () => bindInviteDetailed(base, pair.code))
        if (detail.riskControl) {
          // 风控：envelope 仍是 000000，只能靠回执里的 riskControl 识别 —— 立即停整组
          result = { status: "risk-control", code: pair.code, error: "上游风控（riskControl）", stop: "risk-control" }
        } else if (detail.alreadyActivated) {
          // 已绑过：不是失败，也不能算新绑定（奖励为 0），继续下一个
          result = { status: "already-activated", code: pair.code }
        } else {
          try {
            writeKeyedCache(ctx.configDir, ACTIVATION_CACHE_FILE, "entries", pair.uid, { activated: true, code: pair.code, at: Date.now() })
          } catch {}
          consumePoolCode(ctx.configDir, pair.code)
          result = { status: "bound", code: pair.code, inviterReward: detail.inviterReward, inviteeReward: detail.inviteeReward }
        }
      } catch (e) {
        const error = sanitizeError(e, account.session)
        if (/邀请码已用完|已用完|exhausted/i.test(error)) {
          dropPoolCode(ctx.configDir, pair.code)
          result = { status: "failed", kind: "code-empty", code: pair.code, error }
        } else if (/** @type {any} */ (e)?.rateLimited === true || isRateLimitFailure({ error })) {
          // 风控/限流：立即停掉整个 job，剩下的号一次都不打
          result = { status: "risk-control", code: pair.code, error, stop: "risk-control" }
        } else if (/账号已激活|已激活/i.test(error)) {
          result = { status: "already-activated", code: pair.code }
        } else {
          result = { status: "failed", kind: "other", code: pair.code, error }
        }
      }
      job.done += 1
      if (result.status === "bound") job.okCount += 1
      else if (result.status === "already-activated") job.skipCount += 1
      else job.failCount += 1
      job.results[pair.uid] = result
      if (result.stop) job.stopped = String(result.stop)
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  } catch (e) {
    ctx.log.warn?.(`loomy panel: 邀请码分配异常收尾: ${String(e?.message ?? e).slice(0, 200)}`)
  } finally {
    try {
      const pool = readInvitePool(ctx.configDir)
      const bound = new Set(Object.entries(job.results)
        .filter(([, r]) => isPlainObject(r) && (r.status === "bound" || r.status === "already-activated"))
        .map(([uid]) => uid))
      pool.unbound = pool.unbound.filter((u) => !bound.has(u.uid))
      pool.at = Date.now()
      writeInvitePool(ctx.configDir, pool)
    } catch (e) {
      ctx.log.warn?.(`loomy panel: 邀请码池回写失败: ${String(e?.message ?? e).slice(0, 200)}`)
    }
    finishInviteJob(ctx, job)
  }
}

/** `GET /api/invite/{pool/scan|assign}?jobId=` → 进度（按 kind 校验）。 */
function readInviteJob(res, ctx, params, kind) {
  const jobId = String(params.get("jobId") ?? "").trim()
  const job = jobId ? ctx.inviteJobs.get(jobId) : null
  if (!job || job.kind !== kind) return sendJson(res, 404, { ok: false, error: "没有这个任务" })
  return sendJson(res, 200, {
    ok: true,
    job: {
      jobId: job.jobId,
      kind: job.kind,
      total: job.total,
      done: job.done,
      okCount: job.okCount,
      skipCount: job.skipCount ?? 0,
      failCount: job.failCount,
      running: job.running,
      stopped: job.stopped || "",
      results: job.results,
      // 汇总的来源标记（面板据此写「码池读自缓存 / 缺几个号」；分配任务为空）
      source: job.source ?? "",
      cacheAt: job.cacheAt ?? 0,
      missing: job.missing ?? 0,
      warnings: job.warnings ?? [],
    },
  })
}

/** 错误一句话、去掉 session。 */
function sanitizeError(error, session) {
  const text = String(error?.message ?? error ?? "").trim() || "未知错误"
  const masked = session ? text.replaceAll(String(session), "[redacted]") : text
  return masked.slice(0, 200)
}

/** 限流类失败判据（上游文案不统一，宁可早一点熔断）。 */
function isRateLimitFailure(result) {
  const text = String(result?.error ?? "")
  return /429|rate.?limit|too many|throttl|限流|发送失败/i.test(text)
}

// ── 杂项 ────────────────────────────────────────────────────────────────

/**
 * 按 uid 取账号 session。
 *
 * # ⚠ 这里**绝不**能「找不到就换第一个号」（真机 bug）
 *
 * 旧实现是 `if (!uid) return accounts[0]?.session`。后果是：面板传了一个空 uid
 * （或按手机号/accountId 显示的那个值传上来），实际打的是账号池里**第一个号** ——
 * 用户看到的是「点了 A 号，扣的却是别人的积分、并把别人的号打出限流」。
 *
 * 现在的规则：
 *   · uid 空 → 抛错（拒绝推断，理由要能看见）；
 *   · uid 匹配 `uid` **或** `accountId`（面板里可能显示的是手机号/名称）；
 *   · 找不到 → 抛错。
 *
 * @param {any} ctx
 * @param {string} uid
 * @returns {Promise<string>}
 */
async function resolveSession(ctx, uid) {
  const want = String(uid ?? "").trim()
  if (!want) throw new Error("缺少 uid，拒绝推断是哪个账号")
  const accounts = readMagpieAuth(ctx.configDir)
  const hit = accounts.find((a) => String(a.uid) === want || String(a.accountId) === want)
  if (!hit) throw new Error(`找不到账号 ${want} 的 session`)
  return hit.session
}

async function verifySession(ctx, session) {
  const headers = new Headers({ Accept: "application/json", token: session })
  const url = String(ctx.baseUrl).replace(/\/+$/, "") + "/models"
  const resp = await ctx.fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  if (text.includes("缺少 token") || text.includes("登录已失效")) throw new Error("登录已失效")
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("模型目录不是合法 JSON")
  }
  const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : []
  if (list.length === 0) throw new Error("模型目录为空")
}

function panelError(error) {
  return error instanceof PointsError ? error.message : "面板操作失败，请检查本地配置或稍后重试"
}

/** 只认「普通对象」（排除 null / 数组）。 */
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function safeReceipt(value, session) {
  if (typeof value === "string") return value.replaceAll(session, "[redacted]")
  if (Array.isArray(value)) return value.map((item) => safeReceipt(item, session))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/session|token|authorization|secret|access|credential/i.test(key))
    .map(([key, item]) => [key.replaceAll(session, "[redacted]"), safeReceipt(item, session)]))
}

function selectedAccounts(ctx, params) {
  const accounts = [...new Map(readMagpieAuth(ctx.configDir).map((a) => [a.uid, a])).values()]
  if (!params.has("uids")) return accounts
  const uids = new Set(params.get("uids").split(",").map((s) => s.trim()).filter(Boolean))
  return accounts.filter((a) => uids.has(a.uid))
}

function validConcurrency(value) {
  // ⚠ 没有上限：只要求「整数且 ≥1」。保护靠节流与熔断，不靠这里截断
  return Number.isInteger(value) && value >= 1
}

// ── 面板设置（第二份文件，别塞进 loomy-panel-state.json） ────────────────
//
// loomy-panel-state.json 是**账号任务状态**（firstLogin 等），面板的开关是
// 另一类东西、生命周期也不同（用户随时改、损坏了要能回默认值）。所以单独
// 一份 `<configDir>/loomy-panel-settings.json`。
//
// ⚠ 缺文件 / 字段缺失 / 文件损坏 → 一律用默认值，**绝不抛**。

export const PANEL_SETTINGS_DEFAULTS = Object.freeze({
  // 每一类并发都独立可调（用户要求：凡是涉及并发的地方都要能在设置里改）
  // ⚠ `batchConcurrency` 是 `routeConcurrency` 的历史别名：**两个键都给**，
  //   值恒等 —— 老调用读 batchConcurrency，新代码读 routeConcurrency。
  routeConcurrency: 2,
  batchConcurrency: 2,
  balanceConcurrency: 2,
  tasksConcurrency: 2,
  inviteConcurrency: 2,
  // 每次真实调用之间的启动间隔（毫秒，0 = 不等待；不是并发，是保护）
  gapMs: 300,
  // 判定自动生效：检测完成后自动重拉 magpie 模型列表
  autoApply: true,
  // magpie 可执行文件路径；空 = 自动探测
  magpiePath: "",
  batchSkipChecked: true,
  ledgerReads: 3,
  // 切回窗口时是否重读本地缓存。**默认关**：用户原话「禁止自动刷新，因为发请求都有风险」——
  // 即使那 5 个 GET 只读本地缓存、绝不触发上游，开关也必须由用户自己决定。
  focusRefresh: false,
})

const SETTINGS_FILE = "loomy-panel-settings.json"

/** 每个 job 种类 → 它自己那条并发设置键。 */
const CONCURRENCY_KEYS = Object.freeze({
  route: "routeConcurrency",
  balance: "balanceConcurrency",
  // 额度刷新与余额刷新是**同一种**上游调用（GET /points/records），
  // 所以共用 `balanceConcurrency`（面板上就是「余额刷新并发」那个输入框）。
  // ⚠ 不新增设置项：用户已经能在那里调，多一个键只会让人不知道该改哪个。
  usage: "balanceConcurrency",
  tasks: "tasksConcurrency",
  invite: "inviteConcurrency",
})

/** 设置里所有「并发」类键（含旧别名 batchConcurrency）。 */
const CONCURRENCY_KEY_LIST = Object.freeze([
  "routeConcurrency",
  "balanceConcurrency",
  "tasksConcurrency",
  "inviteConcurrency",
  "batchConcurrency",
])

/**
 * 某个 job 的并发：**只读它自己那条设置**，不跨类复用、不写死。
 *
 * `route` 兼容旧别名：优先 `routeConcurrency`，没有则回落 `batchConcurrency`，
 * 再没有才用 2（保证老调用不坏）。
 *
 * @param {"route"|"balance"|"tasks"|"invite"} kind
 * @param {Record<string, any>} settings
 * @returns {number} 整数 ≥1（不设上限）
 */
/**
 * 规范化写盘/读取时的别名关系：
 *   · 写 `batchConcurrency` → 同时写 `routeConcurrency`（老调用不坏）
 *   · 读时若只有 `routeConcurrency` → 补 `batchConcurrency`（老代码仍在读它）
 *
 * @param {Record<string, any>} data
 * @returns {Record<string, any>}
 */
export function normalizeConcurrencyAliases(data) {
  const next = isPlainObject(data) ? { ...data } : {}
  const valid = (v) => Number.isInteger(v) && v >= 1
  // ⚠ 只补「缺失的对端」，**不覆盖**已存在且合法的值：
  //   否则读取侧（默认值里有 routeConcurrency:2）会把用户刚写进来的
  //   batchConcurrency:32 立刻改回 2。
  if (valid(next.routeConcurrency) && !valid(next.batchConcurrency)) next.batchConcurrency = next.routeConcurrency
  if (valid(next.batchConcurrency) && !valid(next.routeConcurrency)) next.routeConcurrency = next.batchConcurrency
  return next
}

export function concurrencyFor(kind, settings) {
  const data = isPlainObject(settings) ? settings : {}
  const key = CONCURRENCY_KEYS[kind] ?? ""
  let value = key ? data[key] : undefined
  if (value === undefined && kind === "route") value = data.batchConcurrency
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : 2
}

/** 启动间隔（毫秒）：`gapMs` 设置，默认 300。 */
export function gapFor(settings) {
  const n = Number(isPlainObject(settings) ? settings.gapMs : undefined)
  return Number.isInteger(n) && n >= 0 && n <= 5000 ? n : 300
}

/** 一个设置值是否合法（非法值一律回落到默认值，不写盘）。 */
function validPanelSetting(key, value) {
  if (key === "gapMs") return Number.isInteger(value) && value >= 0 && value <= 5000
  if (key === "autoApply") return typeof value === "boolean"
  if (key === "magpiePath") return typeof value === "string" && value.length <= 4096
  if (CONCURRENCY_KEY_LIST.includes(key)) return Number.isInteger(value) && value >= 1
  if (key === "batchSkipChecked") return typeof value === "boolean"
  if (key === "ledgerReads") return Number.isInteger(value) && value >= 1 && value <= 5
  if (key === "focusRefresh") return typeof value === "boolean"
  return false
}

/**
 * 读面板设置（含默认值兜底）。
 *
 * @param {string} [configDir]
 * @returns {{ok: boolean, data: {batchConcurrency: number, balanceConcurrency: number, batchSkipChecked: boolean, ledgerReads: number}}}
 */
export function readPanelSettings(configDir) {
  const data = { ...PANEL_SETTINGS_DEFAULTS }
  if (!configDir) return { ok: true, data }
  const file = join(configDir, SETTINGS_FILE)
  if (!existsSync(file)) return { ok: true, data }
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return { ok: true, data }
  }
  if (!isPlainObject(parsed)) return { ok: true, data }
  for (const [key, value] of Object.entries(parsed)) {
    if (key in data && validPanelSetting(key, value)) data[key] = value
  }
  // 老文件里可能只有 batchConcurrency（别名）→ 补 routeConcurrency，反之亦然
  return { ok: true, data: normalizeConcurrencyAliases(data) }
}

/** 原子写面板设置文件（只写传进来的子集，其余保持原值）。 */
function writePanelSettings(configDir, patch) {
  if (!configDir) throw new Error("未设置 configDir，无法持久保存面板设置")
  const current = readPanelSettings(configDir).data
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (!validPanelSetting(key, value)) throw new Error(`设置项 ${key} 的值不合法`)
    next[key] = value
  }
  // 别名以「本次显式写入的那个键」为准：先补齐另一个，再归一，避免默认值把新值覆盖掉
  if ("batchConcurrency" in patch && !("routeConcurrency" in patch)) {
    next.routeConcurrency = patch.batchConcurrency
  }
  if ("routeConcurrency" in patch && !("batchConcurrency" in patch)) {
    next.batchConcurrency = patch.routeConcurrency
  }
  Object.assign(next, normalizeConcurrencyAliases(next))
  const file = join(configDir, SETTINGS_FILE)
  const temp = file + "." + randomUUID() + ".tmp"
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    renameSync(temp, file)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return next
}

/** 完整设置（迁移用的旧字段 + 新文件里的开关）。 */
function panelSettings(ctx) {
  const legacy = Object.fromEntries(["accountConcurrency", "bindConcurrency"].map((key) => [key, validConcurrency(ctx.state.settings?.[key]) ? ctx.state.settings[key] : 20]))
  return { ...legacy, ...readPanelSettings(ctx.configDir).data }
}

/** 默认值（面板「恢复默认」与前端校验都用它）。 */
function panelSettingsDefaults() {
  return { accountConcurrency: 20, bindConcurrency: 20, ...PANEL_SETTINGS_DEFAULTS }
}

function getPanelSettings(res, ctx) {
  return sendJson(res, 200, { ok: true, settings: panelSettings(ctx), defaults: panelSettingsDefaults() })
}

/**
 * `POST /api/settings`：任意子集，校验后合并写盘。
 *
 * 两句配置落在两个文件里：`accountConcurrency/bindConcurrency` →
 * loomy-panel-state.json（历史原因，那段逻辑没动），其余 → loomy-panel-settings.json。
 */
async function savePanelSettings(req, res, ctx) {
  let input
  try {
    input = JSON.parse(await readBody(req, 4096))
  } catch {
    return sendJson(res, 400, { error: "设置参数不是合法 JSON" })
  }
  const accepted = [
  "accountConcurrency",
  "bindConcurrency",
  "batchConcurrency",
  "routeConcurrency",
  "balanceConcurrency",
  "tasksConcurrency",
  "inviteConcurrency",
  "gapMs",
  "batchSkipChecked",
  "ledgerReads",
  "autoApply",
  "magpiePath",
  "focusRefresh",
]
  if (!isPlainObject(input) || !Object.keys(input).length) {
    return sendJson(res, 400, { error: `仅接受 ${accepted.join("/")}，值必须合法` })
  }
  /** @type {Record<string, any>} */
  const legacy = {}
  /** @type {Record<string, any>} */
  const panel = {}
  // ⚠ T-49：未知字段**忽略**（不报错、不落盘）——客户端多带一个键不该把整次设置
  //    保存打回 400；但只要**一个可识别的键都没有**，仍然按旧行为 400（拦住
  //    「拼错键名 → 以为存上了」那种静默失败）。
  let known = 0
  for (const [key, value] of Object.entries(input)) {
    if (!accepted.includes(key)) continue
    known += 1
    if (key === "accountConcurrency" || key === "bindConcurrency") {
      if (!validConcurrency(value)) return sendJson(res, 400, { error: "accountConcurrency/bindConcurrency 必须是 ≥1 的整数" })
      legacy[key] = value
      continue
    }
    if (!validPanelSetting(key, value)) {
      return sendJson(res, 400, { error: key === "batchConcurrency" || key === "balanceConcurrency" ? `${key} 必须是 ≥1 的整数` : key === "ledgerReads" ? "ledgerReads 必须是 1..5 的整数" : key === "focusRefresh" ? "focusRefresh 必须是布尔值" : key === "gapMs" ? "gapMs 必须是 0..5000 的整数" : "值必须合法" })
    }
    panel[key] = value
  }
  if (!known) return sendJson(res, 400, { error: `仅接受 ${accepted.join("/")}，值必须合法` })
  if (!ctx.configDir) return sendJson(res, 503, { error: "未设置 configDir，无法持久保存设置" })
  try {
    if (Object.keys(legacy).length) {
      updatePanelState(ctx, (state) => {
        state.settings = { ...(isPlainObject(state.settings) ? state.settings : {}), ...legacy }
      })
    }
    if (Object.keys(panel).length) writePanelSettings(ctx.configDir, panel)
  } catch {
    return sendJson(res, 500, { error: "设置保存失败，请检查面板配置目录是否可写" })
  }
  return sendJson(res, 200, { ok: true, settings: panelSettings(ctx) })
}

function readPanelState(configDir) {
  if (!configDir) return { accounts: {} }
  const file = join(configDir, "loomy-panel-state.json")
  if (!existsSync(file)) return { accounts: {} }
  const state = JSON.parse(readFileSync(file, "utf8"))
  if (!state?.accounts || typeof state.accounts !== "object" || Array.isArray(state.accounts)) throw new Error("面板状态文件无效")
  return state
}

function updatePanelState(ctx, change) {
  if (!ctx.configDir) throw new Error("未设置 configDir，无法持久保存面板状态")
  const state = structuredClone(ctx.state)
  change(state)
  const file = join(ctx.configDir, "loomy-panel-state.json")
  const temp = file + "." + randomUUID() + ".tmp"
  try {
    writeFileSync(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 })
    renameSync(temp, file)
    ctx.state = state
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

async function bindAccount(ctx, account, code) {
  let result
  try {
    await bindInvite({ baseUrl: ctx.baseUrl, auth: { session: account.session }, fetchImpl: ctx.fetchImpl }, code)
    result = { ok: true }
  } catch (e) {
    result = { ok: false, error: panelError(e) }
  }
  return { ...result, uid: account.uid, name: account.nickname, code }
}

async function bulkBind(ctx, input) {
  if (input.mode !== "one-each" && input.mode !== "one-many") return { ok: false, error: "mode 必须是 one-each 或 one-many" }
  if (typeof input.codes !== "string") return { ok: false, error: "codes 必须是字符串" }
  const codes = input.codes.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!codes.length) return { ok: false, error: "请至少填一个邀请码" }
  if (!validConcurrency(input.concurrency)) return { ok: false, error: "concurrency 必须是 ≥1 的整数" }
  if (input.mode === "one-many" && (codes.length !== 1 || !Number.isInteger(input.count) || input.count < 1 || input.count > 999)) return { ok: false, error: "one-many 需要单码及 1..999 整数 count" }
  if (ctx.binding) return { ok: false, error: "绑定正在运行" }
  ctx.binding = true
  try {
    const requested = input.mode === "one-many" ? input.count : codes.length
    const candidates = []
    for (const account of selectedAccounts(ctx, new URLSearchParams())) {
      try {
        const activation = await fetchActivation({ baseUrl: ctx.baseUrl, auth: { session: account.session }, fetchImpl: ctx.fetchImpl })
        if (activation.activated === false) candidates.push(account)
      } catch {}
      if (candidates.length === requested) break
    }
    const results = new Array(Math.min(requested, candidates.length))
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(input.concurrency, results.length) }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= results.length) return
        results[index] = await bindAccount(ctx, candidates[index], input.mode === "one-many" ? codes[0] : codes[index])
      }
    }))
    const bound = results.filter((r) => r.ok).length
    const unassigned = requested - results.length
    return { ok: bound === requested, requested, unassigned, bound, failed: results.length - bound, results }
  } finally {
    ctx.binding = false
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let total = 0
    req.on("data", (c) => {
      total += c.length
      if (total > limit) {
        reject(new Error("请求体过大"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

/**
 * 面板所有响应共用的头。
 *
 * # ⚠ CSP 里 `connect-src 'self'` 曾经让面板整体「Failed to fetch」
 *
 * 症状：页面渲染正常（HTML/CSS/JS 都到了），但 /api/accounts 一律
 * `TypeError: Failed to fetch`。原因：面板页是被 magpie 的窗口**导航**进来的，
 * 在 WebView / 嵌套 frame 里 `'self'` 可能匹配不上真实 origin（AGENTS.md 坑 #20/#21）。
 *
 * 修法：connect-src 显式写出 http://127.0.0.1:<port> 与 http://localhost:<port>。
 * `connect-src *` 是**故意的**：这个本地面板页没有第三方内容，也没有可注入的用户输入。
 *
 * @param {number} port 实际监听端口
 * @returns {Record<string,string>}
 */
function commonHeaders(port) {
  const p = Number(port) > 0 ? Number(port) : 0
  const loop = p ? `http://127.0.0.1:${p} http://localhost:${p}` : ""
  const csp = [
    `default-src * data: blob: 'unsafe-inline' 'unsafe-eval'`,
    `connect-src *${loop ? " " + loop : ""}`,
    `img-src * data: blob:`,
    `script-src * 'unsafe-inline'`,
    `style-src * 'unsafe-inline'`,
    "frame-ancestors *",
  ].join("; ")
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": csp,
    // 沙盒 frame 的 opaque origin 是 "null"，用 * 兼容它。
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "X-Content-Type-Options": "nosniff",
  }
}

function sendJson(res, status, obj, port = 0) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...commonHeaders(port || res.socket?.localPort || 0),
  })
  res.end(body)
}

function sendFile(res, file, type, port = 0) {
  if (!existsSync(file)) {
    sendJson(res, 404, { error: "not found" }, port)
    return
  }
  const body = type.startsWith("text/html")
    ? readFileSync(file, "utf8").replaceAll("http://127.0.0.1:4391/", `http://127.0.0.1:${port || res.socket?.localPort || DEFAULT_PORT}/`)
    : readFileSync(file)
  // ⚠ **必须显式给 Content-Length**（字节数，不是字符数）。
  //
  // 实测（node 24.15 / bun 1.4.4，两种运行时各起一个服务、两种客户端各发一次）：
  // 原来的 `res.end(body)` **没有**丢字节 —— 75,906 B 的 app.js 收到 75,906 B、
  // sha256 逐字节相同。所以「服务端把大文件截断」这个结论**不成立**。
  //
  // 但原来的响应走的是 `Transfer-Encoding: chunked`（无 `Content-Length`），
  // 这带来两个真实代价：
  //   ① 中间层 / WebView 只要提前收尾，前端拿到的就是半截 JS（`SyntaxError`
  //      ⇒ 整段脚本不执行 ⇒ 表现正是「改了代码但浏览器里还是旧行为」）；
  //   ② 没有长度可对，**字符数**极易被当成**字节数**：中文 1 字符 = 3 字节，
  //      59,766 B 的 app.js 解码后正好是 49,152 个字符 —— 这个「整数 48 KiB」
  //      是这么来的，不是被截断成了 48 KiB。
  //
  // 给出长度之后，客户端/浏览器能自己判断有没有收全；分块写避免一次
  // `end(hugeBuffer)` 在个别运行时上退化成长时间同步写。
  //
  // ⚠ HTML 分支的 body 是**字符串**：`Buffer.byteLength()` 才是要发的字节数；
  //    用 `str.length` 会让 Content-Length 小于真实字节（比重更大）。
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": String(payload.length),
    ...commonHeaders(port || res.socket?.localPort || 0),
  })
  const CHUNK = 64 * 1024
  if (payload.length <= CHUNK) {
    res.end(payload)
    return
  }
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    res.write(payload.subarray(offset, Math.min(offset + CHUNK, payload.length)))
  }
  res.end()
}

function guessType(p) {
  if (p.endsWith(".css")) return "text/css; charset=utf-8"
  if (p.endsWith(".js")) return "text/javascript; charset=utf-8"
  if (p.endsWith(".svg")) return "image/svg+xml"
  if (p.endsWith(".png")) return "image/png"
  return "application/octet-stream"
}


// ── 手动启动入口 ────────────────────────────────────────────────────────
//
// `node server.mjs` 与 magpie 调 `server()` 等价（走同一套生命周期契约）。
// 排障时用它单独把面板拉起来，不必开 magpie。
//
// ⚠ 这段必须在文件末尾且带守卫：模块被 import 时**不能**有副作用
// （社区脚本会直接 import 做静态检查，导入即监听会占端口）。
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer({
    port: Number(process.env.LOOMY_PANEL_PORT ?? DEFAULT_PORT),
    configDir: process.env.MAGPIE_CONFIG_DIR ?? "",
  })
    .then((s) => {
      console.log(`loomy panel listening on http://127.0.0.1:${s.port}/`)
      console.log(`config dir: ${process.env.MAGPIE_CONFIG_DIR || "(未设置，账号列表会是空)"}`)
    })
    .catch((e) => {
      console.error(`loomy panel not started: ${e?.message ?? e}`)
      process.exit(1)
    })
}
