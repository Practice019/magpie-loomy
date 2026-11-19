// methods.mjs 三种登录方式。
//
//	① 本机客户端登录态   读 leveldb，无需任何交互
//	② 手机号 + 验证码     讯飞账号网关，HMAC-SHA1 签名
//	③ 粘贴 session        从别处拿到的一串 32 位 hex
//
// # 三条硬规则（magpie 契约，踩了会死锁或静默失败）
//
//	⚠ `authorize()` 必须**立刻返回**：真正等待的是 `callback()`。
//	  在 authorize 里发网络请求会让 magpie 拿不到 url 而死锁。
//
//	⚠ `authorize` 里**不要抛异常**：抛出去 magpie 只会看到一次失败，
//	  没有原因。一律 `return { type: "failed", error }`。
//
//	⚠ 判断「问过没有」用 `Object.prototype.hasOwnProperty.call(inputs, key)`，
//	  不要用 `inputs[key] !== undefined` —— 用户填了空字符串也是「问过了」。
//
// # 多步问答（短信那条路）用 `ask()`
//
// `prompts` 是**静态**的：magpie 读它列问题，一次问完。而短信登录是
// 「先要手机号 → 发码 → 再要验证码」，必须用 `ask(inputs)` 每次返回
// **下一个**问题，问完返回 null。
//
// ⚠ 同时保留 `get prompts()`：只给 ask 不给 prompts，那条登录方式
// 在列表里看起来像什么都不问。

import { readLocalAuth, defaultClientStoreDir } from "../client-store.mjs"
import { parseCredential, looksLikeSession, shortUID } from "../credential.mjs"
import { AccountGateway, looksLikePhone } from "../sms-login.mjs"
import { firstLogin } from "../points.mjs"
import { DEFAULT_BASE_URL } from "../constants.mjs"
import { makeImportHook } from "../importer.mjs"

const has = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k)

/**
 * 取 DS4.1 路由探测模块（`src/route.mjs` + `src/route-store.mjs`）。
 *
 * ⚠ 这两个模块由另一条任务线并行开发，本分支上**可能还不存在** ——
 * 所以一律 `import(...).catch(() => null)`：缺失就是「不探测」，绝不抛。
 *
 * 结果缓存到进程级：一次登录失败不该每次都重新 import 一遍。
 * （模块被补上后要重启 magpie 才会生效 —— 重载插件会换新进程。）
 *
 * @type {Promise<null | {probeRoute: Function, writeRouteState?: Function}>|null}
 */
let routeModules = null

function loadRouteModules() {
  routeModules ??= (async () => {
    const [probe, store] = await Promise.all([
      import("../route.mjs").catch(() => null),
      import("../route-store.mjs").catch(() => null),
    ])
    if (typeof probe?.probeRoute !== "function") return null
    return {
      probeRoute: probe.probeRoute,
      writeRouteState: typeof store?.writeRouteState === "function" ? store.writeRouteState : undefined,
    }
  })()
  return routeModules
}

/** 一次登录会话的中间状态（短信那条路要跨 ask/authorize 传递）。 */
/** @type {Map<string, {phone?: string, msgid?: string}>} */
const pending = new Map()

/**
 * 把一份凭证包成 magpie 要的登录成功结果。
 *
 * # 为什么用 oauth（access）而不是 api（key）
 *
 * 实测（2026-11-17）：`type: "api"` 的凭证 magpie **不会调用 `auth.usage`**，
 * 账号卡片显示「未登录」，额度区一片空白。
 * 只有 `type: "oauth"` 的账号才会被当成「订阅」去问额度。
 *
 * 所以即便本上游的凭证其实是一把静态 session，也必须以 **oauth + access**
 * 的形态落盘 —— 这是 magpie 侧的形状要求，不是上游的事实。
 *
 * ⚠ `expires: 0` 有明确语义：「这个凭证不会过期、不要尝试续期」。
 * 与「不实现 auth.refresh」是同一件事的两种表达。
 *
 * @param {object} cred
 * @returns {object}
 */
function successResult(cred) {
  return {
    type: "success",
    access: cred.session,
    // 本上游没有 refresh token（session 不过期）。给空串而不是省略字段：
    // magpie 按「有 refresh 才续期」判断，空串同样是「没有」。
    refresh: "",
    // 0 = 不会过期、不要续期。写一个未来的时间戳会让宿主去调不存在的 refresh。
    expires: 0,
    // 账号名：手机号（掩码）优先，与其他上游统一
    accountId: cred.nickname || shortUID(cred.uid),
    uid: cred.uid,
    metadata: {
      uid: cred.uid,
      nickname: cred.realNickname || cred.nickname,
      phone: cred.phone,
      userId: cred.userId,
      loggedInAt: cred.loggedInAt,
    },
  }
}

/**
 * 构建 `auth.methods`。
 *
 * @param {{baseUrl?: string, clientStoreDir?: string, fetchImpl?: typeof fetch, log?: object}} opts
 * @returns {object[]}
 */
export function makeMethods(opts = {}) {
  const baseUrl = String(opts.baseUrl ?? DEFAULT_BASE_URL)
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = opts.log ?? console
  // 状态文件落在 magpie 的配置目录下（index.mjs 已经把它传进来了）
  const configDir = String(opts.configDir ?? process.env.MAGPIE_CONFIG_DIR ?? "").trim()

  /**
   * 收尾：包成 magpie 要的登录结果，并在**后台**触发补初始化 + DS4.1 路由探测。
   *
   * ⚠ 这里必须是同步返回的（AGENTS.md 坑 #7）：任何 `await` 都会让 magpie 的
   * 登录界面一直转圈。补初始化与路由探测都挂在 `void` 上，失败只记 warn。
   *
   * @param {object} cred
   * @returns {object} 登录结果
   */
  const finish = (cred) => {
    const result = successResult(cred)
    void afterLogin({
      baseUrl,
      doFetch,
      log,
      configDir,
      cred,
      // uid 取**登录结果**的 metadata：magpie 落盘用的就是它，两边必须一致，
      // 否则面板上的 uid 与状态文件里的 uid 会对不上。
      uid: String(result.metadata?.uid ?? cred.uid ?? ""),
      routeModules: opts.routeModules,
    })
    return result
  }

  /** ① 本机客户端登录态 —— 读 leveldb，零交互 */
  const localMethod = {
    type: "oauth",
    label: "Loomy 桌面端登录态（自动读取本机客户端）",
    /**
     * ⚠ 立刻返回：真正的等待在 callback 里。这里只做一次同步读盘 + 校验，
     * 读盘是毫秒级的，但校验要发一次请求 —— 也放在 callback 里做，
     * 免得 authorize 卡住导致 magpie 拿不到 url 而死锁。
     */
    async authorize() {
      const dir = opts.clientStoreDir ?? defaultClientStoreDir()
      if (!dir) {
        return {
          type: "failed",
          error: "本机没有找到 Loomy 客户端的数据目录。请先安装并登录 Loomy 桌面端，或改用手机号登录 / 粘贴 session。",
        }
      }
      let read
      try {
        read = readLocalAuth(dir)
      } catch (e) {
        return { type: "failed", error: `读取客户端数据目录失败: ${e?.message ?? e}` }
      }
      if (!read.credential) {
        const hint = read.source
          ? `已扫描 ${read.source}，但里面没有完整的登录态记录（客户端可能未登录）。`
          : "目录里没有可用的 Local Storage 数据文件（.log/.ldb/.sst）。"
        return { type: "failed", error: hint + "请先在客户端登录，或改用手机号登录。" }
      }
      return {
        url: "about:blank",
        instructions: "已读到本机客户端的登录态，正在验证…",
        method: "auto",
        // true = 不给用户开任何页面
        opened: true,
        async callback() {
          const cred = read.credential
          // 验证一次：能被 /models 认下的 session 才收
          try {
            await verifySession(baseUrl, cred.session, doFetch)
          } catch (e) {
            return { type: "failed", error: `读到的 session 不可用: ${e?.message ?? e}` }
          }
          return finish(cred)
        },
      }
    },
  }

  /** ② 手机号 + 验证码 —— 多步问答 */
  const smsMethod = {
    type: "oauth",
    label: "手机号 + 短信验证码",
    get prompts() {
      // 面板上的列表靠它；真正的多步由 ask() 驱动
      return [
        { type: "text", key: "phone", message: "手机号（中国大陆 11 位）", placeholder: "13800000000" },
      ]
    },
    async ask(inputs) {
      const state = String(inputs?.__state ?? "")
      if (!has(inputs, "phone")) {
        return {
          type: "text",
          key: "phone",
          message: "手机号（中国大陆 11 位）",
          placeholder: "13800000000",
          validate: (v) => (looksLikePhone(v) ? undefined : "请填写 11 位手机号"),
        }
      }
      // 收到手机号 → 发一次码，然后要验证码
      if (!has(inputs, "code")) {
        const phone = String(inputs.phone ?? "").trim()
        try {
          const msgid = await new AccountGateway({ fetchImpl: doFetch }).sendCode(phone)
          pending.set(state, { phone, msgid })
        } catch (e) {
          // 发码失败**不在这里抛**：返回一个提示型问题让用户改手机号重试
          pending.delete(state)
          return {
            type: "text",
            key: "phone",
            message: `验证码发送失败（${e?.message ?? e}），请确认手机号后重新填写`,
            placeholder: "13800000000",
          }
        }
        return {
          type: "password",
          key: "code",
          message: `验证码已发送到 ${phone}，请输入 6 位验证码`,
        }
      }
      return null // 问完了
    },
    async authorize(inputs) {
      // ⚠ 不抛异常：一律返回 failed 带原因
      const phone = String(inputs?.phone ?? "").trim()
      const code = String(inputs?.code ?? "").trim()
      if (!looksLikePhone(phone)) return { type: "failed", error: "请填写 11 位手机号" }
      if (!code) return { type: "failed", error: "请填写短信验证码" }

      const state = String(inputs?.__state ?? "")
      const saved = pending.get(state)
      const msgid = saved?.msgid ?? ""
      if (!msgid) {
        return { type: "failed", error: "登录会话已过期（没有记录到 msgid），请重新发起" }
      }

      let cred
      try {
        cred = await new AccountGateway({ fetchImpl: doFetch }).login(phone, code, msgid)
      } catch (e) {
        return { type: "failed", error: String(e?.message ?? e) }
      } finally {
        pending.delete(state)
      }

      return finish(cred)
    },
  }

  /** ③ 粘贴 session */
  const pasteMethod = {
    type: "oauth",
    label: "粘贴 session",
    get prompts() {
      return [
        { type: "password", key: "session", message: "session（32 位小写 hex）", placeholder: "复制客户端登录态里的 session" },
        { type: "text", key: "phone", message: "手机号（可选，用于显示账号名）", placeholder: "13800000000" },
      ]
    },
    async authorize(inputs) {
      const session = String(inputs?.session ?? "").trim()
      if (!session) return { type: "failed", error: "请粘贴 session" }

      // ⚠ 形态只告警不拒绝：上游随时可能改格式，硬校验会把一个仍然可用的
      // 凭证拒之门外，而用户看到的是「一填就报错」—— 那种错误最难归因。
      if (!looksLikeSession(session)) {
        log.warn?.(`loomy: 粘贴的 session 不是 32 位小写 hex（实测形态如此），仍按原样使用`)
      }

      try {
        await verifySession(baseUrl, session, doFetch)
      } catch (e) {
        return { type: "failed", error: `session 无效或已过期（拉取模型目录失败）: ${e?.message ?? e}` }
      }

      let cred
      try {
        cred = parseCredential({
          session,
          phone: String(inputs?.phone ?? "").trim(),
        })
      } catch (e) {
        return { type: "failed", error: String(e?.message ?? e) }
      }

      return finish(cred)
    },
  }

  return [localMethod, smsMethod, pasteMethod]
}

/**
 * 用一次 `/models` 验证 session 是否可用。
 *
 * ⚠ 必须用 `token:` 那条轨（`modelsAuth`），用 Authorization 会拿到
 * HTTP 200 + 「缺少 token」，那样验不出真假。
 *
 * @param {string} baseUrl
 * @param {string} session
 * @param {typeof fetch} doFetch
 */
export async function verifySession(baseUrl, session, doFetch) {
  const headers = new Headers({ Accept: "application/json", token: session })
  const url = String(baseUrl).replace(/\/+$/, "") + "/models"
  const resp = await doFetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) })
  const text = await resp.text()

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  // 业务失败也是 200 —— 必须看正文
  if (text.includes("缺少 token") || text.includes("登录已失效")) throw new Error("上游说登录已失效")

  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("模型目录不是合法 JSON")
  }
  const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : []
  if (list.length === 0) throw new Error("模型目录为空")
}

/**
 * 登录成功后的「补初始化」+ DS4.1 路由探测。
 *
 * # 首登初始化为什么必须做（源项目里「邀请码不显示」的根因）
 *
 * 客户端每次登录后会自动调它：服务端下发注册奖励（实测 5000）并
 * **生成 5 个邀请码**。而通过第三方导入的账号跳过了这一步 ——
 * 表现就是「我生成的码」永远空、注册奖励也没到账。
 *
 * 服务端有 `alreadyProcessed` 幂等保护，重复调用不会重复发奖。
 *
 * # DS4.1 路由探测为什么也挂在这里
 *
 * 上游对**被限制的账号**会把 `DeepSeek-V4.1-Flash` 实际落到 `spark-x2.6-low`，
 * 而 `/models` 与 chat 响应都看不出来 —— 唯一权威信号是积分账本
 * （`GET /points/records` 里的 `modelName`）。登录是唯一「一定有人在场」的
 * 时刻，顺手探一次并落盘，面板打开就有结论，不必用户手动点。
 *
 * ⚠ 两条都**不许**影响登录（AGENTS.md 坑 #7）：本函数整体挂在 `void` 上，
 * `finish()` 同步返回；这里再慢、再失败也只是日志。
 *
 * @param {{baseUrl: string, doFetch: typeof fetch, log: object, configDir: string,
 *   cred: object, uid: string, routeModules?: object|null}} input
 * @returns {Promise<void>}
 */
async function afterLogin({ baseUrl, doFetch, log, configDir, cred, uid, routeModules: override }) {
  try {
    await firstLogin({ baseUrl, auth: { session: cred.session }, fetchImpl: doFetch })
  } catch (e) {
    log.warn?.(`loomy: 首登初始化失败（不影响登录本身）: ${e?.message ?? e}`)
  }
  // 再套一层 `void`：探测必须彻底脱离登录链路
  void probeRoute({ baseUrl, doFetch, log, configDir, cred, uid, override })
}

/**
 * 后台跑一次路由探测并把结论写状态文件。
 *
 * 失败只 `log.warn` —— 登录已经成功，这里没有任何理由改变结果。
 *
 * @param {{baseUrl: string, doFetch: typeof fetch, log: object, configDir: string,
 *   cred: object, uid: string, override?: object|null}} input
 * @returns {Promise<void>}
 */
async function probeRoute({ baseUrl, doFetch, log, configDir, cred, uid, override }) {
  try {
    const mods = override === undefined ? await loadRouteModules() : override
    // 模块未就绪（并行开发期 / 未部署）：静默跳过，面板显示「未检测」
    if (!mods?.probeRoute) return
    const entry = await mods.probeRoute({ baseUrl, session: cred.session, fetchImpl: doFetch })
    if (!entry || typeof entry !== "object") return
    // `unknown` = 这次没测清。不落盘：否则一次上游抖动就会把上一次的有效结论
    // 抹成「未检测」，用户会以为刚测的结果丢了（与 server 的落盘规则一致）。
    if (entry.verdict === "unknown") return
    if (!configDir) {
      log.warn?.("loomy: 没有 configDir，DS4.1 路由结论无法落盘（不影响登录）")
      return
    }
    await mods.writeRouteState?.(configDir, uid, entry)
  } catch (e) {
    log.warn?.(`loomy: DS4.1 路由探测失败（不影响登录）: ${e?.message ?? e}`)
  }
}
