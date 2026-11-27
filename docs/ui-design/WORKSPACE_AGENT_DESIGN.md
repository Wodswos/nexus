# Workspace、Agent 与任务轮次

> 2026-11-26：本文保留现有实现与兼容基线。新的目标架构以 [Agent 系统设计](../architecture/AGENT_SYSTEM_DESIGN.md) 为准，工作台与交互以 [Agent UI 设计：对齐 T3 Code](AGENT_UI_DESIGN.md) 为准。新方案将 tmux 改为终端功能、独立用户改为身份选项，并明确 Task–Workspace 多对多；新实现与兼容边界见 [Agent 实现记录](../architecture/AGENT_IMPLEMENTATION.md)。

更新：2026-11-24。本文描述当前交互和数据边界，旧接口名保持兼容。

## 名词与入口

- **Workspace 模板**：旧 WorkspaceProfile。账号内可复用的连接、运行方式、仓库、存储与环境启动配置。Prompt 属于 Agent；模板不绑定具体 tmux 会话或实例工作分支。
- **Workspace**：真实执行实例及持久工作目录。保存创建时配置，不因模板更新而改变正在运行的实例。
- **Agent**：绑定一个实际 Task 和一个 Workspace 的执行会话。
- **工作轮次**：一次明确目标、预期产物和验收条件的工作单元。追问与回复可发生在同一轮；协议 end_turn 不等于业务验收完成。

Task 详情直接提供「创建 Workspace 模板」「创建 Workspace」，Agents 区域提供「新建 Agent」。Workspace 区域显示创建入口、默认收起的「可用 Workspace 模板」和实例列表。没有实例时只显示「暂无 Workspace」，有实例时才显示「已创建 Workspace」标题。模板列表按当前节点到祖先聚合，标注来源，可直接打开编辑、删除；不显示「默认选择」。实例列表包含当前节点和祖先的实例；点击仅改变当前查看实例，不写入默认绑定。轮询刷新保留当前选择。

在导图或其他视图打开 Task 详情后，固定头部右上角的「Workspace」按钮直接打开「Workspace 配置」，无需滚动查找配置入口。项目根、任务和文本节点都能绑定默认模板，在项目根配置后，子任务默认继承，仍可在单个节点覆盖或停用。

全局入口为「设置 → Workspace 与模板」，「当前工作」中也可进入同一管理页，集中管理 Workspace 模板和实际 Workspace。新建 Agent 时临时选择其他模板只影响本次创建，不改写项目默认配置。

「新建 Agent」始终创建并启动执行会话，不提供仅创建记录的选项；环境准备后自动创建目录、启动进程并发送初始 Prompt。只有「创建 Workspace」入口提供默认勾选的「同时创建并启动 Agent」，取消后仅准备 Workspace。创建结束打开 Agent 工作台，展示准备、启动、指令投递及实际失败原因。

## Git 来源与工作目录

### Task 的默认绑定与排列顺序

详情按「创建模板／创建 Workspace → 已创建 Workspace → Agent」组织。模板管理位于全局 Workspace 页面；旧的节点配置保留在任务详情固定头部的 Workspace 入口。

每个项目、Task 和文本节点可拥有多个模板和多个 Workspace。模板的 taskId 记录归属；从详情新增模板不会覆盖其他模板或自动改写默认绑定。创建 Workspace 时列出当前节点及全部祖先的模板，当前节点优先，再沿祖先向上排列；账号共享模板也可选。历史默认绑定的模板同样进入候选。

创建 Agent 时收集当前节点及全部祖先附属的所有可用 Workspace，并纳入历史显式绑定；默认采用已有优先选择或最近节点的实例。「显示其他节点的 Workspace」可展开账号内其他可用实例，已删除数据、归档或结束的实例不可选。也可以选择「从模板创建新 Workspace」。每次创建表单生成可编辑的唯一 Workspace 名称，提交后的实例保留同一个名称。保留历史绑定的兼容性，创建时选择候选不改写父节点或当前节点的默认绑定。

更换模板不会切换或修改正在使用的 Workspace。若实例快照与新模板不同，界面显示说明。新建 Agent 优先使用当前正在查看的可用 Workspace；在 Agent 创建对话中临时选择其他模板／实例，不修改 Task 的默认绑定。已删除、归档或清理数据的实例不会作为可用目标。

项目模板可分别或同时配置远程仓库 `repository` 与执行侧本地仓库 `localRepository`。`source=auto` 两者都有时使用本地；也可明确选择 local 或 remote。本地路径无效时不静默 clone 另一个仓库。两者并存时校验 origin，避免把工作发到错误代码库。

`ref` 是基准分支或版本，不固定为 main；`prTarget` 是 PR 目标分支，默认动态跟随基准分支；界面直接显示生效值，不附加跟随说明小字；手动修改后独立保存，可用「跟随基准分支」按钮恢复对齐。空值表示跟随，不将当前 ref 固化为目标。以 commit 或 tag 为基准时应另填实际 PR 目标分支；均留空时从源仓库／远程默认分支推导。模板表单不提供 `branch`；创建 Workspace 时生成并展示可编辑的唯一工作分支，不复用历史模板中的固定分支。API 的 `config.branch` 仍可指定实例分支，省略生成 `nexus-agent/workspace-<environment-id>`。新 Agent 默认选择「自动创建 Git worktree」，生成可编辑且唯一的 worktreeName，目录使用 `nexus-agent/<worktreeName>`，分支使用 `nexus-agent/<worktreeName>`；旧 Agent 保留原有目录与分支；新记录通过 worktreeLayoutVersion=2 区分，不迁移旧目录。

- remote：clone 到实例持久目录，解析基准提交，建立独立工作分支。
- local：从已有本地 Git 仓库创建新 worktree，不切换源工作目录的分支，不修改源工作文件。Git 自身会更新共享仓库中的 worktree 元数据。
- Linux 独立用户：本地源先复制到该实例私有 Git 仓库，再建立工作树，避免不同 UID 共享可写 Git 元数据。

目录显示实际执行环境中的绝对路径，不是 Nexus 服务器上的同名目录。新 SSH 环境的默认目录与源 Git 仓库解耦：

```text
$HOME/.local/share/nexus/workspaces/<environment-id>/
  repo/                         环境仓库／工作树
  nexus-agent/<worktreeName>/    Agent 并行工作树
```

这里的 `$HOME` 由远端 SSH 用户解析，接口保存解析后的绝对路径。指定 `workRoot` 时它是持久父目录，每个新实例追加自己的 ID；旧配置中的 directory 可作为该父目录。`localRepository` 始终指源仓库，不能混同 Workspace 的输出目录。本地源的未提交文件不会自动带入新 worktree。

Linux 独立用户默认使用 `/var/lib/nexus/workspaces/<environment-id>/data/{repo,nexus-agent/<worktreeName>}`，home 位于相邻的 `home`。Docker／Kubernetes 默认使用容器内 `/workspace/<environment-id>/{repo,nexus-agent/<worktreeName>}`。容器本地源必须已在容器中可访问，不会自动挂载 SSH 主机上的同名路径。持久卷挂载覆盖 repo 与 Agent 工作树，不能只持久化工作树而丢失其 gitdir。旧版本使用 `<Agent 初始目录>/../.nexus-worktrees/<agent-id>`，旧实例不自动移动文件；没有 workRoot 的已有环境不移动源目录；SSH / Linux 在执行用户的 `$HOME/.local/share/nexus/workspaces/<environment-id>` 下创建工作树，容器 / Pod 使用 `/workspace/<environment-id>`，显式配置 workRoot 时使用其 `<environment-id>` 子目录。仅追加 Agent 工作树，不接管源仓库的生命周期。

## 四种运行预设与生命周期

| 预设 | 实际资源 | 前置条件 |
| --- | --- | --- |
| SSH + tmux | 既有 Unix 用户下的工作目录与 tmux session | SSH、git、tmux；已有 Agent 与认证 |
| Linux 独立用户 | 受管无特权用户、home、工作目录、会话 | 管理 SSH 连接、非交互 sudo、用户管理工具；Agent 不获得 sudo 凭据 |
| Docker | 经 SSH 控制的容器和持久 volume | Docker 主机、镜像、存储及凭据引用 |
| Kubernetes | API 或 SSH/kubectl 控制的 Pod 与 PVC | namespace、镜像、PVC 权限、exec、TLS；无常驻 Runner |

模板可运行能力检测；安装检测或 ACP 握手不代表模型认证成功。Nexus 必须能连到执行目标，Agent 也需要能访问上下文 URL。

Linux 独立用户由系统分配 UID，通过 `prlimit --nproc` 限制该 UID 的进程数，默认 256；当前不提供 CPU／内存配额或自定义 runUser，填写这些字段会拒绝创建。Docker 支持 CPU、内存、用户与进程数上限；Kubernetes 支持 CPU、内存和 UID/GID，进程数限制需由集群策略实现。SSH + tmux 不建立资源配额。Linux 持久父目录及祖先必须归 root 且不可被普通用户写入，管理连接需要非交互 sudo。

「停止运行」保留工作数据；Docker stop 容器，Pod 释放计算并保留 PVC，恢复时重建 Pod。SSH 停止受管 tmux；Linux 停止受管用户进程。恢复进程内存或模型会话取决于具体 Agent，不把重新创建环境说成完整会话恢复。

「归档」只收起环境记录。「销毁实例」和「删除工作数据」分开。删除数据核对归属并检查未提交／未推送修改；强制放弃数据是独立明确操作。关联的外部实例只解除关联，Nexus 不删除其资源和数据。

旧无卷 Docker 可停止并保留原容器；旧无 PVC Pod 不允许用停止操作隐式删除数据。Linux 用户记录 UID 与受管目录账本，不重用遗失用户的旧数据；不对任意已有账户执行 userdel -r。

tmux 和 worktree 是会话与工作目录组织，不是跨账号安全隔离。账号的模板、连接、实例和执行凭据相互隔离；远端还必须使用独立身份或适当容器／集群权限。

## 创建 Agent 的界面

顺序为 Workspace → 工作目录 → Agent → 可展开的初始 Prompt。Workspace 来源使用「从模板创建新 Workspace」「使用已有 Workspace」标签页；切换保留各自选择和填写内容。已有实例为空时展示空态并禁用提交，不能隐式创建新实例。工作目录在 Workspace 下方直接可见，「自动创建 Git worktree」与「使用自定义工作目录」为互斥单选；前者显示生成的名称、目录及分支，后者填写执行环境的绝对路径。关联已有 pane 则沿用该 pane 目录，不允许同时新建 worktree。服务端在任何创建副作用之前拒绝冲突字段或不安全名称；同一 Workspace 内已有名称返回冲突，不复用其他 Agent 的目录。

窗口只滚动内容区，标题及创建按钮固定，手机不横向溢出。选择其他模板／Workspace 仅影响本次创建，不自动改写 Task 默认值。

## Agent 产品、对话与终端

提供通用 ACP、自定义终端命令及常见 CLI 的启动预设，界面明确区分“预设”和“已验证安装／握手”。没有把未经实机验证的产品标成认证兼容。

ACP v1 展示文本、工具、计划与权限请求。Agent 需要自行提供远端文件和终端工具；Nexus 不向协议客户端承诺未提供的 fs/terminal 能力。对话使用可恢复游标的 SSE，必要时回退到增量读取。持久事件通过 agent-event 推进游标，agent-state 更新状态快照；浏览器传 after 或 Last-Event-ID 恢复。每账号最多 16 个订阅，全服务最多 128 个，失效的网页登录会话不能继续订阅。

tmux 支持启动新 CLI 或关联已有 pane。Nexus 消息作为文字送到指定 TUI，使用 tmux buffer/bracketed paste，保留中文与原始换行，粘贴结束后再发送 Enter。投递前及按 Enter 前核对 pane PID 和 tmux server PID；已有 Agent 退回 shell 时拒绝自动发送工作指令。投递成功只代表输入成功，不代表任务完成。

tmux Agent 工作台默认显示「终端会话」：xterm 持续显示同一 pane 的原生 TUI，屏幕重绘更新原位置，支持直接键盘交互；Esc 交给终端，不关闭工作台。「工作记录」显示 Nexus 消息、状态和报告，旧版本保存的整屏快照只展示最近一份，启动失败诊断保留。ACP 继续使用结构化对话。

各运行方式提供完整终端入口，打开时暂时移除内嵌终端，避免同页重复连接。浏览器通过一次性网页登录票据连接 `/api/workspace-terminal/attach` 指定环境／pane；关闭只 detach。尺寸稳定 750ms 后按需重新连接，远端会话保留。短暂网络中断按 2、4、8、16、30 秒退避重连，最多五次；连续连接 30 秒后重置次数。重连只附着原 pane，不重发 Prompt、不重新启动 CLI；身份／归属失效不自动重试。每账号最多 4 个终端连接，全服务最多 32 个，网页会话结束会断开终端。终端使用 WebSocket，结构化对话使用 SSE；直接终端交互不会自动生成结构化工具与验收状态。

后台不再定时抓取和持久化终端画面，仅每 30 秒检查 pane 存活和进程身份。SSH reset 等暂时检查失败按 60、120 秒退避，保留 Agent 执行凭据和状态；明确退出或身份变化时才标记断开。

已经就绪的 tmux Agent 跨 Nexus 服务重启保留状态与有效凭据，启动后先校验原 pane 身份，再恢复监测；不启动新 CLI、不重投已送达或状态不明的消息。恢复原 pane 复用有效的凭据文件，文件更新采用原子替换。停止 Agent、进程退出或身份变化仍撤销凭据；ACP 随传输关闭的原有撤销和显式恢复流程不变。执行凭据按有效请求续期，连续七天不使用后过期。默认 Prompt 和指南要求请求前读取凭据文件，401 时重新读取并以原请求 ID 重试一次，仍失败才提示恢复连接。

渲染依赖分工：原生终端采用 MIT 开源 xterm.js；Nexus 自行实现 tmux／SSH 桥接、账号权限、生命周期和工作记录。结构化聊天可评估 MIT 开源 assistant-ui，但需要先把 Agent 协议事件映射成消息、工具调用和审批状态；聊天组件不能直接把任意 TUI 输出可靠地转换为结构化会话。

## 每轮推进与验收

创建 Agent 不再要求用户选择阶段、填写本轮目标或验收表单。未显式传 round 时以 auto 记录轮次，由 Agent 根据 Task 现状、Prompt 和已有成果判断本轮工作；需求足够明确就直接推进，缺少影响范围或方案的关键信息时才提问。默认 Prompt 先读取实际 Task、祖先、子任务、资源、最新正文版本和当前轮次。正文中的推测与长期目标不能扩大本轮范围。下表供 Agent 判断时参考，不是要求用户依次填写的流程。

| 轮次参考 | 典型产物 |
| --- | --- |
| 澄清／设计 | 已确认需求、设计取舍、验收条件 |
| 探索 | 实验、证据、可行性与未决问题 |
| 实现 | 一段边界明确的改动、测试与说明 |
| 交付 | PR、验证结果、剩余事项 |

每轮记录目标、预期产物、验收条件及起始正文版本。用户提问后的回复仍属于当前轮；权限请求必须使用对应选项明确回应，普通文字不自动授予工具权限。

Agent 用带 roundId 的报告交付本轮。报告默认独立保存，不无限追加任务正文；显式 writeBack:true 才追加工作记录。用户可「验收本轮」「继续调整」或在验收后「完成任务」；验收不自动完成整个 Task。旧消息不在交付后自动重复执行。

「中止执行」取消当前调用和待发消息，保留当前轮次以便恢复续做。「放弃本轮」调用 `POST /api/agents/{id}/rounds/{roundId}/cancel`，取消执行和待发消息并设为 cancelled，保留代码、历史及 Task 状态；随后可明确开始新轮。消息本身不隐式创建新轮，已验收或已放弃的轮次不再接收普通追加指令。断线／停止的 Agent 先恢复连接，再开始新轮。

默认 Prompt 要求复杂任务经讨论确认后先通过正文 CAS 保留设计思路，再按最新说明执行。代码实现／交付轮次默认执行必要验证、提交、推送独立分支和创建／更新 PR，用户本轮限制优先，不自动合并 PR；纯讨论轮不扩大到代码实现。PR 由远端 Agent 使用已配置的 Git/GitHub 工具完成，Nexus 注入基准／目标分支并记录真实产物链接。Nexus 任务 Token 不等于 GitHub 凭据，缺少权限、安装或远端连接时应显示实际受阻，不能伪造交付成功。

## 正文与版本

正文保持自由编辑，支持 Markdown 阅读、段落折叠、标题目录、文内搜索、宽屏／手机阅读面板和阅读位置。历史版本提供作者／来源、时间、Agent／轮次、比较和恢复。恢复历史标题与正文生成新版本，不修改日期、状态或配置，不删后续历史。

浏览器连续输入在短暂停顿后合并为检查点；人工同步、REST 与 Agent 回写均记录。服务器保存正文与版本使用同一事务；正文 CAS 接口按 expectedRevisionId 检查冲突。未记录版本之前的历史无法凭空恢复；上线时保留当前正文作为基线。

## 本周工作与当前工作

「本周工作」是默认普通快捷视图：全局、动态本周、甘特图，允许编辑排序与移除。旧账号迁移不覆盖已有快捷视图；用户移除后不重复添加。旧任务 URL 仍能定位。

「当前工作」是跨项目／跨日期的 Agent 工作台，按 Task 去重，展示等我回复／授权、待验收、异常、正在推进。一个 Task 多个 Agent 时展示数量与最需处理状态，展开后才显示细节。Agent 空闲或消息已投递不产生待验收。

人工任务继续在本周、项目、自定义视图及“进行中／逾期”筛选中访问。旧 work=current 筛选更名为「推进与逾期」，保持原逻辑，不冒充 Agent 状态。

## 模板表单与实例边界

创建入口统一使用「创建 Workspace 模板」「创建 Workspace」。模板编辑按运行环境、Git 仓库、工作目录与存储排列，启动命令、资源与凭据放入折叠区。远程仓库地址、本地路径、来源策略、基准 ref、PR 目标在同一 Git 区域。

持久化工作根目录默认只读展示，点击铅笔进入编辑，支持恢复默认。SSH 默认使用执行用户的 `$HOME/.local/share/nexus/workspaces`，Linux 独立用户使用 `/var/lib/nexus/workspaces`，Docker／Pod 使用 `/workspace`；实例继续在根目录下按 ID 隔离。旧配置的显式根目录／目录按实际后端规则展示和保留。

Prompt 仅在 Agent 创建表单编辑，切换 Workspace 或模板不改变已生成或编辑的指令。服务端未收到 prompt 时使用 Nexus 的默认任务指令。历史 `promptTemplate` 数据保留，API 标记为 deprecated，不再作为新 Agent 的默认 Prompt。已创建 Agent 的 Prompt 和会话不改写。

模板不预选 tmux 会话。复用实例时，用户在实例或 Agent 的关联已有 pane 入口选择实际目标；新建 Workspace 自动创建自己的 tmux 会话。

## 公网 HTTP 兼容性

UUID 请求键与实例命名统一使用核心 newUuid：支持原生 randomUUID 时直接使用，否则用 HTTP 下仍可用的 crypto.getRandomValues 生成 UUID v4。创建表单渲染、模板保存、环境关联、Agent 消息和工作轮次均使用同一实现；重试保留原请求键。回归需使用真实非 localhost HTTP 地址，避免 localhost 的安全上下文特例掩盖线上问题。

## 集群管理与路径预览

个人设置在 SSH 服务器之后提供「Kubernetes 集群」，支持添加、编辑和确认删除连接，配置 HTTPS API Server、Namespace、CA 与 Token 或客户端证书。模板显式选择连接时带入该连接的 Namespace，允许随后覆盖；重新打开已有模板不会覆盖已保存的 Namespace。实例依配置在该 Namespace 创建 Pod 和必要的 PVC；继续支持 SSH/kubectl。凭据只在服务端加密保存，编辑时留空保留，不进入任务同步或导出。

Agent 创建表单显示「路径：实际完整路径」和分支名。已有 Workspace 优先使用实际 workRoot，新实例用只读 preview 接口解析根目录；默认 SSH 根目录需连接远端读取 HOME。preview 与 workspace-launch 使用相同 requestId，确保预览中的 environment-id 与实际分配一致；内容变化生成新 requestId，重试不重复创建。读取期间或失败时显示真实状态，不用“Workspace 根目录”冒充完整路径。预览不会创建目录、Pod、容器、Workspace 或 Agent。

## 启动失败和重试反馈

tmux Agent 的窗口先设置归属与退出保留，再运行启动命令。启动失败显示实际退出码及终端错误，保留失败 pane；用户点击「重试失败步骤」时，仅在 pane 归属及进程身份匹配后重建，不影响同一 Workspace 的其他会话。Workspace 不可用时带出具体环境错误。NVM 安装的命令可使用执行用户已有的默认 Node 环境，不要求用户修改全局 shell 配置。

## 多 Harness 对话接入方向（2026-11-26，历史方案）

以下记录早期选型背景，后续实现与产品选择以 [Agent 系统设计](../architecture/AGENT_SYSTEM_DESIGN.md) 第 5 节为准。尤其不能将某个 DSH ACP 入口的支持等同于完整流式、工具、审批和恢复能力；各版本需实测。

目标：默认展示结构化对话、流式回复、工具卡片与审批；完整终端是可单独打开的辅助视图。
当前 tmux 集成的连续终端与工作记录不等于完整的原生 Codex 对话历史。

推荐分层：assistant-ui 等聊天组件 → Nexus 按账号鉴权的会话／事件接口 → ACP 或原生协议适配器 → 远端 Harness。
前端不直接连接 SSH／stdio，不保存模型或 Nexus 执行凭据。Nexus 负责持久事件、游标、重连、审批归属和能力协商。
ACP 是 Agent Client Protocol，不是聊天 UI；AG-UI 是另一种面向应用交互的事件协议，二者不能直接互换。

- Codex：[codex-acp](https://github.com/agentclientprotocol/codex-acp) 将 ACP 转为 Codex App Server；若要求完整原生能力，可单独使用官方 app-server 适配器。
- Claude Code：[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) 基于 Claude Agent SDK；不是解析任意 tmux TUI 文本。
- DeepSeek Harness：[官方 ACP profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md) 使用 `dsh --profile acp`。其 resume 不回放历史，Nexus 需要自行保存事件。

各 Harness 的历史、模型选项、权限和扩展不同，应在 UI 中按协商能力显示，不承诺统一协议覆盖全部原生功能。
[Codex 官方平台说明](https://developers.openai.com/blog/codex-as-a-platform)明确 CLI、App Server、SDK 开源；模型与托管服务的使用授权仍单独计算。
[CopilotKit Shared State](https://docs.copilotkit.ai/shared-state) 适合应用与 Agent 双向共享明确的业务状态，例如选中任务、计划或工作进度；
需要显式接入和授权，不是自动读取整个页面或绕过后端权限。单纯多 Harness 对话不必因此引入整套应用状态框架。
