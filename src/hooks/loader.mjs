// loader.mjs 请求接管 —— 本插件**唯一**碰请求路径的地方。
//
// # 只做三件事
//
//	① baseURL：告诉宿主请求发去哪（含 /api/v1）
//	② apiKey ：宿主会按 npm 自动加成 `Authorization: Bearer <key>`
//	③ fetch  ：只改两处 —— 生图补一个 `token` 头、对话改写 body
//
// 其余的（流式分帧、背压、abort、故障转移、协议转换）**全部由 magpie 做**，
// 本文件一行都不碰。这是「寄生」的实质：上游知识留在插件，传输留在宿主。
//
// # 为什么 apiKey 就是 session
//
// `@ai-sdk/openai-compatible` 的 `sdkHeaders` 会给 apiKey 加
// `Authorization: Bearer <key>` —— 这正是 /chat/completions 要的形态。
// 而 /models 走的是 `token:` 那条轨，那条请求**不经过 loader.fetch**
// （由 provider.models 自己发），所以这里不用管它。

import { PROVIDER } from "../constants.mjs"
import { prepareBody } from "../prepare-body.mjs"
import { signInVerdict, applySignInHeader } from "../upstream-facts.mjs"

/** 生图端点路径片段（用来判断该不该补 token 头）。 */
const IMAGE_PATH_HINT = "/images/generations"

/**
 * 构建 `auth.loader` 钩子。
 *
 * @returns {(getAuth: () => Promise<any>, provider: any) => Promise<object>}
 */
export function makeLoaderHook() {
  return async function loader(getAuth) {
    const auth = await getAuth()
    if (!auth?.type || !auth?.access) {
      // 未登录：返回空对象，宿主会用自己的默认（拿不到 key 时请求自然失败）
      return {}
    }

    /** @type {string} */
    const session = auth.access

    /**
     * 只改两处，其余原样交给宿主。
     *
     * @param {string|URL} input
     * @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    async function fetch(input, init = {}) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input)
      const headers = new Headers(init.headers)

      /** @type {RequestInit} */
      const next = { ...init, headers }

      if (url.includes(IMAGE_PATH_HINT)) {
        // 生图端点实测**两个头都认**，且官方客户端也是两个都发。
        // Authorization 由宿主按 apiKey 装好了，这里补 token。
        headers.set("token", session)
        // 生图请求体是 {model,prompt,n,size,response_format}，没有 stream 字段，
        // 硬套 prepareBody 只会把 body 弄坏 —— 原样发。
      } else if (typeof init.body === "string" || init.body == null) {
        // 对话：强制 stream=true + 按模型裁剪 max_tokens
        next.body = prepareBody(init.body)
      }

      const resp = await globalThis.fetch(url, next)

      // ── 只做一件事：把「这次失败是不是登录问题」如实告诉宿主 ──
      //
      // magpie 的默认判据是「401 → 标记账号需要重新登录」。而本上游有三种
      // 完全不同的失败形状，其中两种**不是**登录问题（模型不可用、内容拦截）。
      // 标错的代价是把一个健康账号打成「需要重新登录」，用户会去删一个好好的号。
      //
      // ⚠ 上游的业务失败也可能是 HTTP 200（`{"code":"100002","desc":"缺少 token"}`），
      // 所以 200 也要看正文。
      if (!resp.ok || resp.status === 200) {
        const verdict = await peekVerdict(resp)
        if (verdict) {
          const headers2 = new Headers(resp.headers)
          applySignInHeader(headers2, verdict)
          return new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers: headers2,
          })
        }
      }
      return resp
    }

    return {
      baseURL: undefined, // 用 provider.api（config 里已声明）
      apiKey: session,
      headers: {},
      fetch,
    }
  }
}

/**
 * 偷看响应正文的前若干字节，判断登录态语义。
 *
 * ⚠ 用的是 `resp.clone()` —— 原响应体必须原样交回宿主，绝不能因为
 * 我们看了一眼就把流吃掉。
 *
 * @param {Response} resp
 * @returns {Promise<"expired"|"kept"|null>}
 */
async function peekVerdict(resp) {
  try {
    const text = await resp.clone().text()
    return signInVerdict(resp.status, text.slice(0, 4096))
  } catch {
    // 流已被读 / 不是文本：不表态，交给宿主默认判据
    return null
  }
}
