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
//
// ⚠ plugin-auth.json 的格式**不在 magpie 的插件契约里**。直接写它属于
// 钻实现细节，所以：① 写前一定备份；② 只增不删；③ 写完提示用户
// 在插件管理里关掉再打开（宿主才会重读账号）。

import { createServer } from "node:http"
import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
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
import { usageFromPoints, tasksSummary } from "./src/usage.mjs"

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
 *   fetchImpl?: typeof fetch, log?: object, retry?: boolean}} [opts]
 *   `retry: true` 时端口被占用会**反复重试**（最多 ~30 秒），而不是顺延到
 *   邻近端口 —— 这是页面服务的语义：端口由 magpie 指定，插件不该改。
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
  }

  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((e) => {
      const error = panelError(e)
      log.warn?.(`loomy panel: ${error}`)
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

  // API
  if (path === "/api/hello") return sendJson(res, 200, { ok: true, provider: PROVIDER, since: ctx.startedAt })
  if (path === "/api/settings" && req.method === "GET") return sendJson(res, 200, panelSettings(ctx))
  if (path === "/api/settings" && req.method === "POST") return savePanelSettings(req, res, ctx)
  if (path === "/api/accounts") return sendJson(res, 200, await listAccounts(ctx, url.searchParams))
  if (path === "/api/tasks") return sendJson(res, 200, await tasksForAll(ctx, url.searchParams))
  if (path === "/api/invite") return sendJson(res, 200, await inviteForAll(ctx, url.searchParams))
  if (path === "/api/do" && req.method === "POST") return sendJson(res, 200, await act(req, ctx))

  sendJson(res, 404, { error: "not found" })
}

/** 列出 magpie 里已登录的 loomy 账号。 */
async function listAccounts(ctx, params) {
  const accounts = selectedAccounts(ctx, params)
  const out = await mapAccounts(accounts, async (a) => {
    /** @type {any} */
    const row = {
      uid: a.uid,
      name: a.nickname || shortUID(a.uid),
      phone: a.phone,
      firstLogin: ctx.state.accounts[a.uid]?.firstLogin === true ? true : a.firstLogin,
      quota: null,
      error: "",
    }
    try {
      const pts = await fetchPointsSnapshot({ baseUrl: ctx.baseUrl, auth: { session: a.session }, fetchImpl: ctx.fetchImpl })
      row.quota = usageFromPoints(pts)
    } catch (e) {
      row.error = panelError(e)
    }
    return row
  })
  return { accounts: out, total: out.length }
}

/** 所有账号的新手任务状态。 */
async function tasksForAll(ctx, params) {
  const accounts = selectedAccounts(ctx, params)
  const rows = await mapAccounts(accounts, async (a) => {
    try {
      const map = await fetchTasks({ baseUrl: ctx.baseUrl, auth: { session: a.session }, fetchImpl: ctx.fetchImpl })
      return {
        uid: a.uid,
        name: a.nickname || shortUID(a.uid),
        tasks: map,
        summary: tasksSummary(map),
      }
    } catch (e) {
      return { uid: a.uid, name: a.nickname || shortUID(a.uid), tasks: {}, error: panelError(e) }
    }
  })
  return { defs: TASK_DEFS, rows }
}

/** 所有账号的邀请码与激活状态。 */
async function inviteForAll(ctx, params) {
  const accounts = selectedAccounts(ctx, params)
  const rows = await mapAccounts(accounts, async (a) => {
    /** @type {any} */
    const row = { uid: a.uid, name: a.nickname || shortUID(a.uid), codes: [], activation: null, error: "" }
    try {
      row.codes = await fetchInvitationCodes({ baseUrl: ctx.baseUrl, auth: { session: a.session }, fetchImpl: ctx.fetchImpl })
    } catch (e) {
      row.error = panelError(e)
    }
    try {
      row.activation = await fetchActivation({ baseUrl: ctx.baseUrl, auth: { session: a.session }, fetchImpl: ctx.fetchImpl })
    } catch {
      // 激活状态查不到不影响码列表
    }
    return row
  })
  return { rows }
}

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

  const session = await resolveSession(ctx, input?.uid)
  if (!session) return { error: "找不到这个账号的 session" }

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
 * @returns {Array<{session: string, uid: string, nickname: string}>}
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

  /** @type {Array<{session: string, uid: string, nickname: string}>} */
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
    out.push({
      session,
      uid,
      nickname: String(meta.nickname ?? v?.accountId ?? "").trim(),
      phone: String(meta.phone ?? "").trim(),
      firstLogin: typeof meta.firstLogin === "boolean" ? meta.firstLogin : null,
    })
  }
  return out
}

// ── 杂项 ────────────────────────────────────────────────────────────────

async function resolveSession(ctx, uid) {
  const accounts = readMagpieAuth(ctx.configDir)
  if (!uid) return accounts[0]?.session ?? ""
  const hit = accounts.find((a) => a.uid === String(uid))
  return hit?.session ?? ""
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

function safeReceipt(value, session) {
  if (typeof value === "string") return value.replaceAll(session, "[redacted]")
  if (Array.isArray(value)) return value.map((item) => safeReceipt(item, session))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/session|token|authorization|secret|access|credential/i.test(key))
    .map(([key, item]) => [key.replaceAll(session, "[redacted]"), safeReceipt(item, session)]))
}

async function mapAccounts(accounts, query) {
  const rows = new Array(accounts.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= accounts.length) return
      rows[index] = await query(accounts[index])
    }
  }))
  return rows
}

function selectedAccounts(ctx, params) {
  const accounts = [...new Map(readMagpieAuth(ctx.configDir).map((a) => [a.uid, a])).values()]
  if (!params.has("uids")) return accounts
  const uids = new Set(params.get("uids").split(",").map((s) => s.trim()).filter(Boolean))
  return accounts.filter((a) => uids.has(a.uid))
}

function validConcurrency(value) {
  return Number.isInteger(value) && value >= 1 && value <= 50
}

function panelSettings(ctx) {
  return Object.fromEntries(["accountConcurrency", "bindConcurrency"].map((key) => [key, validConcurrency(ctx.state.settings?.[key]) ? ctx.state.settings[key] : 20]))
}

async function savePanelSettings(req, res, ctx) {
  let input
  try {
    input = JSON.parse(await readBody(req, 4096))
  } catch {
    return sendJson(res, 400, { error: "设置参数不是合法 JSON" })
  }
  const keys = ["accountConcurrency", "bindConcurrency"]
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.keys(input).length || Object.entries(input).some(([key, value]) => !keys.includes(key) || !validConcurrency(value))) {
    return sendJson(res, 400, { error: "仅接受 accountConcurrency/bindConcurrency，值必须是 1..50 的整数" })
  }
  if (!ctx.configDir) return sendJson(res, 503, { error: "未设置 configDir，无法持久保存并发设置" })
  try {
    updatePanelState(ctx, (state) => { state.settings = { ...panelSettings(ctx), ...input } })
  } catch {
    return sendJson(res, 500, { error: "并发设置保存失败，请检查面板状态目录是否可写" })
  }
  return sendJson(res, 200, panelSettings(ctx))
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
  if (!validConcurrency(input.concurrency)) return { ok: false, error: "concurrency 必须是 1..50 的整数" }
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
 * `TypeError: Failed to fetch`，顶栏显示「读取失败」。
 *
 * 原因：面板页是被 magpie 的窗口**导航**进来的，而 magpie 用 WebView /
 * 嵌套 frame 承载它。在这种上下文里 `'self'` 可能匹配不上真实 origin
 * （magpie 的 HOOKS 明确写过这条 WebKit 坑：在 sandbox 框架里，WebKit 的
 * `'self'` 和不带 scheme 的源可能什么都匹配不上）。
 *
 * 修法：connect-src 显式写出 http://127.0.0.1:<port> 与
 * http://localhost:<port> 两种形态，不只依赖 `'self'`。
 * 代价是端口要传进来 —— 所以这里是工厂，不是常量。
 *
 * frame-ancestors * 保留：magpie 的窗口要能嵌它。
 *
 * @param {number} port 实际监听端口
 * @returns {Record<string,string>}
 */
function commonHeaders(port) {
  // 端口从 socket 上取（`res.socket.localPort`），所以调用点不用各自传。
  const p = Number(port) > 0 ? Number(port) : 0
  const loop = p ? `http://127.0.0.1:${p} http://localhost:${p}` : ""
  // ⚠ 曾经只写 `connect-src 'self'`，结果面板在 magpie 的 WebView 里
  // 一律 `TypeError: Failed to fetch`（页面能渲染，API 全挂）——
  // magpie 的 HOOKS 记过这条 WebKit 坑：沙盒/嵌套上下文里 `'self'`
  // 可能匹配不上真实 origin。现在把回环地址显式写出来。
  //
  // `connect-src *` 是**故意的**：面板只可能被本机打开，而 magpie 的
  // WebView 在不同平台对 origin 的判断不一致（opaque origin / null / 代理路径）。
  // 多写一个 * 换来「一定能连通」，代价是这一个本地面板页的 CSP 不再收紧 ——
  // 它没有第三方内容，也没有可注入的用户输入。
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
    // 端口从 socket 上取，调用点不用各自传（handle() 拿不到端口）
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