# Agent Link Windows MVP：开发交接与 4c 卡点

**最新进度（接替下方的原始交接快照）：** Windows 已实现并隔离实测 Pi `/sync` 原位加载和 Codex legacy / paginated 同线程回写。Codex paginated 落盘后通过官方 app-server 触发投影，新进程能读到原生问答；锁住时保留积压并允许 Hook 接续，解锁后自动补齐。`npm test` 42 项通过，`scripts/verify-m2.mjs` 用真实 Pi 1.4.0 / Codex CLI 0.158.0 通过。Codex Desktop GUI 仍需独立验收，未实现应用内热刷新；实测官方 `migrate-rollouts --apply` 会替换 rollout 文件，旧绑定不会自动沿用。详见 [4c 最新计划记录](plans/2026-11-24-agent-link-mvp.md) 和 [Codex 回写说明](../integrations/codex-hooks/README.md)。

**任务 6 更新：** `select` / `merge` 已实现。Windows 真实 CLI 四跳和两种裁决后三端续聊通过；45 项测试通过。见 [发布验收记录](windows-mvp-acceptance.md)；Codex Desktop、Antigravity Desktop/IDE 和 Windows 登录自启仍待实测。

以下为原始交接快照，保留当时的背景和旧卡点。当前状态以上方更新和验收记录为准。

## 1. 背景与最新产品要求

Agent Link 是一个单机本地的会话同步工具。用户希望在同一个项目里交替使用 Pi、Codex 和 Antigravity，不用复制粘贴或重新解释之前的问答。仓库是 `D:/agent_link`，当前开发与验收优先看 Windows，先解决 Pi ⇄ Codex；其他平台不阻塞这个阶段。原始范围见 [PRD](live/prd_mvp.md)、[开发规格](live/dev_spec_mvp.md) 和 [任务计划](plans/2026-11-24-agent-link-mvp.md)。部分较早的计划备注只记录当时的状态，以较新的实测记录和本交接为准。

最近明确的目标是 **同步可见的完整对话，而不仅是共享给模型的上下文**：

- 当前已经在 Pi 中聊过的会话，启用 Agent Link 后，应能在 Codex 中找到对应会话，看到已有的用户和助手问答，并直接继续。反过来也一样。
- 每一轮用户提问和助手回答结束后，Agent Link 把新轮次写入共享记录。以后切回另一端，应在该端对应的**同一个已有会话**中看到新增问答，然后继续聊。
- 如果目标窗口已经打开，用户提出的交互是「检测到新问答 · 更新」的浮动按钮或提示。点击后刷新当前会话；技术实现尚未决定。更新不能中断正在生成的回答，也不能覆盖目标端自己刚产生的内容。
- 之前讨论过「外端问答只做隐藏上下文，界面仅显示『创建于 Pi』『在 Codex 中更新』」。**用户已明确这不是最终目标。** Hook 带入上下文可以作为已有能力或临时退路，不能据此宣布原生时间线同步已通过。
- 一条 Agent Link 逻辑会话用 `thread_id` 标识，两端可以有各自的原生会话 ID。切换端不应每次重建一个新的目标会话或在侧栏造重复项。当前清洗规则保留用户与助手问答和工具摘要，不保留原始工具输出、媒体、思考密文等；用户没有另行要求跨端复刻全部工具细节。

## 2. 已有实现

```text
Pi / Codex 会话文件 ──增量监听──┐
                               ├─ Daemon ── SQLite 索引 + 清洗后的共享轮次
Antigravity Stop ──本地队列─────┘      │
                                      ├─ 创建缺失的 Pi / Codex 首份原生镜像
                                      ├─ Pi / Codex / Antigravity 发言前带入未读上下文
                                      └─ Windows 显式离线追加（Pi、Codex legacy）
```

| 模块 | 已完成或已验证的内容 |
|---|---|
| **任务 1–3：核心与 Daemon** | `watch` / `unwatch` 精确匹配工作区白名单；守护进程单实例、按需启动、本地 IPC；按字节增量读取 JSONL、保留半行，限制超大行；SQLite 持久化绑定和轮次；启动时先入账后扇出。入账和写回有独立游标；追加前先处理目标未读记录，备份、登记台账、校验字节后才提交游标。能检测分叉，保留双方轮次，暂停该线程的出站同步；有防回声和熔断测试。 |
| **任务 2：清洗和代码状态** | 普通问答清洗保留，工具输出摘要化，路径相对化；模型注入上限 12,000 字符，最多 5 轮完整文本。Pi、Codex、Antigravity 都已接入 Git 漂移提醒；Pi 和 Codex 真实客户端测试确认，即使 `git diff` 为空，外部提交造成的 HEAD 变化也会带入变更文件提醒。Codex 依赖按说明启用并信任 Hook。 |
| **4a/4b：Pi、Codex 发现与解析** | 递归发现已纳管路径下的原生会话；Codex 跨日期目录发现和防抖，排除子代理、重复 ID，跟踪绑定的文件标识以保护游标；Pi 能在重启后沿父节点链恢复因果。通常由 Daemon 监听原生文件获取完整问答，Pi/Codex 不靠每轮结束 Hook 才能入账。 |
| **4c：首份镜像** | 目标端尚无绑定时，在临时文件写完整镜像后发布。真实 Pi 1.4.0 能打开镜像并继续；真实 Codex CLI 0.158.0 的 `thread/list` 和 `thread/read(includeTurns=true)` 能看到 Agent Link 创建的 legacy 镜像及用户、助手两条消息。Codex 索引注册失败时保留文件并提示 `codex resume <id>`。 |
| **4c：已有会话离线回写** | Windows 退出目标客户端后可运行 `agent-link sync-offline <thread_id> <pi\|codex> --closed`。通过 `FileShare.Read` 排除竞争写入，写前读入目标的本地增量，遇到半行、分叉、文件被替换或拿不到锁就不追加。真实 Pi 已从追加的叶子继续；真实 Codex 官方接口已读到 legacy 镜像追加的第三轮，索引已刷新。重复执行不会重复写。**Codex 原生 paginated 明确拒绝直接追加并保留积压。** |
| **4c：已有会话在线接续** | Pi 扩展在 `before_agent_start` 带入未读历史，以客户端持久化的自定义消息确认进度。其 `/sync` 等待空闲后重新打开当前会话，不启动新模型问答。Codex 可选官方 `UserPromptSubmit` Hook 带入未读历史；Daemon 只在该轮闭合、且原生 developer 记录出现匹配的一次性标记后确认。Windows 真实 app-server 已验证原生 paginated 线程能收到 Pi 的新增上下文并保持 `SYNCED`。**在线注入不会把外端问答补成原生聊天气泡。** |
| **任务 5：Antigravity 和安装** | `SessionStart` / `PreInvocation` / `Stop`、`#link`、跨工作区拒绝、显式重绑定、未读增量、Stop 掉线暂存和长字段双游标已实现。正常 Stop 记录当时的文件末尾，重启不抢读下一轮。Windows Antigravity CLI 1.5.16 实测首调用为 `0`、同轮后续调用为 `1`、正常 Stop 为 `NO_TOOL_CALL`；Hook 实际给的是 `transcript_full.jsonl`，已归一到主文件并保留补读。该 CLI 拒绝 `metadata.user_markdown`，列表改用 `agent-link status`，普通模型历史注入仍可用。`install` 在临时 HOME 验证可重复执行并保留原配置，默认不开机自启。 |

## 3. 当前两个关键卡点

### A. 已打开的 Codex 窗口怎样接到通知并刷新同一会话？

Daemon 已能发现源端新轮次，**问题不在怎么监听**。Windows 文件锁只保护磁盘写入：文件暂时没有写者，不代表 Codex 内存里没有打开这条会话。外部追加后，窗口可能继续显示旧历史；若它恰好开始写自己的问答，竞争也必须安全处理。因此当前的离线命令要求用户先退出目标客户端，不等于最终的「窗口内点更新」。

目前没有验证过 **现有 Codex Desktop 窗口**可被 Agent Link 用官方方式挂异步按钮、释放或重载当前会话。不要把自己启动的 app-server 能查询和打开线程，理解为能刷新 Desktop 持有的窗口。官方 `thread/unsubscribe` 只取消调用连接自己的订阅；没有其他订阅者时，才可能在一段空闲时间后卸载线程。它不能直接摘掉另一个 Desktop 客户端的订阅。

### B. Codex 怎样把外部问答认成原生 paginated 线程的一轮？

Windows 隔离实验中，向原生 paginated rollout 追加了成对问答，文件确实增加了记录，**但新启一个 app-server 调用 `thread/read` 仍只返回原来的轮次**。这说明仅强制重读窗口不能解决全部问题。确切原因尚未验证：不要擅自认定改 `state_5.sqlite`、调整 ordinal 或写某一种私有索引就能解决。未经验证的追加实现已撤回；当前代码拒绝此操作，文件和已写游标不变。

对照证据：legacy 镜像通过同一官方读取入口能显示附加轮次；`UserPromptSubmit` 和文档里的 `thread/inject_items` 给的是**模型上下文**，不证明 Codex 原生历史会多出一对用户/助手消息。`state_5.sqlite` 的已验证用途是 legacy 镜像的线程列表注册和更新时间，不是伪造原生问答轮次。

## 4. 建议给下一位 AI 的排查顺序

1. **先测原生轮次登记。** 在临时 `CODEX_HOME` 用同版本 Codex 创建隔离 paginated 会话，拿一轮由 Codex 自己生成的真实问答当对照。优先核对[官方 app-server 文档](https://developers.openai.com/codex/app-server)及当前版本生成的协议，找受支持的导入或原生轮次写入路径。具体成功标准：保持同一个 Codex native thread ID；关闭后，新进程通过 `thread/turns/list` / `thread/items/list`（也可对照 `thread/read(includeTurns=true)`）能读到恰好一轮新增的用户与助手内容。确认接口可用性以本地版本为准：0.158.0 在一个隔离场景中普通 `exec resume` 返回 `list_turns is not supported yet`，而 app-server `thread/resume(excludeTurns: true)` 后 `turn/start` 已跑通在线接续。
2. **并行用已验证的 legacy 镜像验证窗口刷新。** 定位 Windows Codex Desktop 的官方界面扩展、通知或同会话重载入口。先用已确认可读的新轮次验证「窗口开着 → 检测更新 → 用户点击 → 等到空闲 → 原窗口显示新增内容」。如果只有外部 Windows 通知或手动重新进入能工作，明确标为过渡方案，不能当成应用内按钮已实现。
3. **保留三种独立状态。** Daemon 已收到、目标模型已收到、目标原生时间线已可读/显示，三者不能用同一个游标替代。现有字段 `last_written_turn_id` / `last_seen_turn_id` 含义不同；Codex Hook 的已读确认不等于界面已经刷新。更新前如果发现目标端已自行续写，先入账并保护分叉；不能丢问答、静默覆盖或强制打断正在运行的轮次。
4. **若原生入口不可用，带证据回报再取舍。** 继续保留已验证的在线上下文接续和手动离线 legacy 方案；不要默认把每次新建镜像、覆盖私有历史或只有模型看到上下文当成满足原需求。未经用户同意不要更改产品目标。

## 5. 剩余 MVP 清单（Windows）

- **4c 开发/验收未完成：** 已有会话的自动原生时间线同步、paginated 同线程追加可读、打开中的 Codex Desktop 更新入口。Pi 虽已有 `/sync` 和安全离线追加，也未形成两端统一的自动时间线闭环。
- **任务 6 开发未开始：** `select` / `merge` 及三端收敛后的续聊。当前能检出 `DIVERGED` 并完整保留分支，不能选定主干后把裁决送到三端并防止立刻再次分叉。
- **5c 尚待实测：** Windows Antigravity 2.0 桌面与 IDE、Codex Desktop。Antigravity CLI 已通过，但不能把 CLI 的调用计数和 UI 行为套到其他界面。实际 Windows 登录自启未测，只验证了配置生成。全局用户配置没有在测试中被修改。
- **发布验收未完成：** Pi → Antigravity → Codex → Antigravity 四跳，以及分叉解决后三端各续写一轮仍为 `SYNCED`。幂等、防回声、并发/中断恢复和低内存已有隔离测试，不等于三端真实客户端发布验收通过。

## 6. 代码入口、证据与复验

**定位文件：**

- `src/cli.ts`、`src/daemon/server.ts`：命令和 IPC；现有 `watch` / `unwatch` / `status`、`sync-offline`、`resume`（熔断恢复）、`daemon`、`install`、`hook`，没有 `select` / `merge`。
- `src/core/engine.ts`、`src/core/db.ts`、`src/core/writer.ts`、`src/core/windows-append.ts`：逻辑会话、分叉、提交游标、原生追加台账和 Windows 写锁。运行数据默认在用户目录 `~/.agent-link/`，可用 `AGENT_LINK_HOME` 隔离；`state.sqlite` 存索引，`turns/<thread_id>.jsonl` 存清洗后的轮次。
- `src/daemon/watcher.ts`、`src/daemon/mirrors.ts`、`src/adapters/codex-adapter.ts`、`src/adapters/pi-adapter.ts`：原生发现、首份镜像、Hook 历史投递与现有文件回写的主要入口。
- `integrations/pi-extension/index.ts`、[Codex Hook 安装说明](../integrations/codex-hooks/README.md)、`src/codex-hook.ts`：在线接续；`src/daemon/agy-bridge.ts`、`src/adapters/agy-adapter.ts`、[Antigravity 探针说明](../integrations/agy-hooks/README.md)：第三端入口。

**实际测试：**

- 本交接重跑 `npm test`：Windows / Node 24.13.1，**41 项通过**。本次 100 MiB 增量样例约 427 ms，峰值 RSS 增量 0.50 MB，Daemon 当时 RSS 69.89 MB；这是隔离样例，不是所有实时负载的性能保证。支持版本声明 Node ≥ 22.13.0，但本次没有用真实最低版本运行全套。
- `scripts/verify-m2.mjs` 已在 Windows 以真实 Pi 1.4.0、Codex CLI 0.158.0 和本地模拟模型通过。覆盖首份镜像、在线历史、原生投递确认、Windows 离线 legacy 回写、防重复、paginated 文件拒写保持不变、Pi/Codex 的 Git 漂移。复验时设置 `PI_CLI` 和 `CODEX_CLI` 为实际可执行文件或 JS 启动器的绝对路径，再运行 `node scripts/verify-m2.mjs`。测试仅信任它自己生成的临时 Codex Hook；真实安装应通过 `/hooks` 审阅。
- `scripts/verify-agy.mjs` 已用真实 Windows Antigravity CLI 1.5.16 和本地模拟 Gemini 通过。用 `AGY_CLI` 指向官方可执行文件，然后运行 `node scripts/verify-agy.mjs`；`node scripts/probe-agy.mjs prepare` 可生成供桌面或 IDE 打开的临时探针工作区。测试命令使用临时 HOME / 客户端数据目录，不需要真实模型账户。构建入口为 `npm run build`。
- 交接时本地仓库还没有首个 Git 提交；`git status` 显示源码、文档和测试为未跟踪。不要把空的 `git diff` 当作没有实现，也不要为了验收擅自提交、推送或改用户真实配置。

**保留的边界：** 维持工作区白名单、文件标识校验、先入账后追加、持久化台账和防回声。不截断用户原生历史，不伪造可读轮次的证据，不修改加密 `.pb` 或注入桌面客户端内存。下一轮工作的首要产物是 **Windows 下同一原生会话新增完整问答的可重复证据**，以及 **现有窗口刷新入口的独立可行性验证**。
