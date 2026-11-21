// reproduce-end.mjs —— 最小复现：`res.writeHead` + `res.end(Buffer)` 在 node / bun 下会不会截断。
//
// 用法：`node tests/helpers/reproduce-end.mjs` 或 `bun tests/helpers/reproduce-end.mjs`
//
// 结论要回答两件事：
//   ① res.end(Buffer(100KB)) 是否**完整**下发；
//   ② 不带 Content-Length 时是不是走了 chunked（浏览器/中间层可能按块读不全）。

import { createServer } from "node:http"
import { request } from "node:http"

const SIZE = 100 * 1024
const payload = Buffer.alloc(SIZE, 0x41)

/** 两种写法各起一个服务，各发一次，报告收到的字节数与是否 chunked。 */
async function probe(label, handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const got = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/x" }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve({ bytes: Buffer.concat(chunks).length, headers: res.headers }))
    })
    req.on("error", reject)
    req.end()
  })
  await new Promise((resolve) => server.close(resolve))
  console.log(`${label}: sent=${SIZE} got=${got.bytes} cl=${got.headers["content-length"] ?? "(none)"} te=${got.headers["transfer-encoding"] ?? "(none)"} complete=${got.bytes === SIZE}`)
  return got.bytes
}

const a = await probe("res.end(Buffer) 无 Content-Length", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/javascript" })
  res.end(payload)
})
const b = await probe("res.end(Buffer) 有 Content-Length", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": String(payload.length) })
  res.end(payload)
})
const c = await probe("res.write(Buffer)+res.end() 有 Content-Length", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": String(payload.length) })
  res.write(payload.subarray(0, 16 * 1024))
  res.write(payload.subarray(16 * 1024))
  res.end()
})

console.log(`runtime=${typeof Bun !== "undefined" ? "bun " + Bun.version : "node " + process.version}`)
if (a !== SIZE || b !== SIZE || c !== SIZE) {
  console.log("RESULT: 截断！")
  process.exitCode = 1
} else {
  console.log("RESULT: 三条都完整下发（截断不在这层）")
}