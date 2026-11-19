# Loomy 上游端点实测报告（真实 session）

> 实测日期：2026-11-19 16:08–16:35（Asia/Shanghai）
> 基址：`https://loomyad.xunfei.cn/api/v1`
> 方法：真机发请求（Node 24 / undici），每个请求的原始 JSON 逐条落盘到 `out/*.ndjson`，报告里的片段全部从落盘文件里抄。
> 脚本：`D:\UserData\Documents\deepseek-harness\default-workspace\loomy-probe\`（`00-recon` / `01-endpoints` / `02-degrade` / `03-ledger` / `04-burst` / `05-by-turn`）
> **凭据只从 `C:\Users\21877\.config\magpie\plugin-auth.json` 读 session；该文件未被修改，未运行 magpie，未改动插件代码。**

| 标记 | 含义 |
|---|---|
| ✅实测 | 真机跑过，脚本 + `out/*.ndjson` 可复现 |
| 📖源码 | 本仓库代码 / 本机状态文件读到，未跑 |
| ❓未验证 | 推测，附验证方法 |

## 0. 消耗与账号

| 项 | 值 |
|---|---|
| **计费调用** | **41 次 / 150 积分**（`dailyBalance` 4998 → 4848，逐点对上） |
| 其中 `POST /chat/completions` | 40 次 × 1 积分 = 40 积分 |
| 其中 `POST /images/generations` | 1 次 = **110 积分**（见 §5 坑 3） |
| **未计费的失败尝试** | B 号 24 次 `402`（被拒，0 积分，`total` 记录数不变：12086） |
| 只读 GET | 每次调用前后各读一次账本 + 端点/鉴权矩阵，未计入 41；全部免费（账本 `total` 只随 chat/生图增长，已核对） |
| 超出预算 | 40 次计划内 + **1 次**（`spark-x2.6-low` 判别实验）。见 §8 |

| 代号 | 凭据键 | uid | 账号 | 起点余额 | 用途 |
|---|---|---|---|---|---|
| **A** | `loomy#vacmrw` | `261116203906989696` | `165****3295` | daily 4998 / avail 19998 | 降级实验、429、恢复、spark 探针（**40 次 chat 计费调用全部在 A 上**） |
| **B** | `loomy#1y3lvh` | `261013232055298595` | `167****6328` | daily 5000 / avail 5000 | 端点探测 + 生图；chat 全被 `402` 拒（见坑 1） |

挑选依据：两者在 `loomy-route-state.json` 里都是 `verdict=clean`、`reason=ledger-deepseek`、`servedModel=DeepSeek-V4.1-Flash`（📖 本机状态）。

---

## 1. 端点实测总表

只读 GET 全部由 A 号发；生图由 B 号发；`/chat/completions` 的 3 条鉴权对照由 A 号发。

| # | 端点 | 状态 | `code` | 耗时 | 鉴权结论 | 响应形状（截断 ≤200 字） |
|---|---|---|---|---|---|---|
| 1 | `GET /models` | 200 | **无 `code` 字段** | 256 ms | `token` 必须；`Authorization` 不认 | `{"reasoning_enabled":true,"reasoning_catalog_version":"sha256:09b71b3cb2d5f728621bf3c315cb3958f0660e69f7da571b6c87a84e01da273d","object":"list","data":[{"reasoning_efforts":["none","low","medium","high","xhigh"],"default_reasoning_effort":"low","id":"spark-x2.6","name":"Spark-X2.6 正式版(x2.5)"…` |
| 2 | `GET /points/records?pageSize=1` | 200 | `000000` | 50 ms | `token` 必须；`Authorization` 不认 | `{"code":"000000","desc":"成功","trace_id":"a8801523e58a59bf36524b5657f8fd3f","data":{"balance":15000,"dailyBalance":4998,"availableBalance":19998,"pageNo":1,"pageSize":1,"total":11,"list":[{"ledgerId":"pl_6fa551aa8df040fe9a4863ef05f46b5c","modelName":"DeepSeek-V4.1-Flash",…` |
| 3 | `GET /points/activation` | 200 | `000000` | 48 ms | `token` 必须（两条负例均 100002） | `{"code":"000000","desc":"成功","trace_id":"a8801523e58a59bf36524b5657f8fd3f","data":{"activated":true,"appliedInvitationCode":"WGX9YA"}}` |
| 4 | `GET /points/by-turn?turnId=…` | 200 | `000000` / `100001` | 39–236 ms | `token` 必须；**参数是 `turnId`，不是 `chatId`** | 命中：`{"code":"000000","desc":"成功","trace_id":"fbf5513fedb7d662bee117d416055507","data":{"turnId":"turn-probe-2-1","purpose":"chat.message","found":true,"points_consumed":1,"ledger_count":1,"modelName":"DeepSeek-V4.1-Flash","firstCreatedAt":1795076239,"lastCreatedAt":1795076239}}` |
| 5 | `GET /onboarding/tasks` | 200 | `000000` | 47 ms | `token` 必须 | `{"code":"000000","desc":"成功",…,"data":{"tasks":{"configure_remote":true,"create_soul":true,"first_message":true,"generate_ppt":true,"install_skill":true,"pi…` |
| 6 | `GET /invitation-codes` | 200 | `000000` | 55 ms | `token` 必须 | `{"code":"000000","desc":"成功",…,"data":{"list":[{"inviteCode":"HW2PSB","usedCount":0,"maxUses":1,"status":"active"}]}}` |
| 7 | `GET /user/identity` | 200 | `000000` | 44 ms | `token` 必须 | `{"code":"000000","desc":"成功",…,"data":{"isInternal":false,"currentTeamId":"tm_ca61f5a1-b0b2-4229-9857-fc522487","teams":[{"teamId":"tm_ca61f5a1-b0b2-4229-98…` |
| 8 | `GET /conversations?limit=1` | 200 | `000000` | 151 ms | `token` 必须 | `{"code":"000000","desc":"成功",…,"data":{"list":[],"has_more":false,"next_cursor":""}}` |
| 9 | `GET /home-cards` | 200 | **无 `code` 字段** | 45 ms | `token` 必须 | `{"scheduleId":"6a9e2120f17303969cbd9765","scheduleName":"敬葶设计的新版","version":2,"publishedAt":"2026-09-08T02:35:15.698Z","serverTime":"2026-11-19T16:12:00.884716014+08:00","cards":[{"id":"new-mts1lrju-1…` |
| 10 | `POST /images/generations` | 200 | 无 | **12945 ms** | 两个头同时发（`token` + `Authorization`） | `{"created":1795075931,"data":[{"url":"https://aigc-output-image-1326893053.cos.ap-guangzhou.myqcloud.com/1441669661/1441669661-hy_image_v3_5_preview-0d6ac6d24b6345f0a79e9762bc19300e_0.png?q-sign-algor…` |
| 11 | `POST /chat/completions` | 200 | 无（成功走 OpenAI 形状） | 667–864 ms（P50） | **只要 `Authorization: Bearer`**；只给 `token` → `100002` | 见 §2 |

### 1.1 鉴权矩阵（每条端点的两条负例都跑了）

| 端点 | 不带任何鉴权头 | 只带 `Authorization: Bearer <session>` | 只带 `token: <session>` |
|---|---|---|---|
| `/models` | `100002 缺少 token` | `100002 缺少 token` | 200 ✅ |
| `/points/records` | `100002 缺少 token` | `100002 缺少 token` | 200 ✅ |
| `/points/activation` | `100002 缺少 token` | `100002 缺少 token` | 200 ✅ |
| `/points/by-turn` | `100002 缺少 token` | `100002 缺少 token` | 200 ✅ |
| `/onboarding/tasks` | `100002 缺少 token` | `100002 缺少 token` | 200 ✅ |
| `/invitation-codes` | `100002 缺少 token` | `100002 缺少 token` | 200 ✅ |
| `/user/identity` | `100002 缺少 token` | `100002 缺少 token` | 200 ✅ |
| `/conversations` | `100002 缺少 token` | `100002 缺少 token` | 200 ✅ |
| `/home-cards` | `100002 缺少 token` | `100002 缺少 token` | 200 ✅ |
| `/chat/completions` | `100002 缺少 token` | 200 ✅ | `100002 缺少 token` |
| `/images/generations` | 未单独测 | 与 `token` 同时命中 200 ✅ | — |

原始负例片段：
```json
{"code":"100002","desc":"缺少 token","trace_id":"456ff0b8cccfa1a925aa90975fb49c4f","data":{}}
```
```json
{"code":"100001","desc":"请求参数错误","trace_id":"a8801523e58a59bf36524b5657f8fd3f","data":{}}
```
> ✅ **实测结论**：九个 GET 端点与 `/chat/completions` 都是**严格单轨**：GET 族只认 `token:`，chat 只认 `Authorization:`。**鉴权失败一律 HTTP 200**，判据只能看正文 `code`。
> 例外是 `/images/generations`：两个头都发（B 号 1 次 200 + 返回图 URL，任务清单里的形态成立）。

### 1.2 `by-turn` 的参数真相（原任务写的是 `chatId`，实测不是）

```json
// chatId 单给 → 100001
{"code":"100001","desc":"请求参数错误","trace_id":"a8801523e58a59bf36524b5657f8fd3f","data":{}}
// chatId + turnId → 000000
{"code":"000000","desc":"成功","data":{"turnId":"turn-probe-2-1","purpose":"chat.message","found":true,"points_consumed":1,"ledger_count":1,"modelName":"DeepSeek-V4.1-Flash"}}
// msgId → 100001（这个参数不存在）
//  仅 turnId → 000000
```
✅ **必须参数是 `turnId`**；`chatId` 可带可不带；`msgId` 不被接受。

**额外发现（本轮最有用的一条工具性证据）**：chat 请求里带的 `TurnId` 头与 `X-Loomy-Request-Purpose` 头**会落进账本**——21 个不同 `turn-probe-<g>-<i>` 全部 `found=true`、`purpose=chat.message`。也就是说，可以用「一次调用一个 TurnId」把账本条目精确回溯到某一次调用，不必赌 `/points/records` 的副本新鲜度。

---

## 2. `/chat/completions` 的确切形状（DS4.1 请求 + 降级后各一次）

DS4.1（`max_tokens:4` 所以只回推理、`content` 空、`finish_reason=length`）：
```json
{"id":"0217950768311624d75fdb53d3f925b15dbd3d601375baa5794b1","object":"chat.completion","created":1795076831,"model":"DeepSeek-V4.1-Flash","choices":[{"index":0,"message":{"role":"assistant","content":"","reasoning_content":"We need answer?"},"finish_reason":"length"}],"usage":{"prompt_tokens":31,…}}
```
完整 usage（同一路请求，`01-endpoints` 与 `02-degrade` 24 条全一致）：
```json
"usage":{"prompt_tokens":31,"completion_tokens":4,"total_tokens":35,"prompt_tokens_details":{},"completion_tokens_details":{"reasoning_tokens":4},"points_consumed":1}
```
> ✅ **响应体自带 `usage.points_consumed`** —— 每次调用花了多少积分是**响应里直接给的**，不必等账本。这是本轮第二个工具性发现。

SSE（`stream:true` + `include_usage`）首个 chunk：
```
data: {"id":"021795076267283c37a42555415f6e0b86f538a2995d878244082","object":"chat.completion.chunk","created":1795076267,"model":"DeepSeek-V4.1-Flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}
```
SSE 可用 ✅（G3 三发全 200，746/742/785 ms，流被完整读完，`by-turn` 三发都 `found=true / points_consumed=1`）。
❓ `include_usage` 的尾块字段清单本轮**没留证**：落盘只截了前 240 字，`out/degrade.ndjson` 里 G3 的 `usage` 字段是 null。验证方法：G3 的头 + body 再发 1 次，把完整 SSE 落盘（约 2 KB），`grep '"usage"'`。

---

## 3. 重点实验：什么会让模型「降级」成 `spark-x2.6-low`

### 3.1 设计

同一个 clean 号（A），8 组 × 3 次，组间 15 s、组内 2 s。**G2 是基线（客户端头齐全），G3–G8 各自在 G2 上只加一个变量**（不做层层累加 —— 累加会让「哪一项起作用」无法归因）。每次调用前后各读一次 `/points/records?pageSize=1`，并**事后用 `/points/by-turn?turnId=` 逐条回捞**。

### 3.2 结果表（组号 | 请求特征 | 返回 modelName | 延迟）

| 组 | 请求特征 | 3 次的账本 `modelName`（by-turn 回捞） | 延迟 (ms) |
|---|---|---|---|
| 1 | 最小请求：只有 `Authorization`，无 `traceparent` / `loomy-version` / purpose，body 最小 | DeepSeek-V4.1-Flash ×3 | 801 / 706 / 816 |
| 2 | **基线**：`traceparent`(合法) + `loomy-version:0.9.39` + `X-Loomy-Request-Purpose: chat.message` + `ChatId`/`MsgId`/`TurnId`/`InvokeOrigin:user` | DeepSeek-V4.1-Flash ×3 | 763 / 864 / 704 |
| 3 | G2 + `stream:true` + `stream_options.include_usage:true` | DeepSeek-V4.1-Flash ×3 | 746 / 742 / 785 |
| 4 | G2 + 客户端 UA（`…Loomy/0.9.39 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36`） | DeepSeek-V4.1-Flash ×3 | 615 / 730 / 755 |
| 5 | G2 + `temperature:0.7` + `top_p:1` | DeepSeek-V4.1-Flash ×3 | 773 / 757 / 2456 |
| 6 | G2 + `system` 消息 | DeepSeek-V4.1-Flash ×3 | 703 / 725 / 772 |
| 7 | G2 + `tools`（空 function schema）+ `tool_choice:"auto"` | DeepSeek-V4.1-Flash ×3 | 3534 / 761 / 787 |
| 8 | G2 + `reasoning_effort`: `low` / `none` / `high` 各一次 | DeepSeek-V4.1-Flash ×3 | 667 / 720 / 856 |

**24/24 全 200，24/24 账本 `modelName = DeepSeek-V4.1-Flash`，24/24 `points_consumed=1`。**

by-turn 逐条回捞的原始输出（21 条，G1 没带 TurnId 所以只有 G2–G8）：
```
turn-probe-2-1 → found=true modelName=DeepSeek-V4.1-Flash pts=1 ledger=1 purpose=chat.message
…
turn-probe-8-3 → found=true modelName=DeepSeek-V4.1-Flash pts=1 ledger=1 purpose=chat.message
不同 modelName 值：["DeepSeek-V4.1-Flash"]；found=true 条数：21/21
```

### 3.3 追加：连发与恢复

| 实验 | 结果 |
|---|---|
| 1 s 间隔连发 10 次 | `200,200,200,200,200,200,200,200,200,200`；**0 个 429**；**无 `Retry-After` 头**；平均 669 ms |
| 5 s 间隔连发 3 次（预算所限由 10 截断，见 §8） | `200,200,200`；0 个 429；无 `Retry-After`；平均 760 ms |
| 以上之后**再等 300 s** 打 1 次 | `200`，`model=DeepSeek-V4.1-Flash`，账本 `DeepSeek-V4.1-Flash`，1 积分 |
| 显式请求 `model:"spark-x2.6"` | `200`，响应 `model=spark-x2.6`，账本 `spark-x2.6`，1 积分 |
| 显式请求 `model:"spark-x2.6-low"` | `200`，响应 **`model=spark-x2.6`**（被归一），账本 **`spark-x2.6`**，1 积分 |

原始片段（`spark-x2.6-low` 请求 → 归一化）：
```json
{"id":"cht000d3a28@dx1a1f2eb4a1129c4503","object":"chat.completion","created":1795076869,"model":"spark-x2.6","choices":[{"index":0,"message":{"role":"assistant","content":"","reasoning_content":"Thinking Process:"},"finish_reason":"length"}],"usage":{"prompt_tokens":21,"completion_tokens":4,"total_tokens":25,"completion_tokens_details":{"reasoning_tokens":4},"points_consumed":1}}
```
```json
{"ledgerId":"pl_713c244b200f4804beead4980e497198","modelName":"spark-x2.6","direction":"debit","description":"模型调用扣分","createdAt":1795076835,"pointsActual":1,"consumeSource":"daily","balanceBefore":19850,"balanceAfter":19849,"dailyCycleDate":"2026-11-19"}
```

### 3.4 同一实验在另一个「clean」号上的对照（意外收获）

B 号 24 次尝试 **全部 `402`**：
```json
{"error":{"message":"团队积分余额不足，请联系团队管理员充值","type":"insufficient_quota","param":null,"code":402,"metadata":{"provider_name":"loomy"}}}
```
但它的 `/points/records` 明明报 `availableBalance: 5000`、`balance: 0`。→ 见 §4 坑 1。**24 次被拒全部 0 积分**（`total` 记录数 12086 未变）。

---

## 4. 必须回答的 6 个问题

### Q1 降级是否与「调用次数」强相关？具体第几次？

**✅ 实测：不相关。clean 号上连打 38 次请求 DS4.1（24 组 + 10 连发 + 3 + 1 恢复），没有任何一次降级。第「几次」= 不存在。**

- 38 次全部 `modelName=DeepSeek-V4.1-Flash`，`points_consumed=1`（账本 `total` 11 → 52，41 条新记录逐条对上）。
- 账本里第一次出现 `spark` 是**第 39 次**，但那是我**显式请求** `model:"spark-x2.6"` 的那一次（`createdAt` 08:27:15），不是降级。
- 3.4 的对照更硬：同批 clean 号里，`402` 与 `DeepSeek` 的分野**不是次数**，而是**账号状态**。
- 旁证（📖 本机 `loomy-route-state.json`，301 个号）：`routed` 171 / `clean` 108 / `expired` 19 / `exhausted` 3；`routed` 的 `servedModel` 是 `spark-x2.6-low`（81）或 `spark-x2.6-low, spark-x2.6-4b`（90）。降级是**账号级常驻状态**，不是请求累积出来的。
- 反向证据（📖 `src/route.mjs:292-299`）：本插件自己的判据就是 `ledger.startsWith("spark") → routed`——降级被当作**账号属性**处理，这与实测一致。

### Q2 降级是否与某个头/字段相关？（有对照组）

**✅ 实测：本轮测的 8 类头/字段没有一类能触发降级。**
对照组结构就是 G2 基线 vs G3–G8 单变量；每一组的 3 次都是 `DeepSeek-V4.1-Flash`（表 §3.2），延迟差异只反映 `tools`（首调 3534 ms，schema 预热）和 `temperature`（一次 2456 ms 抖动）。

**顺带否证一条我原以为会成立的客户端说法**：客户端注释称「缺 `traceparent` 时 `chat/completions` 会挂死直到超时」（📖 `src/auth-headers.mjs:97`）。G1 故意不带 `traceparent`，3/3 都在 700–800 ms 内 200 返回、且正常计 1 积分。→ **该现象在非流式 DS4.1 请求上未复现**（❓ 是否只在流式/长回答上出现，未验证；验证方法：G1 的头 + `stream:true`，跑 5 次看是否超时）。

### Q3 降级后是否永久？等 5 分钟后是否回到 deepseek？

**✅ 实测（部分）：整轮没有任何一次降级，所以「降级后」这个前提不成立 —— 5 分钟那次仍是 `DeepSeek-V4.1-Flash`。**
```
[恢复检查] 200 827ms resp.model=DeepSeek-V4.1-Flash → 账本 modelName=DeepSeek-V4.1-Flash
```
- 因此「是否永久」**本次未能判定**（❓ 拿不到降级样本）。验证方法：取一个已 `routed` 的号（`loomy-route-state.json` 里 `servedModel=spark-x2.6-low`），发 1 次 DS4.1、等 5 分钟再发 1 次，比对两次账本 `modelName`；2 次调用即可。
- 可复述的旁证（📖）：`routed` 判定在 `route-state` 里是**带 `checkedAt` 的常驻字段**，不是一次性事件。

### Q4 429 的触发条件

| 臂 | 次数 | 429 次数 | `Retry-After` | 状态序列 | 平均延迟 |
|---|---|---|---|---|---|
| 1 s 间隔 | 10 | **0** | **不存在** | `200 ×10` | 669 ms |
| 5 s 间隔 | 3（预算所限，见 §8） | **0** | **不存在** | `200 ×3` | 760 ms |

**✅ 实测：在 1 s×10 这个强度上完全打不出 429；整个实验期间（41 次计费调用 + 约 150 次只读 GET）一次 429 都没出现，也从没见到 `Retry-After` 头。**
❓ 更高强度（并发 / 每分钟计数）能否触发 429 未验证。验证方法：串行 1 s 间隔连发 30 次，记录首次 429 的下标；再取一个窗口重复 2 次确认阈值稳定。**本轮不做的原因**：任务要求串行且 40 次预算内。

### Q5 `spark-x2.6-low` / `spark-x2.6` / `spark-x2.6-4b` 的区别

| 名字 | 在 `/models` 里？ | ✅ 实测行为 | 归因 |
|---|---|---|---|
| `spark-x2.6` | **在** | 请求它 → 响应 `model=spark-x2.6`、账本 `spark-x2.6`、1 积分、`reasoning_content` 有内容 | 唯一**可寻址**的 spark 正式 id |
| `spark-x2.6-low` | **不在** | 请求它 → 响应被**归一**成 `spark-x2.6`、账本记 `spark-x2.6`、1 积分 | 不可寻址；只是**上游给受限账号的服务标识**：`ledger-spark` 81 个号 + `catalog-missing-ds41` 90 个号里出现 |
| `spark-x2.6-4b` | **不在** | 未单独请求（预算） | 同上；只在那 90 个 `catalog-missing-ds41` 号的 `servedModel` 里与 `-low` 并列出现（`"spark-x2.6-low, spark-x2.6-4b"`） |

`/models` 实测 9 个 id：`spark-x2.6`、`DeepSeek-V4.1-Flash`、`deepseek-v4-flash-1017`、`GLM-5.3-Flash`、`qwen3.8-flash`、`Hy-Image-3.5-preview`、`doubao-seedream-5-lite`、`qwen-image-3.0-pro`、`auto`。**`spark-x2.6-low` / `-4b` 不在其中。**
目录里 spark 与 DS4.1 的差异（✅）：`spark-x2.6` `context_length=1048576`、`max_output_tokens=131072`、`vision=false`、`is_default_model=true`、`is_default_small_model=true`；`DeepSeek-V4.1-Flash` `context_length=1048576`、`max_output_tokens=384000`、**`vision=true`（`input_modalities:["text","image"]`）**。

> ❓ `-low` / `-4b` 的语义（是否「低推理档」/「4B 小模型」）未验证。验证方法：取一个 `routed` 号发 1 次 DS4.1，读响应 `model` 与账本 `modelName`，看上游自己怎么命名；再对 `spark-x2.6` 与 `spark-x2.6-4b` 各发 1 次同 prompt，比 `usage.completion_tokens_details.reasoning_tokens` 与延迟分布。

### Q6 响应体 `model` 字段 vs 账本 `modelName` 是否一致

| 场景 | 响应 `model` | 账本 `modelName` | 一致？ |
|---|---|---|---|
| 请求 `DeepSeek-V4.1-Flash`（38 次） | `DeepSeek-V4.1-Flash` | `DeepSeek-V4.1-Flash` | ✅ 一致 |
| 请求 `spark-x2.6` | `spark-x2.6` | `spark-x2.6` | ✅ 一致 |
| 请求 `spark-x2.6-low` | `spark-x2.6`（归一） | `spark-x2.6` | ✅ 一致（归一后） |
| 降级态（本账号从未进入） | 未采到 | 未采到 | ❓ |

**✅ 结论：两者一致；账本记的是「归一后的服务名」，响应也回同一个名字。**
⚠ 但**读法**有坑：`/points/records?pageSize=1` 读的是**副本**，会读到几分钟前的头。实测一次读到的头是 08:22:06 的条目，而当时最新条目已经是 08:27:15（滞后 ≈5 min）。同一个号同一分钟，另一次读却是新鲜的（1 s 臂之后 `dailyBalance` 立刻从 4864 变 4854，10 次正好扣 10 分）。
→ **判据**：要「这次调用落在哪个模型」，用 `usage.points_consumed` + `/points/by-turn?turnId=`，不要赌账本头。

---

## 5. 坑清单（症状 → 判据 → 实测数据）

| # | 症状 | 误导性 | 真根因 | 判据 | ✅实测对照 |
|---|---|---|---|---|---|
| 1 | `verdict=clean` 的号，chat 全 `402` | 看着像「限流/网络问题」，实际文案说「**团队**积分余额不足」 | `balance:0`、`dailyBalance:5000`、`availableBalance:5000` —— 个人日额度还有，但**团队池**是 0 | 同一号读 `/points/records` 看 `balance` 与 `availableBalance` 是否同时 >0；再发 1 次看是否 402 | B 号：`availableBalance:5000` 但 24/24 `402`；A 号 `availableBalance:19998` 时 24/24 200 |
| 2 | 账本头读到的 `modelName` 不是刚发那次 | 会误判「模型被换掉了」 | `/points/records` 走**副本**，滞后可达数分钟（本插件自己就写了「多次读取是为了撞上更新的副本」，📖 `route.mjs:304`） | 同一次调用用 `by-turn?turnId=` 交叉验证 | 滞后样本：读到 08:22:06，实际最新 08:27:15 |
| 3 | 生图请求 `doubao-seedream-5-lite`，出的是另一家的图，且**扣 110 积分** | 会以为「积分单价 1」而预算算错一个数量级 | 生图端点会**静默换模型**：响应 URL 里是 `hy_image_v3_5_preview`，账本记 `Hy-Image-3.5-preview` | 读响应 URL 段 + 账本 `modelName` | 1 次调用：`pointsActual:110`、`modelName:"Hy-Image-3.5-preview"`；同号 chat 每次 1 积分 |
| 4 | 任何鉴权错误都是 HTTP 200 | 「200 = 成功」的判断直接失效 | 业务码在正文 `code` 里（`100002` 缺/失效、`100001` 参数错、`000000` 成功） | 只看 `code` | 十条负例全部 200 + `100002` |
| 5 | `by-turn`「请求参数错误」 | 以为要 `chatId` | 必须参数是 **`turnId`** | 用 `turnId` 再打一次 | `chatId` → `100001`；`turnId` → `000000` + `found:true` |
| 6 | 拿真实 session 打测试域名 → `登录已失效` | 以为 session 坏了 | 测试环境（`ossptest.voicecloud.cn/loomy/integration/api/v1`）不认生产 session | 同一 session 打生产域 `/models` | 测试域：`{"code":"100002","desc":"登录已失效，请重新登录",…}`；生产域 200 + 9 个模型 |
| 7 | 缺 `traceparent` 的请求「应该」挂死（客户端注释） | 会让实现者以为必须逐字复刻客户端 UA/头 | 非流式 DS4.1 上**未复现** | 不带 `traceparent` 连发 3 次 | 3/3 200，700–816 ms，正常计费 |

---

## 6. 端点能力清单（这次能直接用的）

| 能力 | 端点 | 状态 |
|---|---|---|
| 模型目录 | `GET /models`（`token`） | ✅ 9 个 id，含 `capabilities` / `context_length` / `reasoning_efforts` |
| 余额与流水 | `GET /points/records`（`token`） | ✅ `balance` / `dailyBalance` / `availableBalance` / `list[].modelName` / `pointsActual` |
| 单轮计费回溯 | `GET /points/by-turn?turnId=`（`token`） | ✅ **本轮新增可用能力**：`found` / `points_consumed` / `modelName` / `ledger_count` |
| 邀请码状态 | `GET /invitation-codes` | ✅ |
| 激活状态 | `GET /points/activation` | ✅ `activated` + `appliedInvitationCode` |
| 新手任务 | `GET /onboarding/tasks` | ✅ 8 个 boolean |
| 身份/团队 | `GET /user/identity` | ✅ `isInternal` / `currentTeamId` / `teams[]` |
| 会话列表 | `GET /conversations` | ✅（本号为空列表，未建过会话） |
| 首页卡片 | `GET /home-cards` | ✅（无 `code` 包装，直接 `{scheduleId…cards[]}`） |
| 对话 | `POST /chat/completions`（`Bearer`） | ✅ 流式/非流式、reasoning、tools、system 全部可用 |
| 生图 | `POST /images/generations`（两个头） | ✅ 但会换模型且单价 110（坑 3） |

---

## 7. 未验证 / 风险

| # | 未验证项 | 现象 | 验证方法 |
|---|---|---|---|
| U1 | **降级态本身**（本报告最大的缺口） | 38 次调 DS4.1 一个降级样本都没拿到；`-low` 只能从本机 `route-state` 看到 | 取一个 `servedModel=spark-x2.6-low` 的号发 1 次 DS4.1，读响应 `model` + 账本；再等 5 分钟发 1 次 |
| U2 | 降级是否永久 | 无样本 | 同上，跨 1 小时 / 跨日各打 1 次 |
| U3 | 429 阈值 | 1 s×10 与 5 s×3 都 0 个 429，无 `Retry-After` | 串行 1 s 间隔 30 连发，记录首次 429 下标；重复 3 次 |
| U4 | `spark-x2.6-4b` 是否可寻址 | 只请求了 `-low`（被归一） | 请求 `spark-x2.6-4b` 1 次，看响应 `model` 是否也归一 |
| U5 | 缺 `traceparent` 是否在**流式**下挂死 | 非流式未复现 | G1 头 + `stream:true` 跑 5 次，记超时率 |
| U6 | `by-turn` 的 `turnId` 是否只在本号可查 | 21/21 命中都是自己发的 | 用 A 的 `turnId` 改 B 的 `token` 查一次，看是否 `found:false`（可能泄漏/可能隔离） |

**风险**：生图单价 110 积分 × 换模型，是「1 积分/次」这个前提的**例外**；任何按调用次数估算额度的实现都会低估两个数量级。

---

## 8. 本报告刻意没做的事

| 没做 | 原因 |
|---|---|
| 拿 `routed` 号去复现降级 | 任务限定「只挑 2 个 clean 号」，且第 3 个号会破坏「2 个号」的实验边界 |
| `spark-x2.6-4b` 探针 | 40 次预算已被 `-low` 用掉最后 1 格（实际总量 41，已超 1） |
| 5 s 臂跑满 10 次 | 实际用量 24（组）+1（生图）+10（1 s 臂）+3（5 s 臂）+1（恢复）+1（spark）+1（-low）= **41**；5 s 臂跑满 10 次会到 48 |
| 并发打 429 | 任务明确要求串行（`ForEach-Object -Parallel` 同号并发不许用） |
| 写入类端点（`/points/activation` POST、`/onboarding/tasks/complete`、`DELETE /conversations`） | 会改服务端账号状态 |
| 贴完整 session / 完整邀请码 | 安全；报告里只出现服务端自己脱敏的手机号与 `uid` |

---

## 附：证据文件

> 前缀：`D:\UserData\Documents\deepseek-harness\default-workspace\loomy-probe\`

| 文件 | 内容 |
|---|---|
| `out/endpoints.ndjson` | 18 条端点探测 + 14 条鉴权矩阵 + 5 条辅助查询的原始响应 |
| `out/degrade.ndjson` | 48 条（A 号 24 次 402 + B 号 24 次 200），含每次调用前后的账本头 |
| `out/byturn.ndjson` | 21 条 `by-turn` 回捞结果 |
| `out/burst.ndjson` | 1 s ×10 / 5 s ×3 / 恢复 / spark ×2 的原始响应 |
| `out/models.json` | `/models` 完整目录（9 个 id 全字段） |
| `out/recon.ndjson` | 两个号的初次 `/models` + `/points/records` |

复跑方式（只读部分不含计费）：
```powershell
cd D:\UserData\Documents\deepseek-harness\default-workspace\loomy-probe
$env:A_KEY='loomy#vacmrw'; $env:B_KEY='loomy#1y3lvh'
node 00-recon.mjs        # 4 次只读
node 01-endpoints.mjs    # 含 1 次生图（110 积分）
node 02-degrade.mjs      # 24 次 chat
node 05-by-turn.mjs      # 21 次只读
```