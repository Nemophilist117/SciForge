# 人类 IM 路由需求

> 边界说明：A 只拥有 provider-neutral Human Gateway 合同、身份绑定、locator 解析与公共路由事实。具体正式 Provider、Zulip 拓扑和最新版 SciForge 接线尚未冻结；现有 adapter 能力不代表产品链路已选定。手机交互、桌面展示与 Computer Use/跨端稳定性是 `origin/gui` 既有跨团队基线，不是 A 本轮发布门槛。

## ADDED Requirements

### Requirement: 每条可执行消息必须有明确目标

Human Gateway SHALL 在接受可执行消息前把它解析为一个稳定的个人 `projectionId` 或 `projectId`。系统 SHALL NOT 根据 topic 文本、桌面焦点、最近在线 Agent、默认 workspace 或发送者显示名猜测目标。

#### Scenario: Locator 无法唯一解析

- **WHEN** provider locator 缺失、重复或与已保存 binding revision 不一致
- **THEN** Gateway SHALL 拒绝执行并记录有界诊断
- **AND** SHALL NOT 把消息发送到候选 Agent 或 Project。

### Requirement: 个人消息路由到所属用户的固定 Agent

个人 Session 消息 SHALL 同时验证 sender `userId`、endpoint binding、projection access 和 projection 指定 `agentId`。默认情况下，sender 和 Agent owner SHALL 是同一用户。

#### Scenario: A 在自己的个人 topic 发言

- **WHEN** A 的 active endpoint 向 A 的 projection 发送消息
- **THEN** 消息 SHALL 路由到 projection 指定的 A 所有 Agent
- **AND** B 的 Agent SHALL 不收到该消息。

#### Scenario: B 未获授权进入 A 的个人 topic

- **WHEN** B 在不允许共享的 A projection 中发送消息
- **THEN** 消息 SHALL 被忽略或拒绝
- **AND** 审计 SHALL 记录 B 的稳定 user/endpoint identity 和目标 projection。

### Requirement: Project topic 写入 Project 而不是私人 Session

Project topic 中的用户输入 SHALL 先转换为带 `projectId`、`senderUserId`、source endpoint 和 remote message ID 的 `ProjectInput`，经成员/角色校验和持久化后通知显式 Coordinator。它 SHALL NOT 直接写入任意成员的私人 AgentRuntime thread。

#### Scenario: Project 成员提出新任务

- **WHEN** 成员在 Project topic 中提出指令
- **THEN** 云端 SHALL 将其保存为 ProjectInput
- **AND** Coordinator SHALL 决定回答、提出 Task 建议、请求澄清或拒绝
- **AND** 正式 Task SHALL 等待 Project Owner 确认后创建
- **AND** 所有 Worker SHALL NOT 被自由广播唤醒。

#### Scenario: 非成员在 Project topic 发言

- **WHEN** endpoint 所属用户不是 Project 成员且没有访客权限
- **THEN** 输入 SHALL NOT 改变 Project 或创建 Task
- **AND** 系统 SHALL 返回或记录稳定权限错误。

### Requirement: 真人请求按 targetUserId 投递且保留来源

每个 `HumanNeeded` SHALL 包含明确 `targetUserId` 和 required assurance。Worker 来源 SHALL 绑定当前 taskId/executionId/revision，只有它 MAY 使 Task 进入 needs_human；Coordinator 来源 SHALL 绑定 projectId/sourceInboxMessageId，SHALL NOT 改变 Worker execution 状态。系统 SHALL 只选择目标用户的 active human endpoint；没有可用端点时 SHALL 保留 user inbox，并由后续已确认的客户端方案决定如何展示。

#### Scenario: B 的 Task 需要决定

- **WHEN** Worker 创建目标为 B 的 HumanNeeded
- **THEN** B 的手机 endpoint SHALL 收到问题
- **AND** A 或其他在线用户 SHALL 不会因可达性更好而收到替代通知。

#### Scenario: 目标端点已撤销

- **WHEN** target user 的 primary endpoint 已撤销
- **THEN** 请求 SHALL 保留为未投递
- **AND** 系统 SHALL NOT 回退到同一 provider realm 的其他账号。

#### Scenario: Coordinator 创建项目追问

- **WHEN** 当前 Coordinator 基于自己的 source Inbox message 向成员发起 HumanNeeded
- **THEN** A SHALL 把 HumanAnswer 返回该 Coordinator 的 Inbox
- **AND** SHALL NOT 把任何 Worker Task 错误置为 needs_human。

### Requirement: 批准回答产生动作绑定 confirmation

当 Coordinator 请求 Owner 批准首次 Task、改派、取消或 Project 完成时，HumanNeeded SHALL 保存不可变 `ConfirmableAction`。有效 approve HumanAnswer SHALL 产生不透明 confirmationId；A SHALL 在后续动作中校验 target Owner、Project、当前 Coordinator、动作 kind/digest、Task execution/assignee、有效期和 supersede 状态。

#### Scenario: 确认被跨动作复用

- **WHEN** Coordinator 把一个 reassign confirmation 用于不同 Task、execution、assignee 或 cancel
- **THEN** A SHALL 返回 `confirmation_mismatch`
- **AND** SHALL NOT 改变目标实体。

### Requirement: 手机只承载人类注意力事项

手机 SHALL 展示个人 Session 消息、需要本人行动的问题、策略允许的批准、重要摘要和最终结果；普通 TaskProgress、心跳、工具日志、内部推理和机器间消息 SHALL NOT 产生手机通知。

#### Scenario: Worker 上报普通进度

- **WHEN** Worker 更新非异常进度
- **THEN** Project UI MAY 更新
- **AND** 手机 SHALL NOT 收到人类通知。

### Requirement: HumanAnswer 可追溯且幂等

HumanAnswer SHALL 记录回答 user、endpoint、Project、Task/request、assurance、时间和内容。重复 provider event 或重复提交 SHALL NOT 产生第二个逻辑回答。

#### Scenario: 用户回答已过期请求

- **WHEN** HumanNeeded 已取消、完成或被新 revision 取代
- **THEN** 系统 SHALL 显示请求已过期
- **AND** SHALL NOT 修改当前 Task。

### Requirement: Provider 通过可安装合同扩展

Provider-specific authentication、event、locator、send、rename 和 lifecycle 行为 SHALL 实现统一 Human Endpoint Provider 合同并通过 manifest/generated composition 发现。Host 和通用协作内核 SHALL NOT 按 provider ID 分支。该约束不选择任何正式 Provider；选择、部署和接线必须由后续方案单独批准。

#### Scenario: 安装新的 IM provider adapter

- **WHEN** composition 发现兼容 provider contribution
- **THEN** Gateway SHALL 可使用该 provider
- **AND** SHALL 不要求修改中央 provider map 或 Host-private 配置。

### Requirement: Provider 启动诊断可被部署门禁验证

启用 Provider 的 Collaboration Server SHALL 在每次 runtime 启动时调用已安装 Provider 的标准
`diagnose` 能力，并把脱敏 diagnostic 持久化。数据库 readiness SHALL 保持只表达 canonical PostgreSQL
状态；部署门禁 SHALL 另行要求预期 Provider catalog 与本次启动后的 healthy diagnostic。core-only 模式 catalog SHALL 为空，且 SHALL NOT 因 `/readyz=200` 声称 pairing 或真实业务 E2E 已开放。

#### Scenario: 所选 Provider 凭据无效

- **WHEN** Provider runtime 启动诊断无法验证 Bot
- **THEN** 系统 SHALL 持久化不含 credential、请求头或远端响应正文的 unavailable diagnostic
- **AND** provider-enabled 发布 SHALL 不得通过验收
- **AND** `/readyz` SHALL NOT 冒充 Provider 健康证明。
