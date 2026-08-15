/**
 * dsh-node-nav — 对话节点导航(浏览器客户端插件,手写 bundle)。
 *
 * 数据源(双轨):
 * 1. 服务端全量列表:host 半部端点 /plugins/dsh-node-nav/api/users 从 attached
 *    会话日志提取全部真实用户消息(含分页未加载的历史),返回
 *    [{ id, seq, time, text }] —— 导航因此覆盖全部历史,而**不展开页面**。
 * 2. DOM 行状态:锚点 key 形如 "<seq>:input-message<uuid>",uuid 即消息 id,
 *    用 [data-chat-anchor-key$="<id>"] 匹配已加载行。
 * 端点不可用/冷会话(返回空)时回退到纯 DOM 扫描。
 *
 * 交互:
 * - 已加载节点:点击 scrollIntoView 跳转 + 高亮;
 * - 未加载节点(虚线半透明):点击先连续触发页面「加载更早」直到该行进入
 *   DOM(上限 30 批),再跳转;hover 预览直接显示服务端全文(含时间);
 * - scroll-spy:active 药丸标出视口内最顶部用户消息(仅对已加载行);
 * - rail 底端固定方形「跳到底部」节点;
 * - details 面板打开时自动左移避让;深色模式;
 *   reduced-motion 禁用动画。
 */
window.__ModuleLoader__.load({
	id: "dsh-node-nav",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");

		const PREVIEW_CHARS = 300
		const LOAD_BATCH_MAX = 30

		/** 用户消息列表共享缓存：sessionId → users:[{id,time,text}]（导航与输入历史共用）。 */
		var usersCache = new Map()
		/** 缓存会话数上限：超出按插入序淘汰最旧（Map 迭代序即插入序）。 */
		var USERS_CACHE_MAX = 10
		/** 在途请求：sessionId → promise（去重：导航/历史/重拉并发时只发一次请求）。 */
		var inflightUsers = new Map()
		/**
		 * force=false 命中缓存立即返回；force=true 强制重拉（DOM 变化后的
		 * 防抖刷新）。并发去重：同会话在途请求共享一个 promise（数据是最
		 * 近 800ms 内的，足够新）。不做 [图片] 过滤——导航节点串保留全部
		 * 用户消息（含纯图片），输入历史模块按需自行过滤。
		 */
		function sharedFetchUsers(sessionId, force) {
			if (typeof sessionId !== "string" || sessionId === "") return Promise.resolve([])
			if (!force) {
				const hit = usersCache.get(sessionId)
				if (hit !== undefined) return Promise.resolve(hit)
			}
			const pending = inflightUsers.get(sessionId)
			if (pending !== undefined) return pending
			const url = new URL("/plugins/dsh-node-nav/api/users", window.location.origin)
			url.searchParams.set("sessionId", sessionId)
			const promise = fetch(url.href)
				.then((r) => r.json())
				.then((data) => {
					if (!data || !Array.isArray(data.users)) return []
					const users = data.users
						.filter((u) => u && typeof u.text === "string" && u.text !== "")
						.map((u) => ({ id: u.id, time: u.time, text: u.text }))
					if (usersCache.size >= USERS_CACHE_MAX) usersCache.delete(usersCache.keys().next().value)
					usersCache.set(sessionId, users)
					return users
				})
				.catch(() => {
					const hit = usersCache.get(sessionId)
					return hit !== undefined ? hit : []
				})
				.finally(() => {
					inflightUsers.delete(sessionId)
				})
			inflightUsers.set(sessionId, promise)
			return promise
		}

		/** 对话流容器动态查询(会话切换后容器可能被替换)。 */
		function flowOf() {
			return document.querySelector('[data-chat-flow=""]')
		}

		/** 流的滚动容器:向上找第一个 overflowY auto/scroll 的祖先。 */
		function scrollerOf() {
			const flow = flowOf()
			if (flow === null) return null
			let n = flow.parentElement
			while (n !== null) {
				const s = getComputedStyle(n)
				if (s.overflowY === "auto" || s.overflowY === "scroll") return n
				n = n.parentElement
			}
			return null
		}

		/** 页面上已加载的 user 消息行(DOM 扫描 fallback 与 loaded 判定用)。 */
		function userRows() {
			return [...document.querySelectorAll('[data-time-hover-root]')].filter((row) =>
				!row.hasAttribute('data-pending-steering') && row.querySelector('[class*="bubble"]') !== null)
		}

		/** 从 user 行提取预览文本。 */
		function rowPreview(row) {
			const bubble = row.querySelector('[class*="bubble"]')
			return ((bubble ?? row).textContent ?? '').trim()
		}

		/** 按消息 id 找已加载锚点行(key = "<seq>:input-message<uuid>")。 */
		function anchorOfId(id) {
			if (typeof id !== 'string' || id === '') return null
			try {
				return document.querySelector(`[data-chat-anchor-key$="${CSS.escape(id)}"]`)
			} catch {
				return null
			}
		}

		/** 页面自带的「加载更早」按钮。 */
		function olderButton() {
			const buttons = document.querySelectorAll('button')
			for (const b of buttons) {
				if ((b.textContent ?? '').includes('加载更早')) return b
			}
			return null
		}

		/** 滚动会话流到底部(最新消息)。 */
		function scrollToBottom() {
			const scroller = scrollerOf()
			if (scroller === null) return
			const reduce = window.matchMedia !== undefined && window.matchMedia("(prefers-reduced-motion: reduce)").matches
			scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
		}

		/** 平滑跳转 + 高亮;行不存在返回 false。 */
		function jumpToRow(row) {
			if (row === null || !row.isConnected) return false
			const reduce = window.matchMedia !== undefined && window.matchMedia("(prefers-reduced-motion: reduce)").matches
			row.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" })
			row.style.transition = "outline-color 1.2s"
			row.style.outline = "2px solid rgba(99,102,241,0.8)"
			row.style.outlineOffset = "3px"
			setTimeout(() => { row.style.outline = "none" }, 1200)
			return true
		}

		/**
		 * 按需加载:连续触发页面「加载更早」直到目标消息行进入 DOM
		 * (上限 LOAD_BATCH_MAX 批)。返回找到的行或 null。
		 */
		function loadUntilVisible(id) {
			return new Promise((resolve) => {
				let tries = 0
				const step = () => {
					const el = anchorOfId(id)
					if (el !== null) { resolve(el); return }
					const btn = olderButton()
					if (btn === null) { resolve(null); return }
					if (tries >= LOAD_BATCH_MAX) { resolve(null); return }
					tries++
					btn.click()
					setTimeout(step, 400)
				}
				step()
			})
		}

		const CSS_TEXT = `
.dsh-node-nav-rail { position: fixed; right: 28px; top: 50%; transform: translateY(-50%); width: 16px; max-height: calc(100vh - 32px); overflow-y: auto; scrollbar-width: none; z-index: 1000; display: flex; flex-direction: column; align-items: center; gap: 9px; padding: 14px 0; }
.dsh-node-nav-rail::-webkit-scrollbar { display: none; }
.dsh-node-nav-rail::before, .dsh-node-nav-rail::after { content: ""; position: absolute; left: 0; right: 0; height: 18px; pointer-events: none; opacity: 0; transition: opacity 0.2s; border-radius: 8px; }
.dsh-node-nav-rail::before { top: 0; background: linear-gradient(to bottom, rgba(0,0,0,0.14), transparent); }
.dsh-node-nav-rail::after { bottom: 0; background: linear-gradient(to top, rgba(0,0,0,0.14), transparent); }
.dsh-node-nav-has-up::before { opacity: 1; }
.dsh-node-nav-has-down::after { opacity: 1; }
body[data-ds-dark-theme] .dsh-node-nav-rail::before { background: linear-gradient(to bottom, rgba(255,255,255,0.18), transparent); }
body[data-ds-dark-theme] .dsh-node-nav-rail::after { background: linear-gradient(to top, rgba(255,255,255,0.18), transparent); }
.dsh-node-nav-line { position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; margin-left: -1px; border-radius: 1px; background: linear-gradient(to bottom, transparent, rgba(127,127,127,0.42) 10%, rgba(127,127,127,0.42) 90%, transparent); }
.dsh-node-nav-dot { position: relative; flex: none; width: 11px; height: 11px; border-radius: 50%; background: #ffffff; border: 2px solid rgba(99,102,241,0.55); padding: 0; box-sizing: border-box; cursor: pointer; box-shadow: 0 0 0 3px rgba(255,255,255,0.55); transition: transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease; }
.dsh-node-nav-dot:hover { transform: scale(1.4); background: rgba(99,102,241,0.95); border-color: rgba(99,102,241,1); box-shadow: 0 0 0 5px rgba(99,102,241,0.16); }
.dsh-node-nav-dot:focus-visible { outline: 2px solid rgba(99,102,241,0.9); outline-offset: 2px; }
.dsh-node-nav-dot-active { background: rgba(99,102,241,0.95); border-color: rgba(99,102,241,1); box-shadow: 0 0 0 4px rgba(99,102,241,0.25); transform: scale(1.2); }
.dsh-node-nav-dot-unloaded { opacity: 0.45; border-style: dashed; }
.dsh-node-nav-bottom { position: relative; flex: none; width: 11px; height: 11px; border-radius: 3px; background: #ffffff; border: 2px solid rgba(127,127,140,0.65); padding: 0; box-sizing: border-box; cursor: pointer; box-shadow: 0 0 0 3px rgba(255,255,255,0.55); margin-top: 10px; transition: transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease; }
.dsh-node-nav-bottom::after { content: ""; position: absolute; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px; border-right: 2px solid rgba(127,127,140,0.9); border-bottom: 2px solid rgba(127,127,140,0.9); transform: rotate(45deg) translate(1px, -1px); }
.dsh-node-nav-bottom:hover { transform: scale(1.3); background: rgba(99,102,241,0.95); border-color: rgba(99,102,241,1); box-shadow: 0 0 0 5px rgba(99,102,241,0.16); }
.dsh-node-nav-bottom:hover::after { border-color: #ffffff; }
.dsh-node-nav-bottom:focus-visible { outline: 2px solid rgba(99,102,241,0.9); outline-offset: 2px; }
body[data-ds-dark-theme] .dsh-node-nav-dot { background: #1e232b; box-shadow: 0 0 0 3px rgba(0,0,0,0.4); }
body[data-ds-dark-theme] .dsh-node-nav-dot:hover { background: rgba(129,140,248,0.95); border-color: rgba(165,180,252,1); box-shadow: 0 0 0 5px rgba(129,140,248,0.22); }
body[data-ds-dark-theme] .dsh-node-nav-dot-active { background: rgba(129,140,248,0.95); border-color: rgba(165,180,252,1); box-shadow: 0 0 0 4px rgba(129,140,248,0.3); }
body[data-ds-dark-theme] .dsh-node-nav-bottom { background: #1e232b; box-shadow: 0 0 0 3px rgba(0,0,0,0.4); }
body[data-ds-dark-theme] .dsh-node-nav-bottom:hover { background: rgba(129,140,248,0.95); border-color: rgba(165,180,252,1); box-shadow: 0 0 0 5px rgba(129,140,248,0.22); }
body[data-ds-dark-theme] .dsh-node-nav-bottom:hover::after { border-color: #ffffff; }
.dsh-node-nav-preview { position: fixed; z-index: 1001; width: 284px; max-height: 240px; overflow: hidden; background: #ffffff; color: #24292f; border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; padding: 10px 12px; font-size: 13px; line-height: 1.6; text-align: left; box-shadow: 0 10px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08); pointer-events: none; white-space: pre-wrap; word-break: break-word; display: none; animation: dshNavIn 0.16s ease; }
.dsh-node-nav-preview-time { color: #6b7280; font-size: 11px; margin-bottom: 5px; display: flex; align-items: center; gap: 6px; }
.dsh-node-nav-preview-time::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: rgba(99,102,241,0.8); display: inline-block; }
body[data-ds-dark-theme] .dsh-node-nav-preview { background: #1f242d; color: #e6e9f0; border-color: rgba(255,255,255,0.07); box-shadow: 0 10px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3); }
body[data-ds-dark-theme] .dsh-node-nav-preview-time { color: #8b93a3; }
.dsh-node-nav-miss { position: fixed; right: 52px; top: 50%; transform: translateY(-120%); z-index: 1002; background: #ffffff; color: #24292f; border: 1px solid rgba(0,0,0,0.1); border-radius: 10px; padding: 8px 10px; font-size: 12px; line-height: 1.5; box-shadow: 0 10px 32px rgba(0,0,0,0.16); display: flex; align-items: center; gap: 8px; animation: dshNavIn 0.16s ease; }
body[data-ds-dark-theme] .dsh-node-nav-miss { background: #1f242d; color: #e6e9f0; border-color: rgba(255,255,255,0.07); box-shadow: 0 10px 32px rgba(0,0,0,0.55); }
@keyframes dshNavIn { from { opacity: 0; transform: translateX(4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .dsh-node-nav-dot, .dsh-node-nav-preview, .dsh-node-nav-bottom, .dsh-node-nav-miss { transition: none; animation: none; }
}
`

		/** epoch ms → HH:MM。 */
		function hhmm(ms) {
			if (!ms) return ""
			const d = new Date(ms)
			return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
		}

		/** 会话 id 的 bare observable(订阅 currentProvideInfo)。 */
		function makeSessionIdSource(ctx) {
			const listeners = new Set()
			let snapshot = undefined
			let disposed = false
			const recompute = () => {
				if (disposed) return
				const info = ctx.sessions.currentProvideInfo.getSnapshot()
				const next = info ? info.sessionId : undefined
				if (snapshot === next) return
				snapshot = next
				for (const fn of listeners) fn()
			}
			const unsub = ctx.sessions.currentProvideInfo.subscribe(recompute)
			recompute()
			return {
				getSnapshot: () => snapshot,
				subscribe: (fn) => {
					listeners.add(fn)
					return () => { listeners.delete(fn) }
				},
				dispose: () => {
					disposed = true
					unsub()
					listeners.clear()
				},
			}
		}

		/** 右侧导航条组件。 */
		function NodeNavRail(props) {
			// 全部 hooks 在任何条件 return 之前调用(React #310 教训)。
			const sessionId = props.useSessionId(s => s)
			const [remoteUsers, setRemoteUsers] = react.useState([])   // 服务端全量 [{id,time,text}]
			const [domTick, setDomTick] = react.useState(0)            // DOM 变化计数,驱动 loaded 重算
			const [activeIdx, setActiveIdx] = react.useState(-1)
			const [hoverIdx, setHoverIdx] = react.useState(-1)
			const [detailsWidth, setDetailsWidth] = react.useState(0)
			const [miss, setMiss] = react.useState("")
			const railRef = react.useRef(null)
			const previewRef = react.useRef(null)
			const missTimer = react.useRef(0)

			// 服务端全量列表:会话切换或 DOM 变化(新消息/加载历史)时防抖刷新
			react.useEffect(() => {
				let timer = 0
				const fetchUsers = () => {
					timer = 0
					if (typeof sessionId !== "string" || sessionId === "") { setRemoteUsers([]); return }
					sharedFetchUsers(sessionId, true)
						.then((users) => {
							setRemoteUsers(users.map((u) => ({ id: u.id, time: u.time, text: u.text })))
						})
						.catch(() => { setRemoteUsers([]) })
				}
				const schedule = () => {
					if (timer !== 0) window.clearTimeout(timer)
					timer = window.setTimeout(fetchUsers, 800)
				}
				schedule()
				const mo = typeof MutationObserver === 'function'
					? new MutationObserver(() => { schedule() })
					: null
				if (mo !== null) mo.observe(document.body, { childList: true, subtree: true })
				return () => {
					if (timer !== 0) window.clearTimeout(timer)
					if (mo !== null) mo.disconnect()
				}
			}, [sessionId])

			// DOM 变化计数(loaded 状态重算)
			react.useEffect(() => {
				let raf = 0
				const schedule = () => {
					if (raf === 0) raf = requestAnimationFrame(() => { raf = 0; setDomTick((t) => t + 1) })
				}
				const mo = typeof MutationObserver === 'function'
					? new MutationObserver(() => { schedule() })
					: null
				if (mo !== null) mo.observe(document.body, { childList: true, subtree: true })
				return () => {
					if (mo !== null) mo.disconnect()
				}
			}, [])

			// active 药丸:视口内最顶部的已加载节点行（数据源与节点串同源——
			// roster 的锚点行；不再扫 DOM userRows，避免 assistant/steering 等
			// 非用户消息行混入导致 DOM 序与节点序错位）。activeIdx 即 roster
			// 全局索引，无需再映射。
			react.useEffect(() => {
				const compute = () => {
					let best = -1
					let bestTop = Number.POSITIVE_INFINITY
					for (let i = 0; i < roster.length; i++) {
						const el = roster[i].el
						if (el === null || el === undefined) continue
						const top = el.getBoundingClientRect().top
						if (top >= 0 && top < bestTop) { bestTop = top; best = i }
					}
					if (best === -1) {
						// 视口内无用户行（滚到底/长输出）：取最后一条已加载节点
						for (let i = roster.length - 1; i >= 0; i--) {
							if (roster[i].el !== null && roster[i].el !== undefined) { best = i; break }
						}
					}
					setActiveIdx((prev) => (prev === best ? prev : best))
				}
				let ticking = false
				const onScroll = () => {
					if (ticking) return
					ticking = true
					requestAnimationFrame(() => { ticking = false; compute() })
				}
				document.addEventListener('scroll', onScroll, { capture: true, passive: true })
				compute()
				return () => document.removeEventListener('scroll', onScroll, { capture: true })
			}, [domTick])

			// details 避让
			react.useEffect(() => {
				const measure = () => {
					const rail = railRef.current
					if (rail === null) return
					const overlay = rail.closest("[data-shell-overlay]")
					const frame = overlay === null ? null : overlay.parentElement
					if (frame === null) return
					const cols = (window.getComputedStyle(frame).gridTemplateColumns || "").split(" ")
					const w = parseFloat(cols[2] || "0") || 0
					setDetailsWidth((prev) => (prev === w ? prev : w))
				}
				const timer = window.setInterval(measure, 3000)
				measure()
				return () => window.clearInterval(timer)
			}, [])

			// roster 组装:服务端全量为主;端点空时 fallback 纯 DOM 行
			let roster
			if (remoteUsers.length > 0) {
				roster = remoteUsers.map((u) => ({
					id: u.id,
					time: u.time,
					preview: u.text,
					el: anchorOfId(u.id),
				}))
			} else {
				roster = userRows().map((el) => ({ id: undefined, time: undefined, preview: rowPreview(el), el }))
			}
			// activeIdx 即 roster 全局索引（scroll-spy 已与节点串同源，无需映射）。

			const showTextPreview = (text, time, anchorEl) => {
				if (anchorEl === null || anchorEl === undefined) return
				const preview = previewRef.current
				if (preview === null) return
				const body = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '…' : text
				preview.innerHTML = ''
				if (time !== undefined && time !== null) {
					const timeDiv = document.createElement('div')
					timeDiv.className = 'dsh-node-nav-preview-time'
					timeDiv.textContent = hhmm(time)
					preview.appendChild(timeDiv)
				}
				const bodyDiv = document.createElement('div')
				bodyDiv.textContent = body
				preview.appendChild(bodyDiv)
				const r = anchorEl.getBoundingClientRect()
				preview.style.right = `${window.innerWidth - r.left + 14}px`
				preview.style.top = `${Math.min(window.innerHeight - 130, r.top - 12)}px`
				preview.style.display = 'block'
			}
			const hidePreview = () => {
				const preview = previewRef.current
				if (preview !== null) preview.style.display = 'none'
			}

			const showMiss = (text) => {
				setMiss(text)
				window.clearTimeout(missTimer.current)
				missTimer.current = window.setTimeout(() => setMiss(""), 3000)
			}

			const onNodeClick = async (entry) => {
				let el = entry.el
				if ((el === null || el === undefined) && entry.id !== undefined) {
					el = await loadUntilVisible(entry.id)
				}
				if (el === null || el === undefined || !jumpToRow(el)) {
					showMiss('目标消息未能定位(历史加载失败或已超过批次上限)')
				}
			}

			const visible = flowOf() !== null

			// 显示窗口：最多 WINDOW 个节点，窗口随 active 平移（阅读到哪里、
			// 节点串滑到哪里，无需滚动条）；窗口外两端用渐隐提示。
			const WINDOW = 15
			let windowStart = 0
			let windowRoster = roster
			if (roster.length > WINDOW) {
				const half = Math.floor((WINDOW - 1) / 2)
				windowStart = Math.min(Math.max(activeIdx - half, 0), roster.length - WINDOW)
				windowRoster = roster.slice(windowStart, windowStart + WINDOW)
			}
			const hasMoreUp = windowStart > 0
			const hasMoreDown = windowStart + WINDOW < roster.length

			const items = windowRoster.map((entry, i) => {
				const globalIdx = windowStart + i
				const isActive = globalIdx === activeIdx
				const unloaded = entry.el === null || entry.el === undefined
				return react.createElement("button", {
					key: entry.id !== undefined ? entry.id : `dom-${globalIdx}`,
					className: "dsh-node-nav-dot"
						+ (isActive ? " dsh-node-nav-dot-active" : "")
						+ (unloaded ? " dsh-node-nav-dot-unloaded" : ""),
					"aria-label": `跳转到消息 ${entry.time ? hhmm(entry.time) : `#${globalIdx + 1}`}${unloaded ? '(未加载)' : ''}`,
					onMouseEnter: () => { setHoverIdx(globalIdx); showTextPreview(entry.preview, entry.time, railRef.current ? railRef.current.children[i + 1] : null) },
					onMouseLeave: () => { setHoverIdx(-1); hidePreview() },
					onFocus: () => { setHoverIdx(globalIdx); showTextPreview(entry.preview, entry.time, railRef.current ? railRef.current.children[i + 1] : null) },
					onBlur: () => { setHoverIdx(-1); hidePreview() },
					onClick: () => { void onNodeClick(entry) },
				})
			})

			const bottomIdx = windowRoster.length + 1
			items.push(react.createElement("button", {
				key: "__bottom",
				className: "dsh-node-nav-bottom",
				"aria-label": "跳到底部(最新消息)",
				onMouseEnter: () => { setHoverIdx(-1); showTextPreview('跳到底部(最新消息)', undefined, railRef.current ? railRef.current.children[bottomIdx] : null) },
				onMouseLeave: hidePreview,
				onFocus: () => { setHoverIdx(-1); showTextPreview('跳到底部(最新消息)', undefined, railRef.current ? railRef.current.children[bottomIdx] : null) },
				onBlur: hidePreview,
				onClick: scrollToBottom,
			}))

			return react.createElement(
				react.Fragment,
				null,
				react.createElement("div", { ref: previewRef, className: "dsh-node-nav-preview" }),
				miss !== "" && react.createElement("div", { className: "dsh-node-nav-miss" },
					react.createElement("span", null, miss)),
				visible && react.createElement(
					"div",
					{
						ref: railRef,
						className: "dsh-node-nav-rail"
							+ (hasMoreUp ? " dsh-node-nav-has-up" : "")
							+ (hasMoreDown ? " dsh-node-nav-has-down" : ""),
						role: "complementary",
						"aria-label": "对话节点导航",
						style: { right: `${detailsWidth > 0 ? detailsWidth + 18 : 28}px` },
					},
					react.createElement("div", { className: "dsh-node-nav-line" }),
					items,
				),
			)
		}

		/**
		 * 输入历史（readline/TUI 惯例）：draft 为空时 ↑ 回填最近一条用户输入，
		 * 连续 ↑ 翻更早、↓ 翻回更近；用户开始编辑或发送后指针重置。
		 *
		 * 状态机：pos ∈ [0, len]（len=历史条数；pos=len 为"基准态"=空 draft/编辑中）。
		 * 判定不依赖 flag，只比对 draft 与 users[pos]：相等=我们的回填还在，
		 * 不等=用户编辑/发送/清空 → 重置 pos=len。多条等值历史天然幂等。
		 *
		 * 契约：provide 通道 hooks.input（InputState store）+
		 * props.inputActions.setDraft(text)（官方单写入口；官方 onDraftChanged
		 * 无 phase 守卫，提交阶段的拒写由本模块的 phase!=='plain' 检查 +
		 * textarea readOnly 兜底）；
		 * 按键走 document 捕获阶段，目标必须位于 [data-composer-card] 内
		 * （composer textarea），菜单打开时 draft 必含触发词、天然不抢键。
		 * 纯图片消息（text 为 [图片] 占位）不参与历史。
		 */
		function installInputHistory(ctx) {
			let sessionId = undefined
			let users = []
			let pos = 0
			let input = undefined
			let actions = undefined
			let unsub = undefined
			let unsubInfo = undefined
			let disposed = false

			const textAt = (i) => (i >= 0 && i < users.length ? users[i].text : "")

			/** 会话切换或首次装配：换 face、重置状态、拉取该会话历史。 */
			const rewire = () => {
				if (disposed) return
				const info = ctx.sessions.currentProvideInfo.getSnapshot()
				const nextId = info && info.sessionId !== undefined ? info.sessionId : undefined
				const nextInput = info && info.hooks ? info.hooks.input : undefined
				// 身份守卫：sessionId 相同且 input store 身份未变才视为已装配；
				// HMR 重载后 provide bundle 重建、input store 换身份，必须重新订阅。
				if (nextId === sessionId && input !== undefined && input === nextInput) return
				sessionId = nextId
				pos = 0
				users = []
				if (unsub) { unsub(); unsub = undefined }
				input = nextInput
				actions = info && info.props ? info.props.inputActions : undefined
				if (input && typeof input.subscribe === "function") {
					unsub = input.subscribe(onInputChange)
				}
				if (sessionId !== undefined && sessionId !== "") {
					sharedFetchUsers(sessionId, false).then((list) => {
						if (disposed || sessionId !== nextId) return
						users = list.filter((u) => u.text !== "[图片]")
						if (pos > users.length) pos = users.length
					})
				}
			}

			/** draft 偏离回填值即重置（用户编辑/发送/清空）；相等则保持（含等值多条）。 */
			const onInputChange = () => {
				if (disposed || input === undefined) return
				const snap = input.getSnapshot()
				if (snap === undefined) return
				if (pos < users.length && snap.draft !== textAt(pos)) pos = users.length
			}

			const onKeyDown = (e) => {
				if (disposed) return
				if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
				if (e.isComposing || e.keyCode === 229) return
				if (e.defaultPrevented) return
				const target = e.target
				if (!(target instanceof HTMLTextAreaElement)) return
				if (target.disabled || target.readOnly) return
				if (target.closest("[data-composer-card]") === null) return
				rewire()
				if (input === undefined || actions === undefined) return
				const snap = input.getSnapshot()
				if (snap === undefined) return
				if (snap.phase !== "plain") return
				const draft = snap.draft

				if (e.key === "ArrowUp") {
					if (pos >= users.length) {
						if (draft !== "") return // 基准态且非空：放行光标移动
						if (users.length === 0) return
						pos = users.length - 1
					} else if (draft === textAt(pos)) {
						if (pos === 0) return
						pos = pos - 1
					} else {
						pos = users.length
						if (draft !== "") return
						pos = users.length - 1
					}
					e.preventDefault()
					actions.setDraft(textAt(pos))
					return
				}
				// ArrowDown
				if (pos >= users.length) return // 基准态：↓ 无历史语义，放行
				if (draft !== textAt(pos)) { pos = users.length; return }
				pos = pos + 1
				e.preventDefault()
				actions.setDraft(pos === users.length ? "" : textAt(pos))
			}

			document.addEventListener("keydown", onKeyDown, true)
			const info = ctx.sessions.currentProvideInfo
			if (info && typeof info.subscribe === "function") {
				unsubInfo = info.subscribe(rewire)
			}
			rewire()
			return () => {
				disposed = true
				document.removeEventListener("keydown", onKeyDown, true)
				if (unsub) unsub()
				if (unsubInfo) unsubInfo()
			}
		}

		function apply(ctx) {
			ctx.effect(() => {
				const disposeHistory = installInputHistory(ctx)
				const style = document.createElement("style")
				style.textContent = CSS_TEXT
				document.head.appendChild(style)
				const sessionIdSource = makeSessionIdSource(ctx)
				const offSlot = ctx.slots.register({
					name: "shell.overlay",
					id: "dsh-node-nav-rail",
					inject: () => ({ hooks: { sessionId: sessionIdSource } }),
				}, NodeNavRail)
				return () => {
					disposeHistory()
					offSlot()
					if (style.isConnected) style.remove()
				}
			}, "dsh-node-nav: overlay registration")
		}

		exports.apply = apply;
		exports.inject = ["sessions", "slots"];
		return module.exports;
	}
});
