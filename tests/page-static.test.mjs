// page-static.test.mjs —— 「刷新全部（余额·任务·邀请）」按钮删除的静态证据（T-49 / P3）。
//
// 用户原话：「我们不需要这个按钮，这个按钮很危险，直接删掉」。
// 危险点：一次点击会把余额 / 任务 / 邀请三条队列**全量**打上游（184 个号）。
//
// 这里钉两件事：
//   ① HTML 里再也没有那个按钮（也没有 `refresh-all`）；
//   ② app.js 里没有对应监听器与 handler，但**独立**刷新入口一个都没少。

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")
const js = readFileSync(new URL("../page/assets/app.js", import.meta.url), "utf8")

test("index.html 不再有「刷新全部」按钮，独立刷新入口全部保留", () => {
  assert.doesNotMatch(html, /refresh-all/, "不得留下 refresh-all 等价物")
  assert.doesNotMatch(html, /id="refresh"/, "id=refresh 的按钮已删除")
  assert.doesNotMatch(html, /刷新全部/, "按钮文案已删除")
  for (const id of ["account-balance", "account-tasks", "invite-refresh", "route-refresh", "route-check-selected"]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} 是用户主动点的独立入口，不能跟着被删`)
  }
})

test("app.js 不再有该按钮的监听器与 handler", () => {
  assert.doesNotMatch(js, /#refresh\b/, "不得再出现 #refresh 选择器（#route-refresh / #invite-refresh 不算）")
  assert.doesNotMatch(js, /async function refresh\(/, "refresh() 这个全量入口已删除")
  assert.doesNotMatch(js, /addEventListener\("click", refresh\)/, "对应监听器已删除")
  for (const kind of ["balance", "tasks", "invite"]) {
    assert.match(js, new RegExp(`startJob\\("${kind}"`), `startJob("${kind}") 仍被独立按钮使用，不能删`)
  }
})
