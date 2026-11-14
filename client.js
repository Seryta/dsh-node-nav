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
 * - rail 接管滚轮:悬停节点串时滚轮手动翻节点窗口(不滚动正文),滚正文/点节点
 *   即回到跟随阅读位置;
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
		/**
		 * 按钮分页的时间预算（毫秒）。主路径（官方会话控制器 loadOlder）不设死线：
		 * 它翻到 hasMore=false 或连续空转就停，大会话也不会被「30 批」这种拍脑袋上限截断。
		 */
		const LOAD_TIMEOUT_MS = 60000

		/** 用户消息列表共享缓存：sessionId → users:[{id,time,text}]（导航与输入历史共用）。 */
		var usersCache = new Map()
		/** 缓存会话数上限：超出按插入序淘汰最旧（Map 迭代序即插入序）。 */
		var USERS_CACHE_MAX = 10
		/** 在途请求：sessionId → promise（去重：导航/历史/重拉并发时只发一次请求）。 */
		var inflightUsers = new Map()
		/**
		 * 客户端插件上下文（apply 时捕获）。点击未加载节点时用它取会话实例，
		 * 调官方 `loadOlder()` 增量翻页——不依赖「加载更早」按钮的文本与 disabled 态。
		 */
		var pluginCtx = undefined
		/**
		 * 缓存更新订阅：rail 每次防抖重拉都会刷新 usersCache，历史模块据此把
		 * 「页面挂载之后才到达的用户消息」也纳入 ↑/↓。旧实现只在 rewire 时读一次
		 * 列表，页面生命周期内新发的消息永远进不了历史（2026-11-04 用户实测）。
		 */
		var usersListeners = new Set()
		function onUsersUpdated(fn) {
			usersListeners.add(fn)
			return () => { usersListeners.delete(fn) }
		}
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
						.map((u) => ({ id: u.id, seq: u.seq, time: u.time, text: u.text }))
					if (usersCache.size >= USERS_CACHE_MAX) usersCache.delete(usersCache.keys().next().value)
					usersCache.set(sessionId, users)
					for (const fn of usersListeners) {
						try { fn(sessionId, users) } catch { /* 订阅方异常不影响请求链 */ }
					}
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


		/* ── 旁支问答（dsh-btw）桥接 ──────────────────────────────────────
		 * 旁支记录不是用户消息，不在 /api/users 里。dsh-btw 的 client 半部把只读快照
		 * 挂到 window.__dshBtw（list/selected/open/subscribe），这里按 anchorSeq 把它们
		 * 混进节点串：菱形=旁支，点击回开浮条，hover 显示提问。
		 * btw 没装 = 没有这个对象 = 行为与从前完全一致。 */
		const EMPTY_BTW = Object.freeze([])

		function btwBridge() {
			const api = typeof window === "undefined" ? undefined : window.__dshBtw
			return api && typeof api.list === "function" && typeof api.subscribe === "function" ? api : undefined
		}

		/**
		 * 订阅旁支快照与“浮条里当前那条”；桥缺席时恒为空。
		 * 每次同步都重新读 window.__dshBtw：btw 单独热重载会换掉那个对象，
		 * 抓住旧引用会拿到已死的闭包。1s 轮询只用于发现“对象被换掉”，不拉数据。
		 */
		function useBtwState() {
			const [state, setState] = react.useState(() => ({
				items: EMPTY_BTW,
				selectedId: undefined,
			}))
			react.useEffect(() => {
				const read = () => {
					const live = btwBridge()
					if (live === undefined) return { items: EMPTY_BTW, selectedId: undefined }
					return {
						items: live.list(),
						selectedId: typeof live.selected === "function" ? live.selected() : undefined,
					}
				}
				const sync = () => setState(read())
				let api = btwBridge()
				let off = api === undefined ? undefined : api.subscribe(sync)
				sync()
				const timer = window.setInterval(() => {
					const current = btwBridge()
					if (current === api) return
					if (off !== undefined) off()
					api = current
					off = api === undefined ? undefined : api.subscribe(sync)
					sync()
				}, 1000)
				return () => {
					window.clearInterval(timer)
					if (off !== undefined) off()
				}
			}, [])
			return state
		}

		/**
		 * 把旁支按 anchorSeq 插进用户消息节点串：anchorSeq 是该记录在会话日志里的
		 * 位置，比它早的用户消息（seq 更小或相等）排在前面，于是“第几次提问之后”
		 * 的先后关系与日志完全一致。纯 DOM 回退模式没有 seq，退化为追加在末尾。
		 */
		function mergeBtwMarkers(roster, items) {
			if (!Array.isArray(items) || items.length === 0) return roster
			const marks = []
			for (const item of items) {
				if (item === null || typeof item !== "object" || typeof item.btwId !== "string") continue
				marks.push({
					kind: "btw",
					btwId: item.btwId,
					seq: typeof item.anchorSeq === "number" ? item.anchorSeq : undefined,
					time: item.startedAt,
					preview: item.question,
					status: item.status,
				})
			}
			if (marks.length === 0) return roster
			const order = (value) => (typeof value === "number" ? value : Number.MAX_SAFE_INTEGER)
			marks.sort((a, b) => order(a.seq) - order(b.seq))
			const hasSeq = roster.some((entry) => typeof entry.seq === "number")
			// 端点回退（纯 DOM 扫描）时没有 seq 可比：至少保证旁支自身按日志顺序排好。
			if (!hasSeq) return roster.concat(marks)
			const merged = []
			let cursor = 0
			for (const mark of marks) {
				while (cursor < roster.length && typeof roster[cursor].seq === "number" && roster[cursor].seq <= order(mark.seq)) merged.push(roster[cursor++])
				merged.push(mark)
			}
			while (cursor < roster.length) merged.push(roster[cursor++])
			return merged
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

		/**
		 * 页面自带的「加载更早」控件。分页期间按钮是 disabled 且标签被换成
		 * 「加载中…」（dsh-client-ui-chat 0.2.x：`loadingOlder ? t("loading") :
		 * t("chat.loadOlder")`），只按「加载更早」文本找会在第一轮就返回 null，
		 * 于是被误判成「没有更早历史」而放弃——这正是点击很早节点失败的主因。
		 * 因此先按结构定位（`div[class*="_older"] > button`），文本只作老版兜底。
		 */
		var olderBtnRef = null
		function olderButton() {
			if (olderBtnRef !== null && olderBtnRef.isConnected) return olderBtnRef
			const structural = document.querySelector('div[class*="_older"] > button')
			if (structural !== null) { olderBtnRef = structural; return structural }
			for (const b of document.querySelectorAll('button')) {
				const t = (b.textContent ?? '').trim()
				if (t === '加载更早' || t === '加载中…' || t === 'Load earlier' || t === 'Loading…') {
					olderBtnRef = b
					return b
				}
			}
			olderBtnRef = null
			return null
		}

		/**
		 * 取会话实例。`sessions` 服务对外的门面只有 list/scope/retain…，
		 * 真正的 Session 实例挂在 `sessions.manager.get(id)`（0.2.x）；
		 * 更早的运行时代替是 `sessions.get(id)`。两者都没有就返回 undefined。
		 */
		function clientSession(ctx, sessionId) {
			const sessions = ctx === undefined ? undefined : ctx.sessions
			if (sessions === undefined || sessions === null) return undefined
			const manager = sessions.manager
			if (manager !== undefined && manager !== null && typeof manager.get === 'function') {
				try { return manager.get(sessionId) } catch { /* 落到下一支 */ }
			}
			if (typeof sessions.get === 'function') {
				try { return sessions.get(sessionId) } catch { /* 没有可用的会话实例 */ }
			}
			return undefined
		}

		/**
		 * 官方增量分页：调用会话控制器 `loadOlder()` 一页页往前翻（每页到 DOM
		 * 就停），锚点行一出现立即返回。比 `loadThrough` 好在**边翻边提交**：
		 * 目标只隔几页时立刻收工，不必把到 seq 0 的整条历史都翻完。
		 * 没有会话实例 / 会话未打开 / 已经没有更早历史时返回 null。
		 */
		function sessionPageUntil(id, session, onPage) {
			return new Promise((resolve) => {
				if (session === undefined || session === null || typeof session.loadOlder !== 'function') { resolve(null); return }
				let pages = 0
				let stalled = 0
				let lastBase = undefined
				const step = () => {
					const el = anchorOfId(id)
					if (el !== null) { resolve(el); return }
					if (session.openState !== undefined && session.openState !== 'open') { resolve(null); return }
					if (session.loadingOlder === true) { setTimeout(step, 120); return }
					if (session.hasMore === false) { resolve(null); return }
					// baseSeq 是当前窗口最早事件的 seq：连续几页不往前挪说明 loader 空转。
					const base = session.baseSeq
					if (base !== undefined && base === lastBase) {
						stalled++
						if (stalled >= 3) { resolve(null); return }
					} else {
						stalled = 0
					}
					lastBase = base
					Promise.resolve(session.loadOlder()).then(() => {
						pages++
						if (onPage !== undefined) { try { onPage(pages) } catch { /* 提示失败不影响翻页 */ } }
						setTimeout(step, 80)
					}, () => resolve(null))
				}
				step()
			})
		}

		/**
		 * 回退：点页面自带的「加载更早」按钮，直到锚点行进入 DOM。
		 * 分页期间按钮 disabled 且标签变「加载中…」，所以要等它恢复可点再点，
		 * 不能把「按钮此刻不存在」当成「没有更早历史」。
		 */
		function buttonPageUntil(id) {
			return new Promise((resolve) => {
				const deadline = Date.now() + LOAD_TIMEOUT_MS
				const step = () => {
					const el = anchorOfId(id)
					if (el !== null) { resolve(el); return }
					if (Date.now() >= deadline) { resolve(null); return }
					const btn = olderButton()
					if (btn === null) { resolve(null); return }
					if (btn.disabled) { setTimeout(step, 200); return }
					btn.click()
					setTimeout(step, 200)
				}
				step()
			})
		}

		/** 按需加载：先走官方会话控制器，拿不到再退回按钮分页。找到返回行，否则 null。 */
		function loadUntilVisible(id, sessionId, onPage) {
			return sessionPageUntil(id, clientSession(pluginCtx, sessionId), onPage)
				.then((found) => (found !== null ? found : buttonPageUntil(id)))
		}

		/**
		 * 节点窗口起点。正常情况跟随 active 居中；**没有任何 active**（视口里
		 * 一条已加载的用户消息都没有，例如分页窗口停在回合中间）时贴住末端：
		 * 这时聊天区显示的是最新一页，节点串也该停在最新节点上。旧实现把
		 * activeIdx=-1 直接当 0 用，窗口滑到最早 15 条（全都未加载），
		 * 末端混进来的旁支菱形永远进不了可见窗口。
		 */
		function windowStartOf(activeIdx, length, size) {
			if (length <= size) return 0
			const focus = activeIdx >= 0 ? activeIdx : length - 1
			const half = Math.floor((size - 1) / 2)
			return Math.min(Math.max(focus - half, 0), length - size)
		}

		/** 轨上滚轮一格：累计 40px 翻一个节点（触控板小增量攒够一格再走）。 */
		const WHEEL_STEP_PX = 40

		/**
		 * 滚轮 deltaY 换算成像素。deltaMode：0=像素、1=行、2=页。
		 * 行模式按 16px/行折算（Chromium 的实现值）；页模式按轨高折算。
		 */
		function wheelDeltaPx(deltaY, deltaMode, pageHeight) {
			if (deltaMode === 1) return deltaY * 16
			if (deltaMode === 2) return deltaY * (pageHeight > 0 ? pageHeight : 1)
			return deltaY
		}

		/**
		 * 轨上滚轮增量 → 节点窗口起点。按 WHEEL_STEP_PX 一格折算位移，两端夹紧；
		 * 不足一格的余量原样返回，留给下一次 wheel（触控板连续小增量因此能攒够一格）。
		 * 顶到任一端后余量清零：继续同向滚不应攒成回头时的"暴冲"。
		 */
		function wheelWindowStart(start, amount, maxStart) {
			if (maxStart <= 0) return { start: 0, rest: 0 }
			let next = Math.min(Math.max(start, 0), maxStart)
			let rest = amount
			const dir = rest > 0 ? 1 : -1
			while (Math.abs(rest) >= WHEEL_STEP_PX) {
				const candidate = Math.min(Math.max(next + dir, 0), maxStart)
				rest -= dir * WHEEL_STEP_PX
				if (candidate === next) { rest = 0; break }
				next = candidate
			}
			return { start: next, rest }
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
/* 旁支问答节点：菱形。用户消息是圆点、底部跳转是方块，三种形状一眼可分。
   旋转必须写进每个状态，否则 hover/active 会把它转回方块。 */
.dsh-node-nav-btw { border-radius: 2px; border-color: rgba(20, 184, 166, 0.65); transform: rotate(45deg) scale(0.92); }
.dsh-node-nav-btw:hover { transform: rotate(45deg) scale(1.3); background: rgba(20, 184, 166, 0.95); border-color: rgba(20, 184, 166, 1); box-shadow: 0 0 0 5px rgba(20, 184, 166, 0.16); }
.dsh-node-nav-btw:focus-visible { outline: 2px solid rgba(20, 184, 166, 0.9); outline-offset: 2px; }
.dsh-node-nav-btw.dsh-node-nav-dot-active { transform: rotate(45deg) scale(1.12); background: rgba(20, 184, 166, 0.95); border-color: rgba(20, 184, 166, 1); box-shadow: 0 0 0 4px rgba(20, 184, 166, 0.25); }
body[data-ds-dark-theme] .dsh-node-nav-btw { border-color: rgba(45, 212, 191, 0.7); }
body[data-ds-dark-theme] .dsh-node-nav-btw:hover { background: rgba(45, 212, 191, 0.95); border-color: rgba(153, 246, 228, 1); box-shadow: 0 0 0 5px rgba(45, 212, 191, 0.22); }
body[data-ds-dark-theme] .dsh-node-nav-btw.dsh-node-nav-dot-active { background: rgba(45, 212, 191, 0.95); border-color: rgba(153, 246, 228, 1); box-shadow: 0 0 0 4px rgba(45, 212, 191, 0.3); }
`

		/** epoch ms → HH:MM。 */
		function hhmm(ms) {
			if (!ms) return ""
			const d = new Date(ms)
			return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
		}

		/**
		 * 当前会话 id，三代兼容：
		 *  - 0.1.5-rc.1：ctx.sessions.list.getSnapshot().current
		 *  - 0.1.6-alpha.2：current/currentAddress 已被删除，"当前会话"改由视图层
		 *    以 mainView 占用表达（SessionSummary.retainedBy.mainView > 0）
		 *  - 0.1.1：ctx.sessions.currentProvideInfo.getSnapshot().sessionId
		 * 读不到一律返回 undefined（调用方按"未知"处理）。上下文已失效时也走这条路：
		 * 客户端 HMR 换代时 store 订阅回调可能早于 dispose 跑，此时 ctx 已 inactive，
		 * 访问 ctx.sessions 会抛 "cannot get required service in inactive context"，
		 * 被 store 记为 subscriber failed 刷进控制台（实测每个热重载一条）。
		 */
		function currentSessionId(ctx) {
			try {
				const list = ctx.sessions && ctx.sessions.list
				const snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : undefined
				if (snap && typeof snap.current === "string" && snap.current !== "") return snap.current
				// 0.1.6-alpha.2：list 状态不再带 current/currentAddress，改为按
				// retainedBy.mainView 占用计数反推（同一时刻只应有一个 mainView 持有者）。
				if (snap && snap.byId !== null && typeof snap.byId === "object") {
					for (const id of Object.keys(snap.byId)) {
						const retainedBy = snap.byId[id] && snap.byId[id].retainedBy
						if (retainedBy && typeof retainedBy.mainView === "number" && retainedBy.mainView > 0) return id
					}
				}
				const info = ctx.sessions && ctx.sessions.currentProvideInfo
				if (info && typeof info.getSnapshot === "function") {
					const s2 = info.getSnapshot()
					return s2 && typeof s2.sessionId === "string" ? s2.sessionId : undefined
				}
				return undefined
			} catch {
				return undefined
			}
		}

		/**
		 * 从 0.1.2+ 的输入机取出可直接调用的 setDraft。
		 *
		 * `conversation.input.for(scope)` 返回的是 SessionInputShell 实例，其
		 * `setDraft` 是原型方法（内部读 `this.projection.clipboardText`）。把这个
		 * 方法引用摘下来单独调用会丢 `this`，直接抛 `TypeError: Cannot read
		 * properties of undefined (reading 'clipboardText')`，表现为 ↑/↓ 历史回填
		 * 静默失效（dsh-client-ui-conversation 0.1.5 实测，2026-09-10）。
		 * 故优先用 shell 的公开 action face（`actions.setDraft`，箭头函数、自带词法
		 * this），取不到再把原型方法绑回实例。
		 */
		function inputSetDraft(input) {
			const face = input.actions !== undefined && typeof input.actions.setDraft === "function" ? input.actions : input
			if (typeof face.setDraft !== "function") return undefined
			return face.setDraft.bind(face)
		}

		/**
		 * 当前会话的输入机，双代兼容：
		 *  - 0.1.2：ctx.conversation.input.for(会话 scope).state + .setDraft
		 *  - 0.1.1：currentProvideInfo 的 hooks.input + props.inputActions.setDraft
		 */
		function currentInput(ctx) {
			const sid = currentSessionId(ctx)
			if (sid === undefined) return undefined
			let actx
			try { actx = ctx.sessions.scope(sid) } catch { return undefined }
			if (actx === undefined) return undefined
			const conversation = ctx.get ? ctx.get("conversation") : undefined
			if (conversation !== undefined && conversation.input && typeof conversation.input.for === "function") {
				try {
					const input = conversation.input.for(actx)
					if (input !== undefined) return { state: input.state, setDraft: inputSetDraft(input) }
				} catch { /* 落到 0.1.1 回退 */ }
			}
			const info = ctx.sessions && ctx.sessions.currentProvideInfo
			if (info && typeof info.getSnapshot === "function") {
				const snap = info.getSnapshot()
				if (snap === undefined) return undefined
				const store = snap.hooks && snap.hooks.input
				const actions = snap.props && snap.props.inputActions
				if (store !== undefined) return { state: store, setDraft: actions && actions.setDraft }
			}
			return undefined
		}

		/** 会话 id 的 bare observable（0.1.2 订阅 sessions.list，0.1.1 回退 currentProvideInfo）。 */
		function makeSessionIdSource(ctx) {
			const listeners = new Set()
			let snapshot = undefined
			let disposed = false
			const recompute = () => {
				if (disposed) return
				const next = currentSessionId(ctx)
				if (snapshot === next) return
				snapshot = next
				for (const fn of listeners) fn()
			}
			let unsub = undefined
			const list = ctx.sessions && ctx.sessions.list
			if (list && typeof list.subscribe === "function") unsub = list.subscribe(recompute)
			else {
				const info = ctx.sessions && ctx.sessions.currentProvideInfo
				if (info && typeof info.subscribe === "function") unsub = info.subscribe(recompute)
			}
			recompute()
			return {
				getSnapshot: () => snapshot,
				subscribe: (fn) => {
					listeners.add(fn)
					return () => { listeners.delete(fn) }
				},
				dispose: () => {
					disposed = true
					if (unsub) unsub()
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
			const btwState = useBtwState()
			/** 手动翻页的窗口起点；null = 跟随阅读位置（默认）。 */
			const [railStartOverride, setRailStartOverride] = react.useState(null)
			/** 轨上滚轮累计的像素余量（不足一格的部分留给下一次 wheel）。 */
			const railWheelAcc = react.useRef(0)
			/** wheel 回调经 ref 读最新窗口参数，避免监听器闭包拿旧值。 */
			const railWheelMeta = react.useRef({ start: 0, maxStart: 0, length: 0 })

			// 服务端全量列表:会话切换或 DOM 变化(新消息/加载历史)时防抖刷新
			react.useEffect(() => {
				let timer = 0
				const fetchUsers = () => {
					timer = 0
					if (typeof sessionId !== "string" || sessionId === "") { setRemoteUsers([]); return }
					sharedFetchUsers(sessionId, true)
						.then((users) => {
							// seq 必须带下来：点击未加载节点时用官方 loadThrough(seq) 翻页。
							setRemoteUsers(users.map((u) => ({ id: u.id, seq: u.seq, time: u.time, text: u.text })))
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

			// 会话切换：手动翻页窗口作废，回到跟随新会话的阅读位置。
			react.useEffect(() => { setRailStartOverride(null) }, [sessionId])

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
					requestAnimationFrame(() => {
						ticking = false
						compute()
						// 滚动正文 = 回到跟随阅读位置；手动翻页状态只在轨上滚轮期间有效。
						setRailStartOverride((prev) => (prev === null ? prev : null))
					})
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

			// 当前是否在对话页：rail 只在对话流存在时渲染。
			const visible = flowOf() !== null

			// 轨上滚轮手动翻页：悬停节点串时滚轮翻节点窗口，不滚动正文。
			// 只在窗口可滑动（节点数 > 一窗）时接管；翻到任一端后余量清零并放行
			// 默认行为（极短视口下 rail 自身溢出时仍可原生滚动到底部节点）。
			react.useEffect(() => {
				if (!visible) return
				const rail = railRef.current
				if (rail === null) return
				const onWheel = (event) => {
					const meta = railWheelMeta.current
					if (meta.length <= WINDOW || meta.maxStart <= 0) return
					const px = wheelDeltaPx(event.deltaY, event.deltaMode, rail.clientHeight)
					if (px === 0) return
					// 反向滚动先清掉上一方向的余量，避免回头时"暴冲"。
					if (railWheelAcc.current !== 0 && (railWheelAcc.current > 0) !== (px > 0)) railWheelAcc.current = 0
					const moved = wheelWindowStart(meta.start, railWheelAcc.current + px, meta.maxStart)
					railWheelAcc.current = moved.rest
					if (moved.start === meta.start) return
					event.preventDefault()
					setRailStartOverride(moved.start)
				}
				rail.addEventListener("wheel", onWheel, { passive: false })
				return () => rail.removeEventListener("wheel", onWheel)
			}, [visible])

			// roster 组装:服务端全量为主;端点空时 fallback 纯 DOM 行
			let roster
			if (remoteUsers.length > 0) {
				roster = remoteUsers.map((u) => ({
					id: u.id,
					seq: u.seq,
					time: u.time,
					preview: u.text,
					el: anchorOfId(u.id),
				}))
			} else {
				roster = userRows().map((el) => ({ id: undefined, time: undefined, preview: rowPreview(el), el }))
			}
			// 旁支记录按 anchorSeq 混进来：菱形节点与用户消息节点共用同一串、同一顺序。
			roster = mergeBtwMarkers(roster, btwState.items)
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
			/** 跳转进行中的提示：不自动消失，由结束时清除（大会话翻页要几秒）。 */
			const showHint = (text) => {
				window.clearTimeout(missTimer.current)
				setMiss(text)
			}
			const hideHint = () => setMiss("")

			const onNodeClick = async (entry) => {
				// 点击节点 = 回到跟随阅读位置：手动翻页窗口作废（跳转本身也会
				// 触发 scroll 再清一次；未加载节点的翻页路径没有 scroll）。
				setRailStartOverride(null)
				let el = entry.el
				if ((el === null || el === undefined) && entry.id !== undefined) {
					showHint('正在加载历史…')
					try {
						el = await loadUntilVisible(entry.id, sessionId, (pages) => showHint(`正在加载历史… 第 ${pages} 页`))
					} finally {
						hideHint()
					}
				}
				if (el === null || el === undefined || !jumpToRow(el)) {
					showMiss('目标消息未能定位(历史加载失败或该会话已不在当前视图)')
				}
			}

			// 显示窗口：最多 WINDOW 个节点。默认随 active 平移（阅读到哪里、
			// 节点串滑到哪里，无需滚动条）；在轨上滚轮可手动把窗口翻到任意一段，
			// 滚正文或点节点后回到跟随。窗口外两端用渐隐提示。
			const WINDOW = 15
			const maxStart = Math.max(0, roster.length - WINDOW)
			const followStart = windowStartOf(activeIdx, roster.length, WINDOW)
			const windowStart = railStartOverride === null ? followStart : Math.min(Math.max(railStartOverride, 0), maxStart)
			railWheelMeta.current = { start: windowStart, maxStart, length: roster.length }
			const windowRoster = roster.length > WINDOW ? roster.slice(windowStart, windowStart + WINDOW) : roster
			const hasMoreUp = windowStart > 0
			const hasMoreDown = windowStart + WINDOW < roster.length

			const items = windowRoster.map((entry, i) => {
				const globalIdx = windowStart + i
				const anchorEl = () => (railRef.current ? railRef.current.children[i + 1] : null)
				if (entry.kind === "btw") {
					// 旁支：菱形，点击回开浮条那一条（不跳转消息——它没有对应的聊天行）。
					const isBtwActive = btwState.selectedId !== undefined && btwState.selectedId === entry.btwId
					const label = entry.status === "running" ? "旁支问答（回答中）" : "旁支问答"
					const hoverText = `${label} · ${entry.preview === undefined || entry.preview === "" ? "（提问内容缺失）" : entry.preview}`
					return react.createElement("button", {
						key: `btw:${entry.btwId}`,
						className: "dsh-node-nav-dot dsh-node-nav-btw"
							+ (isBtwActive ? " dsh-node-nav-dot-active" : ""),
						"aria-label": `${label} ${entry.time ? hhmm(entry.time) : ""}：${entry.preview || ""}`,
						"data-dsh-btw-marker": entry.btwId,
						onMouseEnter: () => { setHoverIdx(-1); showTextPreview(hoverText, entry.time, anchorEl()) },
						onMouseLeave: () => { setHoverIdx(-1); hidePreview() },
						onFocus: () => { setHoverIdx(-1); showTextPreview(hoverText, entry.time, anchorEl()) },
						onBlur: () => { setHoverIdx(-1); hidePreview() },
						onClick: () => {
							const api = btwBridge()
							if (api === undefined || typeof api.open !== "function") { showMiss("旁支问答插件未就绪（dsh-btw client 未加载）"); return }
							api.open(entry.btwId)
						},
					})
				}
				const isActive = globalIdx === activeIdx
				const unloaded = entry.el === null || entry.el === undefined
				return react.createElement("button", {
					key: entry.id !== undefined ? entry.id : `dom-${globalIdx}`,
					className: "dsh-node-nav-dot"
						+ (isActive ? " dsh-node-nav-dot-active" : "")
						+ (unloaded ? " dsh-node-nav-dot-unloaded" : ""),
					"aria-label": `跳转到消息 ${entry.time ? hhmm(entry.time) : `#${globalIdx + 1}`}${unloaded ? '(未加载)' : ''}`,
					onMouseEnter: () => { setHoverIdx(globalIdx); showTextPreview(entry.preview, entry.time, anchorEl()) },
					onMouseLeave: () => { setHoverIdx(-1); hidePreview() },
					onFocus: () => { setHoverIdx(globalIdx); showTextPreview(entry.preview, entry.time, anchorEl()) },
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
				onClick: () => { setRailStartOverride(null); scrollToBottom() },
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
			let unsubUsers = undefined
			let disposed = false

			const textAt = (i) => (i >= 0 && i < users.length ? users[i].text : "")

			/** 会话切换或首次装配：换 face、重置状态、拉取该会话历史。 */
			const rewire = () => {
				if (disposed) return
				const inp = currentInput(ctx)
				const nextId = currentSessionId(ctx)
				const nextInput = inp && inp.state && typeof inp.state.getSnapshot === "function" ? inp.state : undefined
				// 身份守卫：sessionId 相同且 input store 身份未变才视为已装配；
				// HMR 重载后 provide bundle 重建、input store 换身份，必须重新订阅。
				if (nextId === sessionId && input !== undefined && input === nextInput) return
				sessionId = nextId
				pos = 0
				users = []
				if (unsub) { unsub(); unsub = undefined }
				input = nextInput
				actions = inp && typeof inp.setDraft === "function" ? { setDraft: inp.setDraft } : undefined
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
				if (!(target instanceof HTMLTextAreaElement) && !(target && target.isContentEditable === true)) return
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
						if (users.length === 0) { sharedFetchUsers(sessionId, true); return }
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
			// 列表跟随共享缓存：挂载后新到的消息也能 ↑ 回去。
			unsubUsers = onUsersUpdated((sid, list) => {
				if (disposed || sid !== sessionId) return
				const next = list.filter((u) => u.text !== "[图片]")
				const atBaseline = pos >= users.length
				users = next
				pos = atBaseline ? users.length : Math.min(pos, Math.max(users.length - 1, 0))
			})
			// 会话切换订阅：0.1.2 用 sessions.list，0.1.1 回退 currentProvideInfo。
			const list = ctx.sessions && ctx.sessions.list
			if (list && typeof list.subscribe === "function") {
				unsubInfo = list.subscribe(rewire)
			} else {
				const info = ctx.sessions && ctx.sessions.currentProvideInfo
				if (info && typeof info.subscribe === "function") {
					unsubInfo = info.subscribe(rewire)
				}
			}
			rewire()
			return () => {
				disposed = true
				document.removeEventListener("keydown", onKeyDown, true)
				if (unsub) unsub()
				if (unsubInfo) unsubInfo()
				if (unsubUsers) unsubUsers()
			}
		}

		/**
		 * 官方 TurnNavigator 轨的 DOM 节点，**隐藏状态下也认得出**。
		 *
		 * 按「nav 标签 + 类名含 `_frame` + 内部 ≥2 个 `_mark`」匹配，刻意不看可见性：
		 * display:none 的元素 rect 恒为 0，几何判据在「官方轨已被上一份规则隐藏」时
		 * 必然探空 —— 客户端 HMR 重新 apply 时旧实例的样式可能尚未摘除，新实例探空后
		 * 旧样式才被摘掉，官方轨就此复活（2026-09-10 用户实测：刷新后正常、长驻页面
		 * 不行）。`_frame` 后缀来自官方源码的 CSS-module 类名，跨构建稳定；同一文档里
		 * `pI_x6G_frame`（DIV，聊天滚动画布）也含 `_frame`，故用 nav 标签排除。
		 */
		function officialRail() {
			for (const el of document.querySelectorAll('nav[class*="_frame"]')) {
				if (el.querySelectorAll('[class*="_mark"]').length >= 2) return el
			}
			// 回退：官方若不再用 nav 标签，退回几何判据（只在新加载场景可用）。
			for (const el of document.querySelectorAll('[class*="_frame"]')) {
				const rect = el.getBoundingClientRect()
				if (rect.width > 0 && rect.width <= 40 && rect.height >= 40 && el.querySelectorAll('[class*="_mark"]').length >= 2) return el
			}
			return undefined
		}

		/**
		 * 覆盖官方 TurnNavigator 轨（2026-09-10 用户裁定：由本插件接管轮次导航）。
		 *
		 * 官方轨与本插件节点串同处右缘：实测 1700px 视口下官方轨 1650–1678、
		 * 本轨 1656–1672，横向重叠 16px、纵向 152px —— 两条轨叠在一起。故隐藏官方轨。
		 *
		 * 官方类名带构建哈希（eGxaPq_frame）不能硬编码：运行时探测拿类名再生成规则。
		 * 三层保险，任一层单独失效都不会让官方轨复活：
		 *   ① 类名规则 —— 覆盖 React 重建出来的新节点；
		 *   ② 内联 display:none —— 类名若随官方构建变化，规则失效时仍压得住；
		 *   ③ 常驻观察器 —— 规则被摘掉（客户端 HMR 换代空档）或样式元素脱离文档时补回。
		 * 观察器守卫是纯属性读取（不做 DOM 遍历），流式 delta 期间开销可忽略。
		 */
		function installOfficialRailOverride() {
			const style = document.createElement("style")
			document.head.appendChild(style)
			let scheduled = false
			/** 已隐藏的官方轨节点，用于廉价守卫与 dispose 时还原。 */
			let hidden = undefined
			const observer = new MutationObserver(() => {
				if (style.isConnected && style.textContent !== "" && hidden !== undefined && hidden.isConnected && hidden.style.display === "none") return
				if (scheduled) return
				scheduled = true
				setTimeout(hideOfficial, 300)
			})
			function hideOfficial() {
				scheduled = false
				const rail = officialRail()
				if (rail === undefined) return
				const cls = String(rail.className || "").split(/\s+/).filter((c) => c.includes("_frame"))[0]
				if (cls !== undefined) {
					const rule = `.${cls}{display:none !important}`
					if (style.textContent !== rule) style.textContent = rule
				}
				// 脱离文档的 <style> 不生效：被摘掉就挂回去。
				if (!style.isConnected) document.head.appendChild(style)
				rail.style.display = "none"
				hidden = rail
			}
			hideOfficial()
			observer.observe(document.body, { childList: true, subtree: true })
			// 覆盖样式本身被摘掉（HMR 换代 / 样式清理）不会产生 body 变更 —— 单看
			// body 会漏掉这种情况，故同时盯 head。
			observer.observe(document.head, { childList: true })
			return () => {
				observer.disconnect()
				if (hidden !== undefined && hidden.isConnected) hidden.style.display = ""
				if (style.isConnected) style.remove()
			}
		}

		function apply(ctx) {
			ctx.effect(() => {
				pluginCtx = ctx
				const disposeHistory = installInputHistory(ctx)
				const disposeOfficialRail = installOfficialRailOverride()
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
					if (pluginCtx === ctx) pluginCtx = undefined
					disposeHistory()
					disposeOfficialRail()
					offSlot()
					if (style.isConnected) style.remove()
				}
			}, "dsh-node-nav: overlay registration")
		}

		exports.apply = apply;
		exports.__test = { mergeBtwMarkers, useBtwState, btwBridge, sessionPageUntil, olderButton, clientSession, windowStartOf, wheelDeltaPx, wheelWindowStart };
		exports.inject = ["sessions", "conversation", "slots"];
		return module.exports;
	}
});
