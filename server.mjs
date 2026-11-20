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
  fetchInvitationCodes,
  firstLogin,
} from "./src/points.mjs"
import { readLocalAuth, readLocalPoints, defaultClientStoreDir } from "./src/client-store.mjs"
import { usageFromPoints, tasksSummary, DAILY_RESET_AMOUNT } from "./src/usage.mjs"

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
    // 进程级并发槽 + 启动节流（三个全量任务共享，总并发不超过设置值）
    slotActive: 0,
    slotWaiters: [],
    slotLimit: 0,
    refreshGateFn: null,
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
  // 免费巡检：只读模型目录 + 账本/流量，**不发 chat、不扣积分**
  // 判定 → 生效：跑一次 `magpie plugin list`（实测唯一能让运行中 magpie 重拉模型列表的通道）
  if (path === "/api/apply-route" && req.method === "POST") return applyRouteRoute(res, ctx)
  if (path === "/api/route-patrol-batch" && req.method === "POST") return patrolBatchStart(req, res, ctx)
  if (path === "/api/route-patrol-batch" && req.method === "GET") return patrolBatchState(res, ctx, url.searchParams)

  // 余额：单行只刷这一个号；批量是「刷新全部」的全量入口
  if (path === "/api/accounts-refresh" && req.method === "POST") return accountRefreshOne(req, res, ctx)
  if (path === "/api/accounts-refresh-batch" && req.method === "POST") return accountsRefreshStart(req, res, ctx)
  if (path === "/api/accounts-refresh-batch" && req.method === "GET") return accountsRefreshState(res, ctx, url.searchParams)
  // 任务 / 邀请码同理（打开面板读缓存，刷新必须用户点）
  if (path === "/api/tasks-refresh-batch" && req.method === "POST") return tasksRefreshStart(req, res, ctx)
  if (path === "/api/tasks-refresh-batch" && req.method === "GET") return tasksRefreshState(res, ctx, url.searchParams)
  if (path === "/api/invite-refresh-batch" && req.method === "POST") return inviteRefreshStart(req, res, ctx)
  if (path === "/api/invite-refresh-batch" && req.method === "GET") return inviteRefreshState(res, ctx, url.searchParams)

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

// ── 免费巡检（0 积分） ──────────────────────────────────────────────────
//
// # 它和「检测」的区别
//
// 检测要发一次 chat（扣 1 积分）拿权威结论；巡检**只看模型目录 + 账本/流量**：
//   · 目录里没有 DS4.1 / session 失效 / 账号停用 → 直接给结论（免费）
//   · 其余情况 `{keep:true}` —— 不改 verdict，只更新 `catalogOkAt`
//   · 有流量证据且与账本不符（traffic-mismatch）→ 可以改判（仍是免费）
//
// ⚠ 用 `patrolAccount`（单号）而不是 `patrolMany`（整批）：后者不做熔断，
//   而上游限流时必须能「连续 3 次失败就停手」。并发槽 / 300ms 节流 / 熔断
//   复用面板已有的那套（与余额刷新同一组参数）。

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
/** 巡检模块（缺失即 503；T-0x 并行开发，别在面板里伪造它）。 */
async function ensurePatrolModule() {
  if (patrolModulePromise === undefined) {
    patrolModulePromise = import("./src/patrol.mjs")
      .then((m) => (typeof m?.patrolAccount === "function" ? m : null))
      .catch(() => null)
  }
  return patrolModulePromise
}

/**
 * `POST /api/route-patrol-batch {uids?}` → 立刻回 `{ok, jobId, total, costHint:0}`。
 */
async function patrolBatchStart(req, res, ctx) {
  /** @type {any} */
  let input
  try {
    const raw = await readBody(req, 1 << 20)
    input = raw ? JSON.parse(raw) : {}
  } catch {
    return sendJson(res, 400, { ok: false, error: "参数不是合法 JSON" })
  }
  if (!isPlainObject(input)) return sendJson(res, 400, { ok: false, error: "参数必须是 JSON 对象" })
  if (!ctx.configDir) return sendJson(res, 503, { ok: false, error: "未设置 configDir，无法读取账号" })

  const all = selectedAccounts(ctx, new URLSearchParams())
  /** @type {any[]} */
  let targets = all
  if (input.uids !== undefined && input.uids !== null) {
    if (!Array.isArray(input.uids)) return sendJson(res, 400, { ok: false, error: "uids 必须是数组" })
    /** @type {string[]} */
    const list = []
    for (const raw of input.uids) {
      if (typeof raw !== "string") return sendJson(res, 400, { ok: false, error: "uids 的每个元素都必须是字符串" })
      const uid = raw.trim()
      if (uid) list.push(uid)
    }
    if (!list.length) return sendJson(res, 400, { ok: false, error: "uids 不能为空（省略该字段表示巡检全部）" })
    const wanted = new Set(list)
    targets = all.filter((a) => wanted.has(a.uid))
  }
  if (!targets.length) return sendJson(res, 400, { ok: false, error: "没有需要巡检的账号" })

  const mods = await ensureRouteModules(ctx)
  if (!mods) return sendJson(res, 503, { ok: false, error: "检测模块未就绪" })
  const patrol = await ensurePatrolModule()
  if (!patrol) return sendJson(res, 503, { ok: false, error: "巡检模块未就绪" })

  const jobId = randomUUID()
  const job = { jobId, kind: "patrol", total: targets.length, running: true, stopped: "", kept: 0, updated: 0, results: /** @type {Record<string, object>} */ ({}) }
  ctx.routeJobs.set(jobId, job)
  void runPatrol(ctx, mods, patrol, job, targets)
  return sendJson(res, 200, { ok: true, jobId, total: job.total, costHint: 0 })
}

/** 巡检队列：并发槽 + 300ms 启动节流 + 连续 3 次失败熔断（与余额刷新同一套）。 */
async function runPatrol(ctx, mods, patrol, job, targets) {
  let cursor = 0
  let consecutiveFailures = 0
  const worker = async () => {
    for (;;) {
      if (job.stopped) return
      const index = cursor++
      if (index >= targets.length) return
      const account = targets[index]
      await refreshGate(ctx)
      if (job.stopped) return
      /** @type {any} */
      let result
      try {
        result = await withSlot(ctx, () => patrol.patrolAccount({
          baseUrl: ctx.baseUrl,
          session: account.session,
          uid: account.uid,
          configDir: ctx.configDir,
          fetchImpl: ctx.fetchImpl,
        }))
      } catch (e) {
        result = { error: sanitizeError(e, account.session) }
      }
      job.results[account.uid] = result
      if (result?.error || isRateLimitFailure(result)) {
        consecutiveFailures += 1
        if (consecutiveFailures >= BATCH_BREAKER) job.stopped = "upstream-rate-limited"
      } else {
        consecutiveFailures = 0
      }
      if (!result || typeof result !== "object" || result.error) continue
      // ⚠ keep:true 只更新 catalogOkAt，**绝不改** verdict（改判要靠流量证据或付费检测）
      try {
        const prior = typeof mods.getAccountRoute === "function" ? mods.getAccountRoute(ctx.configDir, account.uid) : null
        if (result.keep) {
          if (isPlainObject(prior) && Number.isFinite(Number(result.catalogOkAt)) && Number(result.catalogOkAt) > 0) {
            await mods.writeRouteState(ctx.configDir, account.uid, { ...prior, catalogOkAt: Number(result.catalogOkAt) })
          }
          job.kept += 1
          continue
        }
        if (result.verdict) {
          await mods.writeRouteState(ctx.configDir, account.uid, {
            verdict: result.verdict,
            reason: result.reason ?? "",
            servedModel: result.servedModel ?? "",
            checkedAt: Number(result.checkedAt) || Date.now(),
            catalogOkAt: Number(result.catalogOkAt) || Date.now(),
          })
          job.updated += 1
        } else {
          job.kept += 1
        }
      } catch (e) {
        job.results[account.uid] = { ...result, error: sanitizeError(e, account.session) }
      }
    }
  }
  try {
    // 巡检用**自己那条**设置（patrolConcurrency），不借用批量检测的并发
    const patrolConcurrency = concurrencyFor("patrol", readPanelSettings(ctx.configDir).data)
    await Promise.all(Array.from({ length: Math.min(patrolConcurrency, targets.length) }, worker))
  } catch (e) {
    ctx.log.warn?.(`loomy panel: 巡检异常收尾: ${String(e?.message ?? e).slice(0, 200)}`)
  } finally {
    job.running = false
    // 判定写完了 → 自动让 magpie 重拉模型列表（utoApply 关掉时只记 applied:false）
    scheduleAutoApply(ctx, job)
    const timer = setTimeout(() => { ctx.routeJobs.delete(job.jobId) }, ROUTE_JOB_TTL_MS)
    timer.unref?.()
  }
}

/** `GET /api/route-patrol-batch?jobId=` → 进度（带 costHint:0 与 kept 计数）。 */
function patrolBatchState(res, ctx, params) {
  const jobId = String(params.get("jobId") ?? "").trim()
  const job = jobId ? ctx.routeJobs.get(jobId) : null
  if (!job || job.kind !== "patrol") return sendJson(res, 404, { ok: false, error: "没有这个巡检任务" })
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
      kind: "patrol",
      total: job.total,
      done: okCount + failCount,
      okCount,
      failCount,
      kept: job.kept,
      updated: job.updated,
      running: job.running,
      stopped: job.stopped || "",
      costHint: 0,
      // 判定写完后是否已让 magpie 重拉（`autoApply` 关掉时恒为 false）
      applied: job.applied === true,
      applyError: job.applyError || "",
      results: job.results,
    },
  })
}

/**
 * 批量检测的边界。
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

/** src/patrol.mjs 的加载缓存（缺失即 null；补上后需要重启插件进程）。 */
let patrolModulePromise

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
  const [probe, store, byTurn] = await Promise.all([
    import("./src/route.mjs").catch(() => null),
    import("./src/route-store.mjs").catch(() => null),
    import("./src/byturn.mjs").catch(() => null),
  ])
  if (typeof probe?.probeRoute !== "function") return null
  if (typeof store?.readRouteState !== "function" || typeof store?.writeRouteState !== "function") return null
  return {
    probeRoute: probe.probeRoute,
    /**
     * 面板「检测」的默认通道：**by-turn**。
     *
     * 目录会谎报、账本只能猜时间窗；只有 by-turn 能说清「这一轮到底由谁服务」。
     * 所以单行「检测」与批量检测都走它（发一条带 TurnId 的最小请求 → 回查）。
     * `probeRoute` 保留作为一次性检查的后备。
     */
    probeByTurn: typeof byTurn?.probeByTurn === "function" ? byTurn.probeByTurn : undefined,
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
function probeAccountRoute(ctx, mods, uid, session) {
  const key = String(uid)
  const inflight = ctx.routePending.get(key)
  if (inflight) return inflight

  const task = (async () => {
    // 默认走 by-turn（唯一能说清「这一轮实际由谁服务」的通道）；
    // 注入的测试桩若只给了 probeRoute，就退回旧的探测。
    const entry =
      typeof mods.probeByTurn === "function"
        ? await mods.probeByTurn({ baseUrl: ctx.baseUrl, session, fetchImpl: ctx.fetchImpl })
        : await mods.probeRoute({ baseUrl: ctx.baseUrl, session, fetchImpl: ctx.fetchImpl })
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
 * 进程级并发槽：所有刷新任务共享 `ctx.slotLimit`。
 *
 * 三个全量任务同时启动时，总并发不会超过设置值（而不是 3 × 设置值）。
 */
async function withSlot(ctx, fn) {
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
  patrolConcurrency: 2,
  // 每次真实调用之间的启动间隔（毫秒，0 = 不等待；不是并发，是保护）
  gapMs: 300,
  // 判定自动生效：巡检/检测完成后自动重拉 magpie 模型列表
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
  tasks: "tasksConcurrency",
  invite: "inviteConcurrency",
  patrol: "patrolConcurrency",
})

/** 设置里所有「并发」类键（含旧别名 batchConcurrency）。 */
const CONCURRENCY_KEY_LIST = Object.freeze([
  "routeConcurrency",
  "balanceConcurrency",
  "tasksConcurrency",
  "inviteConcurrency",
  "patrolConcurrency",
  "batchConcurrency",
])

/**
 * 某个 job 的并发：**只读它自己那条设置**，不跨类复用、不写死。
 *
 * `route` 兼容旧别名：优先 `routeConcurrency`，没有则回落 `batchConcurrency`，
 * 再没有才用 2（保证老调用不坏）。
 *
 * @param {"route"|"balance"|"tasks"|"invite"|"patrol"} kind
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
  "patrolConcurrency",
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
  for (const [key, value] of Object.entries(input)) {
    if (!accepted.includes(key)) return sendJson(res, 400, { error: `仅接受 ${accepted.join("/")}，值必须合法` })
    if (key === "accountConcurrency" || key === "bindConcurrency") {
      if (!validConcurrency(value)) return sendJson(res, 400, { error: "accountConcurrency/bindConcurrency 必须是 ≥1 的整数" })
      legacy[key] = value
      continue
    }
    if (!validPanelSetting(key, value)) {
      return sendJson(res, 400, { error: key === "batchConcurrency" || key === "balanceConcurrency" ? `${key} 必须是 ≥1 的整数` : key === "ledgerReads" ? "ledgerReads 必须是 1..5 的整数" : key === "focusRefresh" ? "focusRefresh 必须是布尔值" : "batchSkipChecked 必须是布尔值" })
    }
    panel[key] = value
  }
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
  res.writeHead(200, {
    "Content-Type": type,
    ...commonHeaders(port || res.socket?.localPort || 0),
  })
  res.end(body)
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
