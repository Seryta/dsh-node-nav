/**
 * dsh-node-nav host half: 提供全量用户消息列表端点,供浏览器半部渲染导航。
 *
 * 路由:GET /plugins/dsh-node-nav/api/users?sessionId=<id>
 * 从 attached 会话的 session log 提取全部 'user/message' 事件(source.kind
 * === 'user' 的真实用户输入),返回 [{ id, seq, time, text }]。
 * 冷会话(未 attached)返回空列表,浏览器半部回退到 DOM 扫描。
 */
export const name = 'dsh-node-nav'
export const inject = ['webServer', 'sessions']

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** 从 content 块提取纯文本;图片块占位。 */
function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b && b.type === 'image') parts.push('[图片]')
  }
  return parts.join('\n').trim()
}

export function apply(ctx) {
  const handler = async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ users: [] }))
      return
    }
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const session = sessionId === '' ? undefined : ctx.sessions.get(sessionId)
    if (session === undefined) {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ users: [] }))
      return
    }
    const users = []
    for (const event of session.events) {
      if (event.type !== 'user/message') continue
      const data = event.data
      const messages = Array.isArray(data) ? data : [data]
      for (const message of messages) {
        if (message === null || typeof message !== 'object') continue
        if (message.role !== 'user') continue
        // 只收真实用户输入;tool-result 等 user 角色的合成消息排除
        const source = message.source
        if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
        const text = extractText(message.content)
        if (text === '') continue
        users.push({ id: message.id, seq: event.seq, time: event.time, text })
      }
    }
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify({ users }))
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/plugins/dsh-node-nav/api/users', handler }),
    'dsh-node-nav: users route',
  )
}
