# Windows MVP 验收记录：任务 6

环境：Windows，Node 24.13.1，Pi 1.4.0，Codex CLI 0.158.0，Antigravity CLI 1.5.18。使用真实客户端、临时工作区和独立客户端目录，模型请求走本地模拟服务。验收检查实际请求包含上一端结论和文件提醒，不评价线上模型的复述质量。未修改真实会话、全局 Hook 或系统自启配置。

## 分叉后怎么操作

1. 运行 `agent-link status <项目目录>`，找到 `DIVERGED` 的 `thread_id` 和要保留的端。让正在生成的原生问答先闭合。
2. 二选一：`agent-link select <thread_id> <pi|codex|antigravity>`；或 `agent-link merge <thread_id> --into <pi|codex|antigravity> -m "合并结论"`。`merge` 要求恰好两个独立分支。
3. `selected_turn_id` 是选定分支头，新的 `head_turn_id` 是紧跟其后的裁决轮次。原记录保留，落选轮次标记 `abandoned`。命令不会替任何端确认已读。
4. Pi 可用 `/sync` 补原生问答，或在发言时接收裁决。Codex 释放锁后自动回写，持锁时用已信任的 `UserPromptSubmit` Hook 接续。Antigravity 在下一轮 `PreInvocation` 收到裁决。Pi/Codex 原生文件只追加，不挪动旧消息；作废记录仍可查看。若从还未接收裁决的旧窗口继续，分叉可以再次出现。

## PRD 对照

| PRD 验收 | 结果 | 证据 |
|---|---|---|
| 1. 三端四跳 | 通过（CLI） | `verify-m2.mjs`：Pi → Antigravity `#link` 并通过原生工具创建 `agy-change.txt` → 提交后由 Codex 续聊 → Antigravity `--continue` 返回同一会话。三次跨端请求均断言前端结论，后两跳断言提交后的相对路径提醒。 |
| 2. 幂等 | 通过（CLI） | 三端收敛、积压补齐后，连续重启三次；每次手动同步 Pi 和 Codex 都追加 0 轮。Pi、Codex、Antigravity 主/完整转录的大小和 SHA-256 全部不变。 |
| 3. 防回声 | 通过 | `verify-m2.mjs` 断言跨端问答只记一次、已原生投影的轮次不被 Codex Hook 重复注入；两个分叉裁决各三次续聊均核对实际父节点。单测覆盖原生同步标记和重启防回流。 |
| 4. 大文件低内存 | 通过（隔离样例） | `npm test` 中 100 MiB 增量样例约 429 ms，峰值 RSS 增量 0.84 MB，低于 1 s / 30 MB 上限。 |
| 5. 分叉零丢失 | 通过（CLI） | `verify-m2.mjs` 两次暂停 Daemon，由 Pi/Codex 从同一基线各写一轮，重启发现 `DIVERGED` 并匹配 LCA；分别执行 `select` 和 `merge`，原生文件字节不变、落选记录保留。两种裁决后 Pi、Codex、Antigravity 各续写一轮，始终 `SYNCED`；合并节点保留两个父引用。单测另验证未收到裁决的旧分支续写会再次报分叉。 |
| 6. Codex 原生可读 | 通过（app-server） | `verify-m2.mjs` 校验 legacy、paginated 的同线程回写；新进程用 `thread/read(includeTurns=true)` 校验轮数和原生问答，paginated 另核对 `thread/turns/list` 与 `thread/items/list`。 |
| 7. 写入中断不回流 | 通过（故障注入） | `tests/engine.test.mjs` 模拟字节已写、游标提交失败；重启恢复台账、文件不变。`verify-m2.mjs` 模拟 Codex 投影失败并重启，重试只补投影，不再追加问答。 |
| 8. 目录隔离 | 通过（CLI） | `verify-m2.mjs` 在另一个已纳管目录发出 `#link`，模型请求未收到历史，原 Antigravity 绑定不变。 |
| 9. 代码漂移 | 跨端通过；同轮工具链部分验证 | 四跳实测两个方向的提交提醒。真实 Antigravity 验证工具循环的调用计数，隔离 Hook 测试断言同一用户步骤只注入一次；未单独跑真实 CLI 在同一轮内连续改文件和执行测试的场景。 |
| 数据备份上限 | 通过（故障注入） | `tests/engine.test.mjs` 用 100,000,000 字节预置备份触发滚动清理，断言追加后合计 ≤ 100 MB。 |

## 复验

```powershell
npm test
$env:PI_CLI = 'C:\path\to\pi-launcher.js'
$env:CODEX_CLI = 'C:\path\to\codex.js'
$env:AGY_CLI = 'C:\path\to\agy.exe'
node scripts/verify-m2.mjs
node scripts/verify-agy.mjs
```

结果：`npm test` 45 项通过，两条真实客户端脚本通过。`AGY_CLI` 未设置时，`verify-m2.mjs` 只跑 Pi/Codex，不算任务 6 三端验收。

未验收：Codex Desktop GUI、Antigravity Desktop/IDE、真实 Windows 登录自启、最低支持的 Node 22.13.0、macOS/Linux。Codex Desktop 无已验证的应用内刷新路径；官方迁移替换 rollout 后，原绑定会拒写，未实现自动重绑定。
