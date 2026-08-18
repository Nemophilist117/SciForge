# Zulip User Binding 需求

## ADDED Requirements

### Requirement: Binding request 必须由已认证 OIDC User 发起

A SHALL 提供 `POST /v1/integrations/zulip/bindings`，且 MUST 只允许 ACTIVE OIDC User Actor 调用。每个 binding request SHALL 预先记录发起 `userId` 与目标 Realm，返回五分钟有效的一次性 `bindingCode`，并 MUST NOT 创建 User、按 email 查找 User或签发 User credential。A SHALL 使用不可预测 binding code，只持久化验证所需的不可逆表示，并 MUST NOT 在普通响应、日志或 Trace 中再次泄露已返回的 code。

#### Scenario: 已登录 User 创建 binding request

- **WHEN** ACTIVE OIDC User 为合法 Zulip `realmUrl` 调用 binding 创建接口
- **THEN** A SHALL 创建绑定该 User 与 Realm 的 PENDING request
- **AND** SHALL 一次返回 `bindingRequestId`、`bindingCode` 和服务器创建时间加五分钟的 `expiresAt`
- **AND** SHALL NOT 创建第二个 User 或返回 User bearer credential。

#### Scenario: 匿名 actor 创建 binding request

- **WHEN** 匿名请求、无效 OIDC Token、service actor 或旧 User opaque bearer 调用 binding 创建接口
- **THEN** A MUST 返回认证失败
- **AND** MUST NOT 生成 code、bootstrap User 或创建 PENDING binding。

#### Scenario: 同一 User 和 Realm 再次创建 code

- **WHEN** 同一 User 为同一 Realm 创建新的 binding request，且已有未消费 PENDING request
- **THEN** A SHALL 在同一事务中使旧 request 过期并创建新 request
- **AND** 只有新 code SHALL 可被后续 confirm 使用。

### Requirement: D 只负责命令解析且 A 拥有唯一绑定状态机

D/Zulip Bot SHALL 负责接收并解析 `/bind CODE`、验证 Zulip 事件来源并把稳定 Realm/User 身份交给 A；A MUST NOT 实现 Bot 消息轮询、命令解析或消息发送。现有 `pairing.begin/redeem` MAY 暂时作为同一 binding service 的兼容 adapter，但 MUST 要求 OIDC User、MUST NOT 匿名创建 User、MUST NOT 签发 User credential，并 MUST NOT 维护第二套 challenge、binding 或 identity 状态机。

#### Scenario: D 解析 bind 命令

- **WHEN** D 从经过 Zulip 验证的事件中解析出 `/bind CODE`
- **THEN** D SHALL 通过受信 confirm 边界提交 code 与稳定 Zulip 身份上下文
- **AND** A SHALL 只处理绑定状态转换，不解析原始消息正文或运行 Bot event loop。

#### Scenario: 旧 pairing begin 匿名调用

- **WHEN** 未认证 actor 调用保留的 `pairing.begin` adapter
- **THEN** adapter MUST 返回认证失败
- **AND** MUST NOT 调用旧匿名 User bootstrap 路径。

#### Scenario: 旧 pairing redeem 成功

- **WHEN** 已认证 User 通过兼容 `pairing.redeem` 查询同一权威 binding request 的结果
- **THEN** adapter MAY 返回 pending 或非敏感 binding 状态
- **AND** MUST NOT 返回、轮换或恢复 User credential
- **AND** 结果 SHALL 来自与 REST binding API 相同的状态机和数据库事实。

### Requirement: Confirm 必须只接受可注入的受信 service actor

A SHALL 提供 `POST /v1/integrations/zulip/bindings/confirm`，并 MUST 在进入 binding service 前通过可注入 service-auth adapter 建立受信 service actor。D→A 正式认证未冻结时，离线测试 MAY 直接注入 service actor，但 HTTP/生产路径 MUST 在未配置受信 adapter 时失败关闭；A MUST NOT 添加匿名 header、固定测试 secret、普通 User allowlist 或其他后门。`realmUrl`、`realmId`、`zulipUserId` 与 `providerEventId` SHALL 只在该 adapter 已认证调用方并标记为受信 Zulip context 后进入 confirm，普通 User 自报值 MUST NOT 被接受。

#### Scenario: 受信 service actor 确认 binding

- **WHEN** 可注入 adapter 认证 D 为允许的 binding-confirm service actor，并提供经过 Zulip 验证的 Realm、User 与 event identity
- **THEN** A SHALL 允许该 actor 尝试消费 binding code
- **AND** SHALL 把 service actor ID 和 provider event ID记录到脱敏审计与幂等边界。

#### Scenario: confirm 未配置认证 adapter

- **WHEN** HTTP confirm 路由没有可用的 service-auth adapter或 adapter 未能建立受信 actor
- **THEN** A MUST 返回认证失败或依赖未就绪错误
- **AND** MUST NOT 把请求视为离线测试注入或匿名 service actor。

#### Scenario: 普通 User 或匿名请求 confirm

- **WHEN** Desktop/Web User Actor、匿名 actor 或旧 opaque credential 调用 confirm
- **THEN** A MUST 拒绝请求
- **AND** MUST NOT 信任请求正文中的 Realm、Zulip User、service client ID 或 provider event ID。

#### Scenario: service actor 调用非 confirm User API

- **WHEN** binding-confirm service actor 调用 `GET /v1/me`、Device API、binding begin 或普通 User command
- **THEN** A MUST 拒绝该 actor
- **AND** MUST NOT 将 service client 加入 User `azp` allowlist或为其 JIT 创建 User。

### Requirement: Confirm 只能绑定 code 预先记录的现有 User

成功 confirm SHALL 从 binding request 取得权威目标 `userId`，并 SHALL 在一个事务中验证 code、Realm、到期、消费状态、User ACTIVE 状态、唯一绑定约束与幂等事件，然后消费 code、创建或确认 ACTIVE Zulip identity、写 receipt 和 append-only audit。Confirm MUST NOT 接受目标 `userId`、email 或显示名作为身份来源，MUST NOT 创建 User，并 MUST NOT 把 code 转移给另一个 User。

#### Scenario: 有效 code 首次确认

- **WHEN** 受信 service actor 提交未过期、未消费的 code，且 Zulip identity 不与其他 User 冲突
- **THEN** A SHALL 把该 Realm/Zulip User 绑定到 code 预先记录的现有 `userId`
- **AND** SHALL 原子写入 ACTIVE binding、消费状态、receipt 与审计
- **AND** MUST NOT 创建或按 email 合并 User。

#### Scenario: confirm 自报目标 User

- **WHEN** confirm payload 或调用上下文额外提供与 code 记录不同的 `userId`、email 或显示名
- **THEN** A MUST 忽略非权威显示信息并拒绝冲突主体字段
- **AND** MUST NOT 改写 code 的预绑定 User。

#### Scenario: code 对应 User 已不 ACTIVE

- **WHEN** code 有效但其预绑定 User 在 confirm 前已 suspended 或 revoked
- **THEN** A MUST 拒绝 confirm 并保持无 ACTIVE binding
- **AND** MUST NOT JIT 创建替代 User 或转移到其他 ACTIVE User。

#### Scenario: confirm 事务中途失败

- **WHEN** code 消费、binding、human endpoint、receipt 或审计写入中的任一步失败
- **THEN** A SHALL 回滚整个事务
- **AND** MUST NOT 留下 code 已消费但 identity 未绑定或 identity 已绑定却无审计的部分状态。

### Requirement: ACTIVE Zulip identity 必须满足双向唯一约束

PostgreSQL 与 Fake repository SHALL 保证同一 `(realmId, zulipUserId)` 最多绑定一个 ACTIVE User，且同一 `(userId, realmId)` 默认最多有一个 ACTIVE Zulip identity。Realm URL SHALL 作为经过受信上下文验证的元数据保存，唯一性 MUST 使用稳定 Realm identity而非显示名、stream 或 topic。相同 Zulip identity 已绑定同一 User 时 SHALL 幂等成功；若已绑定其他 User，HTTP MUST 返回 409 `IDENTITY_ALREADY_BOUND` 且不得改变原 binding。

#### Scenario: 同一 Zulip identity 再次绑定同一 User

- **WHEN** 有效新 code 的 User 已拥有相同 Realm 和 `zulipUserId` 的 ACTIVE binding
- **THEN** A SHALL 幂等返回原 ACTIVE identity
- **AND** SHALL 安全消费或协调当前 request，而不创建第二条 ACTIVE identity。

#### Scenario: Zulip identity 已属于其他 User

- **WHEN** 有效 code 尝试把已 ACTIVE 绑定到 User A 的 `(realmId, zulipUserId)` 绑定给 User B
- **THEN** A MUST 返回 HTTP 409 `IDENTITY_ALREADY_BOUND`
- **AND** User A 的 binding、User B 的既有 identities 与 code 的安全状态 SHALL 按事务规则保持一致
- **AND** MUST NOT 按 email 或显示名合并两个 User。

#### Scenario: 同一 User 在 Realm 已有另一个 ACTIVE Zulip identity

- **WHEN** User 在目标 Realm 已有不同 `zulipUserId` 的 ACTIVE identity且未显式解绑
- **THEN** A MUST 返回 typed binding conflict
- **AND** MUST NOT 静默替换、转移或同时保留两个 ACTIVE identities。

#### Scenario: 两个 confirm 并发竞争同一 Zulip identity

- **WHEN** 两个不同 User 的有效 codes 并发确认相同 `(realmId, zulipUserId)`
- **THEN** 数据库唯一约束和事务 SHALL 允许最多一个 ACTIVE binding 成功
- **AND** 失败者 SHALL 得到 `IDENTITY_ALREADY_BOUND`
- **AND** MUST NOT 出现重复 ACTIVE rows 或跨 User endpoint ownership。

### Requirement: Binding code 必须有明确过期、使用与幂等语义

Binding code SHALL 在创建后五分钟过期并只能消费一次。过期 code MUST 返回 `BINDING_CODE_EXPIRED`，已由另一个逻辑请求消费的 code MUST 返回 `BINDING_CODE_USED`。相同 idempotency key、相同 payload 或相同受信 provider event 对首次成功结果的安全重放 SHALL 返回相同非敏感结果；相同 key 配不同 payload MUST 返回 idempotency conflict。幂等重放 MUST NOT 重新创建 User、binding、endpoint 或审计状态转换。

#### Scenario: 使用过期 code

- **WHEN** confirm 到达时服务器当前时间已达到或超过 binding request 的 `expiresAt`
- **THEN** A MUST 返回 `BINDING_CODE_EXPIRED`
- **AND** MUST NOT 创建 ACTIVE identity 或把 code 延长为可用。

#### Scenario: 使用已消费 code

- **WHEN** 不属于首次请求幂等重放的 confirm 再次提交已消费 code
- **THEN** A MUST 返回 `BINDING_CODE_USED`
- **AND** MUST NOT 泄露该 code 绑定的 User 或 Zulip identity 详情。

#### Scenario: 首次成功 confirm 的幂等重放

- **WHEN** 同一受信 provider event 与 idempotency payload 重放首次成功 confirm
- **THEN** A SHALL 返回首次 ACTIVE binding 的同一非敏感结果
- **AND** SHALL NOT 生成第二个 binding、第二个 human endpoint 或第二次状态转换审计。

#### Scenario: 新 code 使旧 pending code 失效

- **WHEN** 同一 User/Realm 的新 binding request 已提交，而 D 随后确认旧 code
- **THEN** A MUST 将旧 code 视为已过期
- **AND** 只有新 request 的 code MAY 创建该 User 的 binding。

### Requirement: User 必须能查询与显式撤销自己的外部身份

A SHALL 提供 `GET /v1/me/external-identities` 和 `DELETE /v1/me/external-identities/{identityId}`。查询 SHALL 只返回当前 User 的非敏感 identity、Realm、状态与时间。解绑 MUST 要求 `0 <= currentTime - auth_time <= 300 seconds`，把 identity 写为 REVOKED 而非删除，并在同一事务中作废该 User/Realm 未使用的 binding codes。REVOKED identity MUST 立即停止身份解析；重新绑定 MUST 使用新 code 并创建新的历史记录。

#### Scenario: User 查询 external identities

- **WHEN** ACTIVE OIDC User 调用 external identity 列表
- **THEN** A SHALL 只返回该 User 的 Zulip identity metadata与状态
- **AND** MUST NOT 返回 binding code、code digest、Bot credential、Token 或其他 User identity。

#### Scenario: 近期登录 User 解绑

- **WHEN** identity owner 的 OIDC `auth_time` 距服务器当前时间不超过 300 秒并请求删除 ACTIVE identity
- **THEN** A SHALL 原子把 identity 标记为 REVOKED并作废相关未消费 codes
- **AND** SHALL 保留原 binding、human endpoint 与审计历史
- **AND** 后续 provider identity resolution MUST 拒绝该 REVOKED identity。

#### Scenario: 过旧登录或非 owner 解绑

- **WHEN** `auth_time` 超过五分钟或另一个 User 请求撤销该 identity
- **THEN** A MUST 拒绝请求
- **AND** identity、pending codes 与 endpoint 状态 SHALL 保持不变。

#### Scenario: User 在解绑后重新绑定

- **WHEN** 原 identity 已 REVOKED 且 User 希望重新绑定 Zulip
- **THEN** User MUST 创建新的 binding request并由受信 service actor 确认新 code
- **AND** A SHALL 创建新的 binding 历史记录而不恢复或覆盖旧 REVOKED row。

### Requirement: Binding 持久化、审计与测试证据必须安全且边界明确

A SHALL 只维护一个权威 Zulip binding 状态模型，可由现有 `human_endpoint_bindings` 演进但 MUST NOT 双写两套 ACTIVE 事实。PostgreSQL migration SHALL 建立 ACTIVE partial unique constraints、外键、状态和时间约束；Fake repository MUST 具有相同冲突、过期、消费、撤销、幂等与并发语义，readiness SHALL 在所需结构缺失时失败。Append-only audit SHALL 记录 begin、confirm、冲突、撤销、重绑的非敏感主体 ID、service actor ID、provider event ID、结果与 correlation，MUST NOT 记录 binding code、code digest、Bot API key、Authorization、User Token、完整 Zulip 消息或个人 credential。

#### Scenario: PostgreSQL 重启后恢复 binding

- **WHEN** A 或 PostgreSQL 在 binding 成功、冲突或撤销后重启
- **THEN** request 消费、ACTIVE/REVOKED identity、endpoint、receipt 与审计 SHALL 从数据库恢复
- **AND** 进程内 service actor 或缓存 MUST NOT 成为绑定事实源。

#### Scenario: 日志记录 binding 错误

- **WHEN** confirm 因认证、过期、已使用、冲突或数据库错误失败
- **THEN** 日志与 Trace SHALL 只记录稳定错误类别、非敏感 ID 与 correlation
- **AND** MUST NOT 包含 code、Bot secret、Token、原始 `/bind` 消息或可重放身份材料。

#### Scenario: binding fixture 离线测试通过

- **WHEN** OIDC User begin、注入 service actor confirm、冲突、过期、重放与撤销 fixture 测试通过
- **THEN** 该结果 SHALL 仅证明 A 的离线 service/provider 边界
- **AND** MUST NOT 被报告为 D Bot `/bind` 解析、真实 Zulip Realm、真实 Keycloak 或完整产品 E2E 已通过。
