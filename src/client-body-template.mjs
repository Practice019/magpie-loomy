// client-body-template.mjs 客户端对话请求的**完整 body 模板**（原样搬自抓包）。
//
// # 来源
//
//	客户端 v0.9.39 抓包（`D:\project_GIT\_loomy_capture\llm-proxy.log`）
//	取第一条 `type:"llm_request"` 且 url 以 `/api/v1/chat/completions` 结尾的请求。
//	该次 body：171,628 字节、18 个 tools、system 42,336 字符、30 条 messages。
//
// # 用途
//
// 用户要求「伪装成客户端」：真实调用与面板探测都发这套形态，避免服务端降级
// （实证：客户端原始 body 10/10 正常；简化 body 第 4 次就降级）。
//
// # 何时需要重新抓包
//
//	· 客户端升级（`loomy-version` 变了）
//	· 模板里的 `$comment` / `tools` / `reasoning_effort` 与服务端行为对不上
//	· 上游开始拒绝旧形态（症状：全量降级或 4xx）
//
// 重新抓包后**直接替换** `client-body-template.json` 即可 —— 代码不用改。
//
// ⚠ 模板里含 `$comment`（客户端自带注释字段），是**有意保留**的：它属于客户端
//    指纹的一部分。不要「清理」它。
//
// ⚠ 模板很大（~180 KB）。它放在 JSON 文件里而不是内联进代码，是为了让 diff
//    看得清、也不让代码文件被数据淹没。

import TEMPLATE from "./client-body-template.json" with { type: "json" }

/** 客户端完整 body 模板（只读，调用方必须 clone 后再改）。 */
export const CLIENT_BODY_TEMPLATE = Object.freeze(TEMPLATE)