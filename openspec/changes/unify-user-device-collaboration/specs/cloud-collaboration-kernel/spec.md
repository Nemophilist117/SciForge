# 云端协作内核需求

> A 本轮规范边界：本文是 A 服务端的 normative release scope，覆盖云端公共合同、权威账本、路由、权限、幂等、审计与持久化。本地 AgentRuntime、Coordinator/Worker 决策与执行逻辑不在 A 内核中。

## ADDED Requirements

### Requirement: 云端拥有统一身份和协作事实

Collaboration Server SHALL 是 User、Human Endpoint Binding、Agent ownership、Participant Profile、Project、Task、Project Record、Inbox 和协作 receipt 的 canonical owner。Zulip 和本地客户端 SHALL NOT 维护可独立冲突的第二套协作状态。

#### Scenario: 用户从手机和桌面查看 Project

- **WHEN** 两端查询同一 Project revision
- **THEN** 两端 SHALL 读取同一云端 Project/Task 状态
- **AND** Zulip 历史 SHALL NOT 覆盖云端状态。

### Requirement: 云端不拥有 Agent 智能或本地权限

云端 SHALL 提供确定性身份、Project/Task 账本、共享记录、信箱、消息中转、授权和并发控制，SHALL NOT 内置负责研究判断、模型推理或本地工具执行的特殊 Agent。

#### Scenario: 创建 Project

- **WHEN** 用户创建 Project 并指定 Coordinator Agent
- **THEN** 云端 SHALL 持久化 Project、成员、目标和 Coordinator
- **AND** SHALL 投递 `project.started`
- **AND** SHALL NOT 自行生成项目计划。

### Requirement: Project 和 Task 有唯一权威状态

Project SHALL 记录 member user IDs、唯一 active Coordinator Agent 和 revision；Task SHALL 记录唯一 assignee Agent 和 revision。正式 Task 创建 SHALL 由 Project Owner User 确认并调用，Task 仍 SHALL 记录该 Project 的 Coordinator Agent 作为协调来源。所有写入 SHALL 验证 actor user/agent、所有权、Project role、expected revision 和状态机。

#### Scenario: Coordinator 不能替 Owner 创建正式 Task

- **WHEN** Coordinator Agent、Worker Agent 或普通成员尝试创建正式 Task、取消 Task 或完成 Project
- **THEN** 云端 SHALL 拒绝并返回 typed permission error
- **AND** Project revision SHALL 保持不变。

#### Scenario: Owner 确认 Coordinator 的任务建议

- **WHEN** Project Owner User 使用当前 revision 创建正式 Task
- **THEN** 云端 SHALL 验证 assignee 所有者是 Project 成员并创建 Task offer
- **AND** Task SHALL 记录 Project 的当前 Coordinator Agent，而不是把建议 Agent 当作人类确认者。

#### Scenario: 非 assignee 提交结果

- **WHEN** 非当前 assignee Agent 提交 TaskResult
- **THEN** 云端 SHALL 拒绝结果
- **AND** 当前 Task SHALL 保持不变。

#### Scenario: Agent owner 不是 Project 成员

- **WHEN** Project Owner 尝试把 Task 分配给未授权用户所拥有的 Agent
- **THEN** 云端 SHALL 拒绝分配
- **AND** 除非该 Agent 是 Project 显式授权的机构服务节点。

### Requirement: 状态变化和信箱消息原子持久化

所有协作写操作 SHALL 带 idempotency key；实体状态变化和对应 InboxMessage SHALL 在同一事务中持久化。WebSocket SHALL 只通知 inbox 可用，不能作为事实源。

#### Scenario: Worker 离线

- **WHEN** Project Owner 确认并为离线 Worker 创建 Task
- **THEN** TaskOffer SHALL 保存在 Agent inbox
- **AND** Worker 重连后 SHALL 从最后确认 sequence 按序读取。

#### Scenario: 请求重试

- **WHEN** 云端收到相同 actor 和 idempotency key 的相同请求
- **THEN** SHALL 返回已有 receipt
- **AND** SHALL NOT 第二次改变状态或投递消息。

#### Scenario: 使用新的关联 ID 重放相同业务请求

- **WHEN** 客户端以相同 actor、idempotency key 和业务有效载荷重试，但使用新的 `requestId`
- **THEN** 云端 SHALL 将 `requestId`、协议版本和 command discriminator 视为传输信封而非业务有效载荷
- **AND** SHALL 返回与首次提交相同的业务结果，并在当前响应中使用新的 `requestId`
- **AND** SHALL NOT 再次改变状态、写审计副作用或投递 InboxMessage。

### Requirement: 云端共享记忆严格分区

云端 SHALL 保存 Project 正式 observation、decision、summary 和被接受的 TaskResult 摘要，并按成员和角色控制访问。完整个人 Session、本地工具日志、凭据和原始数据 SHALL NOT 自动进入 Project Record。

#### Scenario: Worker 提交观察

- **WHEN** 当前 assignee 提交 TaskResult 或 observation
- **THEN** 云端 SHALL 保留作者 user/agent、Task、revision 和时间
- **AND** Coordinator 或 Project Owner MAY 接受 `observation` 或 `task_result` 为正式 Project Record
- **AND** 只有 Project Owner MAY 接受 `proposal`、`decision` 或 `summary`。

#### Scenario: Project 成员读取共享记录

- **WHEN** active Project member user 或 Agent 使用 `project_record.get` 读取已知的 ProjectRecord
- **THEN** 云端 SHALL 返回受合同约束的 `project_record` entity
- **AND** system、Human Endpoint 和非成员 SHALL 被拒绝且不得获得记录内容。

#### Scenario: 其他用户读取私人 Session

- **WHEN** Project 成员请求另一用户的完整本地 transcript
- **THEN** 云端 SHALL 无此默认数据或 authority
- **AND** SHALL NOT 通过摘要或搜索泄漏私人内容。

### Requirement: 云端保持简单且可恢复

PoC SHALL 使用一个服务、一个 PostgreSQL 事实库和一个 WebSocket 入口，并从数据库恢复身份、绑定、Project、Task、Record、Inbox、cursor 和 receipt。

#### Scenario: 云端进程重启

- **WHEN** 服务在 active Project 中重启
- **THEN** 已提交状态和未确认信箱 SHALL 保持可恢复
- **AND** 客户端重连 SHALL NOT 导致重复 Task 或 HumanAnswer。

### Requirement: Project 成员可以查询最小能力目录

云端 SHALL 为 active Project 成员提供 provider-neutral 的能力目录，返回该 Project 成员所拥有 Agent 的
非敏感身份、在线状态和 capability ID。目录 SHALL NOT 暴露设备凭据、installation identity、人类端点、
本地路径或私有运行时详情，也 SHALL NOT 允许非成员枚举 Project 资源。

#### Scenario: Coordinator 为 Task 选择执行者

- **WHEN** active Project 的 Coordinator 查询成员能力
- **THEN** 云端 SHALL 返回属于 active member user 的 active Agent 及其 capabilities
- **AND** 返回结果 SHALL 保留明确的 `ownerUserId` 与 `agentId`
- **AND** 系统 SHALL NOT 根据能力自动分派 Task。

#### Scenario: 非成员枚举能力

- **WHEN** 非 Project 成员查询能力目录
- **THEN** 云端 SHALL 返回 typed permission error
- **AND** SHALL NOT 泄漏成员或 Agent 信息。

### Requirement: Task 进度与结果使用当前授权和 revision

当前 assignee Agent SHALL 可以对 running Task 重复提交有界、结构化进度，并在终态提交最小结果摘要。
每次写入 SHALL 携带 idempotency key 和 expected revision，更新 Task revision，并通知显式 Coordinator；
非 assignee、旧 revision 或改派前 Agent 的写入 SHALL 被拒绝。

#### Scenario: Worker 上报进度

- **WHEN** 当前 assignee 为 running Task 上报 percent 和安全摘要
- **THEN** 云端 SHALL 持久化最新进度并递增 Task revision
- **AND** Coordinator inbox SHALL 收到 `task.updated`
- **AND** 普通进度 SHALL NOT 产生手机通知。

#### Scenario: Worker 回传结果

- **WHEN** 当前 assignee 把 running Task 转为 succeeded 并提交结果摘要
- **THEN** 云端 SHALL 原子保存终态与结果摘要
- **AND** Project 成员通过当前 Task revision SHALL 能读取该摘要
- **AND** 旧 assignee 或旧 revision SHALL NOT 覆盖当前结果。

### Requirement: Task 重试与 Owner 主动改派保留人工决定边界

云端 SHALL 暴露单一 `task.retry` 公共命令，但 SHALL 按 assignee 是否变更执行两种权限和状态规则：

- assignee 不变表示同节点重试；只接受 `failed` 或 `rejected` Task，MAY 由 Project Owner User 或当前 Coordinator Agent 发起。
- assignee 变更表示主动改派；只接受 `offered`、`accepted`、`running`、`needs_human`、`failed` 或 `rejected` Task，且 SHALL 只允许 Project Owner User 发起。`succeeded` 或 `cancelled` Task SHALL NOT 被改派。

两种模式均 SHALL 要求 Project 为 active，并在同一事务中锁定 Project 与 Task、验证 expected revision 和重试预算、递增 attempt/revision、清除上一 attempt 的 progress、resultSummary、safeFailureCode 和 completedAt，然后转为 `offered`，并只向新 assignee 投递一条当前 revision 的 `task.offered`。变更 assignee 时，云端 SHALL 同时取消该 Task 的全部 pending HumanRequest，避免旧问题改变新执行授权。

#### Scenario: Coordinator 重试同一 Worker 的失败 Task

- **WHEN** 当前 Coordinator 对 failed Task 提交原 assignee 和当前 revision
- **THEN** Task SHALL 保持同一 taskId、递增 attempt/revision 并回到 offered
- **AND** 新 attempt SHALL 只产生一条给原 assignee 的 offer。

#### Scenario: Coordinator 不能自行改派失败 Task

- **WHEN** 当前 Coordinator 对 failed Task 提交不同 assignee
- **THEN** 云端 SHALL 返回 typed permission error
- **AND** Task SHALL 保持不变。

#### Scenario: Owner 改派失败 Task

- **WHEN** Project Owner 对 failed Task 提交新的成员 Agent 和当前 revision
- **THEN** Task SHALL 保持同一 taskId、递增 attempt/revision 并回到 offered
- **AND** 旧 assignee 后续进度、资源和结果写入 SHALL 被拒绝。

#### Scenario: Owner 主动改派正在执行的 Task

- **WHEN** Project Owner 对 `running` Task 提交不同的成员 Agent 和当前 revision
- **THEN** Task SHALL 递增 attempt/revision、清空本次执行输出并回到 `offered`
- **AND** 旧 assignee SHALL 立即失去该 Task 的进度、资源和结果写入权。

#### Scenario: 改派使待回答问题过期

- **WHEN** Owner 对带有 pending HumanRequest 的 `needs_human` Task 改派到不同 Agent
- **THEN** 该 Task 的所有 pending HumanRequest SHALL 被取消
- **AND** 之后到达的原回答 SHALL 返回公共 typed error `expired` 且 SHALL NOT 改变当前 Task。

#### Scenario: 两个请求竞争同一改派

- **WHEN** 两个不同幂等请求使用相同 expected revision 竞争重试或改派
- **THEN** 最多一个请求 SHALL 成功并产生一条新 offer
- **AND** 失败请求 SHALL 返回包含 current revision 的 typed conflict。

### Requirement: Task 取消只接受 Project Owner 确认

云端 SHALL 只允许 Project Owner User 把非终态 Task 转为 `cancelled`。Coordinator Agent MAY 在自身逻辑中提出取消建议，但 SHALL NOT 直接改变云端 Task 状态。

#### Scenario: Coordinator 尝试直接取消 Task

- **WHEN** 当前 Coordinator Agent 对 Task 提交 `cancelled` transition
- **THEN** 云端 SHALL 返回 typed permission error
- **AND** Task revision 和状态 SHALL 保持不变。

#### Scenario: Owner 确认取消 Task

- **WHEN** Project Owner User 对可取消 Task 提交 `cancelled` transition 和当前 revision
- **THEN** 云端 SHALL 原子更新 Task 状态和 revision
- **AND** SHALL 写入对应审计与信箱事实。

### Requirement: ResourceRef 只保存安全资源引用

云端 SHALL 保存与 Project 关联、可选关联 Task 的 provider-neutral `ResourceRef` 元数据。引用 SHALL 只包含
稳定外部 ID、资源种类、显示名、HTTPS 打开地址、provider version/status 和 provenance；SHALL NOT 接受或
保存文件正文、provider credential、`file://` URL、本地绝对路径或 provider 私有对象。

#### Scenario: Worker 返回云端资源引用

- **WHEN** active Project 的当前 Task assignee 提交合法 HTTPS ResourceRef
- **THEN** 云端 SHALL 持久化引用、actor、Project、可选 Task revision 和审计事件
- **AND** Project 成员 SHALL 能按公开合同查询该引用。

#### Scenario: 请求夹带正文或本地路径

- **WHEN** ResourceRef 请求包含未知正文字段、凭据字段、非 HTTPS URL 或本地绝对路径
- **THEN** strict contract SHALL 拒绝整个请求
- **AND** 云端 SHALL NOT 持久化部分引用。
