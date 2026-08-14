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
 * - details 面板打开时自动左移避让;<2 条消息隐藏;深色模式;
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
					const id = sessionId
					if (typeof id !== 'string' || id === '') { setRemoteUsers([]); return }
					const url = new URL('/plugins/dsh-node-nav/api/users', window.location.origin)
					url.searchParams.set('sessionId', id)
					fetch(url.href)
						.then((r) => r.json())
						.then((data) => {
							if (!data || !Array.isArray(data.users)) { setRemoteUsers([]); return }
							setRemoteUsers(data.users.map((u) => ({ id: u.id, time: u.time, text: u.text })))
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

			// active 药丸:视口内最顶部已加载 user 行
			react.useEffect(() => {
				const compute = () => {
					const rows = userRows()
					if (rows.length === 0) { setActiveIdx(-1); return }
					let best = -1
					let bestTop = Number.POSITIVE_INFINITY
					for (let i = 0; i < rows.length; i++) {
						const top = rows[i].getBoundingClientRect().top
						if (top >= 0 && top < bestTop) { bestTop = top; best = i }
					}
					if (best === -1) best = rows.length - 1
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
			// active 药丸映射:按已加载行序计算当前行索引
			const loadedIdxs = []
			roster.forEach((entry, i) => { if (entry.el !== null && entry.el !== undefined) loadedIdxs.push(i) })
			let activeLoadedIdx = -1
			for (const i of loadedIdxs) {
				if (i >= activeIdx) { activeLoadedIdx = i; break }
			}
			if (activeLoadedIdx === -1 && loadedIdxs.length > 0) activeLoadedIdx = loadedIdxs[loadedIdxs.length - 1]

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

			const visible = roster.length >= 2 && flowOf() !== null

			const items = roster.map((entry, i) => {
				const isActive = i === activeLoadedIdx
				const unloaded = entry.el === null || entry.el === undefined
				return react.createElement("button", {
					key: entry.id !== undefined ? entry.id : `dom-${i}`,
					className: "dsh-node-nav-dot"
						+ (isActive ? " dsh-node-nav-dot-active" : "")
						+ (unloaded ? " dsh-node-nav-dot-unloaded" : ""),
					"aria-label": `跳转到消息 ${entry.time ? hhmm(entry.time) : `#${i + 1}`}${unloaded ? '(未加载)' : ''}`,
					onMouseEnter: () => { setHoverIdx(i); showTextPreview(entry.preview, entry.time, railRef.current ? railRef.current.children[i + 1] : null) },
					onMouseLeave: () => { setHoverIdx(-1); hidePreview() },
					onFocus: () => { setHoverIdx(i); showTextPreview(entry.preview, entry.time, railRef.current ? railRef.current.children[i + 1] : null) },
					onBlur: () => { setHoverIdx(-1); hidePreview() },
					onClick: () => { void onNodeClick(entry) },
				})
			})

			const bottomIdx = roster.length + 1
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
						className: "dsh-node-nav-rail",
						role: "complementary",
						"aria-label": "对话节点导航",
						style: { right: `${detailsWidth > 0 ? detailsWidth + 18 : 28}px` },
					},
					react.createElement("div", { className: "dsh-node-nav-line" }),
					items,
				),
			)
		}

		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style")
				style.textContent = CSS_TEXT
				document.head.appendChild(style)
				const sessionIdSource = makeSessionIdSource(ctx)
				return ctx.slots.register({
					name: "shell.overlay",
					id: "dsh-node-nav-rail",
					inject: () => ({ hooks: { sessionId: sessionIdSource } }),
				}, NodeNavRail)
			}, "dsh-node-nav: overlay registration")
		}

		exports.apply = apply;
		exports.inject = ["sessions", "slots"];
		return module.exports;
	}
});
