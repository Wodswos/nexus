# Nexus 设计文档

设计文档区分当前实现、历史背景和目标方案。目标方案的存在不代表功能已上线；开发时应同时核对源码、API 文档及对应验收项。

## Agent 与 Workspace 的最新方案

当前 Agent UI 尚未完成与 T3 Code 的视觉对齐，详见 [对齐复核](T3_ALIGNMENT_REVIEW.md)。功能实现记录不等同于视觉验收完成。

| 文档 | 用途 | 状态 |
| --- | --- | --- |
| [Agent 系统设计](../architecture/AGENT_SYSTEM_DESIGN.md) | 对象关系、Workspace 复用与继承、身份与终端特性、原生／ACP 接入、事件、恢复、权限、迁移和实施阶段 | 2026-11-27 规范；实现范围见架构记录 |
| [Agent UI 设计：对齐 T3 Code](AGENT_UI_DESIGN.md) | 工作台、侧栏、对话、输入器、审批、终端、创建流程、视觉 token、响应式和验收 | 2026-11-27 规范；实现范围见架构记录 |
| [Workspace 与 Agent 实现基线](WORKSPACE_AGENT_DESIGN.md) | 已有 ACP／tmux、创建、Git、凭据与轮次行为，以及兼容边界 | 现有实现记录；实际能力仍需核对源码 |
| [节点、Workspace 与环境执行](WORKSPACE_DESIGN.md) | 早期配置继承和环境桥接背景 | 历史设计，不作为新领域命名依据 |

新 Agent 设计明确：tmux 是终端功能，独立用户是执行身份选项；Task 与 Workspace 多对多；Agent 默认复用合适 Workspace，并为并行代码工作分配独立工作目录。新设计不自动迁移或停止已有终端 Agent。

## 其他交互设计

- [总体交互基线](INTERACTION_DESIGN.md)：任务视图、导图、详情、导航、习惯和复盘。
- [移动端 UI](MOBILE_UI_DESIGN.md)：移动布局、安全区与原生手势。
- [Task 多选与批量操作](TASK_BATCH_OPERATIONS.md)：选择、批量编辑与待扩展视图。

## 实施与发布边界

新功能上线时更新对应实现记录和 API／Skill，不能只把目标文档标题改成“已实现”。现状与目标有冲突时：源码和实测决定当前能力，最新目标文档决定迁移方向。

本轮实现和测试记录见 [Agent 实现记录](../architecture/AGENT_IMPLEMENTATION.md)，系统设计归入 `docs/architecture`。运行时文档随构建发布，代码更新按 [RUNBOOK](../RUNBOOK.md) 同步部署。
