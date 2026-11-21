// rate-gate.test.mjs 进程级令牌桶：**防意外爆发**，不是替用户限速。
//
// # 用户的两句话，决定了这里每一条断言
//
//	「一定不可以这样。你想办法限制它。想办法把这个关掉，不要让它自动打。」
//	「并发你不需要限制，就是用户想在设置里面调多少就调多少，这个无所谓的。」
//
// 所以这个闸有两条**互相拉扯**的要求，本文件两边都要钉：
//
//	① 它必须真的能挡住「意外爆发」（否则等于没装）
//	② 它**不许**成为用户并发设置的上限（否则就是偷偷加了个上限）
//
// 具体到实现：容量 ≥ 用户能配出来的并发（默认 20，见 `RATE_GATE_CAPACITY`），
// 突发在容量内**立刻放行**；超出容量的才按 `refillMs` 排队。

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  makeRateGate,
  sharedRateGate,
  resetSharedRateGate,
  RATE_GATE_CAPACITY,
  RATE_GATE_REFILL_MS,
} from "../src/rate-gate.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("容量内的突发**立即**放行（不许排队 —— 那不是保护，是限速）", async () => {
  const gate = makeRateGate({ capacity: 6, refillMs: 60_000 })
  const t0 = Date.now()
  await Promise.all(Array.from({ length: 6 }, () => gate.acquire()))
  assert.ok(Date.now() - t0 < 50, `容量内 6 次 acquire 必须立刻完成，实际 ${Date.now() - t0}ms`)
  assert.equal(gate.waiting(), 0)
})

test("容量 2：第 3 次 acquire 会等待，`refillMs` 之后放行", async () => {
  const gate = makeRateGate({ capacity: 2, refillMs: 120 })
  await gate.acquire()
  await gate.acquire()
  // 前两个用完令牌，第三个必须排队
  assert.equal(gate.waiting(), 0, "还没人排队")
  let released = false
  const third = gate.acquire().then(() => {
    released = true
  })
  // 排队是**异步**的：当前这一拍还没进队列，等一个 tick
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(gate.waiting(), 1, `第三个应当在排队，实际 waiting=${gate.waiting()}`)
  assert.equal(released, false, "令牌还没补出来，不许放行")

  await sleep(260)
  await third
  assert.equal(released, true, "补桶之后必须放行")
  assert.equal(gate.waiting(), 0)
})

test("不泄漏：100 次 acquire 之后 waiting === 0（诊断字段不许永远漂着）", async () => {
  const gate = makeRateGate({ capacity: 3, refillMs: 5 })
  await Promise.all(Array.from({ length: 100 }, () => gate.acquire()))
  assert.equal(gate.waiting(), 0, `100 次 acquire 之后必须归零，实际 ${gate.waiting()}`)
})

test("默认容量 ≥ 20，且 ≥ 用户在设置里能配出来的并发（默认值不许卡住用户）", () => {
  assert.ok(RATE_GATE_CAPACITY >= 20, `默认容量必须 ≥ 20（面板默认并发量级），实际 ${RATE_GATE_CAPACITY}`)
  const gate = makeRateGate()
  assert.equal(gate.capacity(), RATE_GATE_CAPACITY)
  assert.equal(gate.refillMs(), RATE_GATE_REFILL_MS)
})

test("非法参数回落默认值（0 / 负数 / 小数都不许造出「无限令牌」或「永不补桶」）", () => {
  for (const capacity of [0, -1, 1.5, Number.NaN, undefined]) {
    assert.equal(makeRateGate({ capacity }).capacity(), RATE_GATE_CAPACITY, `capacity=${capacity}`)
  }
  for (const refillMs of [0, -5, Number.NaN, undefined]) {
    assert.equal(makeRateGate({ refillMs }).refillMs(), RATE_GATE_REFILL_MS, `refillMs=${refillMs}`)
  }
})

test("队列按 FIFO 放行（不许插队 —— 否则「最早点的那个」会一直饿着）", async () => {
  const gate = makeRateGate({ capacity: 1, refillMs: 40 })
  await gate.acquire()
  /** @type {number[]} */
  const order = []
  const waiting = [1, 2, 3].map((n) => gate.acquire().then(() => order.push(n)))
  await Promise.all(waiting)
  assert.deepEqual(order, [1, 2, 3], `必须按提交顺序放行，实际 ${order.join(",")}`)
})

test("sharedRateGate：容量变了就按新容量重建；没变则复用（保留已攒的令牌）", () => {
  resetSharedRateGate()
  const a = sharedRateGate({ capacity: 20 })
  const b = sharedRateGate({ capacity: 20 })
  assert.equal(a, b, "参数没变必须复用同一个桶")

  const c = sharedRateGate({ capacity: 40 })
  assert.notEqual(a, c, "容量变了必须换桶（否则新容量不生效）")
  assert.equal(c.capacity(), 40)
  resetSharedRateGate()
})