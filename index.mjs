// index.mjs 插件入口 —— 只做「组装」。
//
// # magpie 怎么认插件
//
// 入口模块**每一个具名导出**都会被当成一个独立插件调用（导出名不以 `Plugin`
// 结尾也认，只要它是个函数）。所以本模块导出两个：
//
//	LoomyAuthPlugin  供应商钩子（config / auth / provider）
//	LoomyPage        页面服务的宿主侧（listen 面板端口）
//
// 这与 magpie 自己的测试夹具（`internal/plugin/testdata/pageservice/index.js`
// 的 `PageService`）是同一个形状：**页面服务是一个普通的具名导出函数，
// 它自己 listen，magpie 只负责把 options 传进来**。
//
// # ⚠ 三条踩过的坑（2026-11-18 实测 + 读 magpie 源码确认）
//
//	① 服务**不是**叫 `server` 的钩子。把 `async server()` 塞进插件返回的
//	   钩子对象里，magpie 永远不会调用它 —— 它只读 config/auth/provider/
//	   chat.headers 这几个钩子名。服务必须是模块级的具名导出。
//
//	② 端口来自 `options.port`，由 magpie 的 `hostOptions(target, options)`
//	   在**加载插件时**注入：
//	      magpie（app / web / serve / tray / tui）→ 原样传用户的 options
//	      命令行（如 `magpie plugin list`）        → 若服务声明了 option，
//	                                                改成它自己挑的一个空闲端口
//	   所以「同一个插件在不同进程里端口不同」是**设计如此**，不是 bug。
//
//	③ 兜底是环境变量 `PAGESVC_PORT`（见 magpie 的 pageservice 夹具）。
//
// # 刻意**不实现**的
//
//	auth.refresh   本上游没有 refresh token（session 不过期，见 src/credential.mjs）
//	auth.checkin   本上游没有签到端点（日额度由服务端按自然日自动重置）
//	tool           工具由 magpie 自己的 MCP 提供，与本上游无关
//	*.middleware   请求改写由 loader 承担，不需要额外中间件
//
// 造一个空的 refresh / checkin 是有害的：它会告诉 magpie「这个上游能自动恢复」，
// 从而把「换号重试」当成有效处置 —— 而现实是只能人工重登。

import { PROVIDER, DEFAULT_BASE_URL } from "./src/constants.mjs"
import { makeConfigHook } from "./src/hooks/config.mjs"
import { makeMethods } from "./src/hooks/methods.mjs"
import { makeLoaderHook } from "./src/hooks/loader.mjs"
import { makeUsageHook } from "./src/hooks/usage.mjs"
import { makeModelsHook } from "./src/hooks/models.mjs"
import { makeImportHook } from "./src/importer.mjs"

const { default: manifest } = await import("./package.json", { with: { type: "json" } })
const ICON = manifest.magpie.icon

/**
 * 从 options / 环境变量 / package.json 里取面板端口。
 *
 * # 三级回退的顺序与理由（这是 magpie 的实际行为，不是我的偏好）
 *
 *	① `options.port`      —— **用户在 plugins.json 里实际设置的值**
 *	② `$PAGESVC_PORT`     —— magpie 测试夹具用的兜底（`internal/plugin/testdata/pageservice`）
 *	③ package.json 里的 `magpie.page.service.port` —— **默认值**
 *
 * ⚠ 第 ① 步为什么常常是空的：magpie 的 `host.js` 里是
 * `chosen = p.options ?? {}`，而 `p.options` 来自**用户配置**
 * （`plugins.json` 里那一项的 `options`），不是 `package.json` 的默认值。
 * 用户没手动设过就都是 `{}` —— 此时必须回落到 ③，否则服务不会监听。
 *
 * ⚠ 而 Go 侧的 `ServiceSpec.ServicePort(options)` 做的是同一套回退
 * （option 有值用它，否则用 spec 的 Port）。所以第 ③ 步不是我自己发明的，
 * 是补上宿主没有替我们做的那一半。
 *
 * @param {object} options magpie 传进来的用户选项
 * @param {Record<string,string|undefined>} env
 * @param {number} specPort package.json 里声明的默认端口
 * @returns {number} 0 = 没有可用端口
 */
function resolvePort(options, env, specPort) {
  const pick = (v) => {
    const n = Number(v)
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
  }
  return pick(options?.port) || pick(env?.PAGESVC_PORT) || pick(specPort) || 0
}

/**
 * 供应商插件。
 *
 * @param {{client?: any, directory?: string}} [input] magpie 给的宿主输入
 *   `directory` 就是 magpie 的配置目录（plugin-auth.json 在那里）
 * @param {object} [options] plugins.json 里这一项的 options
 * @returns {Promise<object>} 钩子集合
 */
export const LoomyAuthPlugin = async (input = {}, options = {}) => {
  const baseUrl = String(options?.baseUrl ?? "").trim() || DEFAULT_BASE_URL
  const configDir = String(input?.directory ?? options?.configDir ?? "").trim()

  const log = input?.client?.app?.log
    ? {
        warn: (m) => input.client.app.log({ body: { service: "loomy", level: "warn", message: m } }),
      }
    : console

  // `configDir` 同时喂给四条钩子：登录态（methods）、请求（loader）、
  // 额度窗口（usage）、模型目录（provider.models）。
  //
  // 它们要同一个目录，是因为「这个账号是不是被上游限制了」的判定落在
  // `src/route-store.mjs`（按 configDir 定位的状态文件）。几处必须拿到同一个
  // 目录，否则会出现「卡片说不能用、目录却还列着 DS4.1」这种自相矛盾。
  //
  // ⚠ 真正的「排除」只发生在 `provider.models`（routed ⇒ 空目录）；loader 只
  // 记日志、usage 只加说明窗。理由写在 `src/hooks/models.mjs` 顶部。
  /** @type {any} */
  const auth = {
    provider: PROVIDER,
    methods: makeMethods({ baseUrl, log, configDir }),
    loader: makeLoaderHook({ configDir, log }),
    usage: makeUsageHook({ baseUrl, log, configDir }),
    // 从文件批量导入（magpie 自己的钩子，OpenCode 会忽略）。
    // 装上它，供应商编辑页就会出现「从文件导入账号…」按钮。
    ...makeImportHook({
      // 导入时不验证 —— 上游可能只是这一刻不通，而凭证本身是对的。
      // 让账号先进池子，第一次请求失败会如实标出来。
      verify: undefined,
      // `configDir` 有两个用途（都只在导入时用）：
      //	① 读 `plugin-auth.json` 做去重 —— 超过 magpie 单次 100 条上限时，
      //	   再选一次同一文件才能把剩下的导进来（不再静默丢弃）
      //	② 导入后在后台把新号的 DS4.1 路由探测结果落盘（`void`，不阻塞导入）
      configDir,
      // 后台探测要打模型代理，所以基址也要一起给（用户可能改过 baseUrl）
      baseUrl,
      log,
    }),
  }
  if (ICON) auth.icon = ICON

  return {
    config: makeConfigHook({ baseUrl }),
    auth,
    provider: {
      id: PROVIDER,
      models: makeModelsHook({ baseUrl, log, configDir }),
    },
  }
}

/**
 * 页面服务的**宿主侧**：为「Loomy 面板」跑一个本地 HTTP 服务。
 *
 * # 它为什么必须是一个独立导出
 *
 * magpie 把入口模块的每个具名导出都当成一个插件来调用，并把它自己解析出的
 * options（含 `port`）传进来。服务在这个函数里 `listen`，magpie 不代劳。
 *
 * # 为什么端口被占时要重试而不是退出
 *
 * magpie 的 app 宿主与命令行宿主**可能同时加载本插件**（例如用户在 app 里
 * 跑着面板，同时又执行 `magpie plugin list`）。命令行宿主会把 port 挪到一个
 * 空闲口（见源码 `hostOptions`），但 app 宿主仍然占着真正的那个口。
 * 直接退出会让 app 里的面板偶发不可用；重试则是幂等的。
 *
 * ⚠ 这个函数会被**每个 magpie 进程各调用一次**（app / web / cli）。
 * 所以服务必须是「已经在跑就复用」的语义，不能重复 listen 同一端口。
 *
 * @param {{client?: any, directory?: string}} [input]
 * @param {object} [options]
 * @returns {Promise<object>} magpie 只要求不抛错；返回值仅用于排障
 */
export const LoomyPage = async (input = {}, options = {}) => {
  const baseUrl = String(options?.baseUrl ?? "").trim() || DEFAULT_BASE_URL
  const configDir = String(input?.directory ?? options?.configDir ?? "").trim()
  const log = console

  // 端口三级回退：用户设置 → $PAGESVC_PORT → package.json 的默认值
  const pkg = await import("./package.json", { with: { type: "json" } }).catch(() => null)
  const specPort = Number(pkg?.default?.magpie?.page?.service?.port ?? 0)
  const want = resolvePort(options, process.env, specPort)
  if (!want) {
    // 没有端口 = 这个进程不该跑面板服务（或用户填了非法值）。
    // 不抛错：抛了会让整个插件在插件列表里显示加载失败。
    log.warn?.("[loomy] 面板服务没有可用端口，跳过监听")
    return { ok: false, reason: "no-port" }
  }

  try {
    const { startServer } = await import("./server.mjs")
    const s = await startServer({ port: want, baseUrl, configDir, log, retry: true })
    return { ok: true, port: s.port }
  } catch (err) {
    // 端口被占用是正常竞争（app 宿主已经在跑），不当作失败
    log.warn?.(`[loomy] 面板服务未启动（端口 ${want}）: ${err?.message ?? err}`)
    return { ok: false, reason: String(err?.message ?? err) }
  }
}

/**
 * 测试与排障用的内部引用。
 *
 * ⚠ 挂在一个对象上，不要散着导出 —— 入口的每个具名导出都会被当成插件调用。
 */
export const _internal = {
  PROVIDER,
  DEFAULT_BASE_URL,
  makeConfigHook,
  makeMethods,
  makeLoaderHook,
  makeUsageHook,
  makeModelsHook,
  resolvePort,
}
