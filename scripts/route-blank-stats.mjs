// scripts/route-blank-stats.mjs 真机统计：置空判定是否真的把 routed 号挡掉。
//
// # 它回答的两个数字（T-44 验收）
//
//	可用账号数（models 非空）  —— 应为 71（不是 281）
//	routed 且 models 非空      —— 应为 0
//
// # 为什么必须走**真的** `provider.models`
//
// 直接读 `plugin-providers.json` 里账号的 `models` 数组只能看到「宿主上次
// 记住的东西」，看不到本次改动。所以这里按真机的方式逐个账号调用
// `makeModelsHook`，只替换上游（用文件缓存作答，不发任何请求），
// 然后把结果与 route-state 交叉成一张表。
//
// 用法：
//
//	node scripts/route-blank-stats.mjs                 # 用默认 configDir（%LOCALAPPDATA%\magpie）
//	node scripts/route-blank-stats.mjs "D:/some/dir"   # 指定 configDir
//
// ⚠ 只读：不写任何文件、不带 `routecheck` 反向配置、不提交 git。

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

import { makeModelsHook, resetCatalogInflight, resetModelsWarned } from "../src/hooks/models.mjs"
import { readCachedModels } from "../src/models-cache.mjs"
import { readRouteState } from "../src/route-store.mjs"

const PROVIDER = "loomy"

/** 找到 magpie 的 configDir（`input.directory`）。 */
function resolveConfigDir(argv) {
  const given = String(argv[2] ?? "").trim()
  if (given) return given
  const env = String(process.env.MAGPIE_CONFIG_DIR ?? "").trim()
  if (env) return env
  const cands = [
    join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "magpie"),
    join(homedir(), ".config", "magpie"),
  ]
  for (const c of cands) if (existsSync(join(c, "plugin-providers.json"))) return c
  return cands[0]
}

const configDir = resolveConfigDir(process.argv)
const providersFile = join(configDir, "plugin-providers.json")
const authFile = join(configDir, "plugin-auth.json")

if (!existsSync(providersFile)) {
  console.error(`找不到 ${providersFile}`)
  process.exit(2)
}

const providers = JSON.parse(readFileSync(providersFile, "utf8"))
const entry = (Array.isArray(providers) ? providers : Object.values(providers)).find((p) => String(p?.id) === PROVIDER)
if (!entry) {
  console.error(`plugin-providers.json 里没有 ${PROVIDER}`)
  process.exit(2)
}

/** 账号列表（宿主的形状：`{key, type, accountId, models?}`）。 */
const accounts = Array.isArray(entry.accounts) ? entry.accounts : []
/** 真凭证（含 uid / accountId / access）—— 判定按这几个键查。 */
const auths = existsSync(authFile) ? readAuths(JSON.parse(readFileSync(authFile, "utf8"))) : []

const routeState = readRouteState(configDir)
const verdictOf = (auth) => {
  if (!routeState.ok) return { verdict: "(state-unreadable)", key: "", servedModel: "", reason: "" }
  for (const key of [auth.uid, auth.accountId, auth.metadata?.uid]) {
    const k = String(key ?? "").trim()
    if (!k) continue
    const v = routeState.data[k]
    if (v && typeof v === "object") return { verdict: String(v.verdict ?? "?"), key: k, servedModel: v.servedModel ?? "", reason: v.reason ?? "" }
  }
  return { verdict: "(no-entry)", key: "", servedModel: "", reason: "" }
}

// ── 每个账号走一次真的 provider.models（上游 = 文件缓存，零请求）────────
const baseUrl = "https://loomyad.xunfei.cn/api/v1"
const cached = readCachedModels(configDir, baseUrl)
if (!cached) console.warn(`⚠ 没有模型缓存（${baseUrl}）：冷启动分支会走静态表`)

/**
 * 一个不发请求的「上游」：它只证明「如果代码去打上游，这里能看出一次调用」。
 * 缓存命中时**永远不该被调用** —— 真被调了就是一条独立信号。
 */
const upstream = { calls: 0 }

const rows = []
/** 每个「结论」只留一条日志样例（真机日志会重复，这里只验它能对上）。 */
const logSamples = new Map()
for (const auth of auths) {
  resetCatalogInflight()
  resetModelsWarned()
  const hook = makeModelsHook({
    baseUrl,
    configDir,
    fetchImpl: async () => {
      upstream.calls += 1
      return Response.json({ code: "000000", data: cached ?? [] })
    },
    log: {
      warn: (m) => {
        const v = verdictOf(auth).verdict
        if (!logSamples.has(v)) logSamples.set(v, String(m))
      },
    },
  })
  const out = await hook({ models: {} }, { auth })
  rows.push({ auth, out, verdict: verdictOf(auth) })
}

// ── 交叉统计 ───────────────────────────────────────────────────────────
const hostModelsOf = new Map(accounts.map((a) => [String(a.accountId ?? ""), Object.keys(a.models ?? {}).length]))

/** @type {Record<string, {n: number, withModels: number}>} */
const table = {}
let available = 0
let routedWithModels = 0
for (const row of rows) {
  const v = row.verdict.verdict
  const n = Object.keys(row.out).length
  table[v] = table[v] ?? { n: 0, withModels: 0 }
  table[v].n += 1
  if (n > 0) {
    table[v].withModels += 1
    available += 1
  }
  if (v === "routed" && n > 0) routedWithModels += 1
}

console.log(`configDir            = ${configDir}`)
console.log(`账号数（plugin-auth） = ${rows.length}`)
console.log(`宿主记住的 models 数组非空 = ${[...hostModelsOf.values()].filter((n) => n > 0).length}`)
console.log(`缓存目录模型数        = ${cached?.length ?? 0}`)
console.log(`route-state           = ok:${routeState.ok} ${routeState.error || ""}`)
console.log(`models 输出字节（合计） = ${rows.reduce((s, r) => s + JSON.stringify(r.out).length, 0)}`)
console.log("")
for (const [verdict, c] of Object.entries(table).sort()) {
  console.log(`  ${verdict.padEnd(16)} 账号 ${String(c.n).padStart(3)}   models 非空 ${String(c.withModels).padStart(3)}`)
}
console.log("")
console.log(`可用账号数（models 非空） = ${available}`)
console.log(`routed 且 models 非空     = ${routedWithModels}`)
console.log(`本次统计中上游请求数     = ${upstream.calls}（缓存命中应为 0）`)

if (logSamples.size > 0) {
  console.log("")
  console.log("置空日志样例（每个结论一条）：")
  for (const [verdict, line] of [...logSamples.entries()].sort()) console.log(`  [${verdict}] ${line}`)
}

// ── 内部 ────────────────────────────────────────────────────────────────

/** 把 plugin-auth.json 摊成账号凭证数组（键是 `loomy` / `loomy#xxxx`）。 */
function readAuths(table) {
  const out = []
  for (const [key, value] of Object.entries(table ?? {})) {
    if (key !== PROVIDER && !key.startsWith(PROVIDER + "#")) continue
    if (!value || typeof value !== "object" || !value.access) continue
    out.push({
      type: String(value.type ?? "oauth"),
      access: String(value.access),
      accountId: String(value.accountId ?? ""),
      uid: String(value.uid ?? value.metadata?.uid ?? ""),
      metadata: value.metadata,
    })
  }
  return out
}