// auth-headers.mjs 双轨鉴权 —— 本插件对上游唯一「不可省」的知识。
//
// ⚠⚠ 这是整个插件里最容易出错、也最难排查的一段。源项目手册第 3 节把它列为
// 「90% 的人卡在这」。
//
// 同一个上游的两个端点认**不同**的 Header：
//
//	GET  /models            →  token: <session>
//	POST /chat/completions  →  Authorization: Bearer <session>
//
// 用错的那一个返回 HTTP **200** + `{"code":"100002","desc":"缺少 token"}`。
//
// 注意那个 200：**「看状态码判断鉴权对不对」这条路是不通的**。
// 拿 Authorization 去拉目录会拿到一段没有模型列表的 JSON，于是失败以
// 「目录为空 / 解析不出模型」的形态出现，而不是「鉴权头用错了」——
// 上游不会告诉你，你只能从「为什么目录是空的」倒推。
//
// # 为什么拆成两个独立的小函数，而不是一个 applyAuth(headers, kind)
//
// 合成一个带 kind 参数的函数之后，两处调用点长得一模一样：
//
//	applyAuth(h, AUTH_MODELS)
//	applyAuth(h, AUTH_CHAT)
//
// 评审时看不出哪个端点用了哪个 Header，改错一个（把两个 kind 写反）
// 在 diff 里几乎不可见。拆成两个各自命名的函数之后，「谁用了哪个」
// 在调用点就是字面事实。有测试钉死这对判据。
//
// # 三个端点的差异（都是实测，不是风格选择）
//
//	/models              token                只发这一个
//	/chat/completions    Authorization        只发这一个
//	/images/generations  **两个都发**          官方客户端也是两个都发
//	/search/tencent      Authorization        只发这一个（最小必要）
//
// 生图那里两个都发是唯一有实测背书的形态：官方客户端的注释写着
// 「session 模式同时塞 token + Authorization（兼容 Loomy iModel 两种入参）」。

/**
 * 给**模型目录**请求装鉴权头。
 *
 * 目标形态：`token: <session>`
 *
 * @param {Headers} headers
 * @param {{session: string}} auth
 */
export function modelsAuth(headers, auth) {
  headers.set("token", auth.session)
}

/**
 * 给**对话**请求装鉴权头。
 *
 * 目标形态：`Authorization: Bearer <session>`
 *
 * @param {Headers} headers
 * @param {{session: string}} auth
 */
export function chatAuth(headers, auth) {
  headers.set("Authorization", `Bearer ${auth.session}`)
}

/**
 * 给**生图**请求装鉴权头：两个都发。
 *
 * ⚠ 只在生图端点上这么做。别把它推广到 chat/models —— 那两个是严格单轨。
 *
 * @param {Headers} headers
 * @param {{session: string}} auth
 */
export function imageAuth(headers, auth) {
  chatAuth(headers, auth)
  modelsAuth(headers, auth)
}

/**
 * 给**积分网关**请求装鉴权头。
 *
 * ⚠ 积分网关只认 `token:`，与 /models 同一条轨（不是 /chat/completions 那条）。
 * 实测该网关不认 Authorization。
 *
 * @param {Headers} headers
 * @param {{session: string}} auth
 */
export function pointsAuth(headers, auth) {
  headers.set("token", auth.session)
}
