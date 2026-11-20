// paste-import.mjs —— 登录弹窗里的第 4 个按钮：「从文件导入（粘贴 JSON / NDJSON）」。
//
// # 用户要解决的问题
//
// 供应商详情页把**所有**账号列出来（loomy 真机 301 个），「从文件导入账号…」
// 被挤到列表最底下。而登录弹窗（「用哪种方式登录 X?」）只有 3 个按钮。
// 所以把导入做成**第 4 个登录方式**：点它、粘一段 JSON / NDJSON、完事。
//
// # 为什么是 `type: "oauth"` 而不是 `type: "api"`（读宿主源码确认，不是猜）
//
// 真源：`C:\Users\21877\.cache\magpie\plugin-host\host-acc034d984c6.js`
//
//	2480-2488  methods()：只投影 type / label / labels / keyless / keyAsked / placeholder
//	2496-2498  keyAsked()：api 且有 prompts + authorize ⇒ 宿主不再额外问 key
//	2963-2978  apiKey()：api 方法的 authorize 结果必须含 `key`（或 `refresh`），
//	           然后 save() 写成 `{type:"api", key}`（2755-2766）
//	2814       oauth 方法：authorize(inputs, {signal})，inputs 只在有 prompts 时传
//	2822       oauth 方法**必须**返回一个带 `callback()` 的对象，否则宿主报
//	           「gave nothing to finish it with」
//	2849-2858  callback() 的返回必须是 `{type:"success", …}`，再经 keptAs → save 落盘
//
// 本插件的账号卡依赖 **oauth + access**：`type:"api"` 的凭证 magpie 不会调
// `auth.usage`，账号卡显示「未登录」、额度区空白（见 `src/hooks/methods.mjs` 顶部
// 真机记录 2026-11-17）。所以这里走 oauth：
//
//	authorize(inputs) → { url: "", opened: true, instructions, callback }
//	callback()        → { type: "success", access, refresh: "", expires: 0, … }
//
// # 一次要给多个账号怎么办（宿主一次登录只保存一个）
//
// `callback()` 的**一个**返回只等于**一个**账号。所以：
//
//	① 第 1 条返回给宿主，由它按正常登录落盘；
//	② 其余每条用 `client.auth.set({path:{id}, body})` 自己写 —— 这是宿主
//	   给插件的正规通道（host.js:1346-1370），写完同样会发 `{event:"auth"}`
//	   （host.js:1364-1367），面板会自动刷新，不需要重启。
//
// ⚠ 写进去的 body 形状必须与宿主 `save()` 的产出**逐字段一致**
//   （host.js:2758-2763：`{type:"oauth", refresh, access, expires, ...extra}`），
//   否则同一个号会被 settle() 当成两个号（host.js:1302-1328）。

import { collectResults, readExistingAccounts, IMPORT_MOST } from "./importer.mjs"
import { PROVIDER } from "./constants.mjs"

/** 按钮文案（用户一眼要看到「从文件导入」）。 */
export const PASTE_LABEL = "从文件导入（粘贴 JSON / NDJSON）"

/** 多语言文案（宿主 `byLang`，见 host.js:2464-2475）。 */
export const PASTE_LABELS = Object.freeze({ en: "import from text (JSON / NDJSON)" })

/** 输入框标题。 */
export const PASTE_MESSAGE = "账号内容（单对象 / 数组 / 每行一个对象的 NDJSON）"

/** 输入框标题的多语言版本。 */
export const PASTE_MESSAGES = Object.freeze({
  en: "account text (one object, an array, or an object per line)",
})

/**
 * 宿主 `save()` 写进 `plugin-auth.json` 的 body（host.js:2758-2763 的同构实现）。
 *
 * @param {any} result 一条 `{type:"success", access, refresh?, expires?, …}` 结果
 * @returns {object}
 */
export function authBodyOf(result) {
  const { type: _type, provider: _provider, refresh, access, expires, ...extra } = result ?? {}
  return { type: "oauth", refresh, access, expires, ...extra }
}

/**
 * 分配一个没被占用的账号键：`loomy#<6 位 base36>`。
 *
 * 与宿主 `freshKey()`（host.js:1243-1250）同一形态。**必须带 `#`**：在登录
 * 作用域里给 `client.auth.set` 传裸 `loomy` 会被 `keyFor()`（host.js:1229-1232）
 * 改写成「本次登录的键」，多出来的号就全挤在一个位置上了。
 *
 * @param {string} provider
 * @param {Set<string>} taken 已被占用的键（会被就地更新）
 * @returns {string}
 */
export function nextAccountKey(provider, taken) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const key = `${provider}#${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(key)) {
      taken.add(key)
      return key
    }
  }
  // 理论上到不了这里；到了也绝不返回一个已知冲突的键
  const key = `${provider}#${Date.now().toString(36).slice(-6)}`
  taken.add(key)
  return key
}

/**
 * 把「已通过校验」的账号逐条写进 `plugin-auth.json`（via 宿主的 client.auth.set）。
 *
 * @param {{client?: any, provider: string, configDir?: string,
 *   successes: any[], log?: any}} opts
 * @returns {Promise<{written: string[], errors: string[]}>}
 */
export async function writeAccounts(opts) {
  const provider = String(opts.provider ?? PROVIDER)
  const successes = Array.isArray(opts.successes) ? opts.successes : []
  /** @type {string[]} */
  const written = []
  /** @type {string[]} */
  const errors = []

  if (typeof opts.client?.auth?.set !== "function") {
    // OpenCode 里没有 client.auth.set；magpie 里一定有。没有就只能让宿主存第 1 条。
    if (successes.length > 1) {
      errors.push(`当前宿主没有 client.auth.set，只导入了第 1 条（其余 ${successes.length - 1} 条未写入）`)
    }
    return { written, errors }
  }

  const taken = new Set(readExistingAccounts(opts.configDir).keys)
  for (const [index, result] of successes.entries()) {
    const key = nextAccountKey(provider, taken)
    try {
      await opts.client.auth.set({ path: { id: key }, body: authBodyOf(result) })
      written.push(key)
    } catch (e) {
      errors.push(`第 ${index + 1} 条：写入失败（${String(e?.message ?? e)}）`)
    }
  }
  return { written, errors }
}

/**
 * 导入本身：解析 → 逐条校验/去重 → 写盘。
 *
 * @param {{text: string, provider: string, configDir?: string, client?: any,
 *   log?: any, collect?: (texts: string[]) => Promise<any>}} opts
 * @returns {Promise<object>} 宿主 `callback()` 要的结果
 */
export async function importPastedText(opts) {
  const collect =
    typeof opts.collect === "function"
      ? opts.collect
      : (texts) => collectResults(texts, { configDir: opts.configDir, reportBadLines: true })

  /** @type {any} */
  let got
  try {
    got = await collect([opts.text])
  } catch (e) {
    return { type: "failed", error: `导入失败：${String(e?.message ?? e)}` }
  }

  const results = Array.isArray(got) ? got : Array.isArray(got?.results) ? got.results : []
  const successes = results.filter((r) => r?.type === "success")
  const failures = results.filter((r) => r?.type !== "success")

  if (successes.length === 0) {
    const why = failures
      .map((f) => String(f?.error ?? "").trim())
      .filter(Boolean)
      .join("；")
    return { type: "failed", error: why || "没从粘贴的内容里认出账号（要含 session 字段的 JSON）" }
  }

  const { written, errors } = await writeAccounts({
    client: opts.client,
    provider: opts.provider,
    configDir: opts.configDir,
    successes,
  })

  const skipped = failures
    .map((f) => String(f?.error ?? "").trim())
    .filter(Boolean)
  const saved = written.length > 0 ? written.length : 1
  const message = [
    `已导入 ${saved} 个账号`,
    skipped.length > 0 ? `跳过 ${skipped.length} 条（${skipped.slice(0, 3).join("；")}）` : "",
    errors.length > 0 ? errors.slice(0, 3).join("；") : "",
  ]
    .filter(Boolean)
    .join("；")
  notify({ client: opts.client, log: opts.log, message, variant: skipped.length || errors.length ? "warning" : "info" })

  // 第 1 条交给宿主按正常登录落盘（其余已经自己写完了）。
  return successes[0]
}

/** 一次提示（宿主有 toast 就用，没有就写日志）。 */
function notify({ client, log, message, variant }) {
  try {
    client?.tui?.showToast?.({ title: PASTE_LABEL, message, variant })
  } catch {
    /* 没有 toast 通道就算了 */
  }
  try {
    log?.warn?.(`loomy: ${message}`)
  } catch {
    /* 日志失败不是业务失败 */
  }
}

/**
 * 构建登录弹窗里的第 4 个 method。
 *
 * @param {{provider?: string, configDir?: string, client?: any, log?: any,
 *   collect?: (texts: string[]) => Promise<any>}} [opts]
 * @returns {object} `auth.methods` 的一项
 */
export function makePasteImportMethod(opts = {}) {
  const provider = String(opts.provider ?? PROVIDER)
  const configDir = String(opts.configDir ?? "").trim()
  const client = opts.client
  const log = opts.log ?? console

  return {
    type: "oauth",
    label: PASTE_LABEL,
    labels: { ...PASTE_LABELS },
    get prompts() {
      return [
        {
          type: "text",
          key: "text",
          message: PASTE_MESSAGE,
          messages: { ...PASTE_MESSAGES },
          // 宿主会调它（host.js:2746-2750）：返回字符串 = 报错文案
          validate: (v) => (String(v ?? "").trim() ? null : "请粘贴账号内容（JSON / 数组 / NDJSON）"),
        },
      ]
    },
    async authorize(inputs = {}) {
      const text = String(inputs?.text ?? "").trim()
      if (!text) return { type: "failed", error: "请粘贴账号内容（单对象 / 数组 / 每行一个对象的 NDJSON）" }

      // ⚠ authorize 必须立刻返回（host.js:2814 会 await 它，等待放到 callback）。
      return {
        url: "",
        opened: true,
        method: "auto",
        instructions: `正在导入账号…（单次最多 ${IMPORT_MOST} 条；导入后账号列表会自动刷新）`,
        async callback() {
          return importPastedText({ text, provider, configDir, client, log, collect: opts.collect })
        },
      }
    },
  }
}
