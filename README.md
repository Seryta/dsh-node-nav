# dsh-node-nav — 对话节点导航

DSH(DeepSeek Harness)Web GUI 的客户端插件:在聊天区右侧显示一列等距节点串,
每条用户消息一个节点。hover/focus 显示消息文本预览,点击平滑滚动到对应消息并
短暂高亮,active 药丸跟随阅读位置滑动。

## 功能

| 功能 | 说明 |
|---|---|
| 节点串 | 右缘纵向节点串,每条用户消息一个圆点 |
| 全量历史节点 | host 半部从会话日志提取全部用户消息(含分页未加载的历史),导航在点击前就覆盖全部历史,页面保持原生分页不展开 |
| 底部节点 | rail 最底端固定一个方形「跳到底部(最新消息)」节点,形状与提示区别于消息节点 |
| hover/focus 预览 | 显示消息气泡文本(300 字符截断),键盘焦点同样触发 |
| 点击跳转 | scrollIntoView 居中 + 品牌蓝高亮环 1.2s |
| active 跟随 | 滚动时药丸实时标出视口内最顶部的用户消息 |
| details 避让 | 右侧详情面板打开时节点串自动左移 |
| 深色模式 | 跟随 `body[data-ds-dark-theme]` |
| reduced-motion | 系统减少动效偏好下禁用动画 |
| 自动隐藏 | 少于 2 条用户消息或非对话页时不显示 |

## 数据源:服务端会话日志 + DOM 行状态(双轨)

- **全量列表**:host 半部端点 `/plugins/dsh-node-nav/api/users` 从 attached
  会话的 session log 提取全部真实用户消息(`source.kind === 'user'`),
  返回 `[{ id, seq, time, text }]`——导航覆盖全部历史,**页面不展开**,
  无历史预加载副作用;
- **DOM 行状态**:锚点 key 形如 `<seq>:input-message<uuid>`,uuid 即消息 id,
  用 `[data-chat-anchor-key$="<id>"]` 判定该消息行是否已加载进页面;
- 端点不可用/冷会话(未 attached)时回退到纯 DOM 扫描。

未加载的节点以虚线半透明显示;点击时连续触发页面「加载更早」(上限
30 批)直到该行进入 DOM,再滚动定位。hover 预览显示服务端全文与时间。

## 安装

```sh
dsh plugin --profile web add github:Seryta/dsh-node-nav
```

安装后重启 `dsh web` 并刷新页面。插件是纯手写 JS(零构建、零依赖),
git 安装不会触发任何构建脚本。

也可以 clone 后从本地目录安装:

```sh
git clone https://github.com/Seryta/dsh-node-nav.git
dsh plugin --profile web add ./dsh-node-nav
```

## 与同类插件的差异

| 项目 | 数据源 | 本插件的取舍 |
|---|---|---|
| [dsh-navbar](https://github.com/vlln/dsh-navbar) | DOM 扫描(同款思路) | 本插件采用相同的 DOM 扫描契约,但保留 React + `shell.overlay` 槽位形态(可停用/启用),并补充 details 面板避让 |
| [dsh-turn-index](https://github.com/Simon314620/dsh-turn-index) | 会话快照 `binding(id).session` | 快照方案在部分 dsh 版本上只见最近窗口节点,故本插件改走 DOM |

## 已知限制

- 依赖 dsh 页面的 `data-time-hover-root` 锚点契约(0806 起 user 行携带);
  harness 大版本改动该契约时需同步适配。
- 历史分页未加载的消息行不在 DOM 中,也不会出现在导航里(与页面一致)。
- 预览文本取自消息气泡,不含时间戳;流式中的消息预览取扫描时的快照。
- 预览卡片不显示时间(数据源为 DOM,时间戳提取不可靠,刻意省略)。

## License

MIT
