# dsh-node-nav — 对话节点导航

DSH(DeepSeek Harness)Web GUI 的客户端插件:在聊天区右侧显示一列等距节点串,
每条用户消息一个节点。hover/focus 显示消息文本预览,点击平滑滚动到对应消息并
短暂高亮,active 药丸跟随阅读位置滑动。

## 功能

| 功能 | 说明 |
|---|---|
| 节点串 | 右缘纵向节点串,每条用户消息一个圆点 |
| 自动加载历史 | 会话打开后自动连续触发页面「加载更早」,把分页中的历史全部拉入 DOM——历史消息在点击前就出现在导航里(批次上限 30,按钮消失即停止) |
| 底部节点 | rail 最底端固定一个方形「跳到底部(最新消息)」节点,形状与提示区别于消息节点 |
| hover/focus 预览 | 显示消息气泡文本(300 字符截断),键盘焦点同样触发 |
| 点击跳转 | scrollIntoView 居中 + 品牌蓝高亮环 1.2s |
| active 跟随 | 滚动时药丸实时标出视口内最顶部的用户消息 |
| details 避让 | 右侧详情面板打开时节点串自动左移 |
| 深色模式 | 跟随 `body[data-ds-dark-theme]` |
| reduced-motion | 系统减少动效偏好下禁用动画 |
| 自动隐藏 | 少于 2 条用户消息或非对话页时不显示 |

## 数据源:DOM 扫描 + 历史预加载

节点数据直接从页面 DOM 扫描(`[data-time-hover-root]` 行,排除 pending
steering,要求含气泡结构),**不读会话快照**。原因:部分 dsh 版本的
`ConversationSnapshot.chat.order` 只含最近窗口的用户节点,与页面实际渲染
不一致;DOM 是页面事实,扫描结果天然与可见内容同步。

历史分页的补齐:页面把更早的消息收在「加载更早」按钮之后,不进 DOM。
插件在会话打开后自动代点该按钮(上限 30 次,按钮消失即停止),历史行分批
进入 DOM 后被扫描进导航——**用户不需要手动点加载**,导航天然覆盖全部
历史。代价是页面会展开全部历史(这正是导航覆盖历史的前提)。

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
