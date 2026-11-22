# 路由检测：发一次真实 chat，读实际调用的模型（方案说明）

> 状态：**方案说明，暂未落地代码**。落地前需同步改写 `tests/route.test.mjs`（现有 9 条断言写死了「检测不发 chat」）。
> 基址：`https://loomyad.xunfei.cn/api/v1`
> 需求来源（用户原话）：「正常的逻辑应该是发送一个很小的请求，然后就可以读到实际调用的模型；我用 magpie 用 loomy 就能看到、分辨真实的模型。」

## 1. 背景：现在的检测为什么判不出

当前 `src/route.mjs` 的 `probeRoute → evaluateReadOnly` 是**纯只读、0 积分**：

| 步 | 请求 | 作用 |
|---|---|---|
| ① | `GET /models`（`token` 头） | 目录否证：登录失效 / 封禁 / 目录无 DS4.1 |
| ② | `GET /points/records?pageSize=1`（余额） | 余额为 0 → exhausted |
| ③ | `GET /points/records`（账本最新一条 `modelName`） | 分类 clean / routed |

问题在 ③：它靠**账本里的历史记录**判定。新号 / 闲置号账本为空 → `no-ledger-records` → `unknown`，面板显示「未检测 / 检测不完整」。这就是同一批「检测选中」全是"未检测"的根因。

## 2. 目标

检测时发一次**与 magpie 真实调用一模一样**的 chat 请求（同头 + 同客户端 body 模板），从响应 SSE 的 `model` 字段直接读出「这一轮实际由哪个模型服务」，据此判定，不再干等账本副本。

## 3. 请求规格

**方法 / 地址**

```
POST https://loomyad.xunfei.cn/api/v1/chat/completions
```

**请求头**（= loader 真实调用，`src/auth-headers.mjs` 的 `chatHeaders` + UA + Accept-Encoding）

```
Authorization: Bearer <session>
token: <session>
Accept: */*
Content-Type: application/json
traceparent: 00-<32位hex>-<16位hex>-01        # 每次新生成（newTraceparent）
loomy-version: 0.9.39                          # DEFAULT_LOOMY_VERSION
X-Loomy-Request-Purpose: chat.message          # REQUEST_PURPOSE_CHAT
User-Agent: opencode/1.14.22 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13   # CLIENT_USER_AGENT
Accept-Encoding: gzip, deflate, br, zstd       # CLIENT_ACCEPT_ENCODING
```

可选（有值才发）：`X-Session-Affinity: ses_<20位>`（按 uid 派生，探测若无 uid 可省）、`ChatId / MsgId / TurnId / InvokeOrigin`（探测一般不造）。

**请求体**（完整客户端模板，只换 messages）

```js
buildClientBody({
  model: "DeepSeek-V4.1-Flash",                 // DS41_MODEL_ID
  messages: [{ role: "user", content: "不要思考，只回复一个hi" }],
})
```

- 保留模板里全部客户端指纹字段（`tools` / `max_tokens` / `reasoning_effort` / `$comment` / 客户端 system），**只把对话换成这一条**。
- `stream: true`（模板强制）。
- **不改 `max_tokens`**：靠 prompt「不要思考，只回复一个hi」让模型只回一句，省输出 token。

## 4. 读真实模型 + 判定口径

从响应 SSE 每个 `data: {...}` 里取第一个 `model`（= 实际服务模型）：

```
data: {"object":"chat.completion.chunk","model":"deepseek-v4-flash-1017", ...}
```

分类（与 `classifyLedgerModel` 同口径）：

| 实际 model | verdict | reason |
|---|---|---|
| `deepseek*` | clean | ledger-deepseek |
| `spark*` | routed | ledger-spark |
| glm / qwen / 其它族 | routed | ledger-other-family |
| 读不到（超时 / 非 200 / 流里无 model） | 保留原状态或 unknown | 不误判 |

## 5. 为什么用完整模板（不被降级）

`src/client-body-template.mjs` 抓包实证：**客户端原始 body 10/10 正常；简化 body 第 4 次就降级**。所以必须用完整模板，只替换 messages —— 否则探测本身会把好号"探"成降级（假阳性）。完整模板 body ≈ 182 KB（含 42K 字符 system + 18 tools）。

## 6. 成本与并发（须知）

- 每号 **1 积分** + 一次 ~182 KB 上行。
- 批量「检测选中」300 号 ≈ **300 积分 + ~55 MB 上行/轮**。
- 建议：`patrol`（免费批量巡检）保持只读，**不得**一起改成发 chat；批量探测套 `rate-gate` 并发限流避免齐发被风控；chat 失败回退只读账本。

## 7. 实现落点（待确认后再改）

`src/route.mjs`：

1. 新增 `probeChatModel({ root, session, fetchImpl })`：按 §3 发请求，读 SSE 第一块 `model` 返回（失败返回空串）。
2. `evaluateReadOnly` 增加 `probeChat` 选项：①② 免费前置不变；到 ③ 时——有 `probeChat` 就发 chat 读 model 分类，没有（`patrol`）就维持读账本。
3. `probeRoute` 传入 `probeChat`。

不改：面板文案（"每个号 1 次调用，扣 1 积分"改回发请求后即名副其实）、`routeCostHint`（ledger-* → "已扣 1 积分"重回正确）、`max_tokens`。

## 8. 测试影响（保留提醒）

- `tests/route.test.mjs`：9 条 `calls.chat.length === 0` 断言需改为「发了一次 chat 且读 model」。
- `route-api` / `route-batch` / `reset-route-state` 等的 fake fetch 需补 chat 端点（返回带 `model` 的 SSE）。
- `patrol` 相关保持只读、不许发 chat。
