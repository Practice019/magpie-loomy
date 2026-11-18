// constants.mjs 本插件与上游之间的**唯一一份**常量表。
//
// # 为什么全部集中在这里
//
// 下面每一个值都是**上游的事实**（端点、上限、鉴权头名），不是风格选择。
// 它们被散落到多处时，改上游只改一处的判据就会失效 —— 本仓库在
// 「双轨鉴权」上踩过一次：同一个上游的两个端点认不同的头，
// 而两个调用点长得一模一样时，改错方向在 diff 里几乎不可见。

/** magpie 的供应商 id。agent 用 `loomy/<模型>` 指代本上游的模型。 */
export const PROVIDER = "loomy"

/**
 * 模型代理的基址。
 *
 * ⚠ **已经带 `/api/v1`**：上游的路径是 `https://loomyad.xunfei.cn/api/v1/models`
 * 与 `.../api/v1/chat/completions`。再拼一次 `/v1` 会得到 `/api/v1/v1/models`。
 */
export const DEFAULT_BASE_URL = "https://loomyad.xunfei.cn/api/v1"

/** 模型目录（相对基址）。鉴权头：`token`。 */
export const MODELS_PATH = "/models"

/** 对话（相对基址）。鉴权头：`Authorization: Bearer`。 */
export const CHAT_PATH = "/chat/completions"

/**
 * 生图（相对基址）。
 *
 * ⚠ 这是**唯一**能跑两个生图模型的端点：它们走 CHAT_PATH 会得到 404
 * 「该模型暂未开放」，走这里完全可用。鉴权头：**两个都发**（实测与官方客户端一致）。
 */
export const IMAGE_GENERATE_PATH = "/images/generations"

/** 联网搜索（相对基址）。鉴权头：**只发** `Authorization`（实测差异）。 */
export const SEARCH_PATH = "/search/tencent"

/** 读上游错误体的上限。畸形的大错误体不该把插件进程的内存吃掉。 */
export const MAX_ERROR_BODY = 1 << 20

/** 读搜索结果的上限（一次 10 条约几十 KB；4 MiB 给「要 50 条 + 长正文」留余量）。 */
export const MAX_SEARCH_RESP_BODY = 4 << 20

/** 读生图响应的上限（`response_format=b64_json` 时图片会被内联成 base64）。 */
export const MAX_IMAGE_RESP_BODY = 8 << 20

/**
 * 等响应头的上限。
 *
 * ⚠ 刻意**不设**整体请求超时：本插件最重要的用法是读一条 SSE 长流
 * （一次对话可能持续几十秒到几分钟），整体超时会把正常的长回答拦腰砍断，
 * 而错因看起来像上游故障。真正的下限约束只该作用在「上游多久不给响应头」。
 */
export const RESP_HEADER_TIMEOUT_MS = 120_000

/**
 * 积分网关的路径前缀。
 *
 * 积分网关与模型代理**同域**，但基址要去掉 `/api/v1` 再拼这一段。
 * 三个服务（模型代理 / 账号网关 / 积分网关）是三个不同的东西，
 * 鉴权方式也各不相同 —— 见 http.mjs 的双轨鉴权说明。
 */
export const POINTS_PREFIX = "/api/v1"

/** 讯飞账号网关（短信登录）。与模型代理**完全不同**的 host 与鉴权方式。 */
export const DEFAULT_ACCOUNT_BASE_URL = "https://account.xfinfr.com"

/** 账号网关的 appId（客户端 .env.prod 里的值）。 */
export const DEFAULT_ACCOUNT_APP_ID = "GM3LOOMY"

/**
 * 账号网关的 HMAC-SHA1 密钥对。
 *
 * ⚠ 它们随客户端安装包分发（`resources/.env.prod`，AES-256-GCM + scrypt，
 * 口令内嵌在同一个包里）。客户端自己的注释就写明这是 "local-obfuscation"、
 * 不是真保密 —— 任何拿到安装包的人都能还原。
 *
 * ⚠ 它们**不是用户凭证**：泄漏不等于掉号，但它确实让「拿到安装包就能以官方身份
 * 调用账号网关」成立。这与「硬编码用户自己的 api_key」不是同一类东西，
 * 所以这里内置，同时留环境变量覆盖口。
 */
export const DEFAULT_ACCOUNT_ACCESS_KEY = "2thryby66wxi53sk"
export const DEFAULT_ACCOUNT_ACCESS_SECRET = "zsak6eadrbawz683wf5r3m2snrwj868r"

/** 客户端自己用的 UA（原样照抄，不从别处拼）。 */
export const ACCOUNT_UA = "Loomy|Desktop|Electron|macOS"

/** 账号网关回执的读取上限（回执很小）。 */
export const MAX_ACCOUNT_BODY = 1 << 20

/** 积分网关的业务成功码。**业务失败也是 HTTP 200**，判据必须看 code。 */
export const OK_CODE = "000000"

/**
 * 客户端 Local Storage 里的键名。
 *
 * 抽成常量而不是各处写字面量：它们是与**客户端**之间的契约，
 * 上游改键名时这里必须跟着改，只有一份才查得到。
 */
export const KEY_AUTH_SESSION = "loomy-auth-session"
export const KEY_POINTS_SUMMARY = "loomy-points-summary"

/** 客户端数据目录相对「用户配置目录」的路径段（三平台共用）。 */
export const CLIENT_STORE_REL = ["Loomy", "Local Storage", "leveldb"]

/** leveldb 数据文件的候选后缀。刻意不含裸 `LOG`（那是 leveldb 自己的运行日志）。 */
export const STORE_FILE_SUFFIXES = ["*.log", "*.ldb", "*.sst"]

/** 单个 leveldb 文件的读取上限。 */
export const MAX_STORE_FILE_BYTES = 32 << 20

/**
 * 键与值之间允许的最大字节距离。
 *
 * ⚠ 必须是「距离」而不是 `\s*`：leveldb 在 key 与 value 之间插入 `\x01`
 * 等不可打印分隔符，`\s*` 匹配不到它们，会一个都读不出来。
 */
export const KEY_VALUE_GAP = 64
