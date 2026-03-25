# OpenClaw Time Travel 项目说明

## 目的

这个项目的目标是给 OpenClaw 做一个纯插件版的“时间回溯”能力，不改 OpenClaw core，就能把：

1. 某个 agent 会话的对话上下文回退到过去某个时刻。
2. agent workspace 里受管的 markdown 文件状态一并回退到同一个时刻。
3. 每个可回溯时刻都用一个类似 git commit 的 hashtag 标识，便于用户定位和操作。

V1 的用户侧目标命令只有两个：

- `/versions [n]`
- `/rewind <tag>`

## 本轮已确定的设计

### 1. 纯插件实现

V1 不改 OpenClaw core，只通过插件能力实现。

这意味着插件需要依赖现有的：

- typed hooks
- internal hooks
- runtime session helpers
- runtime transcript update events

其中 `hooks.internal.enabled: true` 是当前方案可工作的前提。

### 2. 使用 git 影子仓库

不直接接管用户 workspace 自己的 git 仓库，而是在插件状态目录下维护一个独立的 shadow repo。

这样做的目的：

- 不污染用户自己的 workspace git 历史
- 不依赖 workspace 本身是不是 git 仓库
- 可以单独控制受追踪文件集合
- 回溯时只恢复插件关心的 markdown 文件

当前 shadow repo 保存的是“受追踪 markdown 文件”的镜像，不是整个 workspace。

### 3. 对话版本和 workspace 版本绑定

每次 assistant 回复写入 transcript 时，插件会生成并记录一个版本点：

- `tag`：对外展示的回溯定位符，格式如 `#tt-xxxxxxxxxx`
- transcript snapshot：当时的会话 transcript 快照
- shadow commit：当时 shadow repo 的 HEAD commit
- summary：对这条 assistant 回复的简要摘要

这样 `/rewind <tag>` 时，就能同时恢复：

- 对话 transcript
- 受追踪 markdown 文件状态

### 4. 受追踪文件范围

V1 默认只追踪标准 Workspace file map 那批 markdown 文件，加上 `memory` 目录：

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `IDENTITY.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `BOOT.md`
- `BOOTSTRAP.md`
- `MEMORY.md`
- `memory/**/*.md`

V1 暂不支持用户自定义追加其他 markdown 文件。

## 当前实现状态

截至本轮，仓库里已经有一版可工作的插件骨架和主逻辑，关键点如下。

### 1. 插件入口

插件入口在 `index.js`，当前已注册：

- service: `time-travel-service`
- command: `/versions`
- command: `/rewind`
- internal hook: `message:received`
- typed hook: `before_message_write`
- typed hook: `after_tool_call`
- typed hook: `message_sending`

### 2. 版本捕获

当前实现流程：

1. 在 `before_message_write` 遇到 assistant 消息时预生成 tag。
2. 在 `message_sending` 把 tag 追加到发给用户的最终文本里。
3. 在 `onSessionTranscriptUpdate` 收到 transcript 更新时，写入：
   - transcript snapshot
   - 版本记录 `versions.jsonl`
   - 当时的 shadow commit

### 3. workspace markdown 管理

当前通过两条路径保持 shadow repo 跟踪最新 markdown 状态：

- `after_tool_call` 后立即同步一次
- 定时轮询 workspace 指纹，发现变化再同步

这样即使某些 markdown 变更不是在最终 assistant 文本写出时发生，也尽量能被自动记录。

### 4. 回溯

`/rewind <tag>` 当前会：

1. 先为“当前状态”创建一个 backup tag
2. 恢复目标 tag 的 transcript snapshot
3. 恢复目标 tag 对应的 shadow repo commit
4. 清理本次会话的临时 prepared tag 状态

V1 只允许回退当前会话自己的 tag，不允许跨会话回退。

### 5. 已补过的关键问题

这轮实现里已经修过几个关键坑：

- tag 出站消费顺序错误
  - 现在按最早待发 tag 处理，不再错误消费最新 tag
- 同一个 tag 在多个路由 key 上的重复消费问题
- session store key 大小写/归一化不一致时的读取稳健性
- rewind 前 backup 因 `restoreInFlight` 过早置位而拿不到 shadow commit 的问题
- 允许回退到“当时没有任何受追踪 markdown 文件”的状态
  - 这时 `shadowCommit` 可以为空，rewind 会删除当前受追踪文件，而不是直接报错

## 运行假设

当前仓库不是依赖旁边那个未构建的 OpenClaw checkout 运行，而是按“全局 npm 安装版 OpenClaw”对齐的。

本地已确认的运行前提：

- OpenClaw 是通过 npm 全局安装的
- 本地插件仓库通过 `scripts/link-openclaw.mjs` 把全局安装的 `openclaw` 链接到本仓库 `node_modules/openclaw`
- 插件导入使用 `openclaw/plugin-sdk/...`

## 已完成的本地验证

本轮已做过的验证：

1. `node ./scripts/smoke-import.mjs` 通过
2. 用 mock runtime 跑过一条端到端 smoke：
   - 生成一个版本 tag
   - 修改受追踪 markdown
   - 执行 `/rewind <tag>`
   - 确认 markdown 状态被恢复
   - 确认 transcript 被恢复
   - 确认 rewind 前会生成 backup tag

## 真实运行时联调结果

后续联调中，已经把插件真实安装到当前 npm 安装版 OpenClaw，并完成了一轮 live runtime 验证：

- 插件已通过 `openclaw plugins install --link ...` 安装到当前环境
- `openclaw gateway restart` 后，systemd 管理的 gateway 已成功加载该插件
- `openclaw plugins doctor` 无报错
- `openclaw plugins inspect time-travel` 可见：
  - commands: `versions`, `rewind`
  - typed hooks: `after_tool_call`, `before_message_write`, `message_sending`
  - custom hook: `message:received`
  - service: `time-travel-service`
- systemd 日志中可见：
  - `time-travel service started`

### 已确认真实可用的部分

通过 `openclaw agent` 真实运行了一次新 session 的 agent turn，插件已成功在真实环境中写出：

- `versions.jsonl`
- transcript snapshot
- shadow repo commit

对应版本记录示例中已经包含：

- `tag`
- `sessionKey`
- `sessionId`
- `sessionFile`
- `shadowCommit`
- `summary`

说明“assistant 回复 -> 版本记录 -> transcript snapshot -> shadow repo 绑定”这一条主链路已经在真实运行时成立。

### 真实环境下确认的限制

`openclaw agent` 这条 CLI 直连路径不会触发插件命令拦截，因此：

- 在 `openclaw agent --message '/versions'` 下，`/versions` 不会进入插件 command handler
- 它会被当作普通用户消息交给模型处理

这意味着：

- 当前 V1 的 `/versions` 和 `/rewind` 仍然主要面向真实聊天渠道中的对话会话
- 还没有在 `openclaw agent` 这种 CLI 直连会话里验证 slash command 可用
- 这不影响版本捕获主链路，但会影响“如何触发回溯命令”的验证范围

## 当前已知限制

这些限制是 V1 有意保留的，不算偏离设计：

- 依赖 `hooks.internal.enabled: true`
- 只支持当前会话内的 tag 回退
- 只追踪默认标准 markdown 文件集合和 `memory/**/*.md`
- 还没有“列出当前 tracked 文件集合”的用户命令
- 还没有“用户追加自定义 md 追踪路径”的配置能力
- `openclaw agent` CLI 直连路径不会命中插件 slash commands；`/versions` 和 `/rewind` 需要在真实聊天渠道里继续验证

## TODO

### 高优先级

- 在真实聊天渠道会话里验证：
  - tag 是否稳定追加到 assistant 最终回复
  - `/versions` 是否能正确列出当前会话历史
  - `/rewind <tag>` 是否在真实 transcript/session store 下稳定工作
  - memory write 等典型路径是否都能触发 markdown 版本更新
- 评估是否需要支持 `openclaw agent` CLI 直连会话下的版本命令
  - 如果要支持，大概率需要额外的宿主侧上下文或命令路由能力

### 功能扩展

- 支持查看当前正在追踪哪些 markdown 文件
- 支持用户添加额外 markdown 路径进入追踪集合
- 支持用户移除/禁用已添加的自定义追踪路径

### 体验改进

- 优化 `/versions` 输出格式
- 给 `/rewind` 增加更清晰的失败原因提示
- 改进线程型频道里的 route/tag 关联稳健性

### 工程化

- 增加自动化测试，覆盖：
  - tag 生成和出站绑定
  - transcript snapshot 记录
  - shadow repo commit 记录
  - rewind 恢复 transcript
  - rewind 恢复/删除 markdown 文件
  - backup tag 生成

## 下次继续时的建议起点

下次继续建议直接从“真实安装联调”开始：

1. 把插件安装到当前全局 OpenClaw
2. 打开 `hooks.internal.enabled`
3. 用一个真实 agent 会话跑几轮消息
4. 验证 `/versions` 和 `/rewind`
5. 根据真实行为再修 API 对齐和边界问题
