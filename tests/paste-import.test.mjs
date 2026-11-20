// paste-import.test.mjs 「登录弹窗里的第 4 个按钮」：从粘贴的文本导入账号。
//
// # 为什么这些断言长这样（都是宿主源码里读出来的，不是猜）
//
//	host-acc034d984c6.js:2822  oauth 方法的 authorize **必须**返回带 callback 的对象
//	host-acc034d984c6.js:2853  callback() 的返回再经 keptAs → save 落盘
//	host-acc034d984c6.js:1346-1370  client.auth.set({path:{id}, body}) 是插件写账号的正规通道
//	host-acc034d984c6.js:2758-2763  save() 写的 body 是 {type:"oauth", refresh, access, expires, ...extra}
//
// 所以：`authorize()` 立刻返回 → `callback()` 给第 1 条 → 其余各条自己
// `client.auth.set`。测试用一个假 client 记录写入，绝不碰真的 plugin-auth.json。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LoomyAuthPlugin } from "../index.mjs"
import { makePasteImportMethod, PASTE_LABEL, authBodyOf, nextAccountKey } from "../src/paste-import.mjs"

/** 32 位小写 hex（上游实测形态）。 */
const S = (c) => c.repeat(32)

function tempDir() {
  return mkdtempSync(join(tmpdir(), "loomy-paste-"))
}

/** 假宿主 client：只记 `auth.set` 的调用，绝不写盘。 */
function fakeClient() {
  /** @type {Array<{key: string, body: any}>} */
  const writes = []
  /** @type {any[]} */
  const toasts = []
  const client = {
    auth: {
      set: async ({ path, body }) => {
        writes.push({ key: path.id, body })
      },
    },
    tui: { showToast: (o) => toasts.push(o) },
  }
  return { writes, toasts, client }
}

const quiet = { warn() {} }

test("登录弹窗的第 4 个按钮存在：从文件导入（粘贴 JSON / NDJSON）", async () => {
  const p = await LoomyAuthPlugin({}, {})
  const method = p.auth.methods.find((m) => String(m.label).includes("从文件导入"))
  assert.ok(method, "auth.methods 里必须有「从文件导入」这一项")
  assert.equal(method.label, PASTE_LABEL)
  // ⚠ 不是 api：type:"api" 的凭证 magpie 不调 auth.usage，账号卡会显示「未登录」
  assert.equal(method.type, "oauth", "必须是 oauth + access 形态")
  assert.equal(method.labels.en, "import from text (JSON / NDJSON)")
  assert.equal(method.prompts.length, 1)
  assert.equal(method.prompts[0].type, "text")
  assert.equal(method.prompts[0].key, "text")
  assert.match(method.prompts[0].message, /账号内容/)
  assert.equal(typeof method.authorize, "function")
})

test("粘贴单个账号 JSON：callback 返回 success，账号按宿主 save 的形状写进去", async () => {
  const dir = tempDir()
  const { writes, client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const started = await method.authorize({ text: JSON.stringify({ phone: "13800000000", session: S("a") }) })
  // host.js:2822 —— 没有 callback 会被判「gave nothing to finish it with」
  assert.equal(typeof started.callback, "function", "oauth 方法必须给 callback")
  assert.equal(started.opened, true, "插件自己完成，不让宿主开页面")

  const r = await started.callback()
  assert.equal(r.type, "success")
  assert.equal(r.access, S("a"))
  assert.equal(r.refresh, "", "本上游没有 refresh token")
  assert.equal(r.expires, 0, "0 = 不会过期、不要续期")

  assert.equal(writes.length, 1)
  assert.match(writes[0].key, /^loomy#[0-9a-z]*$/)
  assert.deepEqual(writes[0].body, authBodyOf(r), "写盘 body 必须与宿主 save() 同构")
  assert.equal(writes[0].body.type, "oauth")
  assert.equal(writes[0].body.key, undefined, "oauth 形态不能带 key")
})

test("粘贴 NDJSON 两行：两条都导入（第 1 条给宿主，第 2 条自己写）", async () => {
  const dir = tempDir()
  const { writes, client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const text = [JSON.stringify({ session: S("b") }), JSON.stringify({ session: S("c") })].join("\n")
  const started = await method.authorize({ text })
  const r = await started.callback()

  assert.equal(r.type, "success")
  assert.equal(r.access, S("b"), "第 1 条交宿主保存")
  assert.equal(writes.length, 2)
  assert.deepEqual(writes.map((w) => w.body.access), [S("b"), S("c")])
  assert.notEqual(writes[0].key, writes[1].key, "两个号不能抢同一个账号键")
})

test("坏行只失败那一行：好行照样导入，提示里带「第 2 条」", async () => {
  const dir = tempDir()
  const { writes, toasts, client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const text = `${JSON.stringify({ session: S("d") })}\n{ 这一行不是 JSON`
  const started = await method.authorize({ text })
  const r = await started.callback()

  assert.equal(r.type, "success", "好行必须导入，不能被坏行连坐")
  assert.equal(writes.length, 1)
  const said = toasts.at(-1)?.message ?? ""
  assert.match(said, /第 2 条：这一行不是合法的 JSON/)
  assert.match(said, /跳过 1 条/)
})

test("已经在 magpie 里的账号不重复导入（去重读 plugin-auth.json）", async () => {
  const dir = tempDir()
  writeFileSync(
    join(dir, "plugin-auth.json"),
    JSON.stringify({ loomy: { type: "oauth", access: S("e"), refresh: "" } }),
  )
  const { writes, client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const started = await method.authorize({ text: JSON.stringify({ session: S("e") }) })
  const r = await started.callback()

  assert.equal(r.type, "failed")
  assert.match(r.error, /都已经在 magpie 里/)
  assert.equal(writes.length, 0)
})

test("单次上限 100 条：超出的明说，不静默丢", async () => {
  const dir = tempDir()
  const { writes, toasts, client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const items = Array.from({ length: 101 }, (_, i) => ({ session: i.toString(16).padStart(32, "0") }))
  const started = await method.authorize({ text: JSON.stringify(items) })
  const r = await started.callback()

  assert.equal(r.type, "success")
  assert.equal(writes.length, 100, "宿主单次只收 100 条")
  assert.match(toasts.at(-1)?.message ?? "", /超出 magpie 单次 100 条上限/)
})

test("空输入 / 认不出的内容返回 failed 而不是抛异常", async () => {
  const dir = tempDir()
  const { client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const empty = await method.authorize({ text: "   " })
  assert.equal(empty.type, "failed")
  assert.match(empty.error, /请粘贴/)

  const started = await method.authorize({ text: "hello world" })
  const r = await started.callback()
  assert.equal(r.type, "failed")
  assert.ok(r.error)
})

test("nextAccountKey 避开已被占用的键", () => {
  const taken = new Set(["loomy#abc123"])
  const key = nextAccountKey("loomy", taken)
  assert.match(key, /^loomy#/)
  assert.notEqual(key, "loomy#abc123")
  assert.equal(taken.has(key), true, "分配过的键要记进 taken，同批次不再复用")
})
