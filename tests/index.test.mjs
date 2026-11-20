import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import { LoomyAuthPlugin, _internal } from "../index.mjs"
import { PROVIDER, DEFAULT_BASE_URL } from "../src/constants.mjs"

test("入口导出五个钩子，形状正确", async () => {
  const p = await LoomyAuthPlugin({}, {})
  assert.equal(typeof p.config, "function")
  assert.equal(typeof p.auth.loader, "function")
  assert.equal(typeof p.auth.usage, "function")
  assert.equal(typeof p.provider.models, "function")
  assert.ok(Array.isArray(p.auth.methods))
})

test("供应商、插件与面板内嵌相同的 LOOMY 官方 PNG 图标", async () => {
  const { default: manifest } = await import("../package.json", { with: { type: "json" } })
  const p = await LoomyAuthPlugin({}, {})
  assert.equal(p.auth.icon, manifest.magpie.icon)
  assert.match(p.auth.icon, /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
  const png = Buffer.from(p.auth.icon.slice("data:image/png;base64,".length), "base64")
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(png.readUInt32BE(8), 13)
  assert.equal(png.toString("ascii", 12, 16), "IHDR")
  assert.equal(png.readUInt32BE(16), 128)
  assert.equal(png.readUInt32BE(20), 128)
  assert.equal(createHash("sha256").update(png).digest("hex"), "18a0633d1537ed9497a55477b416bfb823405324667143b157a3ae9d2d8ac864")
  const html = await readFile(new URL("../page/index.html", import.meta.url), "utf8")
  const brand = html.match(/<img\b[^>]*class="brand-mark"[^>]*>/)?.[0]
  assert.ok(brand, "面板品牌标识必须使用图片")
  assert.equal(brand.match(/\bsrc="([^"]+)"/)?.[1], manifest.magpie.icon)
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) < 1024 * 1024)
})

test("provider id 是 loomy", async () => {
  const p = await LoomyAuthPlugin({}, {})
  assert.equal(p.provider.id, PROVIDER)
  assert.equal(p.auth.provider, PROVIDER)
})

test("刻意不导出 refresh / checkin（造空壳会让宿主误判可自动恢复）", async () => {
  const p = await LoomyAuthPlugin({}, {})
  assert.equal(p.auth.refresh, undefined)
  assert.equal(p.auth.checkin, undefined)
})

test("四种登录方式都在（第 4 个是登录弹窗里的「从文件导入」）", async () => {
  const p = await LoomyAuthPlugin({}, {})
  assert.equal(p.auth.methods.length, 4)
  const labels = p.auth.methods.map((m) => m.label)
  assert.ok(labels.some((l) => l.includes("桌面端")))
  assert.ok(labels.some((l) => l.includes("手机号")))
  assert.ok(labels.some((l) => l.includes("粘贴")))
  assert.ok(labels.some((l) => l.includes("从文件导入")))
})

test("_internal 不导出额外的 Plugin 函数（会被当成插件调用）", () => {
  for (const [k, v] of Object.entries(_internal)) {
    if (typeof v === "function" && k.endsWith("Plugin")) {
      assert.fail(`_internal 里不该有 ${k}`)
    }
  }
})

test("config 声明 provider 与未登录时的模型表", async () => {
  const p = await LoomyAuthPlugin({}, {})
  const cfg = {}
  await p.config(cfg)
  const entry = cfg.provider[PROVIDER]
  assert.ok(entry)
  assert.equal(entry.npm, "@ai-sdk/openai-compatible")
  assert.equal(entry.api, DEFAULT_BASE_URL)
  assert.ok(Object.keys(entry.models).length > 0, "未登录时也必须有模型，否则显示 0 models")
})

test("config 不覆盖用户已配置的 provider 条目", async () => {
  const p = await LoomyAuthPlugin({}, {})
  const cfg = { provider: { [PROVIDER]: { name: "我自己起的名字", models: {} } } }
  await p.config(cfg)
  assert.equal(cfg.provider[PROVIDER].name, "我自己起的名字")
})

test("config 的模型条目显式声明 text-only（漏了会被当成能收图）", async () => {
  const p = await LoomyAuthPlugin({}, {})
  const cfg = {}
  await p.config(cfg)
  const models = cfg.provider[PROVIDER].models
  const chat = models["spark-x2.6"]
  assert.equal(chat.attachment, false)
  assert.deepEqual(chat.modalities, { input: ["text"], output: ["text"] })
  assert.equal(chat.tool_call, true)
})

test("config 里生图模型声明 output: image", async () => {
  const p = await LoomyAuthPlugin({}, {})
  const cfg = {}
  await p.config(cfg)
  const models = cfg.provider[PROVIDER].models
  assert.deepEqual(models["doubao-seedream-5-lite"].modalities.output, ["image"])
})

test("options.baseUrl 可以覆盖上游基址", async () => {
  const p = await LoomyAuthPlugin({}, { baseUrl: "https://alt.invalid/api/v1" })
  const cfg = {}
  await p.config(cfg)
  assert.equal(cfg.provider[PROVIDER].api, "https://alt.invalid/api/v1")
})

test("loader 未登录时返回空对象（不炸）", async () => {
  const p = await LoomyAuthPlugin({}, {})
  const loader = await p.auth.loader(async () => undefined)
  assert.deepEqual(loader, {})
})

test("loader 已登录时给 apiKey = session", async () => {
  const p = await LoomyAuthPlugin({}, {})
  const loader = await p.auth.loader(async () => ({ type: "api", access: "a".repeat(32) }))
  assert.equal(loader.apiKey, "a".repeat(32))
  assert.equal(typeof loader.fetch, "function")
})
