# Antigravity 集成与实测

## 安装

在仓库执行 `npm ci && npm run build`，然后执行 `node dist/cli.js install`。安装器注册 Pi 扩展，并将 `agent-link` 命名组加入 `~/.gemini/config/hooks.json`，不覆盖其他 Hook。第一次修改现有 Hook 配置前，会将原文件备份到 Agent Link 数据目录的 `hooks.before-agent-link.json`。已有同名手写配置、损坏的 JSON 或已编辑的自启文件会阻止安装；请手动处理冲突后重试。

接着用 `node dist/cli.js watch <绝对项目目录>` 启用同步，重启客户端加载设置。安装器本身不会启动 Daemon。只有显式传入 `install --autostart` 才注册当前用户的系统启动项：Windows 登录计划任务、macOS LaunchAgent 或 Linux systemd user unit。需要立即运行时用 `node dist/cli.js daemon start`。

当前 PreInvocation 在未设置 `AGENT_LINK_AGY_FIRST_INVOCATION` 时不注入。变量由 Daemon 启动进程读取，修改后需要重启 Daemon。请先实测对应客户端，再设置验证过的值；不同客户端起点若不一致，不要共用一个未经核对的值。

Windows Antigravity CLI 1.5.16 已确认首调用是 `0`，正常结束为 `NO_TOOL_CALL`。该版本会拒绝 `user_markdown`，请用 `agent-link status <项目目录>` 查看会话短号；`#link` 的模型历史注入仍可用。仓库内可用 `AGY_CLI=<官方可执行文件绝对路径> node scripts/verify-agy.mjs` 复验，使用临时 HOME 和本机模拟 Gemini 响应，不需要真实账号或 API Key。

## 在真实客户端跑协议探针

1. 执行 `node scripts/probe-agy.mjs prepare`。它打印一个临时工作区路径，只在其中写入 `.agents/hooks.json`。每个客户端分别创建一个临时工作区。
2. 在 Antigravity 2.0、IDE 或 `agy` CLI 中打开该路径，确认客户端信任并允许执行这个临时工作区的 Hook。新开会话，发送普通问句，再发送一条会触发多次模型调用的无害请求，例如读取一个临时文本文件后总结。确认提示 `Agent Link UI probe: indigo lantern 407.` 是否出现、出现在哪个界面。核对模型可见性时不要在提问中复述标记；能查看模型请求或客户端追踪时，以其中实际输入为准。
3. 检查临时工作区的 `events.jsonl`，记录客户端及版本、两轮的首个 `invocationNum`（`null` 表示字段未出现）、同轮后续调用计数、`Stop.terminationReason`，以及 `transcriptFile` 是 `primary`、`full`、`other` 还是 `missing`。探针只记录协议元数据，不写入会话 ID、用户正文、文件路径或模型输出。没有日志时，先检查 Hook 是否加载及其工作目录是否是 `.agents`。
4. 长字段验收应使用临时会话的 `transcript.jsonl` / `transcript_full.jsonl`，只提交脱敏后的字段结构与截断样例。完成后关闭会话并删除探针创建的临时目录；无需改动全局 Hook。
