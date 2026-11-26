# Plan: Agent Link MVP

**Created**: 2026-11-24
**Status**: in-progress
**Scope**: 依据 [PRD](../live/prd_mvp.md) 与 [开发设计 r2](../live/dev_spec_mvp.md)，实现本地白名单内的 Pi、Codex、Antigravity 会话同步。

## Tasks

### [WIP] 1. 项目骨架、工作区白名单与有界 JSONL 读取（M1）
- **What**: 初始化 TypeScript CLI 骨架、SQLite 状态库、工作区路径归一化与定长 JSONL 读取器。此任务不启动后台进程或接触客户端数据。
- **Files**: `package.json`、`tsconfig.json`、`src/cli.ts`、`src/core/{workspace,db,jsonl}.ts`、`tests/`。
- **Acceptance**:
  - `npm test` 编译并通过隔离测试；CLI 可报告版本，入口在低于 Node 22.13.0 时退出并说明最低版本。
  - 普通绝对路径、file URI、软链接可匹配同一已启用目录；未启用目录与子目录不匹配，候选按顺序取首个命中。
  - 临时状态库启用 WAL 和 5000 ms busy timeout，建成设计中的五张表；重开保留状态，重复原生绑定被约束拒绝。
  - JSONL 只返回完整行末尾的字节偏移；跨块 UTF-8、CRLF、半行续读与 2 MiB 边界可复现。
  - 隔离测试以固定块扫描 100 MiB 日志，跳过超大行，仍读到下一条记录，扫描进程峰值 RSS 增量低于 30 MB。
- **Notes**: Windows / Node 24.13.1 的 `npm test` 通过；Node 22.12.0 退出分支用注入版本号覆盖。尚未在真实 Node 22.13.0、macOS 或 Linux 运行。

### [WIP] 2. 轮次清洗、注入预算与 Git 漂移（M1）
- **What**: 将适配器提取的正文和工具结果整理为共享轮次，加入安全的历史包装及 Git 基线比对。
- **Files**: `src/core/{sanitizer,git-state}.ts`、`src/adapters/types.ts`、`tests/`。
- **Acceptance**:
  - 清洗保留用户正文和最终助手回复；去掉 `#link`、读取文件正文、思考密文和媒体；失败命令摘要最多 30 行 / 1500 字符。
  - 工作区绝对路径相对化，工作区前缀相似的其他目录不被改写；历史文本不能闭合外层数据标签。
  - 含状态提示及长单轮的注入不超过 12,000 字符；最多保留 5 轮完整正文，更早内容折叠。
  - 测试 Git 仓库提交后即使 diff 为空，HEAD 变化仍触发提醒；非 Git 目录不出提示。
- **Notes**: Windows / Node 24.13.1 的 `npm test` 通过（共 13 项）；清洗和漂移逻辑尚未接入 Daemon、真实客户端和各端基线更新流程。

### [WIP] 3. 入账、持久化防回声与 Daemon（M1）
- **What**: 实现主干/分支、出站台账、写前排空、两阶段启动、频率熔断和本地 IPC；接通 CLI 的 watch/unwatch/daemon/status/resume。用隔离适配器验证，不依赖真实客户端。
- **Files**: `src/core/{db,engine,writer}.ts`、`src/daemon/`、`src/cli.ts`、`tests/`。
- **Split**: 3a 入账、分叉与熔断；3b 原生写入台账与故障恢复；3c Daemon、IPC、CLI 与进程验收。
- **Acceptance**:
  - 同一会话文件读写串行；写前发现未读原生轮次先入账，发现分叉则暂停写入，原生半行不被跨过。
  - 模拟追加完成但游标未提交后重启：写入不回流、目标游标可继续推进；无新轮次时连续重启三次不会改变原生文件哈希。
  - 两端各从同一旧节点续写后重启，阶段一留存两轮并计算 LCA，线程为 `DIVERGED`，阶段二没有出站写入。
  - 10 秒窗口内第六次扇出触发熔断；熔断仍入账，`resume` 补齐积压或保留未解决分叉。
  - 在沙箱验证并发启动只保留一个 Daemon，watch/unwatch 会限制后续读写；已知 `100 MiB` 文件追加一轮后，增量同步实测额外 RSS < 30 MB、耗时 < 1 s，并记录 Daemon 常驻 RSS（上限 80 MB）。
- **Notes**: Windows / Node 24.13.1 上 `npm test` 通过（21 项）；隔离 Daemon 增量同步 431 ms、峰值 RSS 增量 0.45 MB、同步后 RSS 77.27 MB。使用测试适配器，未实测 Linux/macOS 或真实客户端。CLI 可运行，但任务 4 接入适配器前不会发现或同步原生会话。

### [WIP] 4. Pi ⇄ Codex 实机往返（M2）
- **What**: 从真实客户端采集脱敏样例，再接入两端 adapter、Pi 扩展和 Codex 注册；扩展仅通过 IPC 访问 Daemon。
- **Files**: `src/adapters/{pi,codex}-adapter.ts`、`integrations/pi-extension/`、`src/daemon/watcher.ts`、`tests/fixtures/`。
- **Split**: 4a 客户端样例及格式读写；4b 自动发现、白名单与 Daemon 绑定；4c Pi 在线注入、确认及双向实机验收。
- **Acceptance**:
  - 样例测试覆盖 Pi 父链回溯、Codex 子代理排除、仅由 `event_msg` 闭合正文，以及跨日期目录发现。
  - Pi 新建轮次后，Codex `thread/read(includeTurns=true)` 可读到镜像，轮数与问答一致；追加后再次核对。注册失败的回退提示可用。
  - Codex 续聊后，已打开的 Pi 下次发言自动带入；在真实 Pi 核对自定义消息持久化与确认游标，打开时不由 Daemon 离线追加。
  - 真实 Pi 可重开离线追加的 `al_` entry；`/sync` 在命令上下文可用，一轮同步无回声。
- **Notes**: 4a 已实现，在仅使用本机模拟模型响应的隔离目录采集 Pi 1.4.0 / Codex CLI 0.158.0 样例。直接调用适配器创建 Codex 镜像被 `thread/list` 列出，`thread/read(includeTurns=true)` 在新建和追加后分别返回 1、2 轮，每轮各有一条用户和助手消息；Pi 用 `--session` 重开 `al_` 镜像后，本地模型请求包含镜像问答。没有启动真实会话同步。
- **4b 验证**: Daemon 自动递归发现 Pi 与 Codex 会话，过滤未启用工作区、子代理与目录链接，静默 500 ms 后处理完整轮次。跨日新目录、重复会话 ID、`watch` / `unwatch`、Pi 重启后父链和文件替换保护已通过隔离进程测试。4b 仅入账，不追加客户端原生文件。
- **4c 验证**: 已接通首份原生镜像和 Codex 线程注册、Pi 在线注入与 `/sync`。`npm test` 通过 28 项（含镜像暂存恢复、无回声、持久化确认）。Windows 上运行 `scripts/verify-m2.mjs`，用 Pi 1.4.0 / Codex CLI 0.158.0 和本机模拟模型完成 Pi 新建 → Codex 官方 `thread/list` / `thread/read`（1 轮）→ Codex 官方 `exec resume`（2 轮）→ 同一 Pi 进程带入结论、持久化一条自定义消息并从该轮续写；`/sync` 已走真实命令入口且不请求模型。此闭环的第 2 轮由 Codex 自己续写，未验证 Daemon 对现有 rollout 的追加。
- **4c Windows 离线回写**: `sync-offline <thread_id> <pi|codex> --closed` 在用户退出目标客户端后，以 Windows 文件共享锁排空、走现有台账追加并刷新 Codex 索引。`npm test` 40 项通过，覆盖有竞争写者、原生半行、分叉和重复回写。真实 Pi 1.4.0 重开追加叶子，真实 Codex CLI 0.158.0 `thread/read(includeTurns=true)` 读到 legacy 镜像追加后的第三轮。重复回写为零。
- **4c Windows 在线接续**: 可选 [Codex `UserPromptSubmit` Hook](../../integrations/codex-hooks/README.md) 已接通；绑定、文件标识和工作区校验通过后，带入未读历史。确认以该轮原生 developer 记录中的一次性标记为准，完成入账才推进。真实 Codex 0.158.0 app-server 在原生 paginated 会话实测收到 Pi 未读轮次，并从该轮保持 `SYNCED`。
- **Git 漂移**: Pi、Codex 在完整原生轮次入账时记录 HEAD 和指纹，下一次发言前用各自的 Hook 提示漂移。Windows `scripts/verify-m2.mjs` 在 Git 提交后分别核对两端真实模型请求里的 `workspace_state_reset` 与相对路径。未启用 Codex Hook 时没有发言前提示。
- **4c 最新实测（Windows）**: `npm test` 42 项通过。真实 Pi 1.4.0 的 `/sync` 在当前进程安全追加并载入原生问答，不发模型请求。Codex CLI 0.158.0 支持 legacy 和 paginated 同线程回写；后者按 ordinal 写入完整问答，再调用 app-server 官方恢复接口触发投影。独立进程的 `thread/read`、`thread/turns/list`、`thread/items/list` 均复验通过。还验证了 CLI 缺失零写入、投影中断后重启 Daemon 幂等重试、Codex 实际持锁时拒写以及解锁后自动补齐。Hook 接续不会重复注入已投影轮次，且已读游标不会清空未显示积压。
- **4c 边界**: Codex Desktop 不提供已验证的应用内热刷新入口；需释放锁再重新打开，Desktop UI 端到端仍待验收。实测 `migrate-rollouts --apply` 会替换文件，当前拒绝对旧绑定继续写入，迁移后的安全重绑定未做。因回写是追加操作，已经有本地续聊时，积压问答会落在原生时间线末尾。

### [WIP] 5. Antigravity 显式接续、增量注入与安装（M3）
- **What**: 接入三个官方 Hook、transcript 补读与 Stop 暂存；安装 Pi 扩展、Antigravity Hooks 以及可选的系统自启。
- **Files**: `src/adapters/agy-adapter.ts`、`integrations/agy-hooks/`、`src/cli.ts`、`tests/fixtures/`。
- **Split**: 5a Hook 协议编解码与 transcript 增量读取；5b 接入 CLI、Daemon 入账、Stop 暂存与 `#link` 绑定/注入；5c 安装与三界面实测。
- **Acceptance**:
  - 用真实 IDE / CLI / 2.0 样例核对协议字段、`invocationNum` 起点、正常结束原因与长字段补读；核对 `user_markdown` 是否只对用户可见。
  - 新窗口无历史；显式 `#link` 能重绑定并保留旧逻辑会话，拒绝跨工作区目标且不注入。
  - 仅在当轮首次模型调用注入增量及漂移提醒；同轮工具循环无重复提醒。Daemon 不可达时正常 Stop 可暂存并快速放行。
  - 沙箱验证安装可重跑且保留用户原有 Hook 配置；默认不开机自启；Hook 不读取或修改加密 `.pb`。
- **5a 验证**: Windows 本机 Antigravity 2.34.0.0 的随附文档确认了 Hook JSON 结构。从本机 2.0 transcript 提取结构并替换全部会话正文，验证可见问答、长字段双游标、缺失/半行重试、事件的默认输出与工作区候选顺序。`npm test` 共 32 项通过。CLI / IDE 没有可复验样例；尚未通过真实 Hook 采集 `invocationNum` 起点、Stop 实际参数或确认 UI 的 `user_markdown` 表现。5a 不安装 Hook，不改本机全局配置。
- **5b 验证**: `agent-link hook` 与 Daemon 已接通。在隔离进程验证 SessionStart 不绑定、`#link` 拒绝跨目录及按当前用户 step 重绑定、只注入未读轮次、Git 提交漂移提示同轮不重复、正常 Stop 脱离 Daemon 可落盘且重启按快照补账。PreInvocation 默认关闭，待 5c 实测后设置 `AGENT_LINK_AGY_FIRST_INVOCATION`；断电后的磁盘持久性与真实客户端投递确认不在本次隔离验收范围内。未安装任何全局 Hook 或自启。
- **5c 验证**: `install` 在临时 HOME 合并 Antigravity 命名 Hook、备份原配置、注册 Pi 扩展；重复安装保留个人 Hook、禁用状态和原白名单。真实 Pi 1.4.0 已自动加载安装产物并通过 M2 回归。`--autostart` 有 Windows 当前用户任务、macOS LaunchAgent、Linux systemd user unit；仅核对生成形态，未注册真实系统任务。
- **5c CLI 实测**: 在 Windows 临时 HOME 使用官方 Antigravity CLI 1.5.16 与本机模拟模型跑通 `scripts/verify-agy.mjs`。两轮首调用为 `0`，工具后的调用为 `1`，三次正常 Stop 均为 `NO_TOOL_CALL`。Hook 给的是 `transcript_full.jsonl`；已改为按主文件计量游标、用完整文件补读，实测长回复末尾保留。CLI 对 `metadata.user_markdown` 报 `type mismatch` 并丢弃整个注入步，按 DP2 改用 `agent-link status` 列表；已确认不带 metadata 的 `#link` 历史进入实际模型请求，并保持一个逻辑线程。
- **5c 待实测**: 桌面 2.0 / IDE 尚未跑 [临时工作区探针](../../integrations/agy-hooks/README.md)，因此未确认这两端的调用起点、Stop 或 UI 可见性。PreInvocation 仍默认关闭，CLI 验收仅在临时 Daemon 中设置 `AGENT_LINK_AGY_FIRST_INVOCATION=0`；未修改用户全局配置。

### [WIP] 6. 分支收敛与三端发布验收（M3）
- **What**: 实现 `select` / `merge` 的端侧收敛写入，完成三端实机闭环并记录发布验收。
- **Files**: `src/core/engine.ts`、`src/adapters/`、`src/cli.ts`、`tests/`。
- **Split**: 6a CLI/分支留档；6b 三端裁决交付与实际父节点确认；6c 三端四跳与发布记录。
- **Acceptance**:
  - `select` 不删除原记录，落选端收到裁决；三端各续写一轮后保持 `SYNCED`。
  - `merge -m` 保留选中主干和另一分支头的引用，三端看到合并结论与失效提醒。
  - 在隔离项目实机跑通 Pi → Antigravity → Codex → Antigravity，核对跨端结论与已提交改动提醒。
  - 按 PRD 逐条记录验收证据，覆盖幂等、防回声、写入中断、目录隔离和数据备份上限；未实测的平台或客户端单独列出。
- **6a–6c 验证**: Windows `npm test` 45 项通过；Pi 1.4.0 / Codex CLI 0.158.0 / Antigravity CLI 1.5.18 四跳通过，`select`/`merge` 后三端各续写一轮仍 `SYNCED`。三次重启与无积压重试的三端文件 SHA-256 不变。见 [逐条验收和复验命令](../windows-mvp-acceptance.md)。桌面端与最低版本环境未验收，Antigravity 同轮「改文件后执行测试」仅有 Hook 级覆盖。

## Out of scope
- 跨设备、多人共享、其他客户端、图形化分支合并、修改加密会话文件或桌面端内存注入。

## Decision points
- **DP1**: 若客户端格式与设计示例不一致 → 以真实脱敏样例更新适配器和测试；不放宽工作区隔离或覆盖原生会话。
- **DP2**: 若 Antigravity `user_markdown` 不满足仅用户可见 → 列表改由 `status` 与 Pi/CLI 提供。
- **DP3**: 若 Codex 索引注册失败 → 继续保留 rollout，在 `status` 提示 `codex resume <id>`；仍须通过 `thread/read` 验收。
- **DP4**: 若隔离测试与真实客户端结果冲突 → 实机结果优先；只在对应版本与平台验收后标记通过。

## External preconditions
- **EP1**: Node.js >= 22.13.0 与 npm 可用 — verify: `node --version && npm --version` — on-failure: STOP。
- **EP2**: M2/M3 有可在隔离项目运行的对应真实客户端 — verify: 记录版本、成功生成一份沙箱会话 — on-failure: STOP 实机验收。
- **EP3**: Git 可执行 — verify: `git --version` — on-failure: STOP Git 漂移验收。

## Failure policy
- **FP1**: 若隔离测试修复两次后仍失败 → STOP，报告失败用例、命令与错误。
- **FP2**: 若原生写入范围与实际内容无法核对，或发现可能跳过原生行 → STOP 该绑定出站，报告文件和偏移；不截断文件或盲推游标。
- **FP3**: 若真实客户端验收失败或超出 PRD 硬上限 → STOP 对应里程碑验收，报告环境、复现步骤和差异。

## Subtask split policy
- **Trigger**: 单项涉及三个以上独立模块，或无法用一组验收证据覆盖。
- **Split rule**: 沿核心、进程、适配器的边界拆分；每个子任务独立验证输入、输出与失败路径。
- **Labeling**: 在原任务编号后追加 `a`、`b`、`c`，保留父任务。

## Decisions log
- 2026-11-24: 先在临时目录验证核心读写；原生格式及 Hook 行为在实机采样前不靠猜测实现。POSIX 保留文件名中的反斜杠，避免把两个不同路径归到同一白名单键。
- 2026-11-24: Daemon 使用独立 SQLite 排他锁仲裁陈旧 PID/Socket 清理，无需判断或终止可能已被复用的 PID。原生追加须由适配器确认该文件可独占写入；未确认时只读。
