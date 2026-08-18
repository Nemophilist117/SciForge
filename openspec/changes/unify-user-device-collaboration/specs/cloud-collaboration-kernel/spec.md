# 云端协作内核需求

> A 本轮规范边界：本文是 A 服务端的 normative release scope，覆盖云端公共合同、权威账本、路由、权限、幂等、审计与持久化。本地 AgentRuntime、Coordinator/Worker 决策与执行逻辑不在 A 内核中。

## ADDED Requirements

### Requirement: 云端拥有统一身份和协作事实

Collaboration Server SHALL 是 User、Human Endpoint Binding、Agent ownership、Participant Profile、Project、Task、Project Record、Inbox 和协作 receipt 的 canonical owner。任何 IM Provider（包括候选 Zulip）和本地客户端 SHALL NOT 维护可独立冲突的第二套协作状态。

#### Scenario: 用户从手机和桌面查看 Project

- **WHEN** 两端查询同一 Project revision
- **THEN** 两端 SHALL 读取同一云端 Project/Task 状态
- **AND** 任何 Provider 的历史 SHALL NOT 覆盖云端状态。

### Requirement: 云端不拥有 Agent 智能或本地权限

云端 SHALL 提供确定性身份、Project/Task 账本、共享记录、信箱、消息中转、授权和并发控制，SHALL NOT 内置负责研究判断、模型推理或本地工具执行的特殊 Agent。

#### Scenario: 创建 Project

- **WHEN** 用户创建 Project 并指定 Coordinator Agent
- **THEN** 云端 SHALL 持久化 Project、成员、目标和 Coordinator
- **AND** SHALL 投递 `project.started`
- **AND** SHALL NOT 自行生成项目计划。

### Requirement: Project 和 Task 有唯一权威状态

Project SHALL 记录 member user IDs、唯一 active Coordinator Agent 和 revision；Task SHALL 记录唯一 assignee Agent、revision 和不透明 `executionId`。正式 Task 创建 SHALL 由 Project Owner User 直接调用，或由当前 Coordinator Agent 使用绑定该不可变任务 proposal 的有效 `confirmationId` 调用；Task 仍 SHALL 记录 Project 的 Coordinator Agent 作为协调来源。所有写入 SHALL 验证认证上下文中的 actor user/agent、所有权、Project role、expected revision、当前 execution 和状态机。

#### Scenario: Coordinator 无确认不能替 Owner 创建正式 Task

- **WHEN** Coordinator Agent 未携带匹配确认就尝试创建正式 Task、取消 Task 或完成 Project
- **THEN** 云端 SHALL 拒绝并返回 typed permission error
- **AND** Project revision SHALL 保持不变。

#### Scenario: Owner 确认 Coordinator 的任务建议

- **WHEN** Project Owner User 使用当前 revision 创建正式 Task
- **THEN** 云端 SHALL 验证 assignee 所有者是 Project 成员并创建 Task offer
- **AND** Task SHALL 记录 Project 的当前 Coordinator Agent，而不是把建议 Agent 当作人类确认者。

#### Scenario: Coordinator 使用动作绑定确认创建 Task

- **WHEN** 当前 Coordinator Agent 提交与 Task proposal digest、Project 和自身身份匹配的有效 `confirmationId`
- **THEN** 云端 SHALL 原子消费确认并创建正式 Task
- **AND** 同一确认 SHALL NOT 被另一动作复用。

#### Scenario: 非 assignee 提交结果

- **WHEN** 非当前 assignee Agent 提交 TaskResult
- **THEN** 云端 SHALL 拒绝结果
- **AND** 当前 Task SHALL 保持不变。

#### Scenario: Agent owner 不是 Project 成员

- **WHEN** Project Owner 尝试把 Task 分配给未授权用户所拥有的 Agent
- **THEN** 云端 SHALL 拒绝分配
- **AND** 除非该 Agent 是 Project 显式授权的机构服务节点。

#### Scenario: Worker owner 在执行期间发生变化

- **WHEN** Agent owner transfer 与 Task 创建、改派或 Worker 写入竞争
- **THEN** 云端 SHALL 锁定并重验 Agent owner、Project membership、capability profile 和 Task assignee identity
- **AND** SHALL NOT 产生由非成员 owner 继续执行的 active Task。

### Requirement: 每次 Task 执行有独立 execution identity

`revision` SHALL 只用于实体并发版本，`executionId` SHALL 标识一次实际 Worker 执行授权。`task.create` SHALL 生成第一个 executionId；每次 `task.retry` SHALL 生成新的 executionId。accepted、running、needs_human、恢复 running、progress 和结果写入 SHALL 保持当前 executionId，同时仍递增 Task revision。

所有 Worker transition、progress、HumanNeeded、Task-scoped ResourceRef 和结果写入 SHALL 同时校验 `taskId`、`executionId`、当前 `assigneeAgentId` 和 `expectedRevision`。旧 execution、旧 assignee 或旧 revision SHALL 分别使用稳定 typed conflict 拒绝。

#### Scenario: HumanNeeded 后恢复同一次执行

- **WHEN** 当前 Worker 为 running Task 创建 HumanNeeded，收到有效回答后恢复 running
- **THEN** Task revision SHALL 随状态变化递增
- **AND** executionId SHALL 保持不变
- **AND** C SHALL 能把它恢复为同一个本地 execution 而不是启动第二次 Runtime。

#### Scenario: Retry 使旧 execution 失效

- **WHEN** `task.retry` 成功生成新 executionId
- **THEN** 旧 Worker 使用旧 executionId 的 progress、ResourceRef 或结果写入 SHALL 返回 `execution_conflict`
- **AND** 冲突 MAY 返回调用者有权查看的 currentRevision 和 currentExecutionId。

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

### Requirement: Agent 上报有期限能力快照且 Project 成员可查询目录

Agent SHALL 通过独立 `agent.capability_profile.report` 写入严格、provider-neutral 的能力快照；heartbeat SHALL 只维护可达性。快照 SHALL 包含 Agent/owner、节点类型、OS/架构、runtime IDs、稳定 capability IDs 与 detected/configured/verified 证据、GPU 摘要数组、VPN access IDs、Slurm cluster IDs、可访问 ResourceRef IDs、结果回传策略和 reported/expires 时间。无 GPU 的上报请求 MAY 省略 `gpu`，A SHALL 归一为公开输出中的空数组；VPN/Slurm 字段 SHALL 只接受不透明公共 ID，SHALL NOT 接受 credential、地址、队列私有结构或本地路径。

云端 SHALL 为 active Project 成员提供能力目录，并根据心跳、撤销事实和 active execution 派生 online/offline/busy/revoked，SHALL NOT 接受 C 自报这些目录状态。过期、owner 不匹配或已撤销 profile SHALL 从新分派候选中排除。目录 SHALL NOT 暴露设备凭据、installation identity、人类端点、本地路径或 provider/Runtime 私有对象，也 SHALL NOT 允许非成员枚举 Project 资源。

#### Scenario: Coordinator 为 Task 选择执行者

- **WHEN** active Project 的 Coordinator 查询成员能力
- **THEN** 云端 SHALL 返回属于 active member user、profile 未过期的 active Agent 及其严格 profile
- **AND** 返回结果 SHALL 保留明确的 `ownerUserId` 与 `agentId`
- **AND** 系统 SHALL NOT 根据能力自动分派 Task。

#### Scenario: 过期能力快照不能参与新分派

- **WHEN** Agent profile 的 expiresAt 已经过期
- **THEN** 能力目录 SHALL 排除该快照或明确返回 `capability_profile_expired`
- **AND** A SHALL NOT 猜测 GPU、VPN、Slurm 或 Runtime 可用性。

#### Scenario: 非成员枚举能力

- **WHEN** 非 Project 成员查询能力目录
- **THEN** 云端 SHALL 返回 typed permission error
- **AND** SHALL NOT 泄漏成员或 Agent 信息。

### Requirement: Task 进度与结果使用当前 execution、授权和 revision

当前 assignee Agent SHALL 可以对 running Task 重复提交有界、结构化进度，并在终态提交最小结果摘要。
每次写入 SHALL 携带 idempotency key、executionId 和 expected revision，更新 Task revision，并通知显式 Coordinator；
非 assignee、旧 execution、旧 revision 或改派前 Agent 的写入 SHALL 被拒绝。

#### Scenario: Worker 上报进度

- **WHEN** 当前 assignee 为 running Task 上报 percent 和安全摘要
- **THEN** 云端 SHALL 持久化最新进度并递增 Task revision
- **AND** Coordinator inbox SHALL 收到 `task.updated`
- **AND** 普通进度 SHALL NOT 产生手机通知。

#### Scenario: Worker 成功原子产生候选 TaskResult Record

- **WHEN** 当前 assignee 把 running Task 转为 succeeded，并提交摘要、按 criterion ID 组织的 evidence、ResourceRef IDs 和可选有界 log summary
- **THEN** 云端 SHALL 在同一事务中保存 succeeded Task、该 execution 唯一的候选 `task_result` ProjectRecord、幂等回执和发给当前 Coordinator 的 `project_record.submitted`
- **AND** Task SHALL 引用该候选记录
- **AND** 旧 assignee 或旧 revision SHALL NOT 覆盖当前结果。

#### Scenario: 成功响应丢失后同键重试

- **WHEN** Worker 未收到成功响应并使用相同 idempotency key 与相同业务 payload 重试
- **THEN** 云端 SHALL 返回原 Task 与 ProjectRecord receipt
- **AND** SHALL NOT 创建第二条候选记录或重复 InboxMessage。

### Requirement: Task retry 支持结果审查、重做与确认后的改派

云端 SHALL 暴露单一 `task.retry` 公共命令并要求当前 executionId、expected revision 和目标 assignee：

- assignee 不变表示同节点重做；接受 `succeeded`、`failed` 或 `rejected` Task，MAY 由 Project Owner User 或当前 Coordinator Agent 发起。
- assignee 变化表示改派；MAY 由 Project Owner User 直接发起，或由当前 Coordinator Agent 携带与 `taskId + fromExecutionId + newAssigneeAgentId` 匹配的有效 `confirmationId` 发起。

两种模式均 SHALL 要求 Project active，并在同一事务中锁定 Project/Task、验证重试预算和当前 execution/revision、使上一 execution 的未接受候选结果 supersede、过期 pending HumanRequest、清空 execution 输出、生成新 executionId、回到 `offered`，并只向新 assignee 投递一条 `task.offered`。上一结果已被接受为正式 ProjectRecord 时，普通 retry SHALL 失败而不是撤销正式事实。

#### Scenario: Coordinator 要求成功 Worker 重做

- **WHEN** 当前 Coordinator 对 `succeeded` Task 提交原 assignee、当前 execution 和 revision，且候选结果尚未接受
- **THEN** 旧候选 ProjectRecord SHALL 原子进入 `superseded`
- **AND** Task SHALL 保持 taskId、生成新 executionId 并回到 offered。

#### Scenario: Coordinator 无确认尝试改派

- **WHEN** 当前 Coordinator 对 Task 提交不同 assignee 且没有匹配 confirmationId
- **THEN** 云端 SHALL 返回 `confirmation_required`
- **AND** Task 与旧候选结果 SHALL 保持不变。

#### Scenario: Owner 直接改派或 Coordinator 使用确认改派

- **WHEN** Owner 直接提交，或当前 Coordinator 提交匹配 from execution 和 new assignee 的有效确认
- **THEN** Task SHALL 生成新 executionId、清空旧 execution 输出并回到 offered
- **AND** 旧 assignee 的进度、资源和结果写入 SHALL 被拒绝。

#### Scenario: 已接受结果不可被普通 retry 撤销

- **WHEN** Task 的候选 `task_result` 已进入 accepted，随后收到普通 retry
- **THEN** 云端 SHALL 返回 typed state/confirmation error
- **AND** accepted ProjectRecord 和 Task SHALL 保持不变。

#### Scenario: 两个请求竞争同一 retry

- **WHEN** 两个不同幂等请求使用相同 current execution 和 expected revision 竞争 retry
- **THEN** 最多一个请求 SHALL 成功并产生一条新 offer
- **AND** 失败请求 SHALL 返回 current revision/execution 的 typed conflict。

### Requirement: Task 取消与 Project 完成保留 Owner 决定

Project Owner User MAY 直接取消非终态 Task 或完成满足条件的 Project。当前 Coordinator Agent MAY 使用绑定当前 Task execution 或 final record digest 的有效 `confirmationId` 代为执行；没有确认时 SHALL NOT 改变终态。

#### Scenario: Coordinator 无确认取消 Task

- **WHEN** 当前 Coordinator Agent 对 Task 提交 cancelled transition 但没有匹配当前 execution 的确认
- **THEN** 云端 SHALL 返回 `confirmation_required`
- **AND** Task revision 和状态 SHALL 保持不变。

#### Scenario: Owner 直接取消 Task

- **WHEN** Project Owner User 对可取消 Task 提交 current execution 和 expected revision
- **THEN** 云端 SHALL 原子更新 Task 状态/revision、审计与信箱事实
- **AND** SHALL NOT 要求 Owner 先创建冗余确认对象。

### Requirement: ResourceRef 只保存安全资源引用

云端 SHALL 保存与 Project 关联、可选关联当前 Task execution 的 provider-neutral `ResourceRef` 元数据。引用 SHALL 只包含稳定外部 ID、资源种类、显示名、安全 HTTPS 打开地址、provider version、`available | unavailable | revoked` 状态（以及既有 `invalidated` 终态）和 provenance；SHALL NOT 接受或保存文件正文、provider credential、长期 secret、短期签名 URL 作为稳定身份、`file://` URL、本地绝对路径或 provider 私有对象。

Task-scoped ResourceRef SHALL 同时绑定 taskId、executionId 和创建时 Task revision。Worker 只有在仍为当前 execution assignee、且 Task 明确引用/产生该资源时才能创建或读取；失效资源 SHALL NOT 进入成功结果。完整文件或完整日志跨信任域传输 SHALL 另需范围匹配的人类确认与本机 capability approval，A SHALL NOT 自动上传。

#### Scenario: Worker 返回云端资源引用

- **WHEN** active Project 的当前 Task assignee 使用当前 execution 提交合法 HTTPS ResourceRef
- **THEN** 云端 SHALL 持久化引用、actor、Project、Task/execution/revision 和审计事件
- **AND** Project 成员 SHALL 能按公开合同查询该引用。

#### Scenario: ResourceRef 失效

- **WHEN** 有权 actor 把现有引用标记为 unavailable 或 revoked
- **THEN** A SHALL 保留稳定 ResourceRef ID 与失效 provenance
- **AND** 后续 Worker 成功结果引用它时 SHALL 返回 `resource_unavailable`。

#### Scenario: 请求夹带正文或本地路径

- **WHEN** ResourceRef 请求包含未知正文字段、凭据字段、非 HTTPS URL 或本地绝对路径
- **THEN** strict contract SHALL 拒绝整个请求
- **AND** 云端 SHALL NOT 持久化部分引用。

### Requirement: Project 范围读取提供一致协调投影

对已知 projectId，A SHALL 向有权 Project member/Agent 提供 `ProjectCoordinationView` 或语义等价的一致投影，包含 Project、members、当前 Coordinator、全部 Project Tasks、ProjectRecords、HumanRequests 和 HumanAnswers。所有子项 SHALL 属于同一 Project，读取 SHALL 在一个一致边界完成或携带足够 revision 供调用方检测变化并重读。

该投影 SHALL NOT 包含私人 Session、附件正文、完整日志、其他 Project 数据或 B/C 私有状态，也 SHALL NOT 创建可独立写入的第二份事实库。

#### Scenario: Coordinator 规划前读取 Project

- **WHEN** 当前 Coordinator Agent 查询已知 Project 的 coordination view
- **THEN** A SHALL 返回当前成员、协调者、Tasks、Records 和 Human facts 的最小有权字段
- **AND** A SHALL NOT 运行任务拆分、Worker 推荐或科研结果判断。

### Requirement: HumanNeeded 支持 Worker 与 Coordinator 两类来源

Worker 来源 SHALL 绑定当前 taskId、executionId 和 expectedTaskRevision，actor SHALL 是当前 assignee，且只有该来源 MAY 把 active Task 变为 needs_human。Coordinator 来源 SHALL 绑定 projectId 和 sourceInboxMessageId，actor SHALL 是当前 Coordinator，且 SHALL NOT 改变 Worker execution 状态。两类来源都 SHALL 指定 targetUserId；HumanAnswer SHALL 回到原请求 Agent Inbox 并记录请求/回答 revision provenance。

#### Scenario: Coordinator 发起结果追问

- **WHEN** 当前 Coordinator 依据自己的 source Inbox message 向目标成员创建 HumanNeeded
- **THEN** A SHALL 保存定向请求并投递人类通知
- **AND** 任何 running Worker Task SHALL 保持原状态。

#### Scenario: Worker 发起执行问题

- **WHEN** 当前 assignee 使用当前 execution 创建 HumanNeeded
- **THEN** 该 Task SHALL 进入 needs_human 且 executionId 保持不变
- **AND** 有效回答 SHALL 只回到原 Worker/Coordinator 所需 Inbox。

### Requirement: Action confirmation 绑定不可变动作

批准型 HumanRequest SHALL 保存 strict `ConfirmableAction`。Owner 的有效批准 SHALL 产生不透明 confirmationId；确认 SHALL 绑定 target Owner、Project、当前 Coordinator、动作 kind、适用的 proposal/final record digest、Task/from execution/new assignee、有效期和状态。消费确认 SHALL 与受管动作原子发生。

与已批准动作冲突的权威事实（包括相关 Task execution 被 retry、改派、取消或进入不再适用的终态，结果被正式接受，Coordinator 被转交，或 Project 进入终态）SHALL 在同一事务中把仍为 approved 的相关确认持久化为 `superseded`；过期批准也 SHALL 被物化为 `superseded`。`confirmation.get` SHALL 返回该权威状态，且 consumed 确认 SHALL 保持终态。

#### Scenario: 确认被用于不同动作

- **WHEN** Coordinator 把为 Task A reassign 生成的 confirmationId 用于 Task B、不同 execution、不同 assignee 或 cancel
- **THEN** A SHALL 返回 `confirmation_mismatch`
- **AND** 确认与两个 Task 状态 SHALL 保持安全一致。

#### Scenario: Owner 直接执行受管动作

- **WHEN** Project Owner User 使用自己的有效 credential 直接创建 Task、取消、改派或完成 Project
- **THEN** A SHALL 按当前 revision/action 直接校验并执行
- **AND** SHALL NOT 要求 Owner 先创建只为自己消费的 confirmationId。

### Requirement: Inbox 只能连续 ACK 且 Coordinator 转交会重路由

每个 recipient Inbox 的所有消息 SHALL 共享单调 sequence。客户端 MAY 并行处理消息，但 `inbox.ack` SHALL 只推进到连续完成的最高 sequence，并返回服务器已提交的 ack sequence。未完成 active message SHALL 形成 `inbox_ack_gap`；由 A 标记 superseded 的消息 MAY 被连续 ACK 越过。

公开 InboxMessage 状态 SHALL 只包含 `pending | acknowledged | superseded`。active message 的 acknowledged 状态 SHALL 由持久 `ackedSequence` 派生；未确认 message 过期时 SHALL 先保留为同 sequence 的 superseded tombstone，不能因隐藏或删除该 message 制造无法恢复的 ACK gap。A SHALL NOT 发布没有权威持久事实支持的 delivered、expired 或 dead-letter 状态。

Coordinator 转交 SHALL 在事务内 supersede 旧 Coordinator 未处理的 Coordinator 类消息，并向新 Coordinator 创建新的 recipient-specific 消息。新消息 MAY 保留 reroute provenance，但 SHALL NOT 复用旧 recipient 的 message ID、sequence 或 ACK。Worker 专属 Task offer SHALL NOT 因协调者转交被改写。

#### Scenario: ACK 跨过未完成消息

- **WHEN** Agent 尝试确认 sequence 12，但 sequence 11 仍为 active 且未完成
- **THEN** A SHALL 返回 `inbox_ack_gap` 和当前 ack position
- **AND** SHALL NOT 丢弃 sequence 11。

#### Scenario: Coordinator 转交有待处理消息

- **WHEN** Owner 把 Coordinator 从 Agent A 转给 Agent B
- **THEN** A SHALL supersede A 的未处理 Coordinator 消息并为 B 生成新投递
- **AND** A 的 ACK SHALL NOT 影响 B 的新消息。

### Requirement: 公共错误码稳定且最小泄漏

所有公共错误 SHALL 包含 requestId、traceId、稳定 code 和 retryable。B/C 增量 SHALL 至少提供 `execution_conflict`、`assignee_mismatch`、`coordinator_mismatch`、`confirmation_required`、`confirmation_mismatch`、`resource_unavailable`、`capability_profile_expired` 和 `inbox_ack_gap`。冲突 MAY 返回调用者已获权查看的 currentRevision/currentExecutionId/confirmationId，SHALL NOT 泄漏其他 Project、credential、连接参数、provider 响应正文或本地路径。

#### Scenario: 旧 execution 写入

- **WHEN** 旧 Worker 使用已 superseded executionId 写进度
- **THEN** A SHALL 返回 `execution_conflict`、traceId 和安全 current execution/revision
- **AND** SHALL NOT 返回新 assignee 的 credential 或私有 profile。

### Requirement: 协议 1.0 发布可重现机器制品

A SHALL 从固定合同源码生成并提交 command union、response/rest.error、Inbox envelope/message、Agent/Project/Task/ProjectRecord/ResourceRef JSON Schema、状态转换表、actor 权限表和正常/重复/乱序/revision conflict/idempotency conflict/旧 execution/确认失效 fixtures。自动 freshness 测试 SHALL 拒绝手工漂移。

#### Scenario: B/C 验证 adapter payload

- **WHEN** B 或 C 使用固定协议制品校验请求、响应和 Inbox fixture
- **THEN** strict schema SHALL 给出与 A runtime 一致的通过/拒绝结果
- **AND** B/C SHALL 不需要访问 A 数据库或服务端私有模块。

### Requirement: Core readiness 与身份业务前置分离

`/healthz` SHALL 只表达进程存活，`/readyz` SHALL 只表达 canonical PostgreSQL 可用。Provider catalog、启动后脱敏诊断、pairing 与身份业务可用性 SHALL 由独立门禁证明。在 core-only 模式下 Provider catalog SHALL 为空，并且团队 SHALL NOT 据 `/readyz=200` 声称真实 pairing、Agent 注册或 Project 闭环完成。

正式 Human Provider、Zulip 拓扑、最新版 SciForge 接法和公网入口 SHALL 保持未决，直到团队另行批准具体方案；A 核心协议 SHALL NOT 冻结一条未经确认的端到端链路。

#### Scenario: Core-only 服务 ready

- **WHEN** PostgreSQL 可用但未安装正式 Provider
- **THEN** `/readyz` MAY 返回 200 且 catalog SHALL 为空
- **AND** 验收 SHALL 只声明 core/transport conformance，不得声明身份或真实业务 E2E 已开放。
