// boot.js 把 magpie 的框架导航到管理面板服务。
//
// ⚠ 不探测服务：本页的 CSP 是 connect-src 'none'，fetch/XHR 必被拒。
// 所以进度条只由两个真实信号驱动 —— bridge 握手与流逝时间。
// index.html 里的 <meta refresh>（8 秒）是脚本没跑起来时的最后兜底。

;(async () => {
  const DEFAULT_PORT = 4391
  const words = {
    en: {
      bridging: "Connecting to the host bridge…",
      ready: "Panel located, opening…",
      readyLocal: "Ready — opening the local panel…",
      nobridge: "No host bridge — opening the local panel…",
      err: (m) => `Bridge did not respond: ${m} — opening the local panel…`,
    },
    zh: {
      bridging: "正在连接宿主桥接…",
      ready: "已定位面板服务，正在跳转…",
      readyLocal: "已就绪，正在打开本机面板…",
      nobridge: "未检测到宿主桥接，直接打开本机面板…",
      err: (m) => `桥接未响应：${m} —— 将直接打开本机面板…`,
    },
  }

  let lang = String(navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en"
  let port = DEFAULT_PORT

  const bar = document.getElementById("bar")
  const msg = document.getElementById("msg")
  const say = (t, bad) => {
    if (!msg) return
    msg.textContent = t
    msg.classList.toggle("bad", !!bad)
  }
  const setBar = (pct, bad) => {
    if (!bar) return
    bar.style.width = pct + "%"
    if (bar.parentElement) bar.parentElement.classList.toggle("bad", !!bad)
  }

  setBar(18)
  const creep = setInterval(() => {
    const cur = parseFloat(bar?.style.width) || 18
    setBar(Math.min(38, cur + 2.5))
  }, 350)

  let service = ""
  let bridgeErr = ""
  const hasBridge = !!window.magpie

  try {
    const current = await window.magpie?.ready
    if (current) {
      if (typeof current.lang === "string" && current.lang) {
        lang = current.lang.toLowerCase().startsWith("zh") ? "zh" : "en"
      }
    }
  } catch (e) {
    bridgeErr = (e && e.message) || "bridge handshake failed"
  }

  try {
    const options = await window.magpie?.options?.get?.()
    const n = Number(options?.port)
    if (Number.isInteger(n) && n > 0 && n < 65536) port = n
  } catch {
    // 用声明的默认值
  }

  try {
    const s = window.magpie?.service
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s
  } catch {
    // 桌面窗口直接跳 loopback
  }

  clearInterval(creep)
  const w = words[lang]

  if (bridgeErr) {
    setBar(30, true)
    say(w.err(bridgeErr), true)
  } else if (!hasBridge) {
    setBar(72)
    say(w.nobridge)
  } else {
    setBar(72)
    say(service ? w.ready : w.readyLocal)
  }

  let target = service || `http://127.0.0.1:${port}/`

  // 主题从 magpie 带过去（面板自己也会回落 prefers-color-scheme）
  try {
    const u = new URL(target, location.href)
    u.searchParams.set("lang", lang)
    target = u.href
  } catch {
    target += (target.includes("?") ? "&" : "?") + "lang=" + lang
  }

  const go = document.getElementById("go")
  if (go) go.setAttribute("content", "0;url=" + target)
  const manual = document.getElementById("manual")
  if (manual) manual.setAttribute("href", target)

  setTimeout(() => {
    try {
      location.replace(target)
    } catch {
      // meta refresh 仍会导航
    }
  }, 350)
})()
