// verify-sendfile.mjs —— 用**当前代码树的 `startServer`** 直接验证静态资源下发是否完整。
//
// 用法：`node tests/helpers/verify-sendfile.mjs`
//
// 这条脚本不依赖任何测试框架，直接读真实文件、起真服务、比对字节数与 sha256，
// 用来在「改 sendFile 之前」先证明缺陷存在（或不存在）—— 不能凭报告的数字下手。
//
// 注意：`sendFile` 会把 HTML 里的 `http://127.0.0.1:4391/` 换成实际端口，
// 所以 HTML 的字节数会与磁盘**不同**（属预期）；JS/CSS 必须逐字节相同。

import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startServer } from "../../server.mjs"

const HERE = new URL("../../page/", import.meta.url)

function sha(buf) {
  return createHash("sha256").update(buf).digest("hex")
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end()
  })
}

const dir = mkdtempSync(join(tmpdir(), "loomy-sendfile-"))
const server = await startServer({
  port: 0,
  configDir: dir,
  clientStoreDir: "",
  log: { warn() {} },
  fetchImpl: async () => { throw new Error("静态资源验证不得发上游请求") },
})

const targets = [
  ["assets/app.js", join(HERE.pathname.slice(1), "assets", "app.js")],
  ["assets/style.css", join(HERE.pathname.slice(1), "assets", "style.css")],
  ["index.html", join(HERE.pathname.slice(1), "index.html")],
]

let failed = 0
for (const [urlPath, file] of targets) {
  if (!existsSync(file)) {
    console.log(`${urlPath}: 磁盘文件不存在（${file}）`)
    failed += 1
    continue
  }
  const disk = readFileSync(file)
  const res = await get(server.port, "/" + urlPath)
  const cl = res.headers["content-length"] ?? "(none)"
  const te = res.headers["transfer-encoding"] ?? "(none)"
  const isHtml = urlPath.endsWith(".html")
  const same = isHtml ? res.body.length > 0 : res.body.length === disk.length && sha(res.body) === sha(disk)
  if (!same) failed += 1
  console.log(`${urlPath}: status=${res.status} disk=${disk.length} got=${res.body.length} cl=${cl} te=${te} identical=${same}`)
}

await server.close()
rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? "RESULT: 静态资源完整下发" : `RESULT: ${failed} 个资源不完整`)
if (failed) process.exitCode = 1