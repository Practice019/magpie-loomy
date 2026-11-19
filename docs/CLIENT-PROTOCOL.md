# Loomy 桌面客户端 v0.9.39 — 协议事实清单

> **性质**：对**本机已安装客户端**的只读取证记录（静态反编译 + 安装目录配置），没有任何一次真实网络请求。
> **证据等级**：全篇默认 **📖 源码**（读代码得出、未跑过）。凡写 **(推断)** 的，是从代码推导但缺一环直接证据；
> 凡写 **❓未验证** 的，是本次取证**无法**从本机静态材料判定、必须抓包才能确认的。
> **零改动声明**：未修改 `D:\project_GIT\_loomy_app_extract`、`D:\software\Loomy-Setup-CH-cg-VID-9rvzqj71oy`、
> `C:\Users\21877\AppData\Roaming\Loomy` 下任何文件；未运行 Loomy。

## 0. 取证源与路径约定

| 代号 | 路径 | 内容 |
|---|---|---|
| **E:** | `D:\project_GIT\_loomy_app_extract\electron\` | app.asar 解包后的主进程代码（ESM，可读） |
| **S:** | `D:\project_GIT\_loomy_app_extract\src\` | 渲染进程共享源码（`lib/`、`data/`） |
| **D:** | `D:\project_GIT\_loomy_app_extract\dist\` | 渲染进程打包产物（minified） |
| **R:** | `D:\software\Loomy-Setup-CH-cg-VID-9rvzqj71oy\resources\` | 安装目录：`opencode.json` 模板、`.env.prod`、`app.asar` |
| **U:** | `C:\Users\21877\AppData\Roaming\Loomy\` | 客户端数据目录（leveldb / Preferences / electron-store 落盘）。**本次未读取、未写入任何内容**；该目录下的实际落盘键名与值不在本清单范围内（见 §7.4） |

版本号事实：`D:\project_GIT\_loomy_app_extract\package.json` → `name: "loomy"`、`version: "0.9.39"`、**`productName` 为空**。
运行时取值链：`electron/utils/app-version.js:48-50`（`app.getVersion()` 优先，回退 `package.json.version`）。

---

## 1. 端点总表

> **鉴权列写法**：`token` = 请求头名字面为 `token: <session>`；`Bearer` = `Authorization: Bearer <session>`；
> `token+Bearer` = 两者同时发；`HMAC` = 讯飞账号 HMAC-SHA1 签名头（见 §5.2）；`无` = 不带认证。

### 1.1 Loomy 自建服务（`loomy-server`）

**注意：`loomy-server` 这一侧有两条独立的 baseUrl 来源，别当成一个。**

| 家族 | baseUrl 解析 | 默认值（test） | 默认值（prod） | 消费者 |
|---|---|---|---|---|
| **A. pointsConfig** | `electron/points-config.js:128-156`（env → `.env*` → `points.config.local.json` → electron-store → 默认） | `https://ossptest.voicecloud.cn/loomy/integration`（`:16`） | 由 `.env.prod` 的 `LOOMY_POINTS_BASE_URL` 注入 | 云端会话、onboarding、points/pet、skill-store、search、ASR、rtasr、cross-end-sync |
| **B. crashLogConfig** | `electron/crash/crash-log-config.js:94-148` | 同 A（`:15`） | **`https://loomyad.xunfei.cn`**（`:16`，**无** `/loomy/integration` 后缀） | **crash-log、feedback、home-cards** 三者共用 |
| **C. tradeConfig**（独立网关，**不是** loomy-server） | `electron/trade/trade-config.js:218-256` | `https://tradepre.xfinfr.com`（`:11`、`:193`） | `https://trade.xfinfr.com`（`:12`、`:189`） | `/business/*`、`/trade/*`（支付） |

注入证据：A 家族 —— `electron/main.js:928-929`（cloud-conversation）、`electron/main.js:627-630`（skill-store，`getConfig: pointsConfig.getConfig`）、
`electron/main.js:641-644`（search）、`electron/main.js:632-635`（rtasr）、`electron/app/account-service-container.js:29-33`（points）、
`:34-39`（onboarding）、`electron/main.js:873`（cross-end-sync `getServerBaseUrl`）。
B 家族 —— `electron/app/account-service-container.js:40-63`（`getApiBaseUrl: crashLogConfig.getConfig()?.baseUrl` 同时喂给 crash-log / feedback / home-cards）。
C 家族 —— `electron/app/account-service-container.js:24-28`（`tradeService` 用 `tradeConfig.getConfig()`，**域名与 A/B 完全不同**）。

**云端会话（athena，`electron/cloud-conversation/cloud-conversation-service.js`）**

| 方法 | 路径 | 鉴权 | 用途 | 证据 file:line |
|---|---|---|---|---|
| GET | `/api/v1/conversations?status&limit&cursor&loomy_id&task_state&origin_device_id` | token | 会话列表 / 本机非终态运行枚举 | `E:cloud-conversation/cloud-conversation-service.js:88-94`、`:317-323` |
| GET | `/api/v1/conversations/{id}/title` | token | 读会话标题 | `:103-107` |
| POST | `/api/v1/conversations/{id}/title/generate` | token + `Idempotency-Key` | 触发服务端生成标题 | `:110-115` |
| GET | `/api/v1/conversations/{id}/history?window=latest&limit=100` | token | 拉最近历史窗口 | `:118-122` |
| PATCH | `/api/v1/conversations/{id}/title` | token + `Idempotency-Key`，body `{title}` | 改标题（1–255 字符） | `:125-138` |
| DELETE | `/api/v1/conversations/{id}` | token + `Idempotency-Key` + `X-Delete-Source` + `X-Loomy-Device-ID` | 删会话（source∈{desktop,mobile}） | `:141-169` |
| GET | `/api/v1/conversations/changes?limit&wait&cursor` | token + `X-Loomy-Device-ID` | 变更长轮询（wait 0–25s） | `:172-182` |
| GET | `/api/v1/models` | token | 云端模型目录 | `:185-191` |
| GET | `/api/v1/athena/interventions/resolve?task_id&session_id&request_id&tool_call_id` | token | 解析介入卡（强关联校验） | `:196-210` |
| GET | `/api/v1/athena/interventions/resolve-permission?task_id&session_id&permission_id&tool_call_id` | token | 解析权限卡 | `:213-227` |
| POST | `/api/v1/athena/interventions/{card_id}/answer` | token，body `{answer:{decision\|selected\|answers}}` | 回填介入答案 | `:230-253` |
| POST | `/api/v1/chat/files?conversation_id=` | token + `Idempotency-Key`，multipart `files` | 附件上传（1–3 个，单文件 ≤50MiB） | `:256-296` |
| GET | `/api/v1/conversations/{cid}/attachments/{aid}/content` | token | 下载附件 | `:298-302` |
| GET | `/api/v1/conversations/{cid}/artifacts/{aid}/download` | token | 下载 artifact | `:305-310` |
| POST | `/api/v1/athena/chat/completions/{task_id}/cancel` | token | 取消云端任务 | `:337-342` |
| POST | `/api/v1/athena/chat/completions`（`action:'submit'`） | token | 提交云端任务，**SSE 流式** | `:345-423` |
| POST | `/api/v1/athena/chat/completions`（`action:'observe'`） | token | 观测云端任务，**SSE 流式** | `:425-488` |

> 该文件所有请求头由 `#fetchAuthorized` 统一产出：`{ token, 'content-type': 'application/json'(有 body 时) }` + 调用方附加头，
> 见 `:522-553`。**没有** `Authorization`、没有 `traceparent`、没有 `loomy-version`（推断：这条链只认 `token` 头）。

**其余 `/api/v1`、`/api/v2`（同一 baseUrl，家族 A；明确标 B 的除外）**

| 方法 | 路径 | 鉴权 | 用途 | 证据 file:line |
|---|---|---|---|---|
| GET | `/api/v1/home-cards` | token | 首页卡片（**家族 B**：`crashLogConfig.baseUrl`） | `E:home-cards-service.js:7`；注入 `E:app/account-service-container.js:60-63` |
| GET | `/api/v1/onboarding/tasks` | token | 新手任务列表 | `E:onboarding-service.js:174`；头构造 `:116-129` |
| POST | `/api/v1/onboarding/tasks/complete` | token，body `{key}` | 完成任务 | `E:onboarding-service.js:202-205` |
| GET | `/api/v1/pet-work` | token | 宠物工作项 | `E:points-service.js:417` |
| POST | `/api/v1/pet-work/rewards` | token | 宠物奖励结算 | `E:points-service.js:442` |
| GET | `/api/v1/points/records` | token | 积分流水 v1 | `E:points-service.js:457` |
| GET | `/api/v2/points/records` | token | 积分流水 v2 | `E:points-service.js:475` |
| GET | `/api/v1/team-points/balance` | token | 团队积分余额 | `E:points-service.js:490` |
| GET | `/api/v2/team-points/records` | token | 团队积分流水 v2 | `E:points-service.js:510` |
| GET | `/api/v1/invitation-codes` | token | 邀请码列表 | `E:points-service.js:522` |
| POST | `/api/v1/points/redemption-codes/redeem` | token | 兑换码兑换 | `E:points-service.js:535` |
| POST | `/api/v1/points/first-login` | token | 首次登录初始化 | `E:points-service.js:555` |
| GET | `/api/v1/public/promo-banners` | **无** | 侧边栏活动位（走 `requestPublic`，不带 token） | `E:points-service.js:563`、`:238-255` |
| GET | `/api/v1/points/activation` | token | 查询激活状态 | `E:points-service.js:572` |
| POST | `/api/v1/points/activation` | token | 提交激活 | `E:points-service.js:593` |
| GET | `/api/v1/user/identity` | token | 用户身份 | `E:points-service.js:603` |
| GET | `/api/v1/user/team-assets` | token | 团队资产 | `E:points-service.js:607` |
| POST | `/api/v1/user/current-team` | token，body | 切换当前团队 | `E:points-service.js:613` |
| POST | `/api/v1/user/leave-team` | token，body | 退出团队 | `E:points-service.js:622` |
| GET | `/api/v1/points/by-chat?chatId=` | token | 按 ChatId 查积分 | `E:points-service.js:645` |
| GET | `/api/v1/team-points/by-chat` | token | 按 ChatId 查团队积分 | `E:points-service.js:668` |
| GET | `/api/v1/points/by-turn` | token | 按 TurnId 查本轮积分 | `E:points-service.js:699` |
| GET | `/api/v1/team-points/by-turn` | token | 按 TurnId 查团队积分 | `E:points-service.js:712` |
| POST | `/api/v1/asr/recognize` | token（头名 `token`），multipart `audio` | 语音转写 | `E:points-service.js:346-353` |
| GET | `/api/v1/skills/store/list` | token（有 token 才带） | 技能广场列表 | `E:skill/skill-store-service.js:143`；头 `:45-51` |
| GET | `/api/v1/skills/store/categories` | token | 技能分类 | `E:skill/skill-store-service.js:147` |
| POST | `/api/v1/skills/store/check-updates` | token，body=已装技能数组 | 检查技能更新 | `:150-155` |
| POST | `/api/v1/skills/store/install-count` | token，body `{skill_id}` | 上报安装数 | `:157-162` |
| GET | `/api/v1/skills/store/defaults` | token | 默认技能集 | `:170` |
| POST | `/api/v1/feedback/upload-ticket` | token | 反馈附件上传票据（**家族 B**） | `E:feedback-service.js:4` |
| POST | `/api/v1/feedback/complete` | token | 反馈附件完成回调（**家族 B**） | `E:feedback-service.js:5` |
| POST | `/api/v1/feedback/submit` | token | 提交反馈（**家族 B**） | `E:feedback-service.js:6` |
| POST | `/api/v1/crash-logs/upload-ticket` | token（local baseUrl 时改发 `X-User-Id: mock_user_001`） | 崩溃日志上传票据（**家族 B**） | `E:crash/crash-log-service.js:5`、头 `:21-33` |
| POST | `/api/v1/crash-logs/complete` | 同上 | 崩溃日志完成回调（**家族 B**） | `E:crash/crash-log-service.js:6` |
| GET | `/api/v1/version/check?platform=windows\|mac&version=` | 无 | 版本检查 | `E:update/update-check.js:19-24` |
| POST | `/api/v1/team-knowledge/mcp` | token（MCP 代理） | 团队知识库 MCP 代理 | `E:team-asset-service.js:11` |
| POST | `/api/v1/search/tencent` | Bearer + 追踪头 | 联网搜索（body 见下） | `E:search/search-service.js:6`、`:177-187` |
| POST | `/api/v1/loomy/bindcode` | session | Nexus 绑定码 | `E:nexus/nexus-http-client.js:65` |
| GET | `/api/v1/loomy/glasses` | session | 眼镜绑定/在线状态 | `:75` |
| DELETE | `/api/v1/loomy/glasses` | session | 解绑眼镜 | `:85` |
| POST | `/api/v1/images/generations` | token+Bearer（session 模式）/Bearer（apiKey 模式） | 文生图 / 图生图 | `E:image/image-generation-service.js:693-707`、`:723-738`；鉴权头 `:93-104` |
| POST | `/api/v1/athena/connect/bootstrap` | session | Athena 连接引导 | `E:cross-end-sync/athena-user-session-channel.js:2`（常量 `/athena/connect/bootstrap`，前缀 `/api/v1`，见测试 `:60`） |
| POST/GET | `/api/v1/athena/devices` | session | 已绑定设备 | `E:cross-end-sync/athena-user-session-channel.js:3`（测试 `:19`） |

> `search/tencent` body 关键字段（`E:search/search-service.js:100-126`）：`query`、`Mode`(0=natural/1=vr/2=mixed)、
> 可选 `Site`、`FromTime`/`ToTime`(Unix 秒，必须成对)、`Cnt`∈{10,20,30,40,50}、`Industry`∈{gov,news,acad}。

### 1.2 iModel 上游（provider `imodel`，OpenAI 兼容）

| 方法 | 路径 | 鉴权 | 用途 | 证据 file:line |
|---|---|---|---|---|
| GET | `{providerBaseURL}/models` | `token`（`authMode:'token'` 时）/`Bearer`（`auto`\|`bearer` 时） | 同步模型目录 | `E:model-service.js:1083-1106`（URL 拼接 `:1093`，头 `:1094-1106`） |
| POST | `{providerBaseURL}/chat/completions` | Bearer（+ session 模式额外 `token`） | 主对话 / 一次性补全 / 识图 / 音频摘要 / 生图兜底 | `E:llm/llm-completion.js:138`、`E:builtin-assist-service.js:216`、`E:knowledge/kb-vision.js:240`、`E:knowledge/kb-media-summary.js:229`、`E:image/image-generation-service.js:554` |
| POST | `{providerBaseURL}/embeddings` | Bearer（+ session 模式 `token`） | 知识库向量化（批 16） | `E:knowledge/kb-embed.js:84`、`:94-117`；批量 `:15` |
| POST | `{providerBaseURL}/messages` | Bearer + `anthropic-version: 2023-06-01` | Anthropic 协议 companion（`imodel-anthropic`） | `E:builtin-assist-service.js:185-224` |

### 1.3 讯飞账号网关（`account.xfinfr.com` / `accounttest.xfinfr.com`）

见 §5.3 的完整路径表（`E:xfyun/account-service.js`）。

> 域名事实：代码里的**默认值**是 `https://accounttest.xfinfr.com`（`E:xfyun/account-service.js:159`）；
> 生产域名由 `.env.prod` 的 `LOOMY_XFYUN_BASE_URL` 注入（同一 `.env.prod` 是 `LOOMYENC1:` 密文，本次未解密）。
> 因此「现网到底是 `account.xfinfr.com` 还是别的」**❓未验证**（见 §7.3 U4）。

### 1.4 其他域

| 方法 | 路径 | 鉴权 | 用途 | 证据 file:line |
|---|---|---|---|---|
| GET | `{webBase}/api/activities` | 无 | 首页活动位（`webBase` ∈ `…/loomy-web/integration`） | `E:activity/activity-service.js:4`、`:61-64`；base `E:web-api/web-api-config.js:6-7` |
| GET | `{webBase}/api/messages?unread&cursor` | Bearer | 站内信列表 | `E:inbox/inbox-service.js:147`、头 `:109-113` |
| GET | `{webBase}/api/messages/unread-count` | Bearer | 未读数 | `:153` |
| GET | `{webBase}/api/messages/{id}` | Bearer | 站内信详情 | `:157` |
| POST | `{webBase}/api/messages/{id}/read` | Bearer | 标记已读 | `:162` |
| POST | `{webBase}/api/messages/read-all` | Bearer | 全部已读 | `:168` |
| POST | `{shareBase}/static-share` | token + 可选 `Idempotency-Key`，multipart `file`(zip ≤5MiB) | 静态分享上传（HTML/MD/项目打包） | `E:share/upload-static-share.js:77-78`、`:168-191` |
| POST | `{shareBase}/static-share/{shareId}/delete` | token | 撤回静态分享 | `:82`、`:274-278` |
| POST | `{shareBase}/share/buddy` | token | 创建搭子分享 | `E:share-buddy-service.js:434` |
| GET | `{shareBase}/share/buddy/{shareId}` | token | 拉取分享 | `:459` |
| POST | `{shareBase}/share/buddy/register` | token | 注册搭子 | `:489` |
| POST | `{shareBase}/share/buddy/{shareId}/import` | token | 导入分享 | `:517` |
| GET | `{shareBase}/share/buddy/by-buddy/{buddyId}` | token | 按搭子反查分享 | `:548` |
| POST | `{shareBase}/share/buddy/{shareId}/delete` | token | 删除分享 | `:575` |
| GET | `{v2Base}/buddies?category=` | token | 官方搭子目录 | `E:official-buddy-service.js:139` |
| GET | `{v2Base}/buddies/{id}` | token | 搭子详情 | `:146` |
| GET | `{v2Base}/buddy-teams?category=` | token | 搭子团队列表 | `:157` |
| GET | `{v2Base}/buddy-teams/{id}` | token | 团队详情 | `:164` |
| POST | `{tradeBase}/business/queryProducts` | HMAC + 可选 `x-caccount-session`/`x-caccount-userid` | 商品目录（**家族 C**：`tradepre/trade.xfinfr.com`） | `E:trade/trade-service.js:237` |
| POST | `{tradeBase}/business/createOrder` | 同上（下单必带 session） | 业务下单（**家族 C**） | `:258` |
| POST | `{tradeBase}/trade/createOrder` | HMAC + 必有 session，body `{base,param:{channel,bizorderno,payappid}}` | 支付单创建（**家族 C**） | `:327-333`、`:147-163` |
| POST | `{tradeBase}/trade/queryOrder` | HMAC + session | 支付单查询（**家族 C**） | `:355-360` |
| POST | `https://ocpc.baidu.com/ocpcapi/api/uploadConvertData` | 无 | 百度转化回传 | `E:baidu-conversion-service.js:1` |
| WSS | `{base}/api/v1/rtasr/stream` | `Authorization: Bearer <session-token>` | 实时语音识别 | `E:xfyun/xfyun-rtasr-service.js:6`、`:28-31` |
| WSS | `ws://nexustest.xfinfr.com/gateway/nexus-dispatch-integration/ws/loomy` | Nexus 协议 | 眼镜/设备派发长连 | `E:nexus/nexus-config.js:38-41`、`:75-82` |
| HTTPS | `https://nexustest.xfinfr.com/gateway/nexus-gateway-integration` | session | Nexus 网关 REST | 同上 |

### 1.5 本机 loopback（**入站**，opencode 工具 → Loomy 主进程）

不是出站端点，但属于协议面；均为 `127.0.0.1:<随机端口>` 的本地 HTTP 服务：

| 方法 | 路径 | 证据 file:line |
|---|---|---|
| POST | `/v1/loomy-search-tool` | `E:search/search-tool-bridge.js:48`、env `:121` |
| POST | `/v1/loomy-image-tool` | `E:image/image-tool-bridge.js:48`、env `:116` |
| POST | `/v1/loomy-soul-tool` | `E:soul/soul-tool-bridge.js:49`、env `:91` |
| POST | `/v1/loomy-glasses-tool` | `E:nexus/glasses-tool-bridge.js:157`、env `:276` |
| POST | `/v1/loomy-config-tool` | `E:config-tool-bridge.js:172` |

---

## 2. `/chat/completions` 出站规范

### 2.1 URL 构造

**有两条完全独立的出站路径，不能混为一谈。**

**路径 A — 主对话链路（走 opencode 子进程，Loomy 主进程不直接发）**

```
完整 URL = config.provider["imodel"].options.baseURL + "/chat/completions"
```
- baseURL 来自 `opencode.json` 的 provider 配置：`R:\opencode-home-template\opencode.json:7`
  值 = `https://ossptest.voicecloud.cn/loomy/integration/api/v1`
  → 完整 URL = `https://ossptest.voicecloud.cn/loomy/integration/api/v1/chat/completions`
- **客户端不自己拼 `/api/v1`**：`/api/v1` 已经写在 baseURL 里；客户端只做 `baseURL.replace(/\/+$/,'') + '/chat/completions'`
  （单次调用路径的证据：`E:llm/llm-completion.js:138`、`:268`；主链路相同语义，见 `E:image/image-generation-service.js:554`）。
- provider 由 `@ai-sdk/openai-compatible` 驱动：`R:opencode-home-template/opencode.json:5`（`"npm": "@ai-sdk/openai-compatible"`）。
  **模型 body / 流式开关由 opencode 运行时生成，不在 Loomy 主进程代码里**（推断，依据是 §2.3 的 body 字段只出现在「一次性调用」的六个函数，主链路 body 无任何客户端构造代码）。

**路径 B — 一次性 / 后台链路（Loomy 主进程直接 `fetch`）**

```
URL = config.provider[providerID].options.baseURL(去尾斜杠) + "/chat/completions"
```
同样的拼接出现在 6 处，全部相同语义：`E:llm/llm-completion.js:138`、`:268`、`E:image/image-generation-service.js:554`、
`E:knowledge/kb-vision.js:240`、`E:knowledge/kb-media-summary.js:229`、`E:builtin-assist-service.js:216`。

> 结束 `/api/v1` 判断的依据：baseURL 是**配置里给的**（`E:llm/llm-completion.js:59-62` 只校验非空，不做前缀补全），
> 而 `image-generation-service` 在**缺 provider baseURL 时**才自己补 `/api/v1`：`E:image/image-generation-service.js:106-124`
> （`endsWith('/api/v1') ? x : x + '/api/v1'`），说明「带不带 `/api/v1`」由 baseURL 携带，客户端不做统一改写。

### 2.2 请求头逐个列出

| 头名 | 取值 | 何时带 / 何时不带 | 证据 file:line |
|---|---|---|---|
| `Accept` | `application/json` | 所有直连 chat/completions **恒带** | `E:llm/llm-completion.js:149`、`E:knowledge/kb-vision.js:250`、`E:image/image-generation-service.js:557` |
| `Content-Type` | `application/json` | 恒带 | 同上 |
| `Authorization` | `Bearer <token>` | 恒带。`token` = session（`useSessionAuth:true`）或 `apiKey`（第三方） | `E:llm/llm-completion.js:64-77`、`:151` |
| `token` | `<同一个 token>`（裸头，无 Bearer 前缀） | **仅当** `provider.options.useSessionAuth === true` | `E:llm/llm-completion.js:154-156`；`E:knowledge/kb-embed.js:110`；`E:knowledge/kb-vision.js:256`；`E:knowledge/kb-media-summary.js:240`；`E:builtin-assist-service.js:222` |
| `traceparent` | `00-<32hex>-<16hex>-01`（W3C） | **恒带**。传入值合法（正则 `^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$`）则沿用并转小写，否则现生成 | `E:utils/request-headers.js:7`、`:20-22`、`:45-49` |
| `ChatId` | 调用方给的 `chatId` | 非空才带 | `E:utils/request-headers.js:40`、`:51-53` |
| `MsgId` | 调用方给的 `msgId` | 非空才带；子代理派生为 `<祖先MsgId>-sub-<childSessionID>`（截断 256） | `E:utils/request-headers.js:55-57`；`E:opencode-plugin/loomy-chat-headers-source.js:177-188` |
| `TurnId` | 调用方给的 `turnId`；**长度 >256 直接丢弃**（`normalizeTurnId` 返回空串） | 非空且 ≤256 才带；缺失是常态 | `E:utils/request-headers.js:10`、`:33-36`、`:61-63` |
| `InvokeOrigin` | `user` \| `system`（小写归一，非法则不带） | 非空才带；主链路默认 `user` | `E:utils/request-headers.js:8`、`:24-27`、`:69-71`；默认值 `E:opencode/stream-coordinator.js:832` |
| `X-Loomy-Request-Purpose` | 17 个枚举值（下表） | 值在枚举内才带，否则**整头不发** | `E:utils/request-purpose.js:13-51`；`E:utils/request-headers.js:65-67` |
| `X-Loomy-Source` | 字面量 `glasses` | **仅当** `requestContext.appId` 命中眼镜 appId 白名单（`app_05e42243d3f8a6d1` / `app_6072759e901d1dfc`） | `E:utils/request-headers.js:73-76`、`E:config/remote-app-ids.js:8-13` |
| `loomy-version` | `app.getVersion()`，回退 `package.json.version` | 经 `withLoomyVersionHeader` 的出口才带（已存在同名头则不覆盖） | `E:utils/app-version.js:7`、`:48-66`；`E:utils/request-headers.js:81-83` |
| `X-Loomy-Billing-Idempotency-Key` | 账单幂等键（内容哈希派生） | **仅**知识库识图（`kb.vision`）带 | `E:knowledge/kb-vision.js:254` |
| `X-Loomy-Device-ID` | `originDeviceId` | 仅云端会话的 DELETE / `conversations/changes` 带 | `E:cloud-conversation/cloud-conversation-service.js:166`、`:181` |
| `Idempotency-Key` | UUID（`crypto.randomUUID()`） | 云端会话写操作、附件上传、静态分享上传 | `E:cloud-conversation/cloud-conversation-service.js:15-18`、`:114`、`:135`、`:164` |
| `X-Delete-Source` | `desktop` \| `mobile` | 仅会话删除 | `E:cloud-conversation/cloud-conversation-service.js:165` |
| `anthropic-version` | `2023-06-01` | **仅** `imodel-anthropic` 走 `/messages` 时带 | `E:builtin-assist-service.js:222` |
| `Content-Length` | 计算值 | 音频摘要流式 body 手填 | `E:knowledge/kb-media-summary.js:253` |

**`X-Loomy-Request-Purpose` 枚举全 17 值**（`E:utils/request-purpose.js:13-31`）：

```
chat.message, chat.title, pet.comment, pet.reward, kb.vision, kb.audio, kb.summary,
kb.embed, search.web, image.generate, assistant.completion, assistant.asr-correct,
memory.extract, memory.recall, memory.dream, skill.evolution, skill.curator
```

补充协议事实：
- **`loomy-version` 的覆盖面并不全**：走 `withLoomyVersionHeader` / `buildLoomyChatRequestHeaders` 的出口才带。
  实测**不带**的两个出口：`POST /api/v1/search/tencent`（`E:search/search-service.js:170-184` 只用 `buildRequestHeaders`）、
  `POST /api/v1/images/generations`（`E:image/image-generation-service.js:695-700` 只用 `buildRequestHeaders`，无 version 包装）。
  带 `loomy-version` 的识图/补全出口是同文件的 `:556`（`/chat/completions`）。
- 该文件注释明确「旧的 `X-Loomy-Billing-Exempt` 头已废弃，不要再发」→ **本版本不发** `X-Loomy-Billing-Exempt`（`E:utils/request-purpose.js:10`）。
- 内部键 `completion` / `asr-correct` 必须先映射成协议值再出头（`E:utils/request-purpose.js:39-42`、`:53-57`）。
- `X-Loomy-Source` 只有 `glasses` 一个取值（`E:utils/request-headers.js:75`），且测试断言「除它之外不加任何其它头」：`E:__tests__/request-headers.test.js:89-96`。

**主链路（路径 A）的头怎么到位**：Loomy 不直接设置它们，而是
1. 主进程在 `startStream` 里用 `buildLoomyChatRequestHeaders(requestContext)` 生成头（`E:opencode/stream-coordinator.js:847`）；
2. 按 `sessionID` 落盘到 `<globalConfigDir>/chat-headers/<sessionID>.json`（`E:opencode/stream-coordinator.js:1197`；实现 `E:lib/chat-headers-store.js:55-71`）；
3. opencode 子进程里的插件在 `chat.headers` hook 时读该文件并**补齐缺少的头**（不覆盖已有同名头）
   （`E:opencode-plugin/loomy-chat-headers-source.js:217-243`，`hasHeader` 跳过已有键 `:226-229`）；
4. 目录经环境变量 `LOOMY_CHAT_HEADERS_DIR` 注入（`E:opencode-plugin/loomy-chat-headers-source.js:11`、`:80-86`）。
- 子会话（task 派生的 subagent）没有自己的 JSON：插件沿 `parentID` 上溯最多 5 层继承，并**另铸 MsgId**
  （`E:opencode-plugin/loomy-chat-headers-source.js:141`、`:156-211`）。

**`Authorization` 在主链路怎么来**：`agent-composition-coordinator.injectSessionAuthToProviders()` 把
`options.apiKey = sessionData.session`（`useSessionAuth !== true` 的 provider 跳过；anthropic companion 额外写
`options.headers.Authorization`），`E:opencode/agent-composition-coordinator.js:453-471`。
@ai-sdk/openai-compatible 用 apiKey 组 `Authorization: Bearer`（推断：这一层是 SDK 行为，代码里没有显式设置）。

### 2.3 body 逐字段

**B-1 一次性补全 `runLlmCompletion`**（`E:llm/llm-completion.js:170-178`）

| 字段 | 值 / 默认 | 说明 |
|---|---|---|
| `model` | `modelID`（`providerID/modelID` 里的后半段） | `:45`、`:171` |
| `messages` | 调用方数组，**最后一条 user 的 content 前缀加 `/no_think `** | `:84-100`、`:169-172` |
| `temperature` | 默认 `0.7` | `:117`、`:173` |
| `max_tokens` | 默认 `600` | `:118`、`:174` |
| `stream` | `false` | `:175` |
| `enable_thinking` | `false` | `:176` |
| `chat_template_kwargs` | `{ enable_thinking: false }` | `:177` |
| `top_p` | **不发** | 文件中无该字段 |
| `max_completion_tokens` | **不发**（用 `max_tokens`） | — |
| `tools` / `tool_choice` | 不发（另见 B-2） | — |
| `reasoning_effort` | 不发 | — |
| `stream_options` | 不发（非流式） | — |

**B-2 强制工具调用 `runLlmForceToolCall`**（`E:llm/llm-completion.js:284-306`）

在 B-1 基础上替换/新增：`tools: [{type:'function', function:{name, description, parameters}}]`（只 1 个工具）、
`tool_choice: {type:'function', function:{name: toolName}}`（硬绑指定工具名）；`temperature` 默认 `0.4`、`max_tokens` 默认 `400`；
`stream:false`、`enable_thinking:false`、`chat_template_kwargs.enable_thinking:false` 仍在。

**B-3 识图 `_requestImageUnderstanding`**（`E:image/image-generation-service.js:562-571`）

```
{ model, temperature: 0, messages: [{ role:'user', content }] }
```
无 `stream`、无 `max_tokens`。`content` 是 `{type:'text'}|{type:'image_url'}` 组成的内容数组（图片编码见同文件 data-url 解码/拼装函数 `:196-204` 起）。

**B-4 知识库识图 `analyzeImage`**（`E:knowledge/kb-vision.js:260-266`）

```
{ model, messages, temperature: 0, max_tokens: 150, stream: false }
```
`messages` 由 `buildMessages(dataUrl)` 生成（图片走 data URL，`E:knowledge/kb-vision.js:196-230`）。

**B-5 音频摘要 `summarizeAudio`**（`E:knowledge/kb-media-summary.js:246-252`）

```
{ model: 'doubao-seed-2.0-mini', messages, temperature: 0.3, max_tokens: SUMMARY_MAX_TOKENS, stream: false }
```
- `model` **硬编码**：`FORCED_PROVIDER_ID='imodel'`、`FORCED_MODEL_ID='doubao-seed-2.0-mini'`（`E:knowledge/kb-media-summary.js:16-17`）。
- body 用 `duplex:'half'` **流式上传**（音频 base64 占位符在传输时替换，避免整串 stringify）：`:227-228`、`:254-259`。

**B-6 Anthropic 协议 companion**（`E:builtin-assist-service.js:189-212`）

`imodel-anthropic` 时 body 是 Anthropic 形态：`{model, messages, max_tokens, temperature, system?, stop_sequences?,
thinking?:{type:'enabled', budget_tokens}}`；OpenAI 兼容时是 `{model, messages(含 system 作为 role:'system'), max_tokens,
temperature, stream:false, stop?, enable_thinking:false, chat_template_kwargs:{enable_thinking:false}}`。
注意：**Anthropic 分支不发 `stream`**（默认非流式）。

**B-7 `embeddings`**（`E:knowledge/kb-embed.js:115`）

```
{ model, input: batch }   // batch 长度 16
```

### 2.4 是否强制流式 / 是否 `include_usage`

| 链路 | 流式 | `stream_options.include_usage` | 证据 |
|---|---|---|---|
| 主对话（`athena/chat/completions`） | **强制 `stream:true`**，非流式响应直接判错 | **是**，`{include_usage:true}` | `E:cloud-conversation/cloud-conversation-service.js:392-393`；`#requireStreamingResponse` `:615-623` |
| observe 回放 | 强制 `stream:true` | 不带 | `:443-456` |
| 本地 opencode → iModel chat/completions | 由 opencode 运行时决定（**推断**：UI 是流式渲染，`onToken` 逐 token 回调说明走 SSE） | **代码中无客户端设置** | `E:opencode/stream-coordinator.js:813-822`（`onToken`/`onPartUpdate`） |
| `llm-completion` / `builtin-assist` / `kb-vision` / `kb-media-summary` / 识图 | **恒非流式** `stream:false`（或省略） | 不适用 | 见 §2.3 |
| `images/generations` | 非流式 JSON | 不适用 | `E:image/image-generation-service.js:743-765` |

---

## 3. UA 与指纹

**结论：客户端在 `electron/` 内没有任何 User-Agent 覆盖。**

- 全量检索 `electron/` 下 `userAgent|setUserAgent|User-Agent|Accept-Language|sec-ch-ua` → **0 命中**（本次取证 grep 结果为空）。
  即没有 `session.setUserAgent(...)`、没有 `webContents.setUserAgent(...)`、没有在 `headers` 里手写 `User-Agent`。
- 再复核 `dist/` 与全树 `setUserAgent` → **0 命中**。渲染产物里唯一的 `userAgent` 是动画库的平台探测：
  `navigator.userAgent.toLowerCase().includes('applewebkit/')`（`D:dist/assets/main-Bv7VZXLM.js:12`，非 UA 设置）。
- 因此：
  - **渲染进程窗口**（BrowserWindow 加载 `dist/`）：UA 为 Electron 默认形态 `Mozilla/5.0 (Windows NT 10.0; Win64; x64)
    AppleWebKit/537.36 (KHTML, like Gecko) <appName>/<version> Chrome/<chromium ver> Electron/<electron ver> Safari/537.36`。
    本包 `package.json` 无 `productName`、`name: "loomy"`、`version: "0.9.39"`，故 `<appName>/<version>` 段
    **应为 `loomy/0.9.39`（小写，来自 `name` 而非 `productName`）**。**(推断)** —— 依据 Electron 默认 UA 拼接规则 +
    本包元数据；未抓包核对。**❓未验证**。
  - **主进程 `fetch`（Node/undici）**：Node 原生 `fetch` 默认**不发送** `User-Agent`。**(推断)** —— 代码里没有设置，
    但 undici 各版本行为不完全一致，必须抓包确认（见 §7-U1）。
  - **opencode 子进程 → iModel**：UA 由 `@ai-sdk/openai-compatible` + 其 HTTP 栈决定，**完全不在 Loomy 代码里**。**❓未验证**。

**其它指纹头**：

| 头 | 是否出现 | 证据 |
|---|---|---|
| `Accept-Language` | 客户端不设 | 全量检索 0 命中 |
| `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` | 客户端不设（Chromium 在渲染进程网络栈会自动加，主进程 `fetch` 不加） | 同上 |
| `Origin` / `Referer` | **客户端显式请求里都不设**（无 CORS/Referer 逻辑） | 同上 |
| `Accept` | 显式设 `application/json`（§2.2） | `E:llm/llm-completion.js:149` 等 |
| `x-caccount-session` / `x-caccount-userid` | **仅** trade 链路（`points-service` 同 baseUrl 的 `/business/*`、`/trade/*`） | `E:trade/trade-service.js:155-161` |
| `X-User-Id: mock_user_001` | **仅** crash-log 且 baseUrl 是本机 localhost 时（mock 通道） | `E:crash/crash-log-service.js:26-29` |

**账号网关的「UA 常量」是 body 字段而不是 HTTP 头**：`ua: 'Loomy|Desktop|Electron|macOS'` 硬编码在请求 body 的 `base` 里，
见 §5.1（`E:xfyun/account-service.js:447`）。注意：**即使在 Windows 上也是写死 `macOS`**——这是常量，不是平台探测结果。

---

## 4. 并发 / 限流 / 退避

### 4.1 全局流并发上限 = 5

| 常量 | 值 | 证据 |
|---|---|---|
| `DEFAULT_MAX_CONCURRENT_STREAMS` | `5` | `E:opencode/stream-coordinator.js:23` |
| `MAX_CONCURRENT_STREAMS`（重置路径复用） | `5` | `E:opencode/runtime-reset.js:17`、`:79` |
| `GlobalStreamLimiter` 默认 `maxConcurrent` | `5` | `E:lib/global-stream-limiter.js:8` |
| 实际构造 | `new GlobalStreamLimiter({ maxConcurrent: DEFAULT_MAX_CONCURRENT_STREAMS })` | `E:opencode/stream-coordinator.js:119-121` |

**语义（`E:lib/global-stream-limiter.js:1-59`）**：
- 所有入口（UI / 飞书 / 钉钉 / QQ / 微信 / 定时任务）**共享同一个计数器**（`:3`）；
- 达到上限后 `acquire()` **排队等待，不拒绝**（FIFO，`:35-40`）；
- `release()` 幂等：同一 ticket 多次释放只生效一次（`:42-51`）；
- 排队时通过 `onQueued(position)` 回调告知「前面还有几个」，主进程日志为
  `并行会话已达上限 (5)，当前请求排队中，前方还有 N 个等待`（`E:opencode/stream-coordinator.js:849-853`）。

**槽位释放时机**：`startStream` 把 `releaseStreamSlot()` 包在 `onDone` / `onError` 的 `finally` 里
（`E:opencode/stream-coordinator.js:855-868`）——即「流终态（成功/失败/取消）才释放」，不是请求返回就释放。

**注意**：这是**客户端本地并发闸门**，不是服务端限流。它限制的是「同时进行的 AI 会话流数量」，不是 HTTP 连接数。

### 4.2 429 / Retry-After / 退避

**结论：客户端没有 `Retry-After` 解析，没有针对 chat 的通用 429 退避。**

- 全量检索 `429|Retry-After|retry-after|retryAfter` → 仅 3 处业务性判断，无一处读 `Retry-After` 头：

| 位置 | 语义 | 证据 |
|---|---|---|
| 识图重试判据 | `[408,409,425,429]` 视为**可重试**，`>=500` 可重试，其余 `4xx` 不重试；最多换 3 个模型候选（`IMAGE_UNDERSTANDING_MAX_MODEL_ATTEMPTS = 3`） | `E:image/image-generation-service.js:136-176`、`:35` |
| 生图/识图错误包装 | `retryable: status >= 500 \|\| [408,409,425,429].includes(status)` | `E:image/image-generation-service.js:777` |
| 分享 buddy 错误名映射 | `429 → 'rate-limited'` | `E:share-buddy-service.js:375` |

- **对话主链路上限由服务端硬约束**：`event-router.js:875` 在 `useSessionAuth === true` 且上游返回 401 时触发
  「session 失效」处理（`isHttpUnauthorized`），**没有**对 429 做重试。
- 唯一的「退避」是**非 HTTP 的**：
  - 宠物辅助模型连续失败退避：`maxConsecutiveFailures = 3`、`backoffMs = 60000`（`E:pet/pet-model-client.js:20`、`:27`、`:42`）；
  - Nexus WS 重连指数退避 1s → 5s → 30s → 60s 封顶、无次数上限（`E:nexus/nexus-dispatch-client.js:557`）；
  - session 模型同步的懒重试冷却 `DEFAULT_RETRY_COOLDOWN_MS = 5000`（`E:opencode/auth-session-coordinator.js:3`、`:129-133`）；
  - python 运行时缺失/解压失败 60s 退避（`E:python-runtime-manager.js:278-341`）。
- **所有直连 `fetch` 都有 30s 级超时**：points `AbortController` 30s（`E:points-service.js:140`）、skill-store 30s
  （`E:skill/skill-store-service.js:58`）、onboarding 30s（`E:onboarding-service.js:132`）、search 30s
  （`E:search/search-service.js:10`）、llm-completion 45s（`E:llm/llm-completion.js:14`）、生图/识图 5min
  （`E:image/image-generation-service.js:33-34`）、provider 侧 `timeout: 1200000` / `chunkTimeout: 1200000`
  （`R:opencode-home-template/opencode.json:9-10`）。

### 4.3 `X-Loomy-Billing-*` 头的作用

| 头 | 状态 | 作用 | 证据 |
|---|---|---|---|
| `X-Loomy-Billing-Exempt` | **已废弃，本版本不发** | 旧版「豁免计费」标记 | `E:utils/request-purpose.js:10`；`E:knowledge/kb-vision.js:247` |
| `X-Loomy-Billing-Idempotency-Key` | **在发**，仅 `kb.vision` | 让服务端对同一次识图请求幂等计费（客户端按内容派生的稳定键） | `E:knowledge/kb-vision.js:254`、键来源 `:228` |

计费裁决的协议事实：**用途只是业务用途声明，不等于计费决策**，最终是否扣分由服务端裁决层按
`X-Loomy-Request-Purpose` 统一判定（`E:utils/request-purpose.js:8-11`；`E:knowledge/kb-vision.js:247`）。
扣分回执从流事件的字段里读出来（`points_consumed` 提取见 `E:opencode/stream-coordinator.js:247-279`）。

---

## 5. 账号网关（`account.xfinfr.com`）

### 5.1 base 字段与 UA 常量

每个请求 body 的 `base` 由 `_makeBase()` 生成（`E:xfyun/account-service.js:441-450`）：

```json
{
  "appid":   "<config.appId>",           // 来自 LOOMY_XFYUN_APP_ID / VITE_XFYUN_APP_ID
  "modelid": "Web",                      // WEB_MODEL_ID 常量
  "version": "1.0.0",                    // 硬编码
  "devid":   "web",                      // WEB_DEVICE_ID 常量
  "ua":      "Loomy|Desktop|Electron|macOS",   // 硬编码，不区分平台
  "traceid": "<uuid v4 去横线>"
}
```

- `appid` 来源：`E:xfyun/account-service.js:46-48`（`LOOMY_XFYUN_APP_ID` / `VITE_XFYUN_APP_ID`），
  读取顺序 = `.env*` 文件 → `process.env`（`:143`）。
- gateway baseUrl 默认 `https://accounttest.xfinfr.com`，**强制 HTTPS**（非 https 直接抛错）：
  `E:xfyun/account-service.js:159`、`:169-171`。生产值由 `.env.prod` 提供（见 §5.5）。

### 5.2 HMAC 头构造（`E:xfyun/sign.js`）

- 算法：`HMAC-SHA1(accessKeySecret, stringToSign)` → **base64**（`E:xfyun/sign.js:180-182`）。
- `stringToSign` 是 **9 段 `\n` 连接**（`:157-169`）：

```
METHOD                       // 大写
ESCAPED_PATH                 // 逐段 encodeURIComponent，再补 !'()* 的 RFC3986 转义；去尾斜杠
ESCAPED_QUERY_STRING         // key=value 排序不保证，按对象插入序；键值都做同款转义
Content-MD5                  // base64(md5(bodyString))，无 body 为空串
CONTENT_TYPE                 // 原样，如 application/json
DATE                         // new Date().toUTCString()
NONCE                        // crypto.randomUUID()
SIGNED_HEADERS               // 所有 x-* 头名小写、排序、';' 连接
CANONICALIZED_HEADERS        // 每个 x-* 头 "k:v\n"，排序，末尾 \n 去掉
```

- 发出的头（`E:xfyun/sign.js:259-272`）：

```
Authorization: account <accessKeyId>:<signature>     // magicName 默认 'account'
Date:          <RFC1123 UTC>
Nonce:         <uuid>
Content-Type:  application/json
Content-MD5:   <base64 md5>                            // 有 body 才带
```

- **签名只覆盖 `x-` 前缀头**（`buildCanonicalizedHeaders(headers, prefix='x-')`，`E:xfyun/sign.js:84-120`）——
  本文件的调用方 `customHeaders` 恒为空对象（`E:xfyun/account-service.js:203-211` 未传），故
  `SIGNED_HEADERS` 与 `CANONICALIZED_HEADERS` **两段都是空串**。
- `token` / `Authorization: Bearer` **不用于**账号网关：网关会话是靠 body 里的 `param.session` 传的（见 §5.3）。
- 同一套 HMAC 也被 `trade-service` 复用，但那边**写了 contentMd5 + Date + Nonce，且 signed/canonical 两段留空**
  （`E:trade/trade-service.js:130-153`），并把网关会话放在 HTTP 头 `x-caccount-session` / `x-caccount-userid`
  （`:155-161`）—— 与账号网关的「session 走 body」不同，别混。

### 5.3 路径表（全部 POST）

| 路径 | 用途 | body 关键 param | 证据 |
|---|---|---|---|
| `/login/phone/sendMsgCode` | 发登录短信 | `{ccode:'86', phone, expire:300}` | `E:xfyun/account-service.js:343-377` |
| `/login/phone/checkCode` | 短信登录换 session | `{ccode,phone,mcode,msgid,expire:14d,channel?}` | `:379-409` |
| `/login/account/getPuKey` | 取 RSA 公钥（密码登录用） | `{}` | `:411-419` |
| `/login/account/byPwd` | 密码登录 | `{loginid,password(密文),rcode,type,expire:14d}` | `:612-627` |
| `/register/phone/submit` | 手机号注册 | `{phone,code,password?,channel?}` | `:629-654` |
| `/login/account/logout` | 登出 | `{session}` | `:674-689` |
| `/login/thirdAccount/bind/auth` | 微信登录第 1 步（换 rcode） | `{tcode:{code},type:'wx',authconf?,channel?}` | `:453-473` |
| `/login/thirdAccount/bind/sendMsg` | 绑定手机号发码 | `{rcode,phone,ccode,expire}` | `:476-488` |
| `/login/thirdAccount/bind/checkCode` | 绑定并登录 | `{rcode,mcode,msgid,expire}` | `:491-504` |
| `/login/thirdAccount/bind/skip` | 已绑手机号直接换 session | `{rcode,expire}` | `:508-519` |
| `/userinfo/phone/sendMsgCode` | 已登录用户向已绑手机发码 | `{session,expire}` | `:539-549` |
| `/userinfo/thirdAccount/bind` | 追加绑定三方 | `{session,tcode:{code},type,mcode,msgid,authconf?}` | `:551-573` |
| `/userinfo/thirdAccount/unbind` | 解绑三方 | `{session,type}` | `:587-597` |
| `/userinfo/bind/mergeAccount` | 合并账号（0405001 后） | `{rcode}` | `:575-585` |
| `/userinfo/query/thirdInfo` | 查已绑三方（type/nickname/headpic） | `{session,authconf?}` | `:599-610` |
| `/userinfo/query/baseInfo` | 取用户信息 | `{session}` | `:656-672` |
| `/userinfo/audit/update` | 改用户资料（走内容审核） | `{session,list:[{field,value}]}` | `:691-726` |

**业务码与鉴权错误的判别**（`E:xfyun/account-service.js:258-287`）：
`code !== '000000'` 即业务失败；`AUTH_ERROR_CODES = {'020002','100002'}` 视为「登录态无效」（`isAuthError:true`，`:23`、`:266-278`）。
HTTP 层超时 30s（`:240`）。

### 5.4 登录流程 → session 注入链路

```
渲染进程 preload.xfyun.loginBySmsCode                E:preload.js:871-876
  → IPC 'xfyun:account:loginBySmsCode'               E:ipc/xfyun-ipc.js:77-82
  → XfyunAccountService.loginBySmsCode               E:xfyun/account-service.js:379-409
  → POST /login/phone/checkCode（HMAC 头 + base 字段）→ data.session / userid
  → 渲染进程再 invoke 'auth:set-session'             E:ipc/auth-ipc.js:27-42
  → AuthSessionController.update()                   E:auth/auth-session-controller.js:53-88
      ├─ electron-store('auth-session') 落盘 {session,userid,phone,updatedAt}   E:auth/auth-session-runtime.js:5-21
      └─ opencodeService.updateAuthSession()         E:auth/auth-session-controller.js:14-16
           → AuthSessionCoordinator.updateAuthSession E:opencode/auth-session-coordinator.js:160-179
               ├─ 触发 /api/v1/models 同步（providerIds 默认 ['imodel']）   :44-76、:59
               └─ 已在跑则重启 opencode server（'auth-session-updated'）    :169-178
  → 重启时 agent-composition-coordinator 把 session 写成 provider.apiKey   E:opencode/agent-composition-coordinator.js:453-471
  → @ai-sdk/openai-compatible 以 apiKey 发 Authorization: Bearer           （推断）
```

- 启动恢复：`createAuthSessionRuntime().restore()` 读 store 并立即同步（`E:auth/auth-session-runtime.js:26`；
  `E:auth/auth-session-controller.js:38-51`）。
- 失效清理：`clear()` 清 store、清 opencode session、停 Nexus、向所有窗口广播 `auth:session-invalidated`
  （`E:auth/auth-session-controller.js:90-113`）。
- **`session` 同时被 5 类调用方复用作「会话 token」**：points / onboarding / skill-store / inbox(Bearer) /
  cloud-conversation(`token` 头) / opencode provider(`apiKey`)。这是同一个值，不同头名。

### 5.5 `resources/.env.prod`（只记录存在与读取方，**未解密**）

- 文件：`R:.env.prod`，`2359` 字节，**全文单行密文**，前缀 `LOOMYENC1:`（本次只读取了前 200 字节用于确认前缀，
  未尝试解密）。
- 密文格式定义：`LOOMYENC1:<base64(salt|iv|tag|ciphertext)>`，AES-256-GCM + scrypt，口令**内嵌在客户端**
  （`E:utils/env-file-crypto.js:18`、`:21`、`:37-50`）。文件头无前缀时按明文直通（`:53-57`）。
- **哪些模块读它**（全部经 `getEnvFileCandidates` + `decryptEnvContent`）：

| 模块 | 读的字段 | 证据 |
|---|---|---|
| `points-config` | `LOOMY_POINTS_BASE_URL`/`VITE_LOOMY_POINTS_BASE_URL`、`LOOMY_POINTS_TOKEN`/`VITE_POINTS_TOKEN`/`LOOMY_ASR_TOKEN`/`VITE_ASR_TOKEN` | `E:points-config.js:40`、`:57-90`、`:72-80` |
| `xfyun/account-service` | `LOOMY_XFYUN_BASE_URL`、`LOOMY_XFYUN_ACCESS_KEY_ID`、`LOOMY_XFYUN_ACCESS_KEY_SECRET`、`LOOMY_XFYUN_APP_ID`、`LOOMY_WECHAT_APP_ID`、`LOOMY_XFYUN_WECHAT_AUTHCONF`、`LOOMY_WECHAT_REDIRECT_URI`（各带 `VITE_` 别名） | `E:xfyun/account-service.js:125`、`:35-59` |
| `nexus-config` | `LOOMY_NEXUS_URL`、`LOOMY_NEXUS_GATEWAY_URL`、`LOOMY_NEXUS_DEFAULT_APP_ID` | `E:nexus/nexus-config.js:46`、`:53-87` |
| `share-buddy-service` | `LOOMY_SHARE_API_BASE` 等 | `E:share-buddy-service.js:29`、`:77` |
| `trade-config` | 交易 appId / accessKey 等 | `E:trade/trade-config.js:6`、`:107-127` |
| `update-config` | 更新 feed / apiBaseUrl | `E:update/update-config.js:7`、`:125` |

- 候选文件优先级（打包态 = prod）：`['.env.prod', '.env', '.env.test']`（`E:utils/env-file-helpers.js:33-35`）。
- 代码注释自陈安全边界：「解密口令必须随客户端一起分发，本质是混淆而非真正的密钥保密」
  （`E:utils/env-file-crypto.js:8-10`）。

---

## 6. 模型映射与路由

### 6.1 `parseModelId`：按**首个** `/` 切分

```js
parseModelId('open/tencent/hy3-preview:free') → { providerID:'open', modelID:'tencent/hy3-preview:free' }
parseModelId('noSlash')                       → { providerID:'noSlash', modelID:'' }
parseModelId('')                              → { providerID:'', modelID:'' }
```
证据：`E:utils/model-id.js:13-28`（注释说明旧实现 `split('/')` 的丢段 bug 与回归测试 `E:__tests__/model-id.test.js`）。
本地模型前缀常量 `LOCAL_MODEL_PROVIDER_ID = 'loomy-local'`（`:30`），`isLocalModel()` 用它判本地（`:32-34`）。

### 6.2 provider id 映射（`imodel` / `imodel-anthropic`）

| 服务端 `protocol` | 落到的 provider id | npm | 备注 |
|---|---|---|---|
| `openai_chat` / `openai` / 缺省/非法 | `imodel` | `@ai-sdk/openai-compatible` | 非法值警告后按 openai 处理 |
| `anthropic_messages` / `anthropic` | `imodel-anthropic` | `@ai-sdk/anthropic` | companion provider |

证据：`E:model-service.js:29-31`（`-anthropic` 后缀 / `@ai-sdk/anthropic` / `" (Anthropic)"` 名字后缀）、
`:732-759`（协议归一化与分桶）、`:899-902`（`_bucketModelsByProtocol` → 两套 `_mapModelsToProviderConfig`）、
真实响应形态的回归测试 `E:__tests__/builtin-model-protocol.test.js:513-539`（`qwen3.5-plus`/`qwen3.5-flash`/`MiniMax-M2.5`
→ `imodel`，`spark-x` → `imodel-anthropic`）。

### 6.3 默认模型选择与「用户选择不被覆盖」

- 服务端字段：`is_default_model`（主模型）、`is_default_small_model`（小模型）。
  证据：`E:model-service.js:876-878`、`:1000`；测试 `:537-538`。
- 用户显式选过的模型写 sidecar 标记 `modelUserSelected`，此后**不被服务端 default 覆盖**
  （`E:__tests__/builtin-model-protocol.test.js:569-590`）。
- spark-x 从 anthropic 协议迁到 openai 协议时，客户端**保留模型意图并迁移 provider id**
  （`LEGACY_LOOMY_SPARK_X_MODEL='imodel-anthropic/spark-x'` → `OPENAI_LOOMY_SPARK_X_MODEL='imodel/spark-x'`）：
  `E:model-service.js:32-33`；测试 `:592-619`。
- `small_model` 的使用点：`runLlmCompletion` 默认取 `small_model || model`（本地模型则强制用 `model`）
  （`E:llm/llm-completion.js:41`）。

### 6.4 客户端**自己做**的「降级 / 回退」行为

| 行为 | 触发条件 | 动作 | 证据 |
|---|---|---|---|
| 模型列表「可疑收窄」保护 | 旧列表 >1 个模型、新列表**只剩 1 个** | 判失败、**保留本地列表**、打 `model-sync-suspicious-shrink` 诊断日志 | `E:model-service.js:914-935` |
| 音频摘要模型回退检测 | 响应 `data.model` ≠ 请求模型 | 抛 `model-fallback` 错误（`音频摘要模型发生回退：请求 X，实际 Y`），**不静默接受** | `E:knowledge/kb-media-summary.js:277-283` |
| 识图多模型轮询 | 请求失败且 `isRetryableImageUnderstandingError` 为真 | 换下一个候选模型，最多 3 次 | `E:image/image-generation-service.js:35`、`:136-176` |
| `/models` 不支持 | HTTP 500 / 404 | 回退内置模型列表（仅当有内置表命中） | `E:model-service.js:1123-1138` |
| 供应商鉴权失败 | `useSessionAuth===true` 且上游 401 | 走 session 失效处理（提示重登） | `E:opencode/event-router.js:875` |
| 本地模型优先 | 本地 runtime 可用 | `runLlmCompletion` 先试 `localModelService.complete()`，`handled` 即返回 | `E:llm/llm-completion.js:123-126` |

> 注意：客户端**不**把「降级后的模型名」上报给服务端——代码里没有任何 `report/upload` 携带实际模型的路径。
> （`accepted_public_model` 是**读**来的，见下。）

### 6.5 `accepted_public_model` 的来源

- **唯一出现位置**：渲染进程打包产物 `dist/assets/main-Bv7VZXLM.js:200`（minified，单行内的 token）。
  用法是**只读**：云端 SSE 事件处理时把它当作模型名的兜底值 ——
  先取本地选择 `selectedPublicModel`，再退到 `event.accepted_public_model`，再退到消息 metadata 里的 `model`。
- 也就是说：**该字段由服务端在云端会话事件里下发**，客户端把它当作「服务端实际接受的公开模型名」用于展示；
  客户端没有构造或上送它。
- 与 `GET /api/v1/models` 的关系：**推断** —— `/api/v1/models` 返回的条目有 `id` / `name` / `protocol` /
  `is_default_model` / `is_default_small_model`（§6.3 证据），渲染层用 `id`/`name` 匹配
  `accepted_public_model` 去找展示名与是否免费（`is_free` / 名字含「免费」）。**没有**任何代码证据表明
  `accepted_public_model` 就是 `/api/v1/models` 里的 `id`。**❓未验证**（见 §7-U3）。

### 6.6 `spark-x2.6-low` 这类「降级模型」

**结论：客户端 v0.9.39 的代码里根本不存在 `spark-x2.6-low`，也不存在任何 `x2.6` 字面量。**

检索范围：`electron/**`、`src/**`、`dist/**`、`vendor/**`，模式 `x2\.6|x2-6|2\.6-low` → **0 命中**。

客户端里真实存在的 spark 模型字面量只有这些：

| 字面量 | 语义 | 证据 |
|---|---|---|
| `spark-x` | 内置 AI 助理模型（**服务端强制要求 Anthropic 协议 + `thinking` 预算**） | `E:builtin-assist-service.js:15`、`:19-21`、`:146-160`；`E:model-service.js:18`、`:32-33` |
| `imodel/spark-x` | spark-x 的 OpenAI 兼容落点 | `E:model-service.js:33` |
| `imodel-anthropic/spark-x` | spark-x 的 Anthropic 兼容落点（历史值） | `E:model-service.js:32` |
| `spark-x2.5-1.7b` / `spark-x2.5-4b` | **本地** llama 模型（`loomy-local/*`），1.7B / 4B | `E:local-model/local-model-catalog.js:11`、`:32`；设备推荐 `E:local-model/device-profile-service.js:31-33` |

关于「降级模型」在客户端的可见形态：
- 客户端**只在两种情况下感知「模型被换/降级」**：① 音频摘要响应模型不符（§6.4，抛错）；
  ② 云端会话事件里的 `accepted_public_model`（§6.5，仅展示）。
- **没有任何客户端逻辑**会把主模型请求改成 `*-low` / `*-mini` 之类的降级模型再发一次。
  唯一硬编码的小模型是音频摘要的 `doubao-seed-2.0-mini`（`E:knowledge/kb-media-summary.js:17`），
  它只用于「音频摘要」这一个用途，不是主对话的降级目标。
- `*-low` 若出现在真实会话里，**只能是服务端路由的结果**（客户端无法解释它）。**❓未验证**（见 §7-U2）。

---

## 7. 未知与不确定项

### 7.1 有代码证据的（可直接落地）

1. **所有 `/api/v1`、`/api/v2` 路径、方法、鉴权头、body 关键字段**：§1 每条都有 `file:line`。
2. **chat/completions 的头集合与生成规则**：`E:utils/request-headers.js` 全文 + 5 个直连调用点的头字面量。
3. **`traceparent` 格式与生成**：`00-<32hex>-<16hex>-01`，`crypto.randomBytes` 生成，传入非法则重新生成。
4. **并发上限 5 + FIFO 排队不拒绝**：`E:lib/global-stream-limiter.js` + `E:opencode/stream-coordinator.js:23,119,849`。
5. **HMAC-SHA1 / 9 段 canonical / `Authorization: account AK:sig`**：`E:xfyun/sign.js` 全文。
6. **`ua: 'Loomy|Desktop|Electron|macOS'` 是 body 常量**（不是 HTTP UA 头，且 Windows 也写 macOS）。
7. **`.env.prod` 是 `LOOMYENC1:` 密文，读取方 6 个模块**：§5.5 表。
8. **`X-Loomy-Billing-Exempt` 已废弃、只发 `X-Loomy-Billing-Idempotency-Key`（kb.vision）**。
9. **`spark-x2.6-low` / `x2.6` 在客户端不存在**（全量检索 0 命中）。
10. **`accepted_public_model` 只在渲染产物被读取，客户端不上送**。

### 7.2 推断项（代码推导，缺一环直接证据，需抓包确认）

| # | 推断 | 缺什么 |
|---|---|---|
| I1 | 主对话 `chat/completions` 的 `Authorization` 由 `@ai-sdk/openai-compatible` 用注入的 `options.apiKey` 生成 | Loomy 代码只到「写 apiKey」为止，SDK 组头无源码 |
| I2 | 主对话 body 的 `stream:true` / `stream_options` / `tools` / `reasoning_effort` 由 opencode 运行时生成 | 这些字段不在 Loomy 主进程代码里（只有 6 个一次性调用函数自建 body） |
| I3 | 主进程 `fetch` 的 UA 为空（undici 默认不加 `User-Agent`） | 未抓包；undici 版本行为需实测 |
| I4 | 云端会话链路（`athena/*`）不带 `traceparent` / `loomy-version` | 只看到 `#fetchAuthorized` 只加 `token` + `content-type`，但未抓包确认无其它注入 |
| I5 | `accepted_public_model` 与 `/api/v1/models` 的 `id` 是同一命名空间 | 渲染层用 `id`/`name` 双向匹配，但没有字段级文档或抓包 |
| I6 | `*.voicecloud.cn/loomy/integration` 是**集成/测试**环境，生产域名不同 | 模板 `opencode.json` 与 `points-config.js` 默认值都指向 ossptest，生产值靠 `.env.prod`（密文）注入 |

### 7.3 完全未验证（必须抓包/实测）

| # | 问题 | 验证方法 |
|---|---|---|
| U1 | 客户端三类出站（渲染进程窗口 / 主进程 fetch / opencode 子进程）**各自的实际 User-Agent 字面量**与是否存在 `sec-ch-ua`、`Accept-Language` | 本机 mitmproxy / fiddler 挂 127.0.0.1，跑一次登录 + 一次对话 + 一次生图，比对三类请求头 |
| U2 | 服务端是否会**主动**把请求路由到 `*-low` / 降级模型；`accepted_public_model` 是否为被降级后的名字 | 同一次抓包里比对「请求 body 的 `model`」与「SSE 事件里的 `accepted_public_model`」 |
| U3 | 主对话 SSE 事件的完整字段清单（`loomy.task_id` / `loomy.conversation_id` / `finish_reason` / `usage` / `points_consumed`）与实际 `include_usage` 行为 | 抓 `/api/v1/athena/chat/completions` 的原始 SSE 流，逐事件落盘 |
| U4 | 生产环境的真实域名与凭据：账号网关 baseUrl、`appId`、points 家族 baseUrl、trade 家族 baseUrl（前者来自 `.env.prod` 密文，后者有硬编码默认值但可被 env 覆盖） | 不通过解密：抓一次登录 + 一次对话 + 一次支付，读 `POST /login/phone/sendMsgCode` 的 Host 与 `base.appid`、`POST /api/v1/models` 的 Host、`POST /trade/createOrder` 的 Host |
| U5 | 429 / 服务端并发拒绝的真实形态（客户端没有 `Retry-After` 解析，说明它可能从不遇到，或遇到了只报错） | 并发 6+ 个会话流，观察第 6 个及服务端返回码 |

### 7.4 本次**没有**覆盖的面（避免误读成「不存在」）

- `dist/` 里 minified 渲染层的**全部**请求（只定向核了 `accepted_public_model` 一处），
  渲染层若有直连后端的调用未在 `electron/` 找到对应实现，本清单会漏。
- `R:opencode`、`R:opencode-runtime`、`R:local-model-runtime`、`R:playwright-mcp-runtime` 等**外部运行时二进制**的协议。
- `C:\Users\21877\AppData\Roaming\Loomy` —— **本次完全未读取**（按任务要求不写、也不解析），
  因此「session 落盘的实际键值形态」「leveldb 里缓存的模型/会话状态」不在本清单范围内。
  代码侧的落盘约定可查：`electron/auth/auth-session-runtime.js:17-21`（`auth-session` store 的 4 个键）。
- 微信 / 钉钉 / 企微 / QQ / 飞书 / 微信客服等 IM 通道各自的第三方协议（只列了它们在本地链路里共享的并发闸门）。