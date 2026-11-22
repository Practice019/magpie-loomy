// panel-settings.test.mjs —— 设置「改了不生效 / 不落盘 / 下次启动回默认」的回归集（T-49 / P2）。
//
// # 这一集在钉什么
//
//   · 每个设置字段都走同一套三段证据：POST 改值 → **读文件**确认落盘 → **GET 回读**确认回显
//   · 非法值 400 且文件一个字节都不动（不许「先写坏再回滚」）
//   · 未知字段被忽略，但绝不写进文件（不污染 `loomy-panel-settings.json`）
//   · 前端 `syncSettingsFields()` 必须覆盖 index.html 里**全部** `setting-*` 控件
//
// ⚠ 两个文件的历史分工（不是 bug，但必须钉住，否则「改了不生效」永远查不清）：
//   `accountConcurrency` / `bindConcurrency` → `loomy-panel-state.json` 的 `settings`
//   其余全部字段 → `loomy-panel-settings.json`
//
// ⚠ 本集一个字都不打上游：`fetchImpl` 只在 startServer 里占位，不触发任何真实调用。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "node:http"

import { startServer } from "../server.mjs"

const PANEL_FILE = "loomy-panel-settings.json"
const STATE_FILE = "loomy-panel-state.json"

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-settings-test-"))
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://mock.invalid/api/v1",
    log: { warn() {} },
    fetchImpl: async () => {
      throw new Error("设置用例不得发上游请求")
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
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body))
  })
  const readJson = (name) => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null
  return { dir, call, readJson }
}

/** 面板设置文件的完整期望键（与 server.mjs 的 PANEL_SETTINGS_DEFAULTS 同形状）。 */
const PANEL_KEYS = [
  "routeConcurrency", "batchConcurrency", "balanceConcurrency", "tasksConcurrency", "inviteConcurrency",
  "gapMs", "autoApply", "magpiePath", "batchSkipChecked", "ledgerReads", "focusRefresh", "speedSkip",
]

/**
 * 控件 id → 服务端字段名 → 落在哪个文件。
 * 这张表就是验收报告里的「控件 / 白名单 / 文件」三方对照，测试与报告共用一份。
 */
const FIELDS = [
  { id: "#setting-batch-concurrency", key: "batchConcurrency", file: "panel", value: 9 },
  { id: "#setting-balance-concurrency", key: "balanceConcurrency", file: "panel", value: 11 },
  { id: "#setting-tasks-concurrency", key: "tasksConcurrency", file: "panel", value: 13 },
  { id: "#setting-invite-concurrency", key: "inviteConcurrency", file: "panel", value: 15 },
  { id: "#setting-gap-ms", key: "gapMs", file: "panel", value: 0 },
  { id: "#setting-auto-apply", key: "autoApply", file: "panel", value: false },
  { id: "#setting-magpie-path", key: "magpiePath", file: "panel", value: "C:\\tools\\magpie.exe" },
  { id: "#setting-batch-skip", key: "batchSkipChecked", file: "panel", value: false },
  { id: "#setting-ledger-reads", key: "ledgerReads", file: "panel", value: 5 },
  { id: "#setting-focus-refresh", key: "focusRefresh", file: "panel", value: true },
  { id: "#setting-speed-skip", key: "speedSkip", file: "panel", value: false },
  { id: "#setting-account-concurrency", key: "accountConcurrency", file: "state", value: 33 },
  { id: "#bind-conc", key: "bindConcurrency", file: "state", value: 44 },
]

test("每个设置字段：POST → 读文件 → GET 回读，三段都必须对上", async (t) => {
  const f = await fixture(t)
  for (const field of FIELDS) {
    const posted = await f.call("POST", "/api/settings", { [field.key]: field.value })
    assert.equal(posted.status, 200, `${field.key} 应能保存：${posted.text}`)

    const panel = f.readJson(PANEL_FILE)
    const state = f.readJson(STATE_FILE)
    const onDisk = field.file === "panel" ? panel?.[field.key] : state?.settings?.[field.key]
    assert.deepEqual(onDisk, field.value, `${field.key} 必须落盘到 ${field.file === "panel" ? PANEL_FILE : STATE_FILE}`)

    const echoed = await f.call("GET", "/api/settings")
    assert.equal(echoed.status, 200)
    assert.deepEqual(echoed.body.settings[field.key], field.value, `${field.key} 必须能从 GET 回读`)
  }
})

test("别名双写：batchConcurrency 与 routeConcurrency 永远一致，且面板文件只含白名单键", async (t) => {
  const f = await fixture(t)
  assert.equal((await f.call("POST", "/api/settings", { batchConcurrency: 9 })).status, 200)
  let panel = f.readJson(PANEL_FILE)
  assert.equal(panel.batchConcurrency, 9)
  assert.equal(panel.routeConcurrency, 9, "写老键必须同时写新键")

  assert.equal((await f.call("POST", "/api/settings", { routeConcurrency: 4 })).status, 200)
  panel = f.readJson(PANEL_FILE)
  assert.equal(panel.routeConcurrency, 4)
  assert.equal(panel.batchConcurrency, 4, "反向也必须双写，否则两边会漂")

  assert.deepEqual(Object.keys(panel).sort(), [...PANEL_KEYS].sort(), "面板文件只允许出现白名单键")
})

test("非法值 400 且文件一个字节都不动；未知字段被忽略但绝不写进文件", async (t) => {
  const f = await fixture(t)
  assert.equal((await f.call("POST", "/api/settings", { tasksConcurrency: 20 })).status, 200)
  const before = readFileSync(join(f.dir, PANEL_FILE), "utf8")
  for (const body of [
    { tasksConcurrency: 0 },
    { inviteConcurrency: 1.5 },
    { gapMs: 9999 },
    { gapMs: -1 },
    { autoApply: "true" },
    { magpiePath: 123 },
    { ledgerReads: 6 },
    { focusRefresh: "true" },
    { accountConcurrency: 0 },
  ]) {
    assert.equal((await f.call("POST", "/api/settings", body)).status, 400, JSON.stringify(body))
    assert.equal(readFileSync(join(f.dir, PANEL_FILE), "utf8"), before, `${JSON.stringify(body)} 不得写盘`)
  }

  // 全是未知键 → 400（拼错键名不能静默成功）；夹带未知键但有合法键 → 200 且只写合法键
  assert.equal((await f.call("POST", "/api/settings", { patrolConcurrency: 3 })).status, 400)
  const mixed = await f.call("POST", "/api/settings", { tasksConcurrency: 21, patrolConcurrency: 3, other: "x" })
  assert.equal(mixed.status, 200, "未知字段应被忽略，不该把整次保存打回")
  const panel = f.readJson(PANEL_FILE)
  assert.equal(panel.tasksConcurrency, 21)
  assert.equal("patrolConcurrency" in panel, false, "未知字段不得污染文件")
  assert.equal("other" in panel, false, "未知字段不得污染文件")
  assert.equal((await f.call("GET", "/api/settings")).body.settings.tasksConcurrency, 21)
})

test("前端 syncSettingsFields() 覆盖 index.html 里全部 setting-* 控件", () => {
  const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")
  const js = readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")
  const ids = [...new Set([...html.matchAll(/id="(setting-[a-z-]+)"/g)].map((m) => m[1]))].sort()
  assert.ok(ids.length >= 11, `设置控件不该这么少：${ids.join(",")}`)

  const start = js.indexOf("function syncSettingsFields(")
  assert.ok(start > 0, "找不到 syncSettingsFields")
  const open = js.indexOf("{", start)
  let depth = 0
  let end = -1
  for (let i = open; i < js.length; i++) {
    if (js[i] === "{") depth += 1
    else if (js[i] === "}") {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  assert.ok(end > 0, "syncSettingsFields 花括号不配平")
  const body = js.slice(open, end)

  const missing = ids.filter((id) => !body.includes(`#${id}`))
  assert.deepEqual(missing, [], `这些控件没有被回填（改了不生效 / 下次启动回默认）：${missing.join(", ")}`)

  // 状态对象里必须有同名键，否则回填只能读到 undefined
  for (const field of FIELDS) {
    assert.match(js, new RegExp(`${field.key}:`), `state.panel 缺少 ${field.key}`)
  }
})

// ── 五、「账本采样次数」真的生效（以前是存了却从没传给探测的摆设） ─────

async function routeFixture(t, probes) {
  const dir = mkdtempSync(join(tmpdir(), "loomy-settings-route-"))
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({
    loomy: { access: "a".repeat(32), metadata: { uid: "u0", nickname: "甲号", phone: "138****0000" } },
  }))
  const server = await startServer({
    port: 0,
    configDir: dir,
    clientStoreDir: "",
    baseUrl: "https://mock.invalid/api/v1",
    log: { warn() {} },
    fetchImpl: async () => { throw new Error("设置用例不得发上游请求") },
    routeModules: {
      probeRoute: async (opts) => {
        probes.push(opts.ledgerReads)
        return { verdict: "clean", servedModel: "DeepSeek-V4.1-Flash", checkedAt: 1 }
      },
      readRouteState: () => ({ ok: true, data: {} }),
      writeRouteState: () => ({ ok: true }),
      getAccountRoute: () => null,
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
  return { call }
}

test("ledgerReads 真正传给 probeRoute：默认 3，改成 5 后下一次探测就是 5", async (t) => {
  const probes = []
  const f = await routeFixture(t, probes)
  assert.equal((await f.call("POST", "/api/route-check", { uid: "u0" })).status, 200)
  assert.deepEqual(probes, [3], "未设置时用默认值 3")
  assert.equal((await f.call("POST", "/api/settings", { ledgerReads: 5 })).status, 200)
  await new Promise((r) => setTimeout(r, 10)) // 等 in-flight 合并释放
  assert.equal((await f.call("POST", "/api/route-check", { uid: "u0" })).status, 200)
  assert.deepEqual(probes, [3, 5], "改了设置必须生效（以前存了却从没传下去）")
})
