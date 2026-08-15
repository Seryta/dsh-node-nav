# dsh-node-nav — 对话节点导航

DSH（DeepSeek Harness）Web GUI 的客户端插件：在聊天区右侧显示一列等距节点串，每条用户消息对应一个节点。hover/focus 时显示消息文本预览，点击平滑滚动到对应消息并短暂高亮，active 药丸跟随阅读位置滑动。

<img src="docs/node-nav-overview.png" width="720" alt="节点串总览（浅色模式）">

## 功能

| 功能 | 说明 |
|---|---|
| 节点串 | 右缘纵向节点串，每条用户消息一个圆点；最多同时显示 15 个，窗口随阅读位置滑动（无滚动条），两端渐隐提示更多 |
| 全量历史节点 | host 半部从会话日志提取全部用户消息（含分页未加载的历史），导航在点击前就覆盖全部历史，页面保持原生分页不展开 |
| 底部节点 | rail 最底端固定一个方形「跳到底部（最新消息）」节点，形状与提示区别于消息节点 |
| hover/focus 预览 | 显示服务端全文（300 字符截断）与时间，键盘焦点同样触发 |
| 点击跳转 | scrollIntoView 居中 + 品牌蓝高亮环 1.2 秒 |
| active 跟随 | 滚动时药丸实时标出视口内最顶部的用户消息 |
| 输入历史 | 输入框为空时按 ↑ 回填最近一条用户输入，连续 ↑ 翻更早、↓ 翻回；编辑/发送后指针重置 |
| details 避让 | 右侧详情面板打开时节点串自动左移 |
| 深色模式 | 跟随 `body[data-ds-dark-theme]` |
| reduced-motion | 系统减少动效偏好下禁用动画 |
| 自动隐藏 | 非对话页时不显示 |

## 截图

**节点串总览（浅色模式）**：每个圆点对应一条用户消息，底部方形节点一键跳到底部，药丸标出当前阅读位置。

<img src="docs/node-nav-overview.png" width="720" alt="节点串总览（浅色模式）">

**hover/focus 预览**：鼠标悬停（或键盘聚焦）节点时显示该条用户消息的服务端全文与时间。

<img src="docs/node-nav-hover.png" width="720" alt="hover 消息预览">

**active 药丸跟随**：滚动聊天区时，药丸实时移动到视口内最顶部的用户消息节点。

<img src="docs/node-nav-active.png" width="720" alt="active 药丸跟随滚动">

**深色模式**：跟随 `body[data-ds-dark-theme]` 自动切换配色。

<img src="docs/node-nav-dark.png" width="720" alt="深色模式">

## 输入历史（↑ / ↓）

输入框（draft）为空时：

- **↑**：回填最近一条用户输入；连续 ↑ 翻更早（到最早一条为止）；
- **↓**：翻回更近一条；回到最新位置后 ↓ 清空 draft（与 readline/TUI 惯例一致）；
- 开始编辑回填文本、发送或清空后，指针重置（下次 ↑ 从最近一条重新开始）；
- 菜单打开时（触发词在 draft 中）天然不抢上下键；IME 组合中不拦截；
- 数据复用 `/plugins/dsh-node-nav/api/users`（仅 `source.kind === 'user'` 的真实输入，纯图片消息 `[图片]` 占位不参与历史）。

## 数据源：服务端会话日志 + DOM 行状态（双轨）

- **全量列表**：host 半部端点 `/plugins/dsh-node-nav/api/users` 从 attached 会话的 session log 提取全部真实用户消息（`source.kind === 'user'`），返回 `[{ id, seq, time, text }]`——导航覆盖全部历史，**页面不展开**，无历史预加载副作用；
- **DOM 行状态**：锚点 key 形如 `<seq>:input-message<uuid>`，uuid 即消息 id，用 `[data-chat-anchor-key$="<id>"]` 判定该消息行是否已加载进页面；
- 端点不可用/冷会话（未 attached）时回退到纯 DOM 扫描。

未加载的节点以虚线半透明显示；点击时连续触发页面「加载更早」（上限 30 批）直到该行进入 DOM，再滚动定位。hover 预览显示服务端全文与时间。

## 安装

```sh
dsh plugin --profile web add github:Seryta/dsh-node-nav
```

安装后重启 `dsh web` 并刷新页面。插件是纯手写 JS（零构建、零依赖），git 安装不会触发任何构建脚本。

也可以 clone 后从本地目录安装：

```sh
git clone https://github.com/Seryta/dsh-node-nav.git
dsh plugin --profile web add ./dsh-node-nav
```

## 与同类插件的差异

| 项目 | 数据源 | 本插件的取舍 |
|---|---|---|
| [dsh-navbar](https://github.com/vlln/dsh-navbar) | DOM 扫描（同款思路） | 本插件采用相同的 DOM 扫描契约，但保留 React + `shell.overlay` 槽位形态（可停用/启用），并补充 details 面板避让 |
| [dsh-turn-index](https://github.com/Simon314620/dsh-turn-index) | 会话快照 `binding(id).session` | 快照方案在部分 dsh 版本上只见最近窗口节点，故本插件改走 DOM |

## 已知限制

- 输入历史与跳转依赖 dsh 客户端契约：`[data-chat-anchor-key]`（行锚点）、`[data-composer-card]`（composer 容器）与 provide 通道 `hooks.input` / `props.inputActions`（输入状态与写入口）；harness 大版本改动这些契约时需同步适配。
- 输入历史仅覆盖**当前打开的（live）会话**：host 端点只查 attached 会话，未打开的历史会话无 composer 焦点，不适用输入历史。
- 未加载节点点击依赖页面「加载更早」按钮存在（上限 30 批）；按钮被移除的 harness 版本中，点击未加载节点会提示目标消息未能定位。

## License

MIT
