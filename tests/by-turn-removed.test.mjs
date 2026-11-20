// by-turn-removed.test.mjs by-turn 这条链路**整段不存在**（T-38）。
//
// # 用户原话
//
//	「整个删掉就行了，byturn，每个响应体都会带呗，所以我们不要做多余的事情」
//
// 事实依据（真机实测，stream:true）：
//
//	data: {"object":"chat.completion.chunk","model":"deepseek-v4-flash-1017",…}
//	data: {"object":"chat.completion.chunk","model":"deepseek-v4-flash-1017",…}
//
// 每个 chunk 都自带真实模型名 ⇒ **不需要** `/points/by-turn` 查询，更不该为它
// 额外发一次计费 chat + 轮询账本。
//
// 本文件钉三件事：
//
//	1. 源码里没有对 by-turn 的**调用**（注释里可以留历史说明）
//	2. 一个真实对话请求只产生 **1 次** 上游请求（没有隐藏的第二次查询）
//	3. 模块/接口/参数字段全都不在了（导不出 = 调不到）

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { makeLoaderHook, resetCooldowns } from "../src/hooks/loader.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")

/** 递归收集 .mjs / .js 源码（不含测试与 node_modules）。 */
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (/\.(mjs|js)$/.test(name)) out.push(full)
  }
  return out
}

/** 去掉注释后剩下的「真代码」—— 注释里提到历史是允许的。 */
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
}

const SOURCES = [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "page"))]

// ── 1. 源码：by-turn 只剩注释里的历史 ─────────────────────────────────

test("源码里没有任何 by-turn 的**调用/导入**（注释可以留历史）", () => {
  /** @type {string[]} */
  const offenders = []
  for (const file of SOURCES) {
    const code = stripComments(readFileSync(file, "utf8"))
    // 代码中一旦出现这些标识符，就说明某条链路还活着
    for (const needle of ["by-turn", "byTurn", "probeByTurn", "fetchTurnResult", "classifyByTurn", "newTurnId", "BY_TURN_PATH"]) {
      if (code.includes(needle)) offenders.push(`${file.slice(ROOT.length)}: ${needle}`)
    }
  }
  assert.deepEqual(offenders, [], `这些位置还在引用 by-turn:\n${offenders.join("\n")}`)
})

test("`src/byturn.mjs` 已删除，导入它会失败", async () => {
  assert.equal(existsSync(join(ROOT, "src", "byturn.mjs")), false, "模块文件必须不存在")
  await assert.rejects(() => import("../src/byturn.mjs"), /Cannot find module|ERR_MODULE_NOT_FOUND/)
})

test("loader 不再导出 by-turn 时代的任何符号", async () => {
  const loader = await import("../src/hooks/loader.mjs")
  for (const name of ["verifyTurn", "noteServedModel", "BY_TURN_RETRIES", "BY_TURN_INTERVAL_MS"]) {
    assert.equal(loader[name], undefined, `不该再有 ${name}`)
  }
  // 替代它的那一组必须真的在
  for (const name of ["extractFirstModel", "watchFirstModel", "applyServedModel", "isStreamResponse"]) {
    assert.equal(typeof loader[name], "function", `缺少替代实现 ${name}`)
  }
})

test("面板里「免费巡检 / 巡检」相关接口与按钮都不在了", () => {
  const server = stripComments(readFileSync(join(ROOT, "server.mjs"), "utf8"))
  assert.ok(!server.includes("route-patrol"), "接口 /api/route-patrol-batch 必须不在")
  assert.ok(!server.includes("patrolAccount"), "不再依赖 patrol.mjs")
  const html = readFileSync(join(ROOT, "page", "index.html"), "utf8")
  assert.ok(!html.includes("route-patrol"), "面板按钮必须不在")
  assert.ok(!html.includes("setting-patrol-concurrency"), "巡检并发设置必须不在")
  const js = stripComments(readFileSync(join(ROOT, "page", "assets", "app.js"), "utf8"))
  assert.ok(!js.includes("route-patrol"), "前端不许再调巡检接口")
})

// ── 2. 一个对话请求 = 一次上游调用（没有隐藏的第二次查询）──────────────

test("真实对话请求只打 **1 次** 上游（不存在第二次 by-turn 查询）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loomy-onecall-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  resetCooldowns()

  /** @type {string[]} */
  const urls = []
  const enc = new TextEncoder()
  const hook = makeLoaderHook({
    configDir: dir,
    fetchImpl: async (url) => {
      urls.push(String(url))
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('data: {"model":"deepseek-v4-flash-1017","choices":[{"delta":{"content":"hi"}}]}\n\n'))
            c.enqueue(enc.encode("data: [DONE]\n\n"))
            c.close()
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    },
    recordTraffic: () => ({ ok: true, error: "" }),
    bodyMode: "passthrough",
    log: { warn() {} },
  })
  const loader = await hook(async () => ({ type: "oauth", access: "s".repeat(32), uid: "u-turn" }))

  const resp = await loader.fetch("https://loomyad.xunfei.cn/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4-flash-1017", stream: true, messages: [{ role: "user", content: "ping" }] }),
  })
  await resp.text()
  // 给旁路一个落盘窗口（它不许再发请求，只会写文件）
  await new Promise((r) => setTimeout(r, 80))

  assert.equal(urls.length, 1, `一个请求只该产生 1 次上游调用，实际: ${urls.join(" | ")}`)
  assert.ok(!urls.some((u) => u.includes("by-turn")), "不许有 by-turn 查询")
  assert.ok(!urls.some((u) => u.includes("/points/")), "对话路径不许顺带查账本/积分")
})