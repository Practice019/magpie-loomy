import { test } from "node:test"
import assert from "node:assert/strict"

import { makeMethods } from "../src/hooks/methods.mjs"

const SESSION = "a".repeat(32)

/** 一个永远成功的假上游：/models 有货、发码有 msgid、points 有账本、首登 200。 */
function okUpstream() {
  return async (url) => {
    const u = String(url)
    if (u.includes("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "spark-x2.6" }] }), { status: 200 })
    }
    if (u.includes("/login/phone/sendMsgCode")) {
      return new Response(JSON.stringify({ code: "000000", desc: "ok", data: { msgid: "m-1" } }), { status: 200 })
    }
    if (u.includes("/login/phone/checkCode")) {
      return new Response(
        JSON.stringify({ code: "000000", desc: "ok", data: { session: SESSION, userid: "u1", phone: "138****0000" } }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ code: "000000", data: {} }), { status: 200 })
  }
}

test("三种登录方式的标签都带中文", () => {
  const m = makeMethods({ fetchImpl: okUpstream() })
  assert.equal(m.length, 3)
  for (const x of m) assert.ok(/[\u4e00-\u9fa5]/.test(x.label), `${x.label} 应有中文`)
})

test("粘贴 session：成功时返回 oauth + access（不是 api + key）", async () => {
  const m = makeMethods({ fetchImpl: okUpstream() })
  const paste = m.find((x) => x.label.includes("粘贴"))
  const r = await paste.authorize({ session: SESSION })
  assert.equal(r.type, "success")

  // ⚠ 这条是实测钉死的：type=api 的凭证 magpie 不会调 auth.usage，
  //   账号卡显示「未登录」、额度区空白。必须是 oauth + access。
  assert.ok(r.access, "必须给 access（oauth 形态）")
  assert.equal(r.key, undefined, "不能给 key（api 形态会让额度失效）")
  assert.equal(r.expires, 0, "expires=0 表示不会过期、不要续期")
  assert.equal(r.refresh, "", "refresh 给空串（本上游没有 refresh token）")
})

test("粘贴 session：空输入返回 failed 而不是抛异常", async () => {
  const m = makeMethods({ fetchImpl: okUpstream() })
  const paste = m.find((x) => x.label.includes("粘贴"))
  const r = await paste.authorize({ session: "" })
  assert.equal(r.type, "failed")
  assert.ok(r.error)
})

test("粘贴 session：上游说登录失效时返回 failed", async () => {
  const bad = async (url) => {
    if (String(url).includes("/models")) {
      return new Response('{"code":"100002","desc":"缺少 token"}', { status: 200 })
    }
    return new Response("{}", { status: 200 })
  }
  const m = makeMethods({ fetchImpl: bad })
  const paste = m.find((x) => x.label.includes("粘贴"))
  const r = await paste.authorize({ session: SESSION })
  assert.equal(r.type, "failed")
  assert.match(r.error, /登录已失效|无效/)
})

test("粘贴 session：账号名优先手机号", async () => {
  const m = makeMethods({ fetchImpl: okUpstream() })
  const paste = m.find((x) => x.label.includes("粘贴"))
  const r = await paste.authorize({ session: SESSION, phone: "138****0000" })
  assert.equal(r.accountId, "138****0000")
})

test("本机导入：没有客户端目录时返回 failed 并说清怎么办", async () => {
  const m = makeMethods({ fetchImpl: okUpstream(), clientStoreDir: "" })
  const local = m[0]
  const r = await local.authorize()
  assert.equal(r.type, "failed")
  assert.match(r.error, /客户端|手机号|粘贴/)
})

test("本机导入：authorize 立刻返回，不在里面发请求", async () => {
  let called = 0
  const counting = async (url) => {
    called += 1
    return new Response("{}", { status: 200 })
  }
  const m = makeMethods({ fetchImpl: counting, clientStoreDir: "" })
  await m[0].authorize()
  assert.equal(called, 0, "authorize 里不能有网络请求（会死锁）")
})

test("手机号：ask 先问手机号，再问验证码", async () => {
  const m = makeMethods({ fetchImpl: okUpstream() })
  const sms = m.find((x) => x.label.includes("手机号"))

  const q1 = await sms.ask({})
  assert.equal(q1.key, "phone")

  const q2 = await sms.ask({ phone: "13800000000" })
  assert.equal(q2.key, "code")
  assert.equal(q2.type, "password")

  const q3 = await sms.ask({ phone: "13800000000", code: "123456" })
  assert.equal(q3, null, "问完了要返回 null")
})

test("手机号：ask 保留 get prompts（否则列表里像什么都不问）", () => {
  const m = makeMethods({ fetchImpl: okUpstream() })
  const sms = m.find((x) => x.label.includes("手机号"))
  assert.ok(Array.isArray(sms.prompts))
  assert.equal(sms.prompts[0].key, "phone")
})

test("手机号：手机号形态不对时返回 failed", async () => {
  const m = makeMethods({ fetchImpl: okUpstream() })
  const sms = m.find((x) => x.label.includes("手机号"))
  const r = await sms.authorize({ phone: "123", code: "1" })
  assert.equal(r.type, "failed")
})

test("手机号：完整流程（ask 拿到 msgid → authorize 换到 session）", async () => {
  const m = makeMethods({ fetchImpl: okUpstream() })
  const sms = m.find((x) => x.label.includes("手机号"))

  // 走一遍 ask 把 msgid 存进 pending
  await sms.ask({})
  await sms.ask({ phone: "13800000000" })

  const r = await sms.authorize({ phone: "13800000000", code: "123456" })
  assert.equal(r.type, "success")
  assert.ok(r.access)
  assert.equal(r.expires, 0)
})

test("手机号：没走 ask 就拿不到 msgid，如实说会话过期", async () => {
  // 用另一个 phone 绕开上一条留下的 pending（pending 按 state 索引，
  // 这里 state 是空串，上一条已 delete，所以是干净的）
  const m = makeMethods({ fetchImpl: okUpstream() })
  const sms = m.find((x) => x.label.includes("手机号"))
  const r = await sms.authorize({ phone: "13900000000", code: "123456" })
  assert.equal(r.type, "failed")
  assert.match(r.error, /过期|msgid/)
})
