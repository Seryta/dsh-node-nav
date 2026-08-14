/**
 * dsh-node-nav — 对话节点导航（浏览器客户端插件，手写 bundle）。
 *
 * 形态：注册到 shell.overlay（root 作用域的加法槽）。数据源为 **DOM 扫描**
 * （dsh-navbar 同款方案）：会话快照（ConversationSnapshot）在部分 dsh 版本上
 * 只含最近窗口的 user 节点，而页面 DOM 已渲染全部可见行——直接扫
 * `[data-time-hover-root]`（user 行，排除 pending steering，要求含气泡结构）
 * 得到导航节点，绕开快照窗口差异。
 *
 * 交互：hover/focus 节点显示气泡文本预览；点击 scrollIntoView 跳转 + 短暂
 * 高亮；IntersectionObserver + 滚动事件驱动 active 药丸跟随阅读位置；
 * details 面板打开时自动左移避让；<2 条 user 消息时隐藏。
 *
 * 参考：dsh-navbar（DOM 扫描/激活语义/focus 预览/reduced-motion）、
 * dsh-turn-index（details 避让测量）。
 *
 * 构建方式：零 pnpm/零改源码 —— 由 host 端 ClientModuleRegistry 扫描
 * cordis 图中的 dsh-node-nav 行（裸包名），serve 本文件为 /plugins/dsh-node-nav/client.js。
 */
window.__ModuleLoader__.load({
	id: "dsh-node-nav",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");

		const PREVIEW_CHARS = 300

		/** 对话流容器（聊天区）动态查询：会话切换后容器可能被替换。 */
		function flowOf() {
			return document.querySelector('[data-chat-flow=""]')
		}

		/** 流的滚动容器：向上找第一个 overflowY auto/scroll 的祖先。 */
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

		/**
		 * 页面上的 user 消息行：`[data-time-hover-root]` 且含气泡结构
		 * （排除 assistant/Think 行——body 无 bubble）与 pending steering。
		 * @returns {HTMLElement[]}
		 */
		function userRows() {
			return [...document.querySelectorAll('[data-time-hover-root]')].filter((row) =>
				!row.hasAttribute('data-pending-steering') && row.querySelector('[class*="bubble"]') !== null)
		}

		/** 从 user 行提取预览文本（气泡内文本，避免混入时间戳/操作按钮）。 */
		function rowPreview(row) {
			const bubble = row.querySelector('[class*="bubble"]')
			return ((bubble ?? row).textContent ?? '').trim()
		}

		/** 平滑跳转 + 短暂高亮；找不到行（已卸载）返回 false。 */
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

		const CSS_TEXT = `
.dsh-node-nav-rail { position: fixed; right: 28px; top: 50%; transform: translateY(-50%); width: 16px; max-height: calc(100vh - 32px); overflow-y: auto; scrollbar-width: none; z-index: 1000; display: flex; flex-direction: column; align-items: center; gap: 9px; padding: 14px 0; }
.dsh-node-nav-rail::-webkit-scrollbar { display: none; }
.dsh-node-nav-line { position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; margin-left: -1px; border-radius: 1px; background: linear-gradient(to bottom, transparent, rgba(127,127,127,0.42) 10%, rgba(127,127,127,0.42) 90%, transparent); }
.dsh-node-nav-dot { position: relative; flex: none; width: 11px; height: 11px; border-radius: 50%; background: #ffffff; border: 2px solid rgba(99,102,241,0.55); padding: 0; box-sizing: border-box; cursor: pointer; box-shadow: 0 0 0 3px rgba(255,255,255,0.55); transition: transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease; }
.dsh-node-nav-dot:hover { transform: scale(1.4); background: rgba(99,102,241,0.95); border-color: rgba(99,102,241,1); box-shadow: 0 0 0 5px rgba(99,102,241,0.16); }
.dsh-node-nav-dot:focus-visible { outline: 2px solid rgba(99,102,241,0.9); outline-offset: 2px; }
.dsh-node-nav-dot-active { background: rgba(99,102,241,0.95); border-color: rgba(99,102,241,1); box-shadow: 0 0 0 4px rgba(99,102,241,0.25); transform: scale(1.2); }
body[data-ds-dark-theme] .dsh-node-nav-dot { background: #1e232b; box-shadow: 0 0 0 3px rgba(0,0,0,0.4); }
body[data-ds-dark-theme] .dsh-node-nav-dot:hover { background: rgba(129,140,248,0.95); border-color: rgba(165,180,252,1); box-shadow: 0 0 0 5px rgba(129,140,248,0.22); }
body[data-ds-dark-theme] .dsh-node-nav-dot-active { background: rgba(129,140,248,0.95); border-color: rgba(165,180,252,1); box-shadow: 0 0 0 4px rgba(129,140,248,0.3); }
.dsh-node-nav-preview { position: fixed; z-index: 1001; width: 284px; max-height: 240px; overflow: hidden; background: #ffffff; color: #24292f; border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; padding: 10px 12px; font-size: 13px; line-height: 1.6; text-align: left; box-shadow: 0 10px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08); pointer-events: none; white-space: pre-wrap; word-break: break-word; display: none; animation: dshNavIn 0.16s ease; }
body[data-ds-dark-theme] .dsh-node-nav-preview { background: #1f242d; color: #e6e9f0; border-color: rgba(255,255,255,0.07); box-shadow: 0 10px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3); }
@keyframes dshNavIn { from { opacity: 0; transform: translateX(4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .dsh-node-nav-dot, .dsh-node-nav-preview { transition: none; animation: none; }
}
`

		/** 右侧导航条组件（props 由 slots 框架注入）。 */
		function NodeNavRail() {
			// 全部 hooks 在任何条件 return 之前调用（React #310 教训）。
			const [roster, setRoster] = react.useState([])          // 元素序列不变则引用不变
			const [activeIdx, setActiveIdx] = react.useState(-1)
			const [hoverIdx, setHoverIdx] = react.useState(-1)
			const [detailsWidth, setDetailsWidth] = react.useState(0)
			const railRef = react.useRef(null)
			const previewRef = react.useRef(null)

			// DOM 扫描 + MutationObserver（body 全量观察，rAF 去抖）+ 滚动/resize 兜底。
			react.useEffect(() => {
				let raf = 0
				const scan = () => {
					raf = 0
					const rows = userRows()
					setRoster((prev) => {
						if (prev.length === rows.length && prev.every((r, i) => r.el === rows[i])) return prev
						return rows.map((el) => ({ el, preview: rowPreview(el) }))
					})
				}
				const schedule = () => {
					if (raf === 0) raf = requestAnimationFrame(scan)
				}
				const mo = typeof MutationObserver === 'function'
					? new MutationObserver(() => { schedule() })
					: null
				if (mo !== null) mo.observe(document.body, { childList: true, subtree: true })
				let io = null
				const bindIO = () => {
					if (io !== null) io.disconnect()
					const root = scrollerOf()
					if (root === null) return
					io = new IntersectionObserver(() => { schedule() }, { root, rootMargin: '0px 0px -15% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] })
					userRows().forEach((row) => { io.observe(row) })
				}
				bindIO()
				document.addEventListener('scroll', schedule, { capture: true, passive: true })
				window.addEventListener('resize', schedule)
				scan()
				return () => {
					if (mo !== null) mo.disconnect()
					if (io !== null) io.disconnect()
					document.removeEventListener('scroll', schedule, { capture: true })
					window.removeEventListener('resize', schedule)
				}
			}, [])

			// details 面板避让：读 AppFrame grid 第三轨宽（style 变化 + 轮询兜底）。
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

			// active 药丸跟随阅读位置：视口内最顶部 user 行（rAF 节流）。
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
			}, [roster])

			// hover/focus 预览卡
			const showPreview = (entry, anchorEl) => {
				const text = entry.preview
				if (text === '') return
				const preview = previewRef.current
				if (preview === null) return
				preview.textContent = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '…' : text
				const r = anchorEl.getBoundingClientRect()
				preview.style.right = `${window.innerWidth - r.left + 14}px`
				preview.style.top = `${Math.min(window.innerHeight - 130, r.top - 12)}px`
				preview.style.display = 'block'
			}
			const hidePreview = () => {
				const preview = previewRef.current
				if (preview !== null) preview.style.display = 'none'
			}

			// <2 条或非对话页隐藏
			const visible = roster.length >= 2 && flowOf() !== null

			const items = roster.map((entry, i) => {
				const isActive = i === activeIdx
				return react.createElement("button", {
					key: i,
					className: "dsh-node-nav-dot" + (isActive ? " dsh-node-nav-dot-active" : ""),
					"aria-label": `跳转到消息 #${i + 1}`,
					onMouseEnter: () => { setHoverIdx(i); showPreview(entry, railRef.current ? railRef.current.children[i + 1] : null) },
					onMouseLeave: () => { setHoverIdx(-1); hidePreview() },
					onFocus: () => { setHoverIdx(i); showPreview(entry, railRef.current ? railRef.current.children[i + 1] : null) },
					onBlur: () => { setHoverIdx(-1); hidePreview() },
					onClick: () => { jumpToRow(entry.el) },
				})
			})

			return react.createElement(
				react.Fragment,
				null,
				react.createElement("div", { ref: previewRef, className: "dsh-node-nav-preview" }),
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
				return ctx.slots.register({
					name: "shell.overlay",
					id: "dsh-node-nav-rail",
					inject: () => ({}),
				}, NodeNavRail)
			}, "dsh-node-nav: overlay registration")
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
