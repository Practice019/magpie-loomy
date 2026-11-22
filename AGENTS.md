# AGENTS.md —— 给后续维护者的入口

> 人类请读 [README](./README.md)。这份只回答两件事：
> **你在改哪一块、以及忘了哪一条会静默出错。**

---

## 零、先读这条：**不要重启 magpie**

`127.0.0.1:3425` 这个网关**就是 `magpie-windows-amd64` 进程本身**。停它一次，
所有模型请求立刻全断（DSH、agent 会话、正在跑的对话全部中断）。它不是
「重启一下就好」的进程，它是**生产流量入口**。

**改完怎么生效：**

```
1. 改代码 → npm test 全绿
2. git commit + 打 tag + git push（github:Practice019/magpie-loomy）
3. 用户在 magpie 界面点「更新」→ 热加载，不重启
```

**反例（都真实发生过，别再犯）：**

| 错误做法 | 后果 |
|---|---|
| `Stop-Process` 后重启 magpie | 模型中断 2~3 秒，进行中的请求全失败 |
| 改完本地 `plugins/node_modules` 就以为生效 | 下次拉取被 GitHub 旧版覆盖，改动全丢 |
| 改完仓库但**没 push** 就重启 | 重启拉回旧代码，改动同样全丢 |

**永远不要**：`Stop-Process` / `Start-Process` 任何 `magpie*`、手改
`plugins/node_modules/**`、手改 `plugin-providers.json`（运行中进程会覆盖它）。

**验证下发内容用字节数，不要用 `.Length`**：`Get-Content -Raw` 得到的是**字符数**，
中文 UTF-8 每字 3 字节，会让人把「59,766 字节 / 49,152 字符」误判成「48 KiB 截断」。
逐字节比对请用 `[IO.File]::ReadAllBytes()`。

### 发现 magpie 重启了，先别怪人

它自己会升级：`settings.json` 的 `updateEvery`（默认 360 分钟）到点就去 GitHub
看新版，下载成 `magpie-windows-amd64.exe.new`，替换后重启自己。升级日志会写：

```
%LOCALAPPDATA%\magpie\logs\app.log
  magpie <版本> started (app, pid …)
  update: … .exe.new goes on without its GitHub build attestation checked
```

判断顺序：
1. 先看 `app.log` 里有没有 `update:` 与新的 `started` 行 —— 有 = 自更新，与本项目无关
2. 再看版本号有没有变（升级前 0.1.4501 → 升级后 0.1.4624）
3. 两者都不成立，才怀疑有人手工重启

**要关掉自动升级**：在 magpie 设置界面改（不要手改 `settings.json` —— 运行中的进程会覆盖它）：
把「自动检查更新」关掉，或把 `updateEvery` 设为 0。

---

## 一、先定位你在哪一步

| 你在做什么 | 先读 | 做完的判据 |
|---|---|---|
| **第一次接手** | README → 本文件 | 能说清「哪些事 magpie 已经做了、插件不该重做」 |
| **改登录** | `src/hooks/methods.mjs`、`src/sms-login.mjs`、`src/client-store.mjs` | `npm test` 绿 + 真机登录成功 |
| **改请求转发** | `src/hooks/loader.mjs`、`src/prepare-body.mjs`、`src/auth-headers.mjs` | `magpie provider test loomy` 通过 |
| **改额度/积分/任务/邀请码** | `src/points.mjs`、`src/usage.mjs` | `magpie accounts` 里额度显示正确 |
| **改模型目录缓存** | `src/models-cache.mjs`、`src/hooks/models.mjs` | `npm test` 里 `models-cache.test.mjs` 全绿（301 并发只 1 次上游） |
| **改面板** | `server.mjs`、`page/` | `node server.mjs` 后四个标签页都能出数据 |
| **上游改了模型名** | `src/models.mjs` | 静态表能对上实时目录，倍率解析正确 |

---

## 二、会静默出错的坑（症状 → 判据 → 出处）

| # | 症状 | 判据 | 出处 |
|---|---|---|---|
| 1 | 拉模型目录拿到一段没有模型的 JSON，但状态码是 **200** | `/models` 必须用 **`token:`** 头，`/chat/completions` 必须用 **`Authorization: Bearer`**。用错返回 200 + `{"code":"100002","desc":"缺少 token"}` —— **不能靠状态码判断** | `src/auth-headers.mjs` |
| 2 | 账号卡显示「未登录」、额度区一片空白 | 登录结果必须是 **`oauth` + `access`**，不能是 `api` + `key`。实测：`type:"api"` 的凭证 magpie **不会调用 `auth.usage`** | `src/hooks/methods.mjs` 的 `successResult` |
| 3 | 额度窗口不显示 / 路由把耗尽的账号顶到队首 | `windows[].used` 是**路由输入**。没有 `used` 的窗口只当文本；而 `used: 0` 会被当成「满额」 | `src/usage.mjs` |
| 4 | 「免费额度」显示 0，但账号其实一直在成功请求 | `daysKnown` / `permanentKnown` 的 presence 标记不能丢 —— **「字段缺失」≠「值是 0」** | `src/points.mjs` 的 `fetchPointsSnapshot` |
| 5 | 「我生成的邀请码」永远是空的 | 回执字段是 **`inviteCode`**，不是 `code`。猜错一个字段名 = 整块功能看起来没做且不报错 | `src/points.mjs` 的 `fetchInvitationCodes` |
| 6 | 模型「能跑但收不了图」，或者把截图直发上游被拒 | 模型条目的能力**只能来自上游**（`capabilities` / `vision` / `input_modalities` → `mapUpstreamCapabilities`），且 `attachment` 与 `modalities.input.image` 必须同源。**不许写死 `false`**：写死之后 magpie 的「识图模型」下拉框里一个 loomy 模型都没有，路由组选它发图就卡死。上游没给能力字段时才回落 `["text"]`。省掉字段同样不行（≠ 按 text 处理，会退到 models.dev 按同名模型投票） | `src/hooks/models.mjs` 的 `mapUpstreamCapabilities` |
| 6b | 发了图但上游收到的是一条纯文本请求 | loader 遇到 `messages[].content` 是**数组**（多模态）时必须原样透传，**不许裁剪 `image_url`**。`client-body` 只换 model/messages，不做内容整理 | `src/client-body.mjs`、`tests/multimodal-passthrough.test.mjs` |
| 7 | 点了登录界面转圈很久 | `authorize()` 必须**立刻返回**，网络请求一律挪到 `callback()` / `ask()` 里。有测试钉死（`methods.test.mjs` 的「authorize 立刻返回」） | `src/hooks/methods.mjs` |
| 8 | 插件页显示「已停止工作」 | 插件页 10 秒内必须和 bridge 握手。`page/gateway.html` 必须加载 `_magpie/bridge.js` | `page/gateway.html` |
| 9 | 面板打开是空白 / 一片 404 | 插件页是**沙盒 iframe**（CSP `connect-src 'none'`），页面内不能 fetch。必须**导航**到 `page.service` 的地址，不能在沙盒里画 | `page/boot.js`、`server.mjs` |
| 10 | 导入后 magpie 里看不到新账号 | `plugin-auth.json` 写完后，宿主不会自动重读 —— 要在插件管理里**关掉再打开** | `server.mjs` 的 `importAccounts` |
| 11 | `provider test` 偶尔超时 | **上游本身慢**（实测 TTFB 13s–81s），不是插件问题。`provider test` 有 30s 上限 | 实测 2026-11-17 |
| 12 | `config` 钩子里的 `tool_call` 写成 `toolcall` 不生效 | 两个位置两种拼写：`config` 里是 **`tool_call`**，`provider.models` 返回值里是 **`toolcall`** | `src/hooks/config.mjs` vs `src/hooks/models.mjs` |
| 13 | 把 `async server(){}` 放进插件返回的钩子对象里，**永远不会被调用** | 页面服务**不是钩子**。magpie 只读 `config`/`auth`/`provider`/`chat.headers` 这几个名字。服务必须是**模块级的具名导出函数**（本仓库的 `LoomyPage`），它自己 `listen` | `index.mjs`、magpie 源码 `internal/plugin/testdata/pageservice/index.js` |
| 14 | 插件里读 `options.port` 拿到 `undefined`，面板起不来 | magpie 传的 `options` 是**用户在 plugins.json 里实际设置的值**（`host.js` 的 `chosen = p.options ?? {}`），**不是 `package.json` 的默认值**。必须三级回退：`options.port` → `$PAGESVC_PORT` → `package.json` 的 `magpie.page.service.port` | `index.mjs` 的 `resolvePort` |
| 15 | 命令行里 `magpie plugin on/off/list` 之后面板没起来 | 那些命令的宿主**不提供页面服务**（`ServePages(false)`）。只有 **app / magpie web / serve / tray / tui** 才会跑插件服务。命令行宿主还会把 `port` 挪到一个空闲口（`hostOptions`），避免和 app 宿主抢 | magpie 源码 `internal/plugin/host.go` 的 `ServePages` |
| 16 | 端口被占用时面板起不来 | 端口是 **magpie 指定的**，不能顺延（顺延后 magpie 记的地址与实际不符 → 页面导航到拒绝连接）。正确做法是**每 500ms 重试、最多 30 秒** | `server.mjs` 的 `listenRetrying` |
| 17 | **额度窗口全都不显示**，只看到一句话 | `usage` 返回值里的 `error` 是**替代 windows 显示**的（HOOKS：「error?: string // 替代 windows 显示」）。任何附加信息（任务进度、'这是缓存数据'）塞进去，整个额度区就被那一句话替换掉 —— 数据其实全在。附加信息写进窗口的 `name` | `src/hooks/usage.mjs`、`src/usage.mjs` |
| 18 | 「从文件导入账号…」按钮不出现 | 要导出 `auth.import(texts, {signal})` **和** `auth.importFrom`（一句话说明要选什么文件）。`import` 的返回值必须与登录结果**同形**（`{type:"success", access, …}`），magpie 按登录的方式保存它 | `src/importer.mjs`、`index.mjs` |
| 19 | 模型名显示成 `DeepSeek V4.1 Flash(x2.0) 2×`（倍率重复） | 从官方展示名解析出倍率后，**要把后缀从名字里摘掉** —— magpie 自己会在模型旁显示 `2×` | `src/hooks/models.mjs` 的 `withMultiplier`/`stripMultiplier` |
| 20 | 面板**渲染出来了**但所有 API 都 `TypeError: Failed to fetch` | 面板页可能是从 magpie 的沙盒 frame **导航**进来的，那种上下文里 `location.origin` 是 `"null"`（opaque origin）⇒ 相对路径 `/api/x` 没有可解析的 base，`fetch` 直接失败。**请求与资源一律用绝对地址** `http://127.0.0.1:<port>/…` | `page/index.html`、`page/assets/app.js` 的 `BASE` |
| 21 | 同上，且服务端 CORS 明明正常（任何 Origin 都回 200 + `ACAO: *`） | 说明问题在**客户端**不在服务端。CSP 里 `connect-src 'self'` 在 WebView/沙盒上下文里可能匹配不上真实 origin（magpie HOOKS 记过这条 WebKit 坑）。本插件的面板页没有第三方内容，所以 `connect-src *` 是**有意为之** | `server.mjs` 的 `commonHeaders` |
| 22 | 进度条满了但文字显示「0%」 | `usage.windows[].used` 是**已用**百分比，条要画**剩余**。两者不能混用：文字只给绝对量（`4,977 / 5,000`），条画 `剩余/上限` | `page/assets/app.js` 的 `meter` |
| 23 | 邀请码「用了 6 次、上限 20」被标成已用完 | 判据是 `status === "exhausted"` **或** `maxUses > 0 && usedCount >= maxUses`。⚠ `maxUses: 0` 是**不限次数**，不能被 `?? 1` 吞成 1 | `page/assets/app.js` 的 `isCodeExhausted`、`src/points.mjs` |
| 24 | 新手任务**全部都显示未完成**，但账号其实早就 8/8 了 | `/onboarding/tasks` 的 `data.tasks` 是**对象**（`{key: true}`），**不是数组**。只认数组会把「8 项全完成」解析成 `{}` ⇒ 界面显示 0/8。⚠ 同级还有 `earned` / `total` 两个数字，不能当任务状态混进来 | `src/points.mjs` 的 `fetchTasks` |
| 25 | 按钮点了没反应（前端事件绑不上） | HTML 的 `id` 与 JS 的 `$("#id")` 必须逐字对齐。本仓库有一次写成 `bind-start` vs `bind-run`。改完跑一遍 id 对齐检查 | `page/index.html`、`page/assets/app.js` |
| 26 | 面板说可用号很多，实际能用的就那么几个（routed 号又有模型了） | **置空判定必须排在缓存查询之前**。`catalogOnce` 命中 `loomy-models-cache.json` 会直接返回，判定写在它后面就永远轮不到（真机：281 vs 71）。判据：`tests/models-route-blank.test.mjs` 的 T44-2（先写缓存、再断言 `{}`）；真机核对跑 `node scripts/route-blank-stats.mjs` | `src/hooks/models.mjs`、`scripts/route-blank-stats.mjs` |
| 27 | 慢号照样被派活 / 面板「刷新速率」把号打挂 | 速率**只从 magpie 自己记的请求**取（`GET /v1/magpie/usage/requests?period=7d&rows=100&provider=loomy`，本机）。三条不许破：① `POST /api/speed/refresh` 是**唯一**取数入口，`config` / `auth.*` 钩子一个都不许调它（启动瞬间会被调几百次）；② `provider.models` 里的跳过判定**零请求**，只读 `<configDir>/loomy-speed-cache.json`；③ 判定看**最近一次**不看平均（20×130 + 1×25 的突发限速，平均值仍≈125 判不出来）。口径与推导在 `src/speed.mjs` 顶部，判据在 `tests/speed*.test.mjs` | `src/speed.mjs`、`src/speed-cache.mjs`、`src/hooks/models.mjs`、`server.mjs` |
| 28 | 某个模型下的号成批被判「慢」，但这些号实际并不慢 | magpie 的 `usage/requests` 里有 `flow_ms=1` 的异常行（实测 1000 行里 28 条，`out=94/flow_ms=1` → **94000 tok/s**）。它只会让速率**虚高**。B 取中位数挡得住少数离群，但某模型里这种行**过半**时 B 本身会被抬高（实测 `DeepSeek-V4.1-Flash` 34 号、16 个 A>2000、median=48000）⇒ 阈值跟着虚高 ⇒ 正常号被判 slow。所以 B 加了**物理上限** `B_MAX=1000`（真实解码峰值 300–500 tok/s；越过就判该模型「无参考」⇒ 该模型不进 `b`、全员 unknown、一个号都不摘）。**这是 magpie 侧的计时粒度问题，不是我方过滤漏了** —— 别去加行级 `flow_ms` 下限来「修」它 | `src/speed.mjs` 的 `B_MAX` / `buildSpeedTable` |

---

## 三、边界：哪些事**不要**在插件里做

| 不要写 | 因为 magpie 已经做了 |
|---|---|
| HTTP 客户端（重试、连接池、读流、背压） | 宿主的 `fetch` 就是客户端，`loader` 只要返回 `baseURL` + `headers` |
| 故障转移 / 换号 / 熔断 / 冷却 | magpie 网关负责（限流、5xx 自动换账号或模型） |
| 协议转换（OpenAI ↔ Anthropic ↔ Gemini） | 宿主按模型的 `npm` 自动做 |
| 签到调度 | `auth.checkin` 由宿主按北京日每账号一次调度（**本上游没有签到，所以不实现**） |
| token 续期调度 | `auth.refresh` 由宿主串行化调用（**本上游没有 refresh，所以不实现**） |
| 工具（生图 / 联网搜索） | 宿主自己的 MCP；本插件的 `loader.fetch` 已能接住 `/images/generations` |
| 账号列表 UI | 宿主画（本插件只提供面板里的任务/邀请码/导入） |

**造空实现是有害的**：一个空的 `auth.refresh` 会让 magpie 以为「这个上游能自动恢复」，
从而把「换号重试」当成有效处置 —— 而现实是只能人工重登。

---

## 四、两条实测事实（改代码前必须知道）

1. **模型目录是 provider 级属性，只能拉一次。**（T-38 修正）
   原来是「每个账号问一次」—— 301 个号 × 每次 magpie 重读列表 = 301 次请求，
   开发者一天重启 8 次 ≈ 2400 次，服务端判成**批量探测** ⇒ 风控 ⇒ session 失效
   （实测 19 个 expired，18 个 session-expired）。**掉号的根因就是我们自己打的。**
   现在：`<configDir>/loomy-models-cache.json` 文件缓存（**无 TTL，永不自动失效**）
   → 命中即返回、零上游；未命中时模块级单飞去重，整个 provider 只拉一次；
   失败不写缓存（下次还能重试）。想刷新就删文件 / 调 `clearModelsCache`。
   判据全在 `tests/models-cache.test.mjs`（含「301 并发只 1 次」）。
2. **session 不会过期，也没有 refresh token。** 证据：客户端重启多次 session 值不变、
   Local Storage 里该键只 1 条历史、源码里没有 refresh 判断、`/models` 响应无 expires。
   所以 `expires: 0` 是**正确表达**，不是占位符；也就**不实现** `auth.refresh`
   （空壳会让宿主误判「能自动恢复」）。

## 四之二、响应体自带模型名（不再需要 by-turn）

实测 `stream:true` 时**每个 SSE chunk 都带 `model`**：

```
data: {"object":"chat.completion.chunk","model":"deepseek-v4-flash-1017",…}
```

所以「这一轮实际由谁服务」读响应体首块就够，`/points/by-turn`（那次额外计费
chat + 轮询账本）**整段删除**。要点：

- 读法是 `body.tee()`，**不是** `Response.clone()`（clone 读到 EOF 会压平时间轴，
  见 `tests/loader-peek.test.mjs` 的红线）。
- 观察分支读到首个 `model` 就 `cancel()`（只结束它自己，不影响宿主那支）。
- **必须返回新 Response**（`ResponseWithTeedBody`），不能在原对象上
  `defineProperty(body)` —— `text()/json()` 读的是内部槽，改访问器会让每次普通
  对话都抛 `Body is unusable`（真机回归过）。
- 非流式 JSON 200 **不 tee**：那条路由 sign-in peek 整读。
- 结果只写 `route-state`（`served-model-mismatch` / `served-model-match`），
  **不做拦截**（「别选我」只走 `provider.models` 空目录）。

---

## 五、测试约定

- 所有测试都在 `--import ./tests/helpers/network-guard.mjs` 下跑：**任何真实网络请求都会抛错**。
- 需要上游响应的用例自己注入 `fetchImpl`（见 `tests/methods.test.mjs` 的 `okUpstream()`）。
- 测试只验行为，不验实现细节；不做同义反复。
