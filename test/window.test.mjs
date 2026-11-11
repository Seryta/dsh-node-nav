import fs from 'node:fs'
import assert from 'node:assert/strict'

const NAV = process.env.NAV_CLIENT ?? new URL('../client.js', import.meta.url).pathname
let factory
globalThis.window = { __ModuleLoader__: { load: h => { factory = h.factory } } }
new Function(fs.readFileSync(NAV, 'utf8'))()
const React = { createElement: () => null, useState: v => [v, () => {}], useEffect: () => {}, useRef: v => ({ current: v }), memo: f => f }
const { windowStartOf } = factory(spec => { if (spec === 'react') return React; throw new Error('unexpected ' + spec) }).__test

const SIZE = 15

// 1. 节点不满一窗：从头显示
assert.equal(windowStartOf(-1, 3, SIZE), 0)
assert.equal(windowStartOf(2, SIZE, SIZE), 0)

// 2. 没有 active（视口里没有任何已加载消息）→ 贴住末端。
//    这是本次修复的关键：旧实现把 -1 当 0 用，窗口滑到最早 15 条，
//    末端混进来的旁支菱形永远进不了可见窗口（aa_7cf9… 会话实测）。
const start = windowStartOf(-1, 46, SIZE)
assert.equal(start, 46 - SIZE)
assert.ok(start + SIZE === 46, '窗口必须覆盖最后一条节点')

// 3. 有 active：居中，两端夹紧
assert.equal(windowStartOf(0, 46, SIZE), 0)
assert.equal(windowStartOf(SIZE, 46, SIZE), SIZE - Math.floor((SIZE - 1) / 2))
assert.equal(windowStartOf(45, 46, SIZE), 46 - SIZE)
// 居中窗口不越过任一端
for (const active of [0, 1, 7, 20, 31, 45]) {
  const s = windowStartOf(active, 46, SIZE)
  assert.ok(s >= 0 && s + SIZE <= 46, `active=${active} 窗口越界: ${s}`)
}

// 4. 长度刚好比一窗多一条：只有 0/1 两个起点
assert.equal(windowStartOf(-1, 16, SIZE), 1)
assert.equal(windowStartOf(15, 16, SIZE), 1)
assert.equal(windowStartOf(0, 16, SIZE), 0)

console.log('window.test.mjs ok')
