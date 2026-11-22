// speed-route.test.mjs —— 速率的两条接口（T-62）。
//
// # 这一集在钉什么
//
//   · `POST /api/speed/refresh` 是**唯一**允许打 magpie 的地方：
//     打的是本机网关 `http://<gateway>/v1/magpie/usage/requests`（`provider=loomy`），
//     **不打上游 loomy 域名** —— 上游一次都不许碰（碰了就是耗积分 + 风控掉号）。
//   · 翻页：`rows=100`（实测分页上限就是 100，传 rows=500 也只回 100），
//     `offset` 递增，拿满 `total` 或到页数上限就停（不许无边界循环）。
//   · `GET /api/speed` **零请求**：只读 `<configDir>/loomy-speed-cache.json`。
//   · 网关地址读 `<configDir>/gateway.json` 的 `addr`（实测形态 `[::]:3425`），
//     缺文件 / 坏 JSON / 没 addr ⇒ 回落 `127.0.0.1:3425`。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer, SPEED_MAX_PAGES, SPEED_PAGE_ROWS } from "../server.mjs"
import { SPEED_CACHE_FILE, writeSpeedCache } from "../src/speed-cache.mjs"

const NOW = Date.now()

/** 造一行 usage/requests（形状来自实测）。 */
const usageRow = (over = {}) => ({
  route_id: 1,
  t: new Date(NOW - 60_000).toISOString(),
  provider: "loomy",
  providerAccount: "16540492083",
  model: "deepseek-v4-flash-1017",
  out: 200,
  flow_ms: 2000,
  ttft_ms: 1000,
  status: 200,
  ...over,
})

/**
 * 启动面板服务。
 *
 * `usage` 是 magpie 那一侧的假响应（**唯一**允许被这类用例命中的"网络"）。
 */
async function fixture(t, { usage, gateway } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-speed-route-"))
  if (gateway !== null) {
    writeFileSync(join(dir, "gateway.json"), JSON.stringify(gateway ?? { addr: "[::]:3425", pid: 1, serves: "app" }), "utf8")
  }
  /** @type {string[]} */
  const urls = []
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://loomyad.xunfei.cn/api/v1",
    log: { warn() {} },
    fetchImpl: async (url) => {
      urls.push(String(url))
      if (!usage) throw new Error(`本用例不该发网络请求：${url}`)
      const parsed = new URL(String(url))
      const offset = Number(parsed.searchParams.get("offset") ?? 0)
      const rows = usage.slice(offset, offset + 100)
      return new Response(JSON.stringify({ rows, offset, total: usage.length, period: "7d" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  t.after(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""
      res.on("data", (c) => { text += c })
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text), text }))
    })
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const cache = () => existsSync(join(dir, SPEED_CACHE_FILE)) ? JSON.parse(readFileSync(join(dir, SPEED_CACHE_FILE), "utf8")) : null
  return { dir, urls, call, cache }
}

test("GET /api/speed：零请求（注入的 fetch 计数器 === 0），只读缓存", async (t) => {
  const f = await fixture(t)
  const seeded = {
    updatedAt: NOW,
    b: { "deepseek-v4-flash-1017": 126.5 },
    accounts: {
      "deepseek-v4-flash-1017|16540492083": {
        model: "deepseek-v4-flash-1017", account: "16540492083",
        lastSpeed: 24, lastAt: NOW - 60_000, avgSpeed: 93.2, calls: 37, verdict: "slow",
      },
    },
  }
  assert.ok(writeSpeedCache(f.dir, seeded).ok)

  const res = await f.call("GET", "/api/speed")
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.updatedAt, NOW)
  assert.equal(res.body.b["deepseek-v4-flash-1017"], 126.5)
  assert.equal(res.body.accounts.length, 1)
  assert.equal(res.body.accounts[0].account, "16540492083")
  assert.equal(res.body.accounts[0].verdict, "slow")
  assert.equal(f.urls.length, 0, `GET /api/speed 必须零请求，实际打了 ${f.urls.join(",")}`)
})

test("GET /api/speed：没有缓存时返回空表（不报错、不触发刷新）", async (t) => {
  const f = await fixture(t)
  const res = await f.call("GET", "/api/speed")
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, updatedAt: 0, b: {}, accounts: [] })
  assert.equal(f.urls.length, 0)
})

test("POST /api/speed/refresh：只打本机 magpie 的 usage/requests（带 provider=loomy），绝不碰上游", async (t) => {
  const usage = [
    usageRow({ providerAccount: "a", out: 130, flow_ms: 1000 }),
    usageRow({ providerAccount: "b", out: 130, flow_ms: 1000 }),
    usageRow({ providerAccount: "c", out: 25, flow_ms: 1000 }),
  ]
  const f = await fixture(t, { usage })
  const res = await f.call("POST", "/api/speed/refresh", {})
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.rows, 3)
  assert.equal(res.body.models, 1)
  assert.equal(res.body.accounts, 3)
  assert.equal(res.body.b["deepseek-v4-flash-1017"], 130)
  assert.equal(res.body.slow, 1, "c 号 25 tok/s < 130×0.7 ⇒ 慢号")

  assert.ok(f.urls.length >= 1, "必须打一次 magpie")
  for (const url of f.urls) {
    assert.match(url, /\/v1\/magpie\/usage\/requests\?/, `只许打 magpie usage：${url}`)
    assert.match(url, /provider=loomy/, `必须带 provider=loomy：${url}`)
    assert.match(url, /period=7d/, `period 只支持 7d/30d：${url}`)
    assert.match(url, /rows=100/, `分页上限 100：${url}`)
    assert.doesNotMatch(url, /loomyad\.xunfei\.cn|account\.xfinfr\.com/, `绝不打上游：${url}`)
  }
  // `[::]:3425` 必须被归一成可连通的 127.0.0.1（IPv6 通配地址不能直接当 host）
  assert.match(f.urls[0], /^http:\/\/127\.0\.0\.1:3425\//, f.urls[0])

  // 落盘：算出来的表必须在缓存文件里（GET 之后只用它，不再算一次）
  const cached = f.cache()
  assert.equal(cached.b["deepseek-v4-flash-1017"], 130)
  const entry = cached.accounts["deepseek-v4-flash-1017|c"]
  assert.equal(entry.verdict, "slow")
  assert.equal(entry.lastSpeed, 25)
})

test("POST /api/speed/refresh：按 offset 翻页直到拿满 total（每页 100 行）", async (t) => {
  const usage = Array.from({ length: 150 }, (_, i) =>
    usageRow({ route_id: i, providerAccount: i % 2 ? "a" : "b", out: 200, flow_ms: 2000, t: new Date(NOW - (150 - i) * 1000).toISOString() }),
  )
  const f = await fixture(t, { usage })
  const res = await f.call("POST", "/api/speed/refresh", {})
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.rows, 150, "两页都要拿到")
  const offsets = f.urls.map((url) => new URL(url).searchParams.get("offset"))
  assert.deepEqual(offsets, ["0", "100"], `必须按 offset 翻页，实际 ${offsets.join(",")}`)
})

test("POST /api/speed/refresh：gateway.json 缺失 / 没有 addr ⇒ 回落 127.0.0.1:3425", async (t) => {
  const usage = [usageRow()]
  const f = await fixture(t, { usage, gateway: null })
  const res = await f.call("POST", "/api/speed/refresh", {})
  assert.equal(res.status, 200, res.text)
  assert.match(f.urls[0], /^http:\/\/127\.0\.0\.1:3425\/v1\/magpie\/usage\/requests\?/)
})

// ── 页数上限（7d 全量 ≈1436 条，上限必须能覆盖） ────────────────────────

test("SPEED_MAX_PAGES = 20：total=1500 的窗口要翻 15 页、拿满 1500 条（不被旧上限 10 页截断）", async (t) => {
  assert.equal(SPEED_MAX_PAGES, 20, "上限必须覆盖 7d 全量（实测 total≈1436），留一倍余量")
  const usage = Array.from({ length: 1500 }, (_, i) =>
    usageRow({ route_id: i, providerAccount: i % 2 ? "a" : "b", out: 200, flow_ms: 2000, t: new Date(NOW - (1500 - i) * 1000).toISOString() }),
  )
  const f = await fixture(t, { usage })
  const res = await f.call("POST", "/api/speed/refresh", {})
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.rows, 1500, "全量都要拿到")
  assert.equal(res.body.total, 1500)
  assert.equal(res.body.truncated, false, "拿够了就不许报截断")
  const offsets = f.urls.map((url) => Number(new URL(url).searchParams.get("offset")))
  assert.deepEqual(
    offsets,
    Array.from({ length: 15 }, (_, i) => i * SPEED_PAGE_ROWS),
    `必须翻 15 页（offset 0…1400），实际 ${offsets.join(",")}`,
  )
})

test("truncated：total=3000 超过 20 页上限 ⇒ truncated=true，只取到 2000 条", async (t) => {
  const usage = Array.from({ length: 3000 }, (_, i) =>
    usageRow({ route_id: i, providerAccount: i % 2 ? "a" : "b", out: 200, flow_ms: 2000, t: new Date(NOW - (3000 - i) * 1000).toISOString() }),
  )
  const f = await fixture(t, { usage })
  const res = await f.call("POST", "/api/speed/refresh", {})
  assert.equal(res.status, 200, res.text)
  assert.equal(res.body.truncated, true, "rows < total 必须显式告诉面板（静默少算 = 慢号照旧接活）")
  assert.equal(res.body.rows, 2000, "上限 20 页 × 100 = 2000 条")
  assert.equal(res.body.total, 3000)
  assert.equal(f.urls.length, 20, `恰好翻到上限 20 页，实际 ${f.urls.length}`)
  // 截断也要落盘：已经算出来的那 2000 条仍然是有效结论（每行 out=200/flow_ms=2000 ⇒ 100 tok/s）
  const cached = f.cache()
  assert.equal(cached.b["deepseek-v4-flash-1017"], 100, "截断不影响已拿到的样本的结论")
})

test("POST /api/speed/refresh：magpie 报错时如实报错且**不写坏缓存**", async (t) => {
  const f = await fixture(t)
  // 没有 usage ⇒ fetchImpl 抛错
  const res = await f.call("POST", "/api/speed/refresh", {})
  assert.equal(res.status, 502)
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /usage/)
  assert.equal(f.cache(), null, "失败不许留下半份缓存（否则面板会显示一份算坏的表）")
})
