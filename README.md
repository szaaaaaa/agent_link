# Agent Link

Agent Link 在同一台电脑上同步 Pi 和 Codex 的会话。比如，你在 Pi 里讨论完一个改动，可以在 Codex 中打开对应的会话镜像，接着做下去。聊天仍在各自的客户端里进行。

**分支说明：** `main` 使用命令行管理共享；[`dev`](https://github.com/szaaaaaa/agent_link/tree/dev) 在 Windows 上提供独立的 **Agent Link** 设置窗口。

## 安装（Windows）

需要 Node.js **22.13.0 或更高版本**，并已安装 Pi、Codex 中要使用的客户端。在包含本 README 的项目目录中打开 PowerShell：

```powershell
npm ci
npm run build
npm install -g .
agent-link install
```

`agent-link install` 安装 Pi 扩展并注册 Antigravity Hook。它不会修改 Codex 的 Hook 配置，也不会自动开启任何目录的共享。安装后重新打开 Pi，让它加载扩展。从旧版升级时，如果旧后台仍在运行，先执行 `agent-link daemon stop`。

## 开始共享

选择客户端中打开的项目目录。共享按目录启用，包含该目录**已有和新建**的会话；子目录不会自动加入，目前不能只选单个会话。停止共享只停止后续同步，已复制到客户端的会话会保留。

### `main`：用命令行配置

```powershell
agent-link watch 'D:\projects\example'    # 启用共享并启动后台
agent-link status 'D:\projects\example'   # 查看会话和同步状态
agent-link unwatch 'D:\projects\example'  # 停止该目录的共享
```

把示例路径替换为你在客户端中打开的项目目录。

### `dev`：用 Windows 设置窗口配置

`dev` 版的 `agent-link install` 会创建开始菜单入口。打开 **Agent Link**（也可运行 `agent-link settings`），点击 **选择并共享文件夹…**。窗口会显示共享会话在两端的登记状态。需要停止时，选中目录并点击 **停止共享**。关闭窗口后，后台仍会继续同步；以上命令行操作也可用。

### 在另一端续聊

在任一端完成一轮问答，等待镜像生成，再在另一端打开同一个项目，从原生会话列表找到并打开对应的镜像。Codex 镜像索引标题带 `[Sync]`；`dev` 版也为新建的 Pi 镜像添加此标记。另开一条空白会话不会自动接上已有历史。

后台默认不随 Windows 登录启动。如需登录时自动启动，安装时使用 `agent-link install --autostart`。

## 会话已登记，为什么还看不到？

- **在会话列表找不到镜像：** 先确认两端打开的是同一个项目目录，再重新打开项目或客户端。`dev` 设置窗口里的「已登记」表示镜像已写入目标端会话目录，Codex 的镜像索引也已登记；客户端界面可能还未刷新。若 Codex 显示「待索引」，先打开一次 Codex，让它初始化本地索引。`main` 上如果 `agent-link status` 返回 `codex resume <id>`，可以按这条提示从 Codex CLI 打开对应会话。
- **打开了镜像，但看不到最新问答：** 在已加载扩展的 Pi 会话中可用 `/sync` 更新；Codex 如果仍占用会话文件，后台会保留待写入的问答，等释放后重试。可以彻底退出 Codex，等待回写，再打开同一会话。需要在持锁时继续聊天，可按 [Codex Hook 配置](integrations/codex-hooks/README.md) 手动启用上下文接续；Hook 不会补出问答气泡。
- **两个客户端从同一个旧进度各聊了一轮：** Agent Link 可能将该会话标记为「已分叉」，并暂停该会话的同步。用 `agent-link status` 查 `thread_id`，再按[分叉处理说明](docs/windows-mvp-acceptance.md#分叉后怎么操作)选择保留分支或填写合并结论。原有分支记录会保留。
- **用了自定义会话目录：** Agent Link 和客户端需指向同一套会话目录。默认读取 `~/.pi/agent/sessions` 和 `~/.codex/sessions`；可用 `PI_CODING_AGENT_SESSION_DIR`、`PI_CODING_AGENT_DIR` 或 `CODEX_HOME` 覆盖。Pi 项目设置中的 `sessionDir` 不会被 Agent Link 自动读取。更改后台的环境变量后需重启后台服务。

## 数据与兼容性

- 会话同步在本机进行。Agent Link 默认将同步状态和问答记录保存在 `~/.agent-link`（可用 `AGENT_LINK_HOME` 修改），并把镜像写入目标客户端的历史目录。同步内容包括可见问答和部分工具摘要，不复制完整工具日志。Agent Link 不同步项目文件或 Git 提交。接续聊天时，客户端仍会按自己的设置向模型发送上下文。不要启用包含不愿共享内容的目录。
- 当前设置窗口仅支持 Windows。已验证窗口能读取共享配置，也用 Windows 上的真实 Pi CLI 和 Codex app-server 验证了镜像与接续。**Pi Desktop 和 Codex Desktop 的会话列表仍待界面验收**，也未实现桌面应用内的实时刷新。macOS 和 Linux 尚未做完整验收。
- Antigravity 是可选集成，通过 Hook 接续已绑定的会话，配置和版本验证见 [Antigravity 集成说明](integrations/agy-hooks/README.md)。

## 命令行与开发

```powershell
agent-link status                       # 查看共享目录、会话 ID 和同步状态
agent-link daemon status                # 检查后台服务是否运行
agent-link --help                       # 查看 watch、unwatch 等全部命令
npm test                                # 构建并运行测试（在项目目录执行）
```

需要复验真实客户端行为时，参见 [Windows 验收记录](docs/windows-mvp-acceptance.md#复验)。
