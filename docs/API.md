# Agent REST API

本文面向 Nexus 用户、API 客户端开发者和 Agent 调用方，说明如何认证、调用接口与处理错误。
Workspace 会话新增的执行凭据与回报接口见本文末尾「Workspace 与 Agent 接口」，它与通用业务 Token 分别授权。
需要让 Agent 直接执行工作管理操作时，使用配套的 [nexus-api Skill](skills/nexus-api/SKILL.md)：
它提供目标定位、分页查询、最小字段更新、打卡／复盘流程及重试规则。Skill 目录可独立复制给支持
`SKILL.md` 的 Agent 加载；示例请求：「使用 nexus-api，列出 Serve 项目所有进行中的任务」。

也可直接把[公开的 Agent 使用指南](http://115.190.3.4:30090/api/guide.md)交给 Agent，无需复制文件或安装 Skill。
[SKILL.md 下载地址](http://115.190.3.4:30090/api/skill.md)与指南使用同一份源文档，随服务构建发布。
配置好 `NEXUS_TOKEN`（兼容 `CORTEX_TOKEN`）后，只需给 Agent 这样的 Prompt：

> 请阅读 http://115.190.3.4:30090/api/guide.md，按指南连接这个实例，帮我列出 Serve 项目所有进行中的任务。使用已配置的 API Token；缺少时提示我配置。

指南以其 URL 的来源确定目标服务，并引导 Agent 读取同源 OpenAPI；文档可匿名访问，业务数据仍需 Token。

Swagger：[在线交互文档](http://115.190.3.4:30090/api/docs)。机器可读的 OpenAPI 3.0 文档：
[openapi.json](http://115.190.3.4:30090/api/openapi.json)。Swagger 的 JS/CSS 随服务部署，不依赖外部 CDN。

API 基址为 `http://115.190.3.4:30090/api/v1`。如果使用自己的 Nexus 实例，替换来源地址，
保留 `/api/v1`、`/api/docs` 和 `/api/openapi.json` 路径。

在应用「设置 → Agent API」创建独立 Token，选择只读或读写及有效期。Token 只显示一次，
服务端仅保存 SHA-256 摘要；可随时撤销。每个账号最多 50 个 Token。
Token 只能访问所属账号的下述业务数据，不授予账号管理、备份、SSH 或 tmux 权限。
Token 管理使用现有登录 Cookie：`GET/POST /api/tokens`、`DELETE /api/tokens/:id`；
Agent Token 不能给自己创建新 Token。Token 不包含在任务 JSON 备份中。

```bash
export NEXUS_URL='http://115.190.3.4:30090'
# 从安全存储载入 NEXUS_TOKEN，不要提交到仓库或放进 URL。
curl "$NEXUS_URL/api/v1/projects" -H "Authorization: Bearer $NEXUS_TOKEN"
curl "$NEXUS_URL/api/v1/tasks?status=doing&limit=100" -H "Authorization: Bearer $NEXUS_TOKEN"
curl "$NEXUS_URL/api/v1/tasks" \
  -H "Authorization: Bearer $NEXUS_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-create-task-001' \
  -d '{"title":"整理本周计划","status":"todo","parentId":"PROJECT_ID"}'
```

公网入口目前为 HTTP；需要在不受信网络传送 Token 时，应通过部署者配置的 HTTPS/VPN 访问。

## 接口范围

| 资源 | 接口 |
| --- | --- |
| 任务 | `GET/POST /api/v1/tasks`；`GET/PATCH/DELETE /api/v1/tasks/:id`；`POST /api/v1/tasks/:id/restore` |
| 项目 | `GET/POST /api/v1/projects`；`GET/PATCH/DELETE /api/v1/projects/:id`；`POST /api/v1/projects/:id/restore` |
| 习惯 | `GET/POST /api/v1/habits`；`GET/PATCH/DELETE /api/v1/habits/:id`；`POST /api/v1/habits/:id/restore` |
| 打卡 | `GET/POST /api/v1/habits/:id/check-ins` |
| 日报/周报 | `GET /api/v1/reviews`；`GET/PUT/PATCH/DELETE /api/v1/reviews/:id`；`POST /api/v1/reviews/:id/complete` |

写入返回成功前已持久化到 SQLite，并推送到在线浏览器的同一 Yjs 文档；离线客户端下次同步合并。
读取也使用在线同步房间的最新状态。PATCH 只更新指定字段，不接受 `ownerId`、`id`、
创建时间等服务端字段；未知字段直接返回 400。父任务必须存在于同一账号，禁止形成层级循环。

列表返回 `{data: [...], total, offset, limit}`，默认 100 条，最多 500 条；分页使用 offset。
项目/任务支持 `q`、`status`，任务还支持 `projectId`（项目下全部层级），复盘支持 `kind=daily|weekly`。
任务、项目和习惯默认排除软删除数据，可用 `includeDeleted=true` 查询。单对象返回 `{data: {...}}`。

数据节点分为 TODO 任务（`kind=todo`）和文本节点（`kind=node`），均通过 `/tasks` 读写。文本节点可作为叶子记录标题、正文和标签，也可包含子节点。项目使用 `/projects` 创建，保持独立的项目根身份。
创建文本节点未指定状态时默认 `todo`，用于进入常规内容工作区。创建 TODO 任务时，有父节点默认 `todo`，顶层默认 `inbox`。文本节点转换与创建会显式记录 `project=false`。更改 TODO 状态沿用网页的完成时间规则。
删除任务/项目会连同子树软删除，恢复沿用回收站规则。习惯删除保留打卡记录，可恢复。
**复盘没有回收站，DELETE 会删除该份复盘正文和汇总快照**；任务与独立备份不受影响。

习惯 `reminderTimes` 为不重复的 `HH:mm` 数组，可设置多个时间；空数组清除，兼容旧的
`reminderAt`，两者不能同时提交。打卡请求 `{date: "2026-11-04", delta: 1}`；date 必须
明确提供调用方本地日期，负 delta 撤销次数。每次不超过每日目标三倍或 10000，不直接覆盖累计值。
提醒仍由已打开的应用执行，REST 设置时间不会产生网页关闭后的后台推送。

复盘 ID：`daily_2026-11-04` 或 `weekly_2026-11-02`，日期为周期首日。
PUT 创建或更新草稿，PATCH 只修改现有草稿。正文属性为 highlights、plan、friction、resolution、nextSteps。
highlights 保存实际进展，plan 保存推进计划。完成后的 facts 中，completed 按实际完成时间统计，
planned 保存本期排期任务及 done 标记，pending 保存截至当天尚未完成的本期及更早任务。
进行中的周报保留整周计划，pending 以调用方时区的今天为截止日。旧快照可能没有 planned。
修改正文会将已完成复盘恢复成草稿。完成复盘需传 `{timeZone: "Asia/Shanghai"}`，
服务端据此计算汇总的日期边界，支持夏令时；避免使用服务端 UTC 时区误计当天任务。

## 重试、并发与错误

新增、打卡等写入建议提供 `Idempotency-Key`。同账号相同键、路径与请求体在 24 小时内重放原响应，
响应含 `Idempotency-Replayed: true`；不同请求复用同键返回 409。每账号最多保留 1000 个幂等记录。
JSON 属性顺序应保持一致。幂等记录与业务数据在同一数据库事务中提交。

单对象响应含 ETag。修改、删除或恢复时可将其放入 `If-Match`，版本不一致返回 412；
重新读取后再决定如何更新。没有 If-Match 时，指定字段按最后写入及 Yjs 合并规则处理。
Token 撤销/过期后，幂等重放也会被拒绝。

常规业务接口每账号所有 Token 合计每分钟最多 240 次请求；请求体最多 64 KiB。正文／版本接口单独限流为每账号每分钟 180 次，`/description` 请求体上限为 512 KiB。
错误返回 `{error: "说明"}`，状态码见 Swagger；401 为认证失败、403 为只读权限或 Origin 不受信任、
404 为当前账号无此对象、409 为幂等或账号冲突、412 为版本冲突、429 为限流。
跨账号请求返回 404，不透露对象是否属于别人。不得将 API Token 用作同步 WebSocket 的会话票据。

## Workspace 执行接口

Swagger 的 Workspace 分组使用浏览器登录的 `cortex_session` Cookie，沿用 Origin 检查，支持 `X-Cortex-User` 检测账号切换。节点配置在网页详情中保存并通过 CRDT 同步。连接与执行权限来自当前账号的 SSH 或 Kubernetes 连接配置。

| 操作 | 路径 |
| --- | --- |
| 有效配置、环境、最近指令 | `GET /api/workspaces/:id` |
| 查找已有 tmux／Docker／Pod | `POST /api/workspaces/:id/discover` |
| 创建或复用环境 | `POST /api/workspaces/:id/environments` |
| 投递到已有 pane | `POST /api/workspaces/:id/instructions` |
| 实例状态及配置快照 | `GET /api/workspace-environments/:id` |
| 列出 pane | `GET /api/workspace-environments/:id/panes` |
| 最近 200 行输出 | `GET /api/workspace-environments/:id/output?pane=%251` |
| 检查现场／重新准备 | `POST /api/workspace-environments/:id/check`、`POST /api/workspace-environments/:id/retry` |
| 结束托管实例或解除已有环境关联 | `DELETE /api/workspace-environments/:id` |

创建请求使用 `{requestId, config?, resourceId?}`。省略 config 时采用节点有效配置，提供 config 时需要完整字段。提供 resourceId 时复用已有资源，SSH 的值为 session 名，Docker 为容器 ID，Kubernetes 为 Pod 名称。创建新环境返回异步状态，轮询实例接口查看准备结果。

投递请求使用 `{requestId, environmentId, pane, text, submit?, terminalInput?}`，pane 使用列举接口返回的对象。文本最多 32000 UTF-8 字节。默认 submit 和 terminalInput 均为 false。服务端先核对 pane PID 与 tmux server PID，再按字面粘贴文本。submit=true 会额外按 Enter，terminalInput=true 允许向 Shell 输入。

requestId 为 1–128 位字母、数字、下划线或连字符，相同逻辑操作的重试复用原 ID 与请求体。幂等记录随服务端数据保留。「已投递」表示 tmux 接收成功，Agent 执行进度通过目标输出查看。发生投递中断时记录 unknown，需要核对现场后决定是否另建发送请求。

所有成功响应为 `{data: ...}`。列表界面读取最多 500 个近期环境、从账号近期 500 条指令中提取当前节点最多 100 条，较早绑定可直接按环境 ID 读取。每账号最多 10 个待准备环境和 50 条待投递指令，接口限流为每分钟 120 次。运行依赖和使用流程见 [Workspace 设计](ui-design/WORKSPACE_DESIGN.md)。

## Workspace 与 Agent 接口

以下控制接口使用 `browserSession`，业务 Token 不授予执行权限。普通 JSON 响应外层为 `{data: ...}`，SSE 与终端 WebSocket 使用各自帧格式；完整字段以 [OpenAPI](/api/openapi.json) 为准。

| 用途 | 接口 |
| --- | --- |
| 可复用命名配置 | `GET/POST /api/workspace-profiles`，`GET/PATCH/DELETE /api/workspace-profiles/{id}` |
| 创建环境及默认 Agent | `POST /api/tasks/{taskId}/workspace-launch` |
| 生成当前任务 Prompt 草稿 | `GET /api/tasks/{taskId}/agent-prompt` |
| 列出／添加任务 Agent | `GET/POST /api/tasks/{taskId}/agents` |
| Agent 状态与增量事件 | `GET /api/agents/{id}`，`GET /api/agents/{id}/events?after=0` |
| 发送消息 | `POST /api/agents/{id}/messages`，`{requestId,text}` |
| 中止当前执行／停止 Agent／重试 | `POST /api/agents/{id}/cancel`、`/stop`、`/retry`；中止执行保留当前轮次 |
| 恢复会话 | `POST /api/agents/{id}/resume`，`{newSession:false}`；明确新开时为 true |
| 回应工具权限请求 | `POST /api/agents/{id}/permissions`，`{permissionId,optionId}`；null 表示拒绝 |
| Kubernetes 直连配置 | `GET/POST /api/kubernetes-connections`，`PUT/DELETE /api/kubernetes-connections/{id}` |

组合创建传入 `{requestId,config,name?,workspaceId?,resourceId?,agent?}`。`agent` 提供 name、mode（codex、claude、acp，及兼容旧记录的 tmux）、command、可选的 prompt、workspaceId、directory、worktree、worktreeName、productId 和 round。已有 pane 可用 pane 对象关联；productId 必须与 mode 匹配，round 使用下文的轮次字段；省略时创建 kind=auto 的轮次，让 Agent 根据 Task 和 Prompt 自主判断本轮工作。name 是创建前展示的实例名称，workspaceId 是所采用的模板 ID；省略 agent 仅创建环境。「创建 Workspace」默认勾选同时创建 Agent，「创建 Agent」入口总会启动会话。worktree=true 与非空 directory 互斥，worktreeName 仅允许 1–80 位字母、数字、短横线或下划线，当前环境中重复名称返回 409。创建意图持久化，环境准备后自动启动 Agent。相同内容和请求 ID 可恢复失败步骤，不会重复创建已保存的环境或 Agent。

命名配置包含 name、config。历史 promptTemplate 字段仍可读写，但已废弃，不再参与新 Agent 的默认指令；请在创建 Agent 时传入 prompt，省略则使用 Nexus 默认任务指令。PATCH 中的 config 是完整配置替换；未提供 config 时保留原配置。提供 expectedUpdatedAt 可拒绝并发覆盖。档案创建 requestId 使用 24 小时业务幂等记录，Agent、消息、报告与组合创建的幂等记录随服务端数据保留。删除仍被活动节点引用的档案会被拒绝。

事件接口返回 `{events,nextCursor,hasMore}`，每页最多 200 条，使用返回的 nextCursor 继续。会话的工具调用、计划、报告及权限均以事件形式保存。服务重启或连接中断时，发送结果未知的消息不会自动重放。

Workspace Agent 的专用执行凭据使用 `agentBearer`（`nxa_` 前缀）。凭据由环境变量或受限文件提供，按有效请求续期，连续七天不使用后过期。已经就绪的 tmux 会话跨 Nexus 重启保留凭据，恢复原 pane 复用有效凭据；停止、确认进程退出或身份变化时撤销。新建结构化 Agent 默认使用持久宿主，Nexus 断线／更新保留仍有效的执行凭据；显式 `persistentSession:false` 的旧式直连在断开后撤销并显式恢复。配置了凭据文件时每次请求前读取文件；遇到 401，重新读取并以相同请求 ID 重试一次，仍失败才请求恢复连接。仅允许以下绑定 Agent 的回调接口。

| 用途 | 接口 |
| --- | --- |
| 最新任务、正文版本、本轮目标、祖先／子任务／资源与接口地址 | `GET /api/agent-context/{id}?taskId=实际任务ID` |
| 未确认工作消息 | `GET /api/agent-context/{id}/messages` |
| 确认消息 | `POST /api/agent-context/{id}/messages/ack`，`{messageIds:[...]}` |
| 回报进展 | `POST /api/agent-context/{id}/events`，`{requestId,kind,text}` |
| 工作报告 | `POST /api/agent-context/{id}/reports`，`{requestId,roundId,summary,verification,remaining,artifacts,suggestions?,writeBack?}` |
| 修改绑定任务正文 | `PATCH /api/agent-context/{id}/description`，`{expectedRevisionId,notes}` |

上下文给出 messagesUrl、acknowledgeUrl、eventsUrl、reportUrl、descriptionUrl 和 taskUrl，以及 revision、currentRound、历史报告和实际仓库分支。报告持久化并进入本轮待验收，默认不追加正文。显式 writeBack:true 才追加；正文更新使用带 expectedRevisionId 的 description 接口，不自动完成整个任务。逐 Agent 确认消息、回报幂等和账号归属检查均由服务端执行。公开指南已有这一调用流程，可直接提供 [指南 URL](/api/guide.md)。


## Workspace、轮次和正文版本（2026-11-24）

Task 的 `title` 仍为普通字符串，支持保存 `[显示文字](https://example.com)` 或直接 URL。网页在标题展示时渲染安全链接，编辑与 API 响应保留原始语法，不请求目标网站获取标题。节点的默认模板 `workspaceId` 与默认实例 `environmentId` 分别按父链继承；字段缺省表示继承，`null` 表示显式不绑定，具体 ID 表示本节点覆盖。切换模板不会重置默认实例。

用户界面将旧 workspace-profiles 称为“Workspace 模板”，workspace-environments 称为“Workspace”。URL 保持兼容。

| 操作 | 接口 |
| --- | --- |
| 全局Workspace | GET `/api/workspace-environments` |
| 主机能力检测 | POST `/api/workspaces/{id}/capabilities`，`{config?}` |
| 停止运行／恢复 | POST `/api/workspace-environments/{id}/stop`、`/resume` |
| 归档／取消归档 | POST `/api/workspace-environments/{id}/archive`，`{archived}` |
| 检查未提交／未推送数据 | GET `/api/workspace-environments/{id}/git` |
| 单独删除工作数据 | DELETE `/api/workspace-environments/{id}/data`，`{confirm:true,force?:boolean}` |
| 产品启动预设／连接检测 | GET `/api/agent-products`、POST `/api/agents/check` |
| 当前工作台 | GET `/api/agent-workbench`，按任务去重并返回四组状态 |
| 历次轮次／开始新轮 | GET/POST `/api/agents/{id}/rounds` |
| 验收／调整／完成任务 | POST `/api/agents/{id}/rounds/{roundId}/review` |
| 放弃本轮并保留产物 | POST `/api/agents/{id}/rounds/{roundId}/cancel`，`{requestId,text?}` |
| SSE 事件流 | GET `/api/agents/{id}/stream?after=事件游标` |
| Agent 修改绑定任务正文 | PATCH `/api/agent-context/{id}/description` |

Workspace与 Agent 控制接口使用 browserSession，正文回调使用 agentBearer。配置字段包含 repository、localRepository、source(auto/local/remote)、ref(基准分支或版本)、branch(独立分支)、prTarget、workRoot、storage、volumeName、storageClass、storageSize。source=auto 优先已配置本地仓库；不会在本地路径失效时悄悄切到远程。远程和本地来源可同时保存，使用本地来源时会检查 origin 与远程配置的一致性。本地路径是执行目标中的仓库路径；容器不会自动挂载主机上的同名目录。源仓库的工作文件与分支不因创建Workspace而改变。

新建 SSH 环境默认写入远端登录用户的 `$HOME/.local/share/nexus/workspaces/<environment-id>/repo`；并行 Agent 工作树位于同一实例根下的 `nexus-agent/<worktreeName>`（未指定名称时用 agent-id），与源仓库目录解耦。自定义 `workRoot` 是持久父目录，实例会追加自己的 ID；兼容旧配置的 directory 也可作为该父目录。Linux 独立用户默认实例根是 `/var/lib/nexus/workspaces/<environment-id>/data`，home 位于相邻的 `home`；Docker／Kubernetes 默认是容器内 `/workspace/<environment-id>`。接口返回实际解析后的绝对 workRoot 和 directory。

linux-user 创建受管无特权 Unix 用户，通过非交互 sudo 管理生命周期，Agent 不获得管理连接的 sudo 身份。当前只实施 `pidsLimit`（默认 256，按独立 UID 的进程数约束），不提供 CPU／内存配额；填写 cpuLimit、memoryLimit 或 runUser 会拒绝创建。Docker 支持 CPU、内存、进程数和用户；Kubernetes 支持 CPU／内存与运行 UID/GID，pidsLimit 不映射为 Pod 配额。SSH + tmux 本身没有这些隔离与配额。存储、集群和镜像仍需相应平台权限。

开始新轮输入为 `{requestId,kind,objective,expectedOutcome,acceptanceCriteria,text?}`，kind 是 auto/clarify/design/explore/implement/deliver。普通消息直接继续对话；前一轮 accepted/cancelled/failed 时，发送消息会原子建立后续轮次并保留历史，无需额外调用 rounds。显式 rounds API 继续兼容，要求先结束前一轮。报告携带上下文 currentRound.id 作为 roundId；默认独立存储、等待验收。review 输入为 `{requestId,action,text?}`：accept 只验收本轮，revise 需要调整说明，complete_task 仅在本轮已验收后明确完成整个 Task。放弃本轮先取消当前执行与待发消息，再设为 cancelled，保留代码、历史和 Task 状态。停止或断线的 Agent 需要先恢复连接。

SSE 返回 `agent-event`（持久化事件，id 为游标）、`agent-state`（Agent／当前轮次快照）和 `ping`。使用 `after` 或 `Last-Event-ID` 恢复，存在两者时优先后者；`agent-state` 不推进游标。每账号最多 16 个 SSE 订阅，全服务最多 128 个；重连应先关闭旧连接。流与增量事件接口均校验账号，网页登录失效后断开。普通回复可解除等待用户状态，但不能替代 ACP 工具授权。

内嵌／完整终端使用网页登录身份向 `/api/auth/ticket?purpose=workspace-terminal&userId=...` 取得一次性票据，再连接 WebSocket `/api/workspace-terminal/attach?ticket=...&environmentId=...&pane=%251&cols=120&rows=36`。5 秒内发送 `{type:"start"}`，等待 `{type:"ready"}`；之后发送键盘文本／二进制，输出为连续的二进制终端数据，结束为 `{type:"exit",reason,retryable}`。`retryable: true` 表示暂时传输故障，可重新取得一次性票据并附着同一 pane；不可因此重投消息或重新启动 Agent。每账号最多 4 个连接，全服务最多 32 个；每帧最多 64 KiB。尺寸变化需重新连接，关闭连接只 detach，不销毁环境或 pane；登录失效会断开。这与用于结构化事件的 SSE 是两条独立通道，终端键盘输入不会自动成为工作轮次或报告。常规终端屏幕刷新不再写入 Agent 事件，历史快照和退出诊断仍可读取。

任务和项目均支持以下业务接口（`/api/v1/tasks` 或 `/api/v1/projects`，使用原 ctx_ Token）：

| 操作 | 路径 |
| --- | --- |
| 最新正文与版本 | GET `/{id}/description` |
| 按版本修改正文 | PATCH `/{id}/description`，`{expectedRevisionId,notes}` |
| 版本列表 | GET `/{id}/revisions?offset=0`，每页50条 |
| 版本全文 | GET `/{id}/revisions/{revisionId}` |
| 恢复标题和正文 | POST `/{id}/revisions/{revisionId}/restore`，`{expectedRevisionId}` |

版本列表返回 `{data:{revisions,total,currentRevisionId}}`，列表不包含 notes，全文需要单独读取。版本保存来源、作者、Agent／轮次和时间。恢复发生内容变化时生成新版本，保留其后的历史；不会恢复状态、日期或Workspace。正文更新与恢复使用 expectedRevisionId，冲突返回409；这些接口不使用常规业务接口的 ETag／If-Match 或 Idempotency-Key 回放。网络中断后先重读当前正文与版本核对结果，再决定是否提交合并后的内容。正文接口请求体最多512KiB，notes最多100000字符；其他接口保持64KiB。


Workspace 模板创建接口支持可选 `taskId`，归属必须是当前账号的有效节点；省略为账号共享模板。一个 Task 可以拥有多个模板，归属字段随备份与同步保留。创建候选按当前节点、父节点直至项目根聚合；已有 `workspaceId` / `environmentId` 默认绑定只影响优先选择，不表示只能使用一个模板或实例。Workspace 实例返回可选 `workspaceId` 记录创建模板。

Workspace 表单中的 PR 目标为空表示动态跟随 `config.ref`；均为空时由仓库默认分支推导。`config.workRoot` 留空使用运行方式的默认根目录，SSH 在执行用户 HOME 下、Linux 独立用户在 `/var/lib/nexus/workspaces`、容器在 `/workspace`，已有显式目录保留兼容。`config.branch` 用于具体 Workspace 创建请求，UI 不在模板中配置固定分支；Agent 的独立 worktree 分支继续由 `worktreeName` 派生。


工作目录预览：`POST /api/workspaces/{taskId}/preview`，网页登录鉴权和 Origin 检查。新建实例传 `{requestId,config,worktreeName}`，使用与后续 `workspace-launch` 完全相同的 requestId；已有实例传 `{environmentId,worktreeName}`。返回 `{data:{environmentId,workRoot,directory,branch}}`。该接口只读，不保存实例、不创建目录或计算资源；SSH 默认根目录通过连接远端只读解析 HOME。名称校验与创建相同，实例及 Task 必须属于当前账号。

新 Agent 工作树目录是 `<workRoot>/nexus-agent/<worktreeName或agent-id>`，分支 `nexus-agent/<worktreeName或agent-id>`，记录 `worktreeLayoutVersion:2`；无版本的旧 Agent 沿用原有 worktrees 或 .nexus-worktrees 目录和旧分支，重试不迁移。Workspace 未指定实例 branch 时默认 `nexus-agent/workspace-<environment-id>`，已存在的 branch 保留。创建 Agent 的 round 可省略；auto 仅表示由 Agent 自主判断，不强制先澄清或依次执行所有阶段，显式 round 继续兼容。

Kubernetes 集群可在个人设置的 SSH 服务器下方管理。模板选择集群时带入该连接 Namespace，也可显式覆盖。接口 config.namespace 为空时采用连接 Namespace；已保存的非空 Namespace 优先。创建的 workload 为 Pod，持久存储模式按配置创建或复用同 Namespace 的 PVC。

## 浏览器多账号登录

这些接口在 Swagger 的「账号」分组，供 Nexus 登录界面使用；Agent 的 Bearer Token 不能授权账号切换。
`cortex_session` 表示当前账号；`nexus_accounts` 是本浏览器保存登录的 HttpOnly 凭据，仅授权管理／切换已验证身份，不能直接访问任务。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/auth/login` | `{username,password}`，登录并保存身份 |
| POST | `/api/auth/register` | `{username,password,inviteCode?}`，注册并登录 |
| GET | `/api/auth/me` | 当前 `{id,username,isAdmin}`，未登录 401 |
| GET | `/api/auth/accounts` | `{accounts:[{id,username,isAdmin}]}`，无登录返回空数组 |
| POST | `/api/auth/switch` | `{userId}`，仅允许已在本浏览器验证且未过期的身份 |
| DELETE | `/api/auth/accounts/:id` | 退出非当前账号，保留账号与数据 |
| POST | `/api/auth/logout` | 退出当前账号并移除其免密切换资格 |
| POST | `/api/auth/logout-all` | 退出本浏览器所有账号，不影响其他设备 |

遵循现有 Origin 校验；客户端附 `X-Cortex-User` 检测过期页面，身份不符返回 409。
每个保存登录自密码验证起有效 180 天，切换不延长该账号授权期限；最多 10 个账号。
切换生成新活动会话，撤销此浏览器的旧活动会话和票据，关闭旧同步／终端连接。
同浏览器标签页跟随当前身份；不同浏览器／设备独立。账号退出不停止后台 Agent，不撤销 Agent 专用 Token。


## 结构化 Agent 与工作台（2026-11-27）

新建 Agent 默认 `mode=codex`、`command="codex app-server"`；Claude 使用 `mode=claude` 和执行侧 Agent SDK，ACP 使用 `mode=acp` 与实际适配器命令。`productId` 与 mode 必须匹配。创建时支持 `providerId`、`model`、`terminalPolicy`（on-demand/create/disabled）、`persistentSession`（默认 true）。`worktree=true`、`isolatedDirectory=true` 与非空自定义 `directory` 互斥；普通独立目录也使用 `worktreeName` 作为目录名称，以兼容已有预览接口。

`environmentId` 是 Workspace 实例，历史字段 `workspaceId` 是模板 ID，不可混用。新 UI 创建的 Workspace 配置快照带 `terminalPolicy=on-demand`，因此无需 tmux 即可准备原生 Agent 环境。模板不存 Prompt 或固定 Agent 分支。

下列控制 API 均使用浏览器登录身份；`ctx_` 业务 Token 与 `nxa_` 执行 Token 均不能访问它们。公开说明不授予执行权限。

| 操作 | URL 与请求 |
| --- | --- |
| 当前账号所有会话 | `GET /api/agents` |
| 稳定对话快照 | `GET /api/agents/{id}/conversation?before=序号`；返回 items、sequence、before、hasMore、最近 runs/messages；每页 100 项 |
| 实时增量 | `GET /api/agents/{id}/stream?after=sequence`；快照后只接收更大序号。旧游标 409 时重取快照 |
| 编辑／取消队列 | `PATCH /api/agents/{id}/messages/{messageId}`，`{text}` 或 `{cancel:true}`；仅 queued 可改 |
| 核对未知投递 | `POST /api/agents/{id}/runs/{runId}/reconcile`，`{resolution:"completed"或"cancelled"}`；必须先检查远端结果，不重发消息 |
| 回答结构化问题 | `POST /api/agents/{id}/answers`，`{permissionId,answers:{问题ID:"回答"}}`；重复同一回答幂等 |
| 终端 | `POST /api/agents/{id}/terminal`，`{}` 复用，`{requestId}` 幂等新建额外终端；返回 pane 后按已有 ticket/WebSocket 流程连接 |
| 结束人工终端 | `DELETE /api/agents/{id}/terminals/{paneId}`；核对进程身份及归属，不停止 Agent；关闭面板无需调用 |
| 工作目录变更 | `GET /api/agents/{id}/changes`；Git status 与 HEAD diff（含已暂存修改），标明时间及截断；不是任意文件读取接口 |
| Provider 配置 | `GET/POST /api/agent-providers`、`PUT/DELETE /api/agent-providers/{id}`；name、harness、command、model、configDirectory；不传递模型秘密 |
| 可用 Workspace 关联 | `GET /api/tasks/{taskId}/workspace-bindings`；当前及祖先关联，返回来源和实例 |
| 建立／解除关联 | `POST /api/tasks/{taskId}/workspace-bindings`，`{environmentId,inherit:true}` 或 `{environmentId,remove:true}`；解除不销毁资源 |
| 独立工作目录清理预览 | `GET /api/agents/{id}/workarea/cleanup-plan`；列出共享引用、终端、产物及未提交／未推送状态 |
| 清理独立工作目录 | `DELETE /api/agents/{id}/workarea`，`{confirmDirectory}` 必须与完整路径一致；仅已结束、无活动终端且数据已保存的受管目录，保留 Git 分支、报告与对话 |
| 销毁影响预览 | `GET /api/workspace-environments/{id}/cleanup-plan`；列出任务、Agent、Git 检查及持久存储，检查失败也明确返回 |

消息按稳定 messageId、工具按 toolCallId、审批按 permissionId 更新原项，不能把每个增量当成独立消息。连接、Run、Round 与 Task 状态分别处理：一次 turn 结束不自动验收 Round，也不完成 Task。未知投递不得换 requestId 自动重发；先核对再明确继续。没有确认停止的远端宿主会阻止销毁其 Workspace。

模型安装、登录与协议能力以目标环境为准；当前不暴露原生 TUI 接管、steering、fork/rollback 或已有会话原位模型切换，见 [实现记录](architecture/AGENT_IMPLEMENTATION.md)。

### 旧 tmux Agent 的历史显示

`GET /api/agents/{id}/conversation` 对可读内容分页，内部连接状态不占用分页名额；消息送达状态仍更新原用户消息，事件流 sequence 仍覆盖全部事件。tmux 模式仅在可读时间线显示最近一份终端快照，历史原始事件不删除。

旧终端 Agent 没有采集的结构化回复不会因更新自动出现。无需重新创建原 Agent 即可继续使用原终端；新建的原生 Agent 才通过其协议提供结构化对话。恢复原生历史或交接为结构化会话是另一项操作，不能假装已自动发生。


### 连续对话、下一步建议与澄清问题

Agent 上下文包含 `interactionGuide` 和最近 10 组 REST `questions`。Agent 应先读取任务正文、祖先背景和最新消息，不能只凭标题推测需求。目标不明时先提出关键问题，再做依赖这些答案的工作。

`POST /api/agent-context/{id}/events` 在 `kind: "waiting"` 时可附 `questions:[{id,question,options:[{label,description?}],multiSelect?}]`。问题 ID 在该组内唯一，界面不预选答案；用户可单选、多选或自定义。浏览器通过 `POST /api/agents/{id}/answers` 提交 `{permissionId,answers:{问题ID:字符串或字符串数组}}`；原生问题回传 Harness，REST 问题以用户消息投递，答案持久保存在上下文。重复相同回答幂等，冲突答案或跨 Agent 使用拒绝。

进展事件和报告可附 `suggestions:[{label,text}]`，最多 4 项，label 最多 40 字，text 最多 4000 字。建议来自当前 Agent，只作为可编辑草稿，不能自动执行。发布、部署等操作必须由用户实际发送指令触发。旧轮次接口保留用于 API 兼容，界面以连续对话为主。

## 服务器 Agent 代理配置

登录会话接口 `GET /api/servers` 返回当前账号的 SSH 连接；`PUT /api/servers/{id}` 接收 `{name,host,password?,agentProxy?}`。`agentProxy` 为 `{url,noProxy}`，例如 `{"url":"http://127.0.0.1:7890","noProxy":"localhost,127.0.0.1,::1"}`；省略保留，`null` 移除。代理不允许内嵌认证信息。该接口属于账号设置，不开放给 Task 范围的 Agent 凭据。

配置仅作用于该连接下新启动的 SSH／独立用户 Agent，`127.0.0.1` 指执行主机；原生会话和新 tmux Agent 均适用。已有进程需取消、结束并恢复原会话后读取新值。容器／Pod 通过其环境变量／Secret 配置代理。详见 [RUNBOOK](RUNBOOK.md#agent-执行网络与代理)。
