# 邀请码「健康号供码」重绑方案（草案 · 仅规划，未实现）

> 状态：**方案稿（T-49 / P4）**。本文只定判据、接口与验收，不改一行代码。
> 用户原话：
> 「账号被封禁 / 降级之后，把不健康账号的邀请码给别人绑定毫无意义（那 5K 积分给了废号）。
> 希望能统计所有健康账号的邀请码，让不健康账号去绑健康账号的码，让健康号拿积分。」
>
> 约束：不动 `src/hooks/*`；不动服务端真实上游调用逻辑（`src/points.mjs` 的端点与语义不动）；
> 面板仍然是「用户手动点」——**默认干跑（只列计划，不提交）**，批量提交必须由用户显式确认。

---

## 0. 一句话结论

把「绑定」从**人工找码**改成**账号级配对**：

```
健康号 H（verdict === "clean" 且有剩余可绑次数）
  └─ 提供自己的邀请码 c（H 自己 GET /invitation-codes 拿到）
不健康号 U（verdict ∈ {routed, expired, exhausted}）
  └─ 用 c 绑定（U 的 POST /points/activation）

一个码还能绑几次 = maxUses − usedCount（服务端自己的计数，别自己猜）
```

「健康号拿积分」这件事**客户端只能间接证明**（见 §6），不要把它写成既成事实。

---

## 1. 健康账号的判定口径

### 1.1 主判据：`loomy-route-state.json` 的 `verdict`

唯一权威来源是路由判定文件（`context.configDir/loomy-route-state.json`，由 `src/route-store.mjs` 读写），
每条 entry 形如：

```json
{ "verdict": "clean", "reason": "ledger-deepseek", "servedModel": "DeepSeek-V4.1-Flash",
  "checkedAt": "2026-11-21T03:12:00.000Z", "label": "正常", "costHint": "已扣 1 积分" }
```

`verdict` 的四档（对应 `routeLabel()`，面板与本文共用同一份文案来源）：

| verdict | 含义（`routeLabel`） | 健康？ | 供码？ |
| --- | --- | --- | --- |
| `clean` | 正常 | ✅ | ✅ 可以供码 |
| `routed` | 已被上游限制 · 整号停用（实际 → `spark-x2.6-low`） | ❌ | ❌ |
| `expired` | 登录已失效 | ❌ | ❌ |
| `exhausted` | 积分不足 · 已停用（充值后自动恢复） | ❌ | ❌ |
| `unknown` / 无记录 | 未检测 / 检测不完整 | ❓ | ❌ **不供码、也不绑**（先检测） |

**判定口径（建议写死，别做「加权分」）**：

```
isHealthy(uid) =
      route[uid].verdict === "clean"
  &&  route[uid].servedModel !== "spark-x2.6-low"        // 双保险：routed 的另一种表现
  &&  quota[uid].daily.remaining > 0                      // 今天还能打（否则「健康」也没用）
```

三处取材字段（都在已有接口里，不必新增上游调用）：

| 项 | 取自 | 字段 |
| --- | --- | --- |
| 路由结论 | `GET /api/route-state`（只读本地文件，0 积分） | `state[uid].verdict` / `.servedModel` |
| 额度 | `GET /api/accounts`（只读 `loomy-accounts-cache.json`） | `accounts[i].quota.windows[]`，窗口名 `额度 · 每日赠送` 的 `amount` |
| 签到/首次初始化 | `GET /api/accounts` + `POST /api/do {action:"first-login"}` | `accounts[i].firstLogin` |

### 1.2 为什么**不**叠加「任务完成数」

任务数（`GET /api/tasks` 的 `8/8`）只影响一次性奖励，和「这个号还能不能正常服务」无关；
把它写进健康判据会让「任务没做完但号好得很」的健康号被误排除。**只作为展示列**，不进判据。

### 1.3 数据新鲜度门槛（否则等于拿旧结论乱配对）

- `checkedAt` 超过 `ROUTE_STALE_MS`（面板侧是 10 分钟，前端常量）→ 标 `stale`，**默认不参与配对**，提示用户点「刷新路由状态」。
- `route-state` 里没有该 uid → `unknown` → 不参与（先「检测」）。
- 额度缓存（`loomy-accounts-cache.json` 的 `updatedAt`）超过 24h → 标 `stale`，只警告不阻断（额度只用来判「今天还能不能打」）。

---

## 2. 谁去绑谁 · 一个健康码能绑几个

### 2.1 方向

```
不健康号（被邀请方）  ──绑──▶  健康号的邀请码（邀请方）
```

理由（用户诉求）：邀请奖励按**码的归属**记，废号拿奖励等于白给；
而「被邀请」这个动作对废号本身没有额外代价（它反正已经不能用），所以让它当被邀请方最划算。

### 2.2 一个码能绑几个：**以服务端 `maxUses` 为准**

`GET /invitation-codes` 每项返回 `{ inviteCode, usedCount, maxUses, status }`
（`src/points.mjs` 的 `fetchInvitationCodes()` 已经把 `inviteCode`→`code` 归一）。

| `maxUses` | 语义 | 还能绑几次 |
| --- | --- | --- |
| `1`（常见） | 一码一人 | `1 − usedCount` |
| `0` | **不限次数**（活动码） | 不限（仍建议设软上限，见下） |
| 缺失 / `null` | 不知道上限 → 保守按 1 处理 | `1 − usedCount` |

所以：

```
capacity(code) = code.maxUses === 0 ? Infinity : Math.max(0, (code.maxUses ?? 1) - (code.usedCount ?? 0))
```

⚠ **不要**自己写「一个码最多绑 5 个」这种硬数字：上游的真实上限就在 `maxUses` 里，
硬数字要么浪费（`0` 的不限次码被限制）要么撞墙（某人 `maxUses: 1` 的码被绑第二次直接失败）。

软上限（仅 UI 建议，不是规则）：一个健康号放出去的码不超过它的**码总数**（实测首登生成 5 个），
避免「一个号把全池的废号都收了」这种反常识的配对结果。

### 2.3 账号状态门槛（比「不健康」更严：能不能绑）

不健康号要能被绑，还必须满足（与现有 `bind-invite` 一致）：

| 条件 | 判据 | 不满足时 |
| --- | --- | --- |
| 未绑定过 | `GET /api/invite` 的 `activation.activated === false` | 跳过（`activated === true` 直接排除） |
| 登录仍有效 | `verdict !== "expired"` | 跳过（登录失效连 `/points/activation` 都打不了） |
| 状态已确认 | `activation` 是明确布尔值 | 跳过（`未知` 不猜，先刷新邀请码） |

---

## 3. 邀请码从哪来

**结论：用面板已有的邀请码缓存，不新增上游接口。**

数据流（全部是既有路径）：

```
POST /api/do {action:"first-login", uid}        // 新号补初始化 → 服务端生成 5 个码（幂等）
        ↓
GET  /api/invite?uids=…                          // 只读 invite-cache.json（0 上游）
        ↓
rows[].codes[] = [{ code, usedCount, maxUses, status }]
```

- 码的**真实来源**是 `GET /invitation-codes`（`src/points.mjs:fetchInvitationCodes`），
  写入 `invite-cache.json`；面板读缓存，**不直接打上游**。
- 健康号必须先「刷新邀请码」（`invite-refresh-batch`）才有 `codes` 落盘；
  没有 `codes` 的健康号在配对里显示「未取码，先刷新」，**不参与配对**。
- 同一个号既是「健康码持有者」又可能是「废号」？不可能——健康与不健康互斥，
  但要注意**同一个码不要重复分配给两个不健康号**，除非 `maxUses > 1`（见 §2.2 的 `capacity`）。

---

## 4. 执行入口

### 4.1 前端（邀请码 tab 增加一块「健康码配对」卡片）

```
┌ 健康码配对 ────────────────────────────────────────────┐
│ 健康号 12 个（可出码 27 个） · 待绑废号 9 个             │
│ [x] 只列计划（干跑，默认勾选）      [生成配对方案]        │
│ 方案预览（表格，虚拟滚动，最多展示 200 行）：            │
│   废号手机号 | 废号 uid | → 健康码手机号 | 码 | 该码剩余  │
│ 全选 / 反选 | 并发 [20] | 间隔 [300ms] | [按方案绑定]     │
│ 结果：成功 N / 失败 M / 跳过 K（原因逐行）               │
└────────────────────────────────────────────────────────┘
```

交互硬约束（贴用户「很多事我自己决定」）：

1. **默认干跑**：`只列计划` 默认勾选；不勾时才允许真正提交。
2. 「按方案绑定」需二次确认，确认框里写清「将调用 N 次绑定，等于 N 次上游写操作」。
3. 复用现有并发/间隔设置（`bindConcurrency` / `gapMs`），不引入新开关。
4. 方案表格里**健康号自己的码不出现在「可被绑」列表**（它不需要绑别人的码）。

### 4.2 服务端接口（新增一个只做配对的端点，不做绑定）

```
POST /api/invite-rebind/plan
  body: { uids?: string[], dryRun?: true }        // 省略 uids = 全部
  200:  { ok: true, pairs: [{ unhealthy, healthy, code, remaining }],
          skipped: [{ uid, reason }], stats: { healthy, unhealthy, codes, paired } }
```

- **纯读**：只读 `loomy-route-state.json` + `loomy-accounts-cache.json` + `invite-cache.json`，零上游。
- 真正的绑定仍走**已有的**：

```
POST /api/do { action: "bind-invite", uid, code }          // 单条
POST /api/do { action: "bind-invite-bulk", mode, codes, count, concurrency }  // 批量（已有）
```

这样「配对」与「绑定」分离：配对可以反复算、结果可审；绑定才花钱、才动上游。

> 若后续发现 bulk 的 `mode` 语义不够用（它按「一条码 → N 个号」或「N 条码 → N 个号」分配，
> 不支持「每个号绑定指定的那条码」），再加一个 `bind-invite-pairs`：
> `body: { pairs: [{ uid, code }] }`，服务端逐对调用 `bindInvite()`，共用同一个并发槽。
> **这一条属于实现阶段再定，不在本文承诺。**

---

## 5. 风险与必须跳过的情形

### 5.1 风控 / 限流

| 风险 | 现实约束 | 缓解 |
| --- | --- | --- |
| 批量绑定像脚本 | 服务端已有全局启动闸 `gapMs`（默认 300ms）+ 连续 3 次限流熔断（`makeThrottle` / 熔断逻辑） | 沿用：绑定走同一个 `startRefreshJob`/工作队列，不另开不受控并发 |
| 同一码短时间内被多次绑定 | 上游可能按「码」限频（**未验证**，见 U-2） | 同一码的绑定串行化（同一 `code` 一次只跑一个） |
| 一次性把 184 个号都绑了 | 用户看不出来 | 干跑 + 二次确认 + 每批最多 50 对（可配，默认 50） |

### 5.2 失败与回滚

绑定是**一写到底**的（`POST /points/activation` 没有「撤销」端点 —— 未在上游文档中出现，按不可回滚处理）。
因此：

- **不做「自动重试」**：失败就是失败，结果逐行落日志（`log()` 已有 500 条环形缓冲）。
- **不做「回滚」**：没有撤销接口，任何「回滚」都是假的。失败时的正确处理是
  「把该号标成 `绑定失败（原因）`，并提示用户去上游核实」。
- **幂等**：绑定前再查一次 `activation`（`false` 才提交）；提交后无论成功失败都刷新该号邀请码缓存，
  让下一次配对看到真实状态，而不是本地乐观值。

### 5.3 必须跳过（写进 `skipped[].reason`，让用户看见原因）

| 情形 | reason |
| --- | --- |
| 健康码自己 | `healthy-self`（健康号不绑别人的码） |
| 该号已绑定 | `already-activated` |
| 该号登录失效 | `session-expired` |
| 该号状态未知 | `activation-unknown`（先刷新邀请码） |
| 该号未被检测 / 结论过期 | `route-unknown` / `route-stale` |
| 健康码没取到码 | `healthy-no-code`（先刷新该健康码） |
| 码已用尽 | `code-exhausted` |
| 码剩余次数不够分配 | `code-capacity` |
| 同一个号在本次被配了两条 | `duplicate-uid`（去重，不重复提交） |

---

## 6. 验收：怎么证明「绑定后是健康号拿到了积分」

客户端**看不到**「奖励记给了谁」这件事的权威字段（`/points/activation` 只回 `activated` 与
`inviteCode`，不带奖励归属）。所以验收分三层，前两层能自动断言，第三层必须人看：

### 6.1 第一层：配对正确（可自动）

- 干跑产出的每一对里，`healthy` 的 `verdict === "clean"`、`unhealthy` 的 `verdict !== "clean"`；
- `pairs` 里 `unhealthy` 不重复、`code` 的剩余次数够用（`remaining >= 1`）；
- `skipped` 覆盖 §5.3 的每一条（用固定 fixture 逐条构造）。

### 6.2 第二层：绑定真的落地（可自动）

- 绑定后 `GET /api/invite`（缓存）里该号 `activation.activated === true` 且 `applied === code`；
- 该码的 `usedCount` +1（重新刷新该健康码的邀请码后比对，允许 `maxUses: 0` 的码跳过计数断言）；
- 绑定失败时**不能**出现 `activated === true`（防止「假成功」）。

### 6.3 第三层：奖励归属（人工，一次）

在真机上做一次 A/B，各 1 个号，记录前后余额：

```
# 记录：健康号 H 的余额（永久 / 每日），废号 U 的余额
GET /points/balance（面板「查余额」）        →  H.before, U.before
# 用 H 的码绑 U
POST /points/activation { inviteCode: H.code }（面板「按方案绑定」）
# 再记录
GET /points/balance                          →  H.after,  U.after
```

判据（写成会失败的命令，别写「应该会」）：

| 断言 | 失败意味着 |
| --- | --- |
| `H.after.permanent − H.before.permanent ≥ 5000`（数值以实测奖励为准） | 奖励没记给邀请方 → 本方案的**唯一目的不成立**，必须停下来重新评估 |
| `U.after.permanent − U.before.permanent ≥ 注册奖励` | 注册奖励没到 → 说明该号之前没做 `first-login`，不是本方案的错 |
| `GET /points/activation` 在 U 上 `activated === true && applied === H.code` | 绑定没落地 |

⚠ `5000` 来自 `src/points.mjs` 对 `registerReward` 的实测注释（**是注册奖励，不是邀请奖励**）。
**邀请方拿到多少，未验证**（U-1）。第三层不通过，本方案整体作废 —— 不要「先上线再观察」。

---

## 7. 未验证项（实施前必须先钉死）

| 编号 | 未知点 | 为什么重要 | 怎么验（一次真机 / 一次抓包） |
| --- | --- | --- | --- |
| U-1 | 邀请奖励记给**邀请方**还是被邀请方？金额多少？ | 整个方案的前提 | §6.3 的 A/B |
| U-2 | 同一个码被多个不同账号绑定时，上游是否限频/风控？ | 决定是否要按码串行 | 同一个 `maxUses: 0` 的码连绑 3 个号，看是否有 429 / 静默失败 |
| U-3 | `maxUses` 是否会随绑定实时递减（缓存里是旧值） | 决定「剩余次数」要不要每次重读 | 绑 1 次后重刷该健康码，比对 `usedCount` |
| U-4 | 一个账号被「邀请」后，是否还能当邀请方（双向） | 决定健康号能不能同时收码 | 让健康号 H 绑一次别人的码，看 H 的 `codes` 是否仍可生成/可用 |

---

## 8. 分阶段实施（建议，不在本次范围）

| 阶段 | 内容 | 是否动上游 | 验收 |
| --- | --- | --- | --- |
| M1 | `POST /api/invite-rebind/plan` + 干跑表格（只读） | 否 | §6.1 的断言全绿 |
| M2 | 单对绑定（选一行 → 「绑定这一对」） | 是（1 次写） | §6.2 + §6.3 人工确认 |
| M3 | 批量绑定（无「按对提交」前用 `bind-invite-bulk` 近似） | 是（N 次写） | §6.2 + 熔断/跳过用例 |

M1 与 M2 之间必须先过 §6.3（U-1）。U-1 不成立 → 停止，别做 M2。

---

## 9. 明确不做的事

- 不动 `src/hooks/*`（另一条任务线在管）。
- 不改 `src/points.mjs` 的端点、路径、请求体语义（只调用不改）。
- 不做「自动绑定 / 定时绑定」（用户明确：这些事他自己决定）。
- 不做「把健康号的码批量导出去卖给第三方」（与需求无关，且属于外部风险面）。
