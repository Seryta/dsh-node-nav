import fs from 'node:fs'
import assert from 'node:assert/strict'

const NAV = process.env.NAV_CLIENT ?? new URL('../client.js', import.meta.url).pathname
let factory
globalThis.window = { __ModuleLoader__: { load: h => { factory = h.factory } } }
new Function(fs.readFileSync(NAV, 'utf8'))()
const React = { createElement: () => null, useState: v => [v, () => {}], useEffect: () => {}, useRef: v => ({ current: v }), memo: f => f }
const { wheelDeltaPx, wheelWindowStart } = factory(spec => { if (spec === 'react') return React; throw new Error('unexpected ' + spec) }).__test

// ── 1. deltaY 单位换算：像素 / 行 / 页三种 deltaMode ─────────────────────
// 为什么要有这层：鼠标一格在浏览器里可能是 100/120px，也可能按「行」（deltaMode=1）
// 或「页」（deltaMode=2）上报；只按像素处理会让 Firefox/部分鼠标滚一格无效。
assert.equal(wheelDeltaPx(120, 0, 800), 120, '像素模式原样')
assert.equal(wheelDeltaPx(3, 1, 800), 48, '行模式按 16px/行折算')
assert.equal(wheelDeltaPx(1, 2, 800), 800, '页模式按轨高折算')
assert.equal(wheelDeltaPx(1, 2, 0), 1, '轨高未知时按 1px，不能把整页手势吞成 0')
assert.equal(wheelDeltaPx(0, 0, 800), 0)

// ── 2. 一格一个节点，不足一格的余量留给下一次 ───────────────────────────
// 语义：让触控板连续小增量能攒够一格（否则永远翻不动），鼠标一格 120px 翻 3 个节点。
assert.deepEqual(wheelWindowStart(0, 40, 10), { start: 1, rest: 0 })
assert.deepEqual(wheelWindowStart(0, 120, 10), { start: 3, rest: 0 })
assert.deepEqual(wheelWindowStart(0, 130, 10), { start: 3, rest: 10 })
assert.deepEqual(wheelWindowStart(0, 30, 10), { start: 0, rest: 30 }, '不足一格不动，余量保留')
assert.deepEqual(
  wheelWindowStart(0, 30 + 30 + 40 - 10, 10),
  { start: 2, rest: 10 },
  '两次 30px 小增量凑满一格后继续按余量折算',
)
// 行模式换算后的手势同样走这条路径：3 行 = 48px = 1 个节点 + 8px 余量。
assert.deepEqual(wheelWindowStart(0, wheelDeltaPx(3, 1, 800), 10), { start: 1, rest: 8 })

// ── 3. 反向滚动：负增量往前翻，余量同号 ─────────────────────────────────
assert.deepEqual(wheelWindowStart(5, -40, 10), { start: 4, rest: 0 })
assert.deepEqual(wheelWindowStart(5, -130, 10), { start: 2, rest: -10 })

// ── 4. 两端夹紧，顶到头后余量清零 ───────────────────────────────────────
// 为什么清零：在末端连续滚轮不应攒成回头时的"暴冲"（一松手就翻回去好几格）。
assert.deepEqual(wheelWindowStart(9, 120, 10), { start: 10, rest: 0 }, '顶到末端后余量清零')
assert.deepEqual(wheelWindowStart(0, -120, 10), { start: 0, rest: 0 }, '顶到开头后余量清零')
assert.deepEqual(wheelWindowStart(10, -200, 10), { start: 5, rest: 0 })
assert.deepEqual(wheelWindowStart(0, 120, 0), { start: 0, rest: 0 }, '节点不满一窗时不吃滚轮手势')

// ── 5. 入参防御 + 不变量：起点始终落在 [0, maxStart] ────────────────────
assert.deepEqual(wheelWindowStart(99, 40, 10), { start: 10, rest: 0 }, '越界起点先夹紧')
assert.deepEqual(wheelWindowStart(-3, 40, 10), { start: 1, rest: 0 })
for (let amount = -520; amount <= 520; amount += 13) {
  for (let start = 0; start <= 10; start++) {
    const out = wheelWindowStart(start, amount, 10)
    assert.ok(out.start >= 0 && out.start <= 10, `start=${start} amount=${amount} 越界: ${out.start}`)
    assert.ok(amount === 0 ? out.rest === 0 : Math.abs(out.rest) < 40 || out.rest === 0, `余量未收敛: amount=${amount} rest=${out.rest}`)
    assert.ok(out.rest === 0 || (out.rest > 0) === (amount > 0), `余量符号错: amount=${amount} rest=${out.rest}`)
  }
}

console.log('wheel.test.mjs ok')
