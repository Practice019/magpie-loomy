// 网络闸：测试期间任何真实网络请求都必须失败。
//
// # 为什么必须有它
//
// 本插件的所有模块都直接打上游（loomyad.xunfei.cn / account.xfinfr.com）。
// 单元测试若意外发真请求，会出现两种都很糟的结果：
//
//	① 慢、不稳定，测试结果取决于网络
//	② 用真实 session 打真上游 —— 测试会消耗积分、触发风控
//
// 所以测试一律在「网络被禁用」的前提下跑；需要响应的用例自己注入假 fetch。
//
// 用法：`node --test --import ./tests/helpers/network-guard.mjs`

const realFetch = globalThis.fetch

/** 装闸：把全局 fetch 换成抛错的实现。 */
export function installNetworkGuard() {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input))
    throw new Error(`network-guard: 测试期间禁止真实网络请求（${url}）`)
  }
}

/** 撤闸：还原真实 fetch。 */
export function restoreNetworkGuard() {
  globalThis.fetch = realFetch
}

// --import 指定的模块在测试进程启动时执行一次，因此这里直接装闸。
installNetworkGuard()
