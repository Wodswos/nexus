# Agent 设计实现与验证记录

2026-11-27。对应 [系统设计](AGENT_SYSTEM_DESIGN.md) 与 [UI 设计](../ui-design/AGENT_UI_DESIGN.md)。本文件记录可执行代码与能力限制；设计规范中的参考接口名不等于另有一套公开 API。

UI 验收纠正：已实现工作台布局和相关功能，但尚未完成与 T3 Code 的视觉对齐；对照依据及差距见 [UI 复核](../ui-design/T3_ALIGNMENT_REVIEW.md)。

## 实现映射

| 设计职责 | 实现 | 行为 |
| --- | --- | --- |
| Provider、Run、WorkArea、关联及稳定对话项 | `packages/core/src/agentRuntime.ts`、`apps/server/src/agents/store.ts` | 服务端权威数据，owner 参与主键；不经 CRDT 同步执行状态 |
| 持久消息、操作和事件 | `agents/service.ts`、`agents/store.ts`、`db.ts` | 请求指纹、事务、Outbox、尝试记录、按 Agent 串行；未知投递需核对 |
| Codex 原生 | `agents/provider.ts` | App Server initialize、thread/start/resume、turn/start/interrupt；文本、工具、计划、审批及用户问题 |
| Claude Code | `agents/claudeBridge.ts` | SDK 在实际 Workspace 的 Node 进程中运行；query/resume、流式、工具、问题与 canUseTool |
| 通用 ACP | `agents/provider.ts`、`agents/acp.ts` | ACP v1 握手、prompt、cancel、load 能力协商；恢复回放不追加为新对话 |
| 执行侧宿主 | `agents/hostMain.ts`、`host.ts`、`scripts/build-host.mjs` | SSH/Kubernetes exec 连接 Unix socket，无额外公网端口；进程身份、事件缓冲、操作回执、审批及 Token 文件 |
| Workspace | `workspaces/service.ts`、`runtime.ts`、`git.ts` | SSH／独立用户／Docker／Kubernetes；持久根目录、基准提交、独立 worktree／普通目录 |
| 账号边界 | `workspaces/service.ts`、`db.ts` | SSH machine-id + UID 归属；Workspace 及 Agent 控制、事件、审批、终端均按当前账号校验 |
| 多对多关联 | `agents/service.ts`、`WorkspaceBindings.tsx` | 显式关联、祖先可用性、最近关联优先去重；移除关联不销毁实例 |
| TaskBridge | `taskDescriptions.ts`、`agents/service.ts` | 任务范围凭据、正文版本前置条件、独立报告与 Round 验收；归档不终止既有工作 |
| 工作台 | `features/work/AgentThread.tsx`、`AgentSidebar.tsx` | `/work/agents/:id` 路由，账号隔离草稿与最近对话缓存、首次连接失败自动重连、历史分页、40 ms 合并、阅读锚点、队列和待回应入口 |
| 详情及交付 | `ChangePreview.tsx`、`TaskDescription.tsx` | 可调右栏，正文与历史、Git 统一／并排视图、报告及真实产物链接 |
| 人工终端 | `WorkspaceTerminal.tsx`、`agents/service.ts` | 默认按需创建；同目录多终端、全屏、缩放高度、独立结束；关闭只 detach |
| 独立工作目录清理 | `agents/workarea.ts`、`WorkAreaCleanup.tsx` | 路径与 Git 归属核验、所有引用必须结束、活动终端与未知投递阻止清理；保留分支、报告和历史，禁止强制抹去未保存数据 |
| 创建及公共 UI | `WorkspaceAgentCreate.tsx`、`packages/ui` | Workspace → 目录 → Agent → Prompt；原生 Codex 默认、非 Git 独立目录、模板／实例标签页，统一控件与弱边界，输入器可引用 Task 正文快照或工作目录文件路径 |

## 生命周期与恢复

- 浏览器离开、账号切换和 SSE 断线均不停止后台工作。Nexus 更新时宿主保持运行，新连接核对回执并补发事件；不重发整段初始 Prompt。
- 宿主也崩溃时，按 PID 与 Linux 进程出生标识检查旧进程组。原进程仍活着时拒绝创建重复 Provider；核对或显式结束后再恢复。磁盘状态损坏也停止自动恢复。
- 中断需要 Provider 的结束确认；队列保留，显式继续才发送。停止持久会话需要确认进程组退出；失败时保留错误，不标为已停止。
- Run 的 unknown 不等于 failed。核对 API 先检查远端状态，用户确认后只更新记录，不自动重发或回滚代码。正在执行的 Run 不能被人工核对为完成。
- 事件窗口最多约 5,000 项／32 MiB；稳定消息投影另行保存。过期游标返回 409，客户端重新获取快照。工具输出按需展开、分段显示并可下载已保存日志；下载不承诺恢复已截断的 Provider 原始输出。
- 宿主目录、Token、socket 限制为所属执行用户；使用 `/tmp` 下的短 socket 路径避开 Unix socket 长度限制。Token 不进入 URL 或进程 argv。
- 新 UI 创建的 Workspace 使用 `terminalPolicy=on-demand`，准备结构化 Agent 无需 tmux。点击人工终端时才检查 tmux。旧 Workspace 的原会话规则保留。
- Workspace 销毁前返回清理计划，检查共享 Agent、关联 Task、仓库和存储。暂停、销毁计算和删除数据分别处理；活动或结果不明的持久会话会阻止销毁。

## 产品能力与验证边界

| 产品／能力 | 本次状态 |
| --- | --- |
| Codex App Server | 适配器及协议夹具覆盖流式、工具、审批、取消、持久重连；本机 `codex-cli 0.172.0` 在独立空 CODEX_HOME 下实测 initialize + thread/start，未调用模型 |
| Claude Agent SDK | 远端 SDK 桥接及协议夹具覆盖工作目录、流式、工具、用户拒绝；执行侧需另行安装 SDK 并完成模型登录。本机存在 Claude Code CLI 2.1.300，但 CLI 安装不等同于 SDK 安装 |
| ACP／DSH | 通用 ACP v1 入口可用，按握手提供恢复能力。本机 `dsh` 是 profile 启动器，不能据其存在宣称某个 DSH Agent 已认证；需填写底层实际 ACP 命令 |
| 模型 | 创建时可选模型或 Provider 默认模型；已有会话的原位模型切换未暴露 |
| 原生 TUI 接管、steering、fork、rollback | 当前适配层未开放这些控制能力，UI 不展示入口。人工终端可操作同一工作目录，但不等于接管同一原生会话 |
| 多模态／语音、AG-UI／CopilotKit | 本次不新增这些可选扩展；Nexus 的消息、队列和权限仍只有服务端一份权威状态 |
| 远端后端 | SSH、Docker、Kubernetes 的既有管理及传输保留；本次自动回归用临时实例和模拟边界，不把夹具测试称为所有真实集群／镜像已认证 |

因此不能把本次发布描述为“任意已有 CLI TUI 都能无损转成网页聊天”，也不能将设计中所有可选能力标记为已认证。可用产品在创建界面选择；缺安装／认证会给出具体启动错误，历史与目录仍保留。

## 测试与发布

- `apps/server/test/agentProvider.test.ts`：原生 Codex、Claude SDK 桥接、宿主 detach/reattach、幂等、孤儿进程与损坏状态。
- `apps/server/test/agents.test.ts`：生命周期、跨账号、Token 续期、正文版本、队列、Round、原生服务重启与旧 tmux 回归。
- `apps/server/test/workspaces.test.ts`、`workspaceGit.test.ts` 等：无 tmux 的 Workspace、归属、Git、共享资源、清理与后端边界。
- `e2e/specs/agent-native-workbench.spec.ts`、`agent-workspace.spec.ts`：路由、草稿、IME、长历史、日志、审批、报告、终端、浅深主题及移动布局。
- `workspace-creation`、`workspace-flow`、`workspace-defaults`、`accounts`：创建和现有配置回归。

使用独立临时数据与测试账号，不操作生产任务或向真实 Agent 发送测试指令。发布按 [RUNBOOK](../RUNBOOK.md) 构建镜像、保留回滚镜像、停服务备份完整 data，再替换并只读验证。构建不会自动安装或升级远端 Harness，不迁移旧目录或重启旧 tmux Agent。

## 最终验证记录（2026-11-27）

- 全量类型检查通过。单测：core 133、server 143、crdt 87、web 82；server 的 2 项可选外部 Runtime 集成保持跳过，未将其计为通过。
- 离线、账号切换防串写、任务日期、导图连线与拖动、日历及移动布局：独立 smoke 实例 27 项通过。Agent／Workspace／账号专项分批执行，新增和关联浏览器用例合计 48 项通过，以遵守生产同等的每分钟注册限流；完整结果与截图保存在 `.preview.local/agent-redesign-20261127/`。
- 长会话样本：1,000 条消息、10,000 行工具日志、3 个 Agent，初始渲染 100 项、加载历史后 200 项。Linux 无头 Chromium 151.0.7922.34，20 次详情面板切换在两次 requestAnimationFrame 后取样，p95 为 33.4 ms。仅代表此本地交互样本，不代表真实模型／公网响应延迟，也不是多 Agent 真实模型压测。
- 已查看浅色桌面、深色桌面及 390 px 移动截图；布局测试还覆盖 1280／1024／768 px。Service Worker 离线能力只在 localhost／HTTPS 验证，公网 HTTP 的安全上下文限制不变。
- WorkArea 测试使用临时真实 Git 仓库，验证未提交／未推送阻止清理、保留源仓库和分支、symlink 替换拒绝；服务测试覆盖账号、活动引用、清理后恢复与终端入口阻止。
- 本地缓存最多每账号 5 个会话、每会话最近 100 项，正文限长、工具日志仅保存摘要；离线只阅读与编辑草稿，控制操作不会自动排队。联网收到 401／403／404 后清理该会话可见缓存。

### 已部署

已部署至 `http://115.190.3.4:30090`，构建镜像 `nexus:agent-system-20261127`。容器 healthy；线上主入口、Agent／Workspace 路由、移动布局、JS/CSS、Swagger 与公开 Guide 验证通过。匿名请求 Agent／Provider 控制接口返回 401。

发布前后用户、文档、连接档案和普通 API Token 的数量一致，文档快照摘要一致；原有 tmux server、Shell 和 Codex 进程保留。验证没有新增生产账号、修改任务或向 Agent 发送指令。

完整数据备份：`backups/agent-system-20261127-012931-data.tgz`。回滚镜像：`nexus:rollback-agent-system-20261127-012931`。回滚限制见 RUNBOOK，新原生会话建立后不能盲目降级。

### 旧终端 Agent 空白修复（2026-11-27）

修复连接状态占满可读历史分页的问题。后端分页排除隐藏状态，前端实时投影不插入空行；送达状态仍更新原用户消息，事件游标覆盖全部事件。旧 tmux 只展示最近一份重叠快照，历史原始记录不删除，原终端入口和接入能力说明固定可见。

通过全量类型检查、35 项服务端定向测试、1 项前端投影测试及 13 项 Agent 浏览器回归；额外查看了旧会话的桌面和 390 px 截图。生产使用现有登录身份只读请求历史，确认首屏返回 1 条用户指令、1 份终端快照及 4 条错误，隐藏状态不再占位。原 tmux/Codex 进程、用户和文档快照保留。

已部署镜像 `nexus:agent-history-20261127`。这项修复不等于导入旧 Codex 原生聊天历史，旧 Agent 的完整 CLI 会话仍通过原终端查看。

### 当前工作导航修正（2026-11-27）

恢复 `/work` 的任务分组看板（等我回复、待验收、执行中、异常），同一 Task 下保留多个 Agent 入口。总览继续使用项目、快捷视图和工具导航，仅具体 `/work/agents/:id` 会话使用 Agent 侧栏。看板和会话顶栏有明确的“打开 Task”入口，按所属项目记住的视图定位；从看板进入会话后，返回箭头回到看板。

全量类型检查、构建及任务分组服务端定向测试通过。浏览器回归 16 项通过：首轮 15 项通过，1 项旧验收测试补充 `/api/agent-workbench` 测试数据后单独重跑通过。新增回归覆盖侧栏稳定、同 Task 多 Agent、项目视图记忆、无日期任务定位、看板自动刷新及匿名空态；已检查桌面和 390 px 截图。

已部署镜像 `nexus:current-work-20261127`；健康检查、线上 JS/CSS、公开 Guide/Swagger、匿名接口保护和现有身份的只读历史／看板请求通过。用户与文档快照保持一致，原有 tmux/Codex 进程保留。完整数据备份为 `backups/current-work-20261127-101518-data.tgz`，回滚镜像为 `nexus:rollback-current-work-20261127-101518`。

对当前运行中的 Codex 进程核查：通过 `NEXUS_AGENT_TOKEN_FILE` 获取 Nexus 任务范围凭据，文件权限 `0600`，进程环境无明文 `NEXUS_AGENT_TOKEN`。部署后使用该文件读取绑定 Task 上下文得到 HTTP 200，Task ID 匹配。未轮换凭据或向真实 Agent 发送测试指令；凭据值未写入日志或文档。

### 连续对话、终端切换和澄清问答（2026-11-27）

- 移除输入器前的“验收本轮／开始新一轮／提出调整”步骤。普通消息在旧轮次已结束时原子创建后续记录，保持消息幂等性、历史报告和 Task 状态。
- 进展事件和报告接收最多 4 项 `suggestions`，由当前 Agent 生成；点击填入或追加草稿，不自动发送。没有当前建议时显示发布、部署、总结进展。建议只取最近用户消息之后的内容，不另外配置模型。
- 默认 Prompt 和上下文 `interactionGuide` 强调先读正文、祖先和最新消息，信息不足先询问。支持原生单选／多选／自定义回答；REST `waiting + questions` 支持旧终端 Agent，回答持久化且作为消息投递。用户直接回复也可解除 REST 问题的等待状态；不会替代工具审批。
- 原终端占据整个对话主区域。切回保留草稿、问题选择和阅读位置，关闭只 detach；终端仍可全屏。

验证：全量类型检查、构建通过；服务端相关 43 项与新增原生多选题定向 1 项通过。18 项浏览器回归通过，扩大问题区后又复验建议、澄清和终端 3 项；已检查桌面、390 px 问题卡与完整终端截图。记录在 `.preview.local/agent-dialogue-20261127/`。

已部署 `nexus:agent-dialogue-20261127`。线上健康、静态资源、Swagger、公开 Guide、旧会话与看板的只读请求通过；现有 Codex 凭据读取新上下文 HTTP 200，包含交互说明与问题记录。用户与文档快照一致，原进程保留，没有向真实 Agent 发送测试指令。完整备份 `backups/agent-dialogue-20261127-104227-data.tgz`，回滚镜像 `nexus:rollback-agent-dialogue-20261127-104227`。

已有会话无需重建；其保存的初始 Prompt 不强制覆盖。下一次读取任务上下文时可获得新交互协议；动态建议／问题卡需要 Agent 使用原生工具或上报对应结构化字段，不从任意自然语言回复猜测并执行操作。

### 工作目录说明、Prompt 精简与 Agent 代理（2026-11-27）

- 创建界面明确区分 Git worktree（检出代码和独立分支）、空目录（无仓库／分支）及自定义目录（使用已有内容）；空目录也校验名称，仓库能力以当前选择的 Workspace／模板为准。
- 默认 Prompt 合并上下文读取要求，保留范围澄清、认证、CAS 写回和报告协议；删除 UI 轮次按钮说明，问答／建议格式仅由上下文 `interactionGuide` 提供。已有会话的历史 Prompt 不强制覆盖。
- 服务器档案增加按账号保存的 Agent 代理开关、URL 和 `NO_PROXY`，旧请求省略字段时保留配置。SSH／独立用户中的原生及新 tmux Agent 在启动时注入代理；不改宿主 shell 配置、不影响 Nexus 的 SSH 客户端、不将主机 loopback 代理套用到容器／Pod。Nexus 回调主机自动直连。
- 日志展示清理 ANSI 控制字符，为模型目录刷新超时、等待网络提供解释与可展开原文；stderr 不决定会话成败。

现场排查确认：故障 Codex 已完成握手和 turn/start，但进程没有代理变量，执行主机直连 ChatGPT 超时，本地 HTTP 代理可达。上线后按用户要求配置其服务器连接的默认代理；通过原生取消回执、停止和恢复流程保留同一个 thread、工作目录及消息 ID，不重发初始任务。新 Codex 进程确实加载代理，外网请求 HTTP 200；任务范围凭据文件权限 0600，读取绑定 Task 上下文 HTTP 200。恢复后处于 idle，未向生产 Agent 发送验证指令或代用户继续执行任务；网络连通不代替真实工作结果验证。

验证：全量类型检查与构建通过；服务端 61 项相关回归及代理单测 1 项通过，新增同会话停止／恢复不重放的定向测试通过；前端单测 2 项、浏览器回归 15 项通过，最终目录切换和诊断调整再复验 4 项。截图检查覆盖创建窗口手机布局和代理设置。记录位于 `.preview.local/agent-startup-20261127/`。

已部署 `nexus:agent-startup-20261127`。健康、线上 JS/CSS、公开 Guide／Swagger、匿名接口保护及已有会话只读请求通过。完整备份 `backups/agent-startup-20261127-112409-data.tgz`，回滚镜像 `nexus:rollback-agent-startup-20261127-112409`。任务、习惯、资源等语义数据与备份一致；重连客户端在服务器档案新增 `agentProxy` 字段，因此不能用全库二进制哈希一致来描述本次升级。原终端 Agent 保留运行，故障原生 Agent 的进程仅在明确恢复操作中替换。
