import fs from 'node:fs'
import assert from 'node:assert/strict'

const NAV = process.env.NAV_CLIENT ?? new URL('../client.js', import.meta.url).pathname
let factory
globalThis.window = { __ModuleLoader__: { load: h => { factory = h.factory } } }
new Function(fs.readFileSync(NAV, 'utf8'))()
const React = { createElement: () => null, useState: v => [v, () => {}], useEffect: () => {}, useRef: v => ({ current: v }), memo: f => f }
const exports = factory(spec => { if (spec === 'react') return React; throw new Error('unexpected ' + spec) })
const { mergeBtwMarkers } = exports.__test

const user = (id, seq) => ({ id, seq, time: seq * 1000, preview: 'u' + id, el: null })
const btw = (id, anchorSeq) => ({ btwId: id, anchorSeq, question: 'q' + id, status: 'answer', startedAt: anchorSeq * 1000 })
const kinds = merged => merged.map(e => e.kind === 'btw' ? 'b:' + e.btwId : 'u:' + e.id).join(',')

// 1. 按 anchorSeq 插进用户消息之间（日志先后 = 视觉先后）
const merged = mergeBtwMarkers([user('a', 1), user('b', 5), user('c', 9)], [btw('X', 3), btw('Y', 7)])
assert.equal(kinds(merged), 'u:a,b:X,u:b,b:Y,u:c')

// 2. anchorSeq 与用户消息相同 → 用户消息在前（提问发生在那条消息之后）
assert.equal(kinds(mergeBtwMarkers([user('a', 4), user('b', 8)], [btw('X', 4)])), 'u:a,b:X,u:b')

// 3. 比所有用户消息都早 / 都晚 → 落在两端
assert.equal(kinds(mergeBtwMarkers([user('a', 5)], [btw('X', 1), btw('Y', 9)])), 'b:X,u:a,b:Y')

// 4. 端点回退（roster 无 seq）→ 追加在末尾，且旁支之间仍按 anchorSeq 排序
const fallback = mergeBtwMarkers([{ id: undefined, preview: 'row', el: null }], [btw('Y', 9), btw('X', 2)])
assert.equal(kinds(fallback), 'u:undefined,b:X,b:Y')

// 5. 空输入不改动原数组（同一引用，避免每次渲染重建节点）
const roster = [user('a', 1)]
assert.equal(mergeBtwMarkers(roster, []), roster)
assert.equal(mergeBtwMarkers(roster, undefined), roster)

// 6. 脏数据被丢弃，不产生幽灵节点
const dirty = mergeBtwMarkers([user('a', 1)], [null, {}, { btwId: 'Z', anchorSeq: 2 }])
assert.equal(kinds(dirty), 'u:a,b:Z')

// 7. 插入不改变用户消息相对顺序（稳定性）
const many = mergeBtwMarkers([user('a', 1), user('b', 2), user('c', 3)], [btw('X', 5)])
assert.equal(kinds(many), 'u:a,u:b,u:c,b:X')

console.log('OK: 7 merge assertions passed')