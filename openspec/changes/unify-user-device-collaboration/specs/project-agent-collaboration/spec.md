# 多用户 Project Agent 协作需求

> 边界说明：本文是 A/B/C 共享的系统级合同。B 拥有 Coordinator 的目标理解、拆分、推荐与业务验收，C 拥有 Worker 节点接入与本地执行；A 只实现确定性 Project/Task 账本、路由、revision、单执行者与 Owner 确认权限。六用户场景是跨团队 QA 基线，不是 A 单独开放服务的前置条件。

## ADDED Requirements

### Requirement: Project 成员是用户，执行者是 Agent

Project SHALL 使用 `memberUserIds` 表达参与者，使用 `coordinatorAgentId` 和 Task `assigneeAgentId` 表达执行节点。系统 SHALL 通过 Agent `ownerUserId` 验证成员与执行者关系，不能把 userId 和 agentId 当成可互换身份。

#### Scenario: 六名用户加入 Project

- **WHEN** 六个 UserPrincipal 成为成员并分别选择自己的 Agent
- **THEN** Project SHALL 记录六个 userId
- **AND** Agent registry SHALL 分别记录其 owner
- **AND** 手机与机器 SHALL 在 UI 中组合显示为六个协作个体。

### Requirement: 每个 Project 只有一个活跃 Coordinator

Project SHALL 同时记录一个 active Coordinator Agent。该 Agent SHALL 维护协调建议、接收 Worker 结果，并 MAY 接受 `observation` 或 `task_result`；Coordinator 的 owner SHALL 是 Project 成员或显式服务角色。Project Owner User SHALL 确认并创建正式 Task、确认变更 assignee 的改派与取消、接受 `proposal`/`decision`/`summary`，并完成 Project。Coordinator SHALL NOT 替代 Owner 作出这些正式人类决定。

#### Scenario: 发起人指定 Coordinator

- **WHEN** 用户创建 Project 并选择一台有权 Agent
- **THEN** 云端 SHALL 原子记录 Coordinator 和 Project revision
- **AND** 向该 Agent 投递 `project.started`。

#### Scenario: 手动转交 Coordinator

- **WHEN** 有权用户将 Coordinator 转交给另一台 Agent
- **THEN** 云端 SHALL 原子更新 coordinatorAgentId 和 revision
- **AND** 旧 Coordinator 后续计划写入 SHALL 被拒绝。

### Requirement: Project 使用星形结构化任务协作

Coordinator SHALL 为 Worker 形成独立 Task 与执行者建议；Project Owner 确认后 SHALL 通过云端创建正式 Task。Worker SHALL 只更新分配给自己的 Task、提交结果或提出子任务建议，不得自由修改计划或向其他 Agent 广播可执行指令。

#### Scenario: 两个 Worker 并行执行

- **WHEN** Coordinator 提出两个无依赖 Task 与执行者建议，且 Project Owner 分别确认创建
- **THEN** 两个 Agent MAY 并行执行
- **AND** 各自 SHALL 只能更新自己的 Task。

#### Scenario: Worker 需要其他能力

- **WHEN** Worker 判断需要另一 Agent 帮助
- **THEN** SHALL 向 Coordinator 提交结构化建议
- **AND** Coordinator MAY 形成新 Task 建议
- **AND** 只有 Project Owner 确认后云端 SHALL 创建正式 Task。

### Requirement: Project topic 不等于共享私人 Session

Project topic SHALL 是 ProjectInput 和人类通知的远端投影。Coordinator MAY 在自己的本地 thread 中处理输入，但该 thread SHALL NOT 被表示为所有成员共同拥有的 Session，其他成员消息也 SHALL NOT 自动路由到各自 Agent。

#### Scenario: 两名成员同时在 Project topic 发言

- **WHEN** A 和 B 提交 ProjectInput
- **THEN** 云端 SHALL 分别保存其 senderUserId 和顺序
- **AND** Coordinator SHALL 按 Project queue 处理
- **AND** A、B 的 Worker SHALL 只在收到 Task 时执行。

### Requirement: Coordinator 循环有明确预算

PoC SHALL 限制每 Project Task 数、每轮新增 Task、重试次数和协调轮数。超出预算 SHALL 生成失败、当前总结或 HumanNeeded，而不是无限创建工作。

#### Scenario: Task 重复失败

- **WHEN** Task 达到最大自动重试次数
- **THEN** Coordinator SHALL 停止相同重试
- **AND** MAY 建议改派、重新规划、创建 HumanNeeded 或保留明确失败
- **AND** 改派到不同 Agent 或取消 SHALL 等待 Project Owner 确认。

### Requirement: HumanNeeded 定向到用户并恢复 Project

Agent 无法可靠继续时 SHALL 创建绑定 Project/Task 和 `targetUserId` 的 HumanNeeded。有效 HumanAnswer SHALL 记录回答 endpoint 和 assurance，并通知 Coordinator；无关用户的回答 SHALL 被拒绝。

#### Scenario: B 回答自己的问题

- **WHEN** B 通过 active endpoint 回答目标为 B 的请求
- **THEN** 云端 SHALL 持久化一次回答 receipt
- **AND** Coordinator SHALL 收到 `human.answered`
- **AND** MAY 基于回答继续 Task 或创建新 revision。

#### Scenario: A 尝试代答 B 的私人决定

- **WHEN** A 没有委托角色却回答目标为 B 的请求
- **THEN** 云端 SHALL 拒绝
- **AND** Task SHALL 保持 `needs_human`。

### Requirement: Project 共享记录有明确作者和接受者

Worker SHALL 提交 TaskResult、observation 或 proposal；当前 Coordinator 或 Project Owner MAY 接受 `observation`/`task_result`，只有 Project Owner MAY 接受 `proposal`/`decision`/`summary`。每条 Project Record SHALL 保留 authorUserId、authorAgentId、sourceTaskId 和 revision。

#### Scenario: Worker 直接写正式 Decision

- **WHEN** 普通 Worker 尝试写正式 decision
- **THEN** 云端 SHALL 拒绝或降为 proposal
- **AND** Project 正式状态 SHALL 不被越权修改。

#### Scenario: Coordinator 尝试接受正式结论

- **WHEN** 当前 Coordinator Agent 尝试接受 `proposal`、`decision` 或 `summary`
- **THEN** 云端 SHALL 返回 typed permission error
- **AND** Project Record SHALL 保持候选状态。

#### Scenario: Owner 接受正式结论

- **WHEN** Project Owner User 接受 `proposal`、`decision` 或 `summary`
- **THEN** 云端 SHALL 保存接受者与 revision provenance
- **AND** 该记录 SHALL 成为正式 Project 事实。

### Requirement: Project 完成只接受 Owner 确认

只有 Project Owner User MAY 完成 Project；Coordinator MAY 起草最终总结或提出完成建议，但 SHALL NOT 直接改变 Project 终态。

#### Scenario: Coordinator 尝试完成 Project

- **WHEN** 当前 Coordinator Agent 请求完成 Project
- **THEN** 云端 SHALL 返回 typed permission error
- **AND** Project SHALL 保持 active。
