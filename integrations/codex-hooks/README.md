# Windows Codex 回写与在线接续

此 Hook 在 Codex 发言前把当前会话的未读跨端历史和 Git 变更提醒带入模型。它不会改写 Codex rollout，也不会在 Codex 原生时间线上补出其他客户端的问答气泡。新会话不会自动承接其他逻辑线程。

1. 运行 `agent-link install`、`agent-link watch <项目目录>`。安装命令不会修改 Codex Hook；它会在 Agent Link 数据目录生成 `launcher.cjs`。
2. 将下面的 `UserPromptSubmit` handler 合并进 `$CODEX_HOME/hooks.json`（未设置时为 `~/.codex/hooks.json`），保留其他 Hook。替换命令里的路径；命令可从 Windows Codex 进程的 `PATH` 找到 `node`。

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:\\Users\\YOUR_NAME\\.agent-link\\launcher.cjs\" hook CodexPrompt",
            "timeout": 5,
            "additionalContextLimit": 5000
          }
        ]
      }
    ]
  }
}
```

3. 重启 Codex，通过 `/hooks` 查看并信任这条命令。打开 `agent-link status` 中已绑定的会话后正常发言即可。不要在生产使用跳过 Hook 信任的选项。

Agent Link 只为启用工作区内的已绑定会话提供上下文。Codex 正常完成该轮且 rollout 内出现匹配的注入标记后，Daemon 才确认该端已经读到历史。Hook 失败、超时或尚未信任时，Codex 可继续正常运行；同步端不会假定历史已送达。

## 原生问答回写

- Windows Daemon 默认尝试回写未被锁定的 legacy（含首份镜像）和 paginated 会话。回写前排空目标本地轮次；检测到分叉或拿不到排他租约时保留积压。也可彻底退出目标客户端后执行 `agent-link sync-offline <thread_id> codex --closed`。要关闭自动回写，在 **Daemon 的启动环境**设置 `AGENT_LINK_CODEX_AUTO_SYNC=0` 后重启 Daemon。
- Paginated 回写需能启动 Codex CLI。Daemon 查找默认 npm 安装或 PATH 上的 `codex.exe`；也可在其启动环境设置 `AGENT_LINK_CODEX_CLI`，指向绝对路径的 `.exe` 或 JS 启动器（不支持 `.cmd`）。找不到 CLI 时不会写入任何问答。写入后通过官方 app-server 投影；失败时保留已记账的落盘内容，下次重跑投影，不重复追加已落盘的问答。
- Codex 窗口没有应用内更新按钮。Codex 正持锁时可通过上述 Hook 续聊；想补齐原生问答，彻底退出客户端，等自动回写或执行离线命令，再打开同一会话。已经发生的对话不会被挪动，积压问答会追加在末尾。
- **不要对仍绑定的镜像运行 `codex migrate-rollouts --apply` 并期待继续自动回写。** 实测 0.158.0 会替换 rollout 文件，Agent Link 会保留绑定和积压并拒绝沿用旧字节游标；自动重绑定未实现。

`scripts/verify-m2.mjs` 已用 Windows Codex CLI 0.158.0 验证同线程追加、投影重试、实际写锁释放后补齐，以及新进程通过 `thread/turns/list`、`thread/items/list` 和 `thread/read` 读出完整问答。该脚本不启动 Codex Desktop。
