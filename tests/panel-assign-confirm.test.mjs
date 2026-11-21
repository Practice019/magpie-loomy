// 「开始分配」的确认方式：必须是**两次点击**，不能用原生 `confirm()`。
//
// # 真机事故（2026-11-21）
//
// 点「开始分配」永远只得到一行日志：「已取消（计划 82 对）」。
// 原因：magpie 的面板页跑在 WebView 里，`typeof confirm === "function"` 成立，
// 但它**恒返回 false** —— 点了跟没点一样，于是每次都被当成「用户取消」。
//
// 所以判据不是「confirm 存在」，而是「确认这件事根本不该交给原生对话框」。

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const js = () => readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")

test("① 面板不再调用原生 confirm()（WebView 里恒 false）", () => {
  const src = js()
  // 去掉注释再断言：注释里允许提到 confirm()，但代码里不许出现
  const code = src.replace(/^\s*\/\/.*$/gm, "")
  assert.doesNotMatch(code, /\bconfirm\s*\(/, "代码里不许再调 confirm()，改用两次点击")
})

test("② 「开始分配」是两次点击确认，且第二次才真发绑定", () => {
  const src = js()
  assert.match(src, /ASSIGN_CONFIRM_MS\s*=\s*\d+/)
  assert.match(src, /assignState\.confirmAt\s*=\s*now/)
  // 第一次点击必须 return（不发起真实分配）
  const armed = src.match(/if \(!armedAt \|\| now - armedAt > ASSIGN_CONFIRM_MS\) \{[\s\S]*?return\s*\n\s*\}/)
  assert.ok(armed, "第一次点击必须在 arm 之后 return")
  assert.doesNotMatch(armed[0], /\/api\/invite\/assign", \{\}\)/, "arm 分支不许真发绑定")
})

test("③ 按钮在「已 arm」时改文案，过窗口自动还原", () => {
  const src = js()
  assert.match(src, /再点一次确认/)
  assert.match(src, /run\.textContent\s*=\s*live \?/)
})

test("④ 不再出现「已取消（计划 …」这种假取消日志", () => {
  const code = js().replace(/^\s*\/\/.*$/gm, "")
  assert.doesNotMatch(code, /已取消（计划/)
})
