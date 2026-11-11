import fs from 'node:fs'
import assert from 'node:assert/strict'

const NAV = process.env.NAV_CLIENT ?? new URL('../client.js', import.meta.url).pathname
let factory
globalThis.window = { __ModuleLoader__: { load: h => { factory = h.factory } } }
globalThis.CSS = { escape: (s) => s }
new Function(fs.readFileSync(NAV, 'utf8'))()
const React = { createElement: () => null, useState: v => [v, () => {}], useEffect: () => {}, useRef: v => ({ current: v }), memo: f => f }
const exports = factory(spec => { if (spec === 'react') return React; throw new Error('unexpected ' + spec) })
const { sessionPageUntil, olderButton, clientSession } = exports.__test

/** 假文档：present 打开后 [data-chat-anchor-key] 才存在。 */
function docWith(rows, buttons) {
  return {
    present: false,
    querySelector(sel) {
      if (sel.includes('data-chat-anchor-key')) return this.present ? rows[0] : null
      if (sel.includes('_older')) return buttons.structural ?? null
      return null
    },
    querySelectorAll() { return buttons.list ?? [] },
  }
}
async function withDocument(doc, fn) {
  const prev = globalThis.document
  globalThis.document = doc
  try { return await fn() } finally { globalThis.document = prev }
}

// ── 官方会话控制器：一页页 loadOlder()，锚点一出现就停 ────────────────────
// 这是点击未加载节点的主路径：不依赖「加载更早」按钮的标签（0.2.x 分页期间
// 按钮会变成「加载中…」且 disabled，旧实现因此第一轮就放弃）。

{
  const doc = docWith([{ id: 'row' }], {})
  const calls = []
  const session = {
    openState: 'open',
    hasMore: true,
    loadingOlder: false,
    baseSeq: 300,
    loadOlder() {
      calls.push(this.baseSeq)
      this.baseSeq -= 100
      if (calls.length === 3) doc.present = true // 第 3 页才把目标行带进 DOM
      return Promise.resolve()
    },
  }
  const found = await withDocument(doc, () => sessionPageUntil('msg-1', session))
  assert.equal(found, doc.querySelector('[data-chat-anchor-key]'), '应返回目标行')
  assert.equal(calls.length, 3, '锚点出现后必须停下，不再继续翻页')
}

// 已经翻到底（hasMore=false）→ null，且不空转
{
  const calls = []
  const session = { openState: 'open', hasMore: false, loadingOlder: false, baseSeq: 5, loadOlder() { calls.push(1); return Promise.resolve() } }
  assert.equal(await withDocument(docWith([{}], {}), () => sessionPageUntil('x', session)), null)
  assert.equal(calls.length, 0)
}

// 会话没打开 / 没有 controller → null（调用方回退按钮）
assert.equal(await withDocument(docWith([{}], {}), () => sessionPageUntil('x', undefined)), null)
assert.equal(await withDocument(docWith([{}], {}), () => sessionPageUntil('x', { openState: 'loading' })), null)

// loadOlder 空转（baseSeq 不前进）→ 有限步内放弃，不死循环
{
  const doc = docWith([{}], {})
  let calls = 0
  const session = {
    openState: 'open', hasMore: true, loadingOlder: false, baseSeq: 42,
    loadOlder() { calls++; return Promise.resolve() },
  }
  const found = await withDocument(doc, () => sessionPageUntil('x', session))
  assert.equal(found, null)
  assert.ok(calls <= 4, `空转应尽快放弃，实际调用了 ${calls} 次`)
}

// ── 会话实例解析：0.2.x 挂在 sessions.manager.get ──────────────────────────
{
  const session = { openState: 'open' }
  assert.equal(clientSession({ sessions: { manager: { get: () => session } } }, 's1'), session)
  assert.equal(clientSession({ sessions: { get: () => session } }, 's1'), session, '老运行时回退 sessions.get')
  assert.equal(clientSession({ sessions: {} }, 's1'), undefined)
  assert.equal(clientSession(undefined, 's1'), undefined)
}

// ── 分页控件定位：分页中的按钮（「加载中…」、disabled）仍算分页控件 ────────
{
  const structural = { textContent: '加载中…', disabled: true, isConnected: true }
  const found = await withDocument(docWith([{}], { structural }), () => olderButton())
  assert.equal(found, structural)

  structural.isConnected = false
  const loadingBtn = { textContent: '加载中…', disabled: true, isConnected: false }
  const fallback = await withDocument(docWith([{}], { list: [loadingBtn] }), () => olderButton())
  assert.equal(fallback, loadingBtn, '结构取不到时「加载中…」也是分页控件')

  const none = await withDocument(docWith([{}], { list: [] }), () => olderButton())
  assert.equal(none, null)
}

console.log('load-history.test.mjs ok')
