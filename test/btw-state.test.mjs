import fs from 'node:fs'
import assert from 'node:assert/strict'

const NAV = process.env.NAV_CLIENT ?? new URL('../client.js', import.meta.url).pathname
const source = fs.readFileSync(NAV, 'utf8')

// 迷你 hook 运行时（同一时刻只挂一个实例）
const state = []; const cleanups = []; let index = 0; let effects = []; let instance = null; let last = null
const React = {
  createElement: (t, p, ...c) => ({ type: t, props: { ...(p ?? {}), ...(c.length ? { children: c.length === 1 ? c[0] : c } : {}) } }),
  memo: f => f,
  useState(init) { const i = index++; if (!(i in state)) state[i] = typeof init === 'function' ? init() : init; const set = v => { state[i] = typeof v === 'function' ? v(state[i]) : v; if (instance) instance() }; return [state[i], set] },
  useEffect(fn) { const i = index++; if (state[i] === undefined) { state[i] = true; effects.push(fn) } },
  useRef(v) { const i = index++; if (!(i in state)) state[i] = { current: v }; return state[i] },
}
let factory
globalThis.window = { __ModuleLoader__: { load: h => { factory = h.factory } }, setInterval: () => 1, clearInterval: () => {} }
new Function(source)()
const exports = factory(s => { if (s === 'react') return React; throw new Error('unexpected ' + s) })
const { useBtwState } = exports.__test

globalThis.window.setInterval = () => 1
globalThis.window.clearInterval = () => {}

function mountHook() {
  const run = () => { index = 0; effects = []; const out = useBtwState(); last = out; for (const fn of effects) { const c = fn(); if (typeof c === 'function') cleanups.push(c) } return out }
  instance = run
  run()
  return last
}
const settled = () => last

// ── 1. 桥缺席：空状态，不抛 ──
delete globalThis.window.__dshBtw
assert.deepEqual(mountHook(), { items: [], selectedId: undefined })

// ── 2. 桥在：初次同步就拿到条目 ──
state.length = 0; effects = [];
const listeners = new Set(); let items = [{ btwId: 'b1', anchorSeq: 3 }]; let selected;
globalThis.window.__dshBtw = { version: 1, list: () => items, selected: () => selected, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, open: () => {} }
assert.deepEqual(mountHook().items.map(b => b.btwId), ['b1'])
assert.equal(listeners.size, 1, '订阅了 btw 总线')

// ── 3. btw 发布新快照 → 通知 → 节点串跟着更新 ──
items = [{ btwId: 'b1', anchorSeq: 3 }, { btwId: 'b2', anchorSeq: 9 }]
for (const fn of listeners) fn()
assert.deepEqual(settled().items.map(b => b.btwId), ['b1', 'b2'])

// ── 4. 选中态透传（右侧菱形据此高亮）──
selected = 'b2'
for (const fn of listeners) fn()
assert.equal(settled().selectedId, 'b2')

// ── 5. 桥被换掉（btw 单独热重载）时旧订阅不再有数据，看门狗换新桥 ──
const oldListeners = new Set(listeners)
listeners.clear()
const newListeners = new Set(); const freshItems = [{ btwId: 'b9', anchorSeq: 12 }]
globalThis.window.__dshBtw = { version: 1, list: () => freshItems, selected: () => undefined, subscribe: fn => { newListeners.add(fn); return () => newListeners.delete(fn) }, open: () => {} }
assert.equal(exports.__test.btwBridge().list()[0].btwId, 'b9', '总是读当前 window 上的桥')

console.log('OK: useBtwState 5 组断言通过')