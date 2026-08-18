# Agent 与 Device 关联需求

## ADDED Requirements

### Requirement: agent.register 必须引用当前 User 的 ACTIVE Device

`agent.register` SHALL 要求一个非空 `deviceId`，并 MUST 在签发或确认 Agent credential 前验证该 Device 存在、状态为 ACTIVE 且归当前 OIDC User Actor 所有。Agent owner SHALL 从认证 User 推导；若过渡合同暂时保留 `ownerUserId`，该字段 MUST 与认证 User 完全一致且 MUST NOT 成为权威身份来源。`agent.register` MUST NOT 创建 Device、消费 Device enrollment 或接受 Device 持钥证明。

#### Scenario: User 为自己的 ACTIVE Device 注册 Agent

- **WHEN** ACTIVE OIDC User 提交引用自己 ACTIVE `deviceId` 的合法 `agent.register`
- **THEN** A SHALL 创建或幂等确认一个归该 User 所有且关联该 Device 的 Agent
- **AND** SHALL 仅在关联事实提交成功后按现有节点协议签发或返回 Agent credential。

#### Scenario: deviceId 不存在

- **WHEN** `agent.register` 引用数据库中不存在的 `deviceId`
- **THEN** A MUST 返回稳定的 Device not found 或 invalid linkage 错误
- **AND** MUST NOT 隐式创建 Device、Agent 或 credential。

#### Scenario: Device 属于另一个 User

- **WHEN** 已认证 User 引用其他 User 拥有的 ACTIVE Device
- **THEN** A MUST 返回权限或所有权错误且不泄露额外 Device 信息
- **AND** MUST NOT 创建跨 User Agent linkage、转移 Device 或签发 credential。

#### Scenario: Device 已 REVOKED

- **WHEN** `agent.register` 引用状态不是 ACTIVE 的 Device
- **THEN** A MUST 拒绝注册
- **AND** MUST NOT 恢复 Device、复用旧 Agent credential 或建立可认证的 Agent。

#### Scenario: ownerUserId 与认证 User 不同

- **WHEN** 过渡请求携带的 `ownerUserId` 与 OIDC User Actor 不一致
- **THEN** A MUST 拒绝请求
- **AND** MUST NOT 以请求体 owner 建立 Agent 所有权。

### Requirement: Device 与 Agent 必须保持独立身份和数据权威

`deviceId` 与 `agentId` SHALL 始终是不同 namespace 的独立 ID，A MUST NOT 从其中一个复制、截取或等同生成另一个。Device SHALL 独占 installation、platform、Ed25519 public JWK 和 enrollment-time `capabilitySummary`；Agent SHALL 保存节点 `displayName`、`nodeType`、当前 runtime `capabilities`、credential lifecycle、heartbeat 与节点状态。`agent.register` strict payload MUST NOT 接受 platform、Device JWK、私钥、Device signature、nonce 或 capability summary 作为 Agent 字段。

#### Scenario: Agent 注册包含 runtime capabilities

- **WHEN** 合法 `agent.register` 提交 `deviceId`、节点名称、节点类型和 runtime `capabilities`
- **THEN** A SHALL 把 capabilities 保存到 Agent 节点事实
- **AND** SHALL 保持关联 Device 的 `capabilitySummary` 不变
- **AND** 响应 SHALL 同时保持不同的 `agentId` 与 `deviceId`。

#### Scenario: 请求把 Device 字段塞入 Agent

- **WHEN** `agent.register` 包含 platform、public JWK、Device signature、nonce、私钥或 `capabilitySummary`
- **THEN** strict contract MUST 拒绝未知或越界字段
- **AND** MUST NOT 在 Agent row、credential 或审计中复制这些 Device 数据。

#### Scenario: heartbeat 更新 Agent capabilities

- **WHEN** 已认证 Agent 通过现有 heartbeat 或 capability 协议更新 runtime capabilities
- **THEN** A SHALL 只更新 Agent 的当前 capabilities与相关节点 revision
- **AND** MUST NOT 改写 Device platform、public JWK 或 enrollment-time capability summary。

### Requirement: Agent credential 生命周期必须复用现有节点协议

身份模块 SHALL 复用现有 Agent credential 签发、认证、轮换和撤销机制，MUST NOT 新建第二套长连接认证或把 Device public key 当作 Agent bearer。每次 Agent credential 认证 SHALL 同时验证 Agent ACTIVE、credential generation 有效、关联 Device ACTIVE 且 Agent owner 与 Device owner 一致。Device linkage 不得削弱现有 credential redaction、rotation 或 WebSocket/Inbox actor checks。

#### Scenario: 有效 Agent credential 请求节点接口

- **WHEN** credential 属于 ACTIVE Agent，generation 当前，且其关联 Device 仍 ACTIVE并与 Agent 同 owner
- **THEN** A SHALL 按现有 Agent actor 合同授权对应节点操作
- **AND** SHALL 保持 Device 持钥证明与 Agent bearer 生命周期相互独立。

#### Scenario: credential generation 已轮换

- **WHEN** Agent 提交旧 generation credential，即使关联 Device 仍 ACTIVE
- **THEN** A MUST 按现有节点协议拒绝该 credential
- **AND** MUST NOT 因 Device 仍有效而恢复旧 credential。

#### Scenario: Agent 与 Device owner 数据不一致

- **WHEN**认证路径发现 Agent owner 与关联 Device owner 不一致
- **THEN** A MUST 失败关闭并返回不泄露 owner 详情的结构或认证错误
- **AND** MUST NOT 仅信任 Agent row、请求体或缓存中的任一方继续授权。

### Requirement: Device 撤销必须立即失效全部关联 Agent 认证

Device 被标记 REVOKED 时，A SHALL 在同一权威事务中使该 Device 下所有 Agent credential 和后续认证失效。失效范围 MUST 包括 credential-authenticated HTTP command、heartbeat、capability report、Inbox read/ack、WebSocket 建连或续用以及 Task/progress/result 等节点写入。历史 Agent 与 linkage MAY 保留用于审计，但 MUST NOT 继续授权。单独撤销 Agent SHALL NOT 删除或撤销 Device，也 SHALL NOT 自动撤销该 Device 下其他 Agent。

#### Scenario: Device 撤销后 Agent heartbeat

- **WHEN** Device 已 REVOKED，而其下 Agent 使用此前有效的 credential 发送 heartbeat
- **THEN** A MUST 立即拒绝请求
- **AND** MUST NOT 更新 last-seen、capabilities 或节点在线状态为可用。

#### Scenario: Device 撤销后 Agent 写 Task 状态

- **WHEN** 关联 Device 已 REVOKED 的 Agent 尝试接受 Inbox、ack、写 progress 或提交结果
- **THEN** A MUST 在任何业务状态写入前拒绝认证
- **AND** Project、Task、Inbox、receipt 与 ProjectRecord MUST NOT 被该请求改变。

#### Scenario: 只撤销一个 Agent

- **WHEN** owner 通过现有 Agent revoke 流程撤销一个 Agent
- **THEN** A SHALL 使该 Agent credential 失效并保留其历史
- **AND** 关联 Device SHALL 保持原状态
- **AND** 同一 Device 下其他 ACTIVE Agent MUST NOT 因此被隐式撤销。

### Requirement: Register 与 revoke 并发必须保持 ACTIVE linkage 不变量

Agent registration、Device revoke、Agent credential rotation 与 Agent-authenticated 写入 SHALL 使用事务锁、revision 或等价数据库同步，在提交点重新验证 Device ACTIVE 与 owner 一致。并发最终状态 MUST 不存在关联 REVOKED Device 但 credential 仍可认证的 Agent，也 MUST 不存在跨 owner linkage。已在事务开始时认证的 Agent 请求 MUST 在关键写入提交前重新检查 Device 撤销状态。

#### Scenario: agent.register 与 Device revoke 并发

- **WHEN** User 注册 Agent 与撤销同一 Device 并发发生
- **THEN** A SHALL 串行化两个状态转换
- **AND** 若 register 先提交则随后 revoke MUST 使新 credential 失效
- **AND** 若 revoke 先提交则 register MUST 被拒绝
- **AND** 最终 MUST NOT 存在可认证的 Agent 关联 REVOKED Device。

#### Scenario: Agent 请求认证后 Device 被撤销

- **WHEN** Agent 请求最初通过 credential 认证，但 Device 在该请求业务事务提交前被撤销
- **THEN** A MUST 在提交前重新验证 Device状态并拒绝过期 actor context
- **AND** MUST NOT 提交 heartbeat、Inbox、Task、receipt 或其他节点写入。

#### Scenario: 两个相同幂等注册并发

- **WHEN** 两个具有相同 idempotency key 和相同 payload 的 `agent.register` 并发引用同一 ACTIVE Device
- **THEN** A SHALL 收敛到同一个 Agent、Device linkage 和首次 credential receipt
- **AND** MUST NOT 创建第二个 Device、第二个 Agent 或两份有效 credential
- **AND** 相同 key 配不同 payload MUST 返回 idempotency conflict。

### Requirement: PostgreSQL 必须约束 Agent 到 Device 的持久关联

`agent_nodes.device_id` SHALL 是指向 Device 的外键；每个 ACTIVE Agent 的 `device_id` MUST 非空，历史 REVOKED Agent MAY 为 null。Repository 与数据库约束/受控事务 SHALL 保证 Agent owner 与 Device owner 一致。Migration SHALL 保留现有 Agent 与协作历史，不得按 email、installation 显示名或最近 Device 猜测 owner，并 MUST 撤销无法通过明确映射建立合法 Device 关联的旧 ACTIVE Agent 及其 credentials。Fake 与 PostgreSQL repository MUST 对关联、状态、并发、幂等和回滚具有相同语义，readiness SHALL 在列、外键或必要约束缺失时失败。

#### Scenario: migration 遇到无明确 Device 的旧 Agent

- **WHEN** 旧 Agent 无法通过明确、同 owner 的迁移映射关联到 Device
- **THEN** migration MUST NOT 按 email、显示名或 installation 猜测关联
- **AND** SHALL 把该旧 Agent 与其 credentials 置为不可认证并保留历史，等待显式 Device 注册。

#### Scenario: PostgreSQL 拒绝跨 owner linkage

- **WHEN** repository 或并发事务尝试持久化 Agent owner 与 Device owner 不一致的关联
- **THEN** PostgreSQL 不变量 SHALL 拒绝提交
- **AND** Agent、Device、credential、receipt 与审计 MUST 保持事务前一致状态。

#### Scenario: 服务重启恢复关联

- **WHEN** A 或 PostgreSQL 在 Agent 注册、credential rotation 或 Device revoke 后重启
- **THEN** Agent、Device linkage、owner、credential generation、状态、receipt 与审计 SHALL 从数据库恢复
- **AND** 进程内 Agent map MUST NOT 成为身份权威事实。

### Requirement: Agent linkage 错误、审计与范围边界必须明确

HTTP/command 层 SHALL 将 Device missing、not ACTIVE、owner mismatch、Agent revoked、Device revoked、idempotency conflict 与结构不一致映射为稳定 typed errors，且 MUST 在认证失败时阻止业务 handler。Append-only audit SHALL 记录 register/link/reject、credential lifecycle、Agent revoke 和 Device cascade 的非敏感 Agent/Device/User ID、结果与 request/trace correlation，MUST NOT 记录 Agent bearer、Device signature、nonce、私钥、Authorization 或完整 capabilities 私有内容。本 capability SHALL NOT 实现 C 的节点 runtime、heartbeat scheduler、本地 journal、D/E UI、消息转发或 B 的 Project/Task 决策，也 MUST NOT 修改 Project/Task 状态机。

#### Scenario: linkage 失败写入安全日志

- **WHEN** Agent registration 或认证因 Device/owner/status/idempotency 不变量失败
- **THEN** A SHALL 记录稳定错误类别和非敏感 correlation
- **AND** 日志与 Trace MUST NOT 包含 Agent credential、Token、签名、nonce、私钥或可重放 secret。

#### Scenario: 原有协作命令回归

- **WHEN** 已合法关联 Device 的 ACTIVE Agent 使用原有 Project、Task、Inbox、HumanNeeded、ResourceRef 与 WebSocket 合同
- **THEN** A SHALL 保持既有协作状态机和权限语义
- **AND** 本 change MUST 只增加身份前置与 Device revoke fencing，不实现或接管 B/C/D/E 私有逻辑。

#### Scenario: Agent Device fixture 离线测试通过

- **WHEN** 动态 Device fixture 的 `agent.register(deviceId)`、ownership、revocation、并发和 capability 分离测试通过
- **THEN** 该结果 SHALL 仅证明 A 的离线合同、Service 与 repository 边界
- **AND** MUST NOT 被报告为真实 Desktop AgentRuntime、长连接或完整 Device-to-Agent 产品 E2E 已通过。
