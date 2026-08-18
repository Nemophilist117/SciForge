# Device 身份需求

## ADDED Requirements

### Requirement: Device API 必须由 OIDC User Actor 授权

A SHALL 提供 `POST /v1/device-enrollments`、`POST /v1/devices`、`GET /v1/me/devices` 和 `DELETE /v1/me/devices/{deviceId}`。四个接口 MUST 使用统一 OIDC User resolver，权威 `userId` MUST 来自认证上下文；请求体 MUST NOT 携带或覆盖权威 User。匿名 actor、service actor 和旧 User opaque bearer MUST NOT 使用这些接口。

#### Scenario: 已认证 User 开始 Device enrollment

- **WHEN** ACTIVE OIDC User 为一个合法 `installationId` 调用 `POST /v1/device-enrollments`
- **THEN** A SHALL 创建绑定该认证 User 与 installation 的短期 enrollment
- **AND** SHALL 返回 `enrollmentId`、一次性 nonce 与精确 `expiresAt`。

#### Scenario: 未认证 actor 调用 Device API

- **WHEN** 匿名请求、binding-confirm service actor 或无效 Token 调用任一 Device API
- **THEN** A MUST 返回认证失败
- **AND** MUST NOT 创建 enrollment、Device 或审计为成功的身份事实。

#### Scenario: 请求体自报另一个 User

- **WHEN** Device 请求包含与认证 User 不同的 `userId`、`ownerUserId` 或等价主体字段
- **THEN** strict contract SHALL 拒绝未知或冲突字段
- **AND** A MUST NOT 为自报 User 创建、列出或撤销 Device。

### Requirement: Device enrollment 必须短期、绑定且单次消费

A MUST 使用密码学安全随机源生成 nonce，base64url 解码后长度 SHALL 至少为 32 字节。Enrollment SHALL 绑定发起 User 与 installation，精确在创建后五分钟过期，并只能被成功消费一次。Repository MUST 只长期保存 nonce 摘要、User、installation、过期/消费时间与幂等元数据，MUST NOT 保存 nonce 明文。

#### Scenario: 创建五分钟 enrollment

- **WHEN** 合法 User enrollment 请求提交
- **THEN** A SHALL 生成不可预测且解码后至少 32 字节的 nonce
- **AND** `expiresAt` SHALL 等于服务器创建时间加五分钟
- **AND** 持久化记录 MUST 只包含 nonce 摘要而非响应中的 nonce 明文。

#### Scenario: 另一个 User 使用 enrollment

- **WHEN** 与 enrollment 发起者不同的 OIDC User 提交该 `enrollmentId`
- **THEN** A MUST 返回稳定的 enrollment 归属错误
- **AND** MUST NOT 消费 enrollment 或创建、转移 Device。

#### Scenario: installation 与 enrollment 不一致

- **WHEN** `POST /v1/devices` 的 `installationId` 与 enrollment 绑定的 installation 不同
- **THEN** A MUST 拒绝请求
- **AND** MUST NOT 使用签名中的自报值改变 enrollment 绑定。

#### Scenario: enrollment 已过期

- **WHEN** Device 创建请求到达时服务器当前时间已达到或超过 `expiresAt`
- **THEN** A MUST 返回可区分的 enrollment expired 错误
- **AND** MUST NOT 创建 Device 或把过期 enrollment 恢复为可用。

#### Scenario: enrollment 被并发消费

- **WHEN** 两个非同一幂等重放的有效 Device 创建请求并发消费同一 enrollment
- **THEN** 数据库原子消费 SHALL 允许最多一个请求创建 ACTIVE Device
- **AND** 另一请求 SHALL 返回可区分的 enrollment used 错误
- **AND** MUST NOT 产生第二个 Device。

### Requirement: Device 创建合同必须严格验证 platform 和公开 JWK

`POST /v1/devices` SHALL 使用 strict schema，并 MUST 携带 enrollment 响应中一次返回的原始 `nonce`，使服务器可核对持久化 nonce 摘要后重建签名字节；nonce 仅是本次请求的 transport proof，MUST NOT 被长期保存。`platform.os` MUST 为 `windows`、`macos` 或 `linux`，`platform.arch` MUST 为 `x64` 或 `arm64`，`platform.appVersion` MUST 是非空字符串，`osVersion` MAY 是非空字符串。`publicKeyJwk` MUST 严格表示 Ed25519 公钥：`kty=OKP`、`crv=Ed25519`、`alg=EdDSA`、`use=sig`、非空 `kid` 与 base64url `x`；`x` 解码后 MUST 恰为 32 字节。任何 `d` 私钥字段、RSA/P-256 key、错误算法或未知私密字段 MUST 被拒绝。`capabilitySummary` SHALL 属于 Device，并按 bounded capability identifier 列表验证。

#### Scenario: 合法 Ed25519 Device 请求

- **WHEN** 请求包含冻结的 platform 值、必填 app version、严格 Ed25519 public JWK 和合法 capability summary
- **THEN** A SHALL 在持钥证明通过后把这些字段保存到 Device
- **AND** SHALL 将新 Device 状态设置为 ACTIVE。

#### Scenario: JWK 包含私钥材料

- **WHEN** `publicKeyJwk` 包含 `d` 或其他私钥材料
- **THEN** A MUST 在验签和持久化前拒绝整个请求
- **AND** 日志、错误或审计 MUST NOT 回显该私钥值。

#### Scenario: JWK 算法或公钥长度错误

- **WHEN** JWK 使用 RSA、P-256、非 `OKP/Ed25519/EdDSA` 组合，或 `x` 不能严格 base64url 解码为 32 字节
- **THEN** A MUST 返回 Device key validation 错误
- **AND** MUST NOT 创建降级算法或无法验证的 Device。

#### Scenario: platform 或未知字段错误

- **WHEN** platform 的 os/arch 不在冻结枚举、缺少 `appVersion`，或 Device/platform/JWK 对象包含 strict contract 不允许的字段
- **THEN** A MUST 返回 validation error
- **AND** MUST NOT 静默删除未知字段后继续创建 Device。

### Requirement: Device 创建必须验证固定 canonical Ed25519 持钥证明

A MUST 使用服务器保存的 enrollment 事实构造 UTF-8 canonical bytes。内容 SHALL 恰为六个非空、无 CR/LF 的字符串，以五个单独 LF 分隔且末尾无额外 LF：`SCIFORGE-DEVICE-ENROLLMENT-V1`、`enrollmentId`、原始 nonce base64url、认证 `userId`、绑定 `installationId`、原始 `expiresAt` RFC3339 字符串。A MUST 使用请求 JWK 对 signature 执行 Ed25519 验证，并 SHALL 仅在验证通过后于同一事务消费 enrollment、创建 ACTIVE Device、幂等 receipt 与 append-only audit。

#### Scenario: canonical 签名有效

- **WHEN** 请求 signature 是 Device 私钥对服务器 canonical bytes 的有效 Ed25519 签名，且 enrollment 尚未过期或消费
- **THEN** A SHALL 原子创建一个 ACTIVE Device并消费 enrollment
- **AND** Device 响应 SHALL 使用独立 `deviceId`，不得把 enrollment 或 installation ID 当作 Device ID。

#### Scenario: User 或 canonical 字节被替换

- **WHEN** 请求由错误 User 提交，或 enrollment、nonce、User、installation、expiresAt 任一 canonical 值与服务器事实不同
- **THEN** Ed25519 持钥证明 MUST 被视为无效
- **AND** A MUST NOT 信任客户端重建的 User、nonce 或到期时间。

#### Scenario: 签名错误或编码不合法

- **WHEN** signature 不是严格 base64url Ed25519 签名、由其他私钥签发或针对不同 canonical payload
- **THEN** A MUST 返回 proof validation error
- **AND** MUST NOT 创建 Device、保存 signature 或将失败证明作为长期 credential。

#### Scenario: 同一幂等创建请求重放

- **WHEN** 客户端以相同 idempotency key 和相同 payload 重放已成功的 Device 创建请求
- **THEN** A SHALL 重放首次非敏感成功结果
- **AND** SHALL NOT 第二次消费 enrollment或创建第二个 Device
- **AND** 相同 key 配不同 payload MUST 返回 idempotency conflict。

### Requirement: Device 是安装元数据与设备公钥的权威实体

Device SHALL 以独立 `deviceId` 保存 owner User、`installationId`、显示名、platform、Ed25519 public JWK、`capabilitySummary`、状态、revision 与时间戳。Agent MUST NOT 成为 platform、public JWK、capability summary 或持钥证明的权威副本。相同 installation 跨 User MUST NOT 自动转移；任何转移均不属于本 change，A SHALL 以所有权冲突失败关闭。

#### Scenario: User 列出自己的 Devices

- **WHEN** OIDC User 调用 `GET /v1/me/devices`
- **THEN** A SHALL 只返回该 User 拥有的 Device 及其非敏感元数据、状态和 revision
- **AND** MUST NOT 返回 nonce、nonce digest、signature、私钥或其他 User 的 Device。

#### Scenario: 另一个 User 声明相同 installation

- **WHEN** 不同 User 尝试为已归属的 installation 创建 Device
- **THEN** A MUST 返回所有权冲突
- **AND** 原 Device、owner、公钥与 Agent 关联 MUST 保持不变。

#### Scenario: Device 与 Agent 元数据分离

- **WHEN** Agent 注册或 heartbeat 更新节点 capabilities
- **THEN** Device 的 platform、public JWK 与 enrollment-time `capabilitySummary` SHALL 保持 Device 权威事实
- **AND** Agent 更新 MUST NOT 覆盖这些 Device 字段。

### Requirement: Device 撤销必须要求近期登录并保留历史

`DELETE /v1/me/devices/{deviceId}` SHALL 只允许 Device owner，并 MUST 要求认证上下文满足 `0 <= currentTime - auth_time <= 300 seconds`。成功撤销 SHALL 把 Device 写为 REVOKED 而不删除 User、OIDC identity、Device 历史或审计，并 SHALL 立即触发其下 Agent credential 与后续 Agent 认证失效。撤销 MUST NOT 依赖请求体自报 `auth_time`。

#### Scenario: 近期登录的 owner 撤销 Device

- **WHEN** Device owner 的 OIDC `auth_time` 距服务器当前时间不超过 300 秒
- **THEN** A SHALL 原子把 Device 标记为 REVOKED并增加 revision
- **AND** SHALL 保留 User、Device 记录和历史关联
- **AND** SHALL 使该 Device 下 Agent credential 立即失去授权。

#### Scenario: 登录时间过旧

- **WHEN** owner 的有效 OIDC Token 中 `currentTime - auth_time` 大于 300 秒
- **THEN** A MUST 返回 recent authentication required 错误
- **AND** Device 与 Agent credential 状态 SHALL 保持不变。

#### Scenario: 非 owner 撤销 Device

- **WHEN** 一个 User 尝试撤销另一个 User 的 Device
- **THEN** A MUST 拒绝请求且不泄露额外 Device 详情
- **AND** MUST NOT 改变 Device、Agent 或 enrollment 状态。

#### Scenario: 重复撤销同一 Device

- **WHEN** owner 以同一幂等语义重放已成功的撤销
- **THEN** A SHALL 返回一致的已撤销结果而不删除历史
- **AND** SHALL NOT 产生新的 ACTIVE Device 或恢复任何 Agent credential。

### Requirement: Device repository、错误与审计必须在 Fake 和 PostgreSQL 中一致

Fake 与 PostgreSQL repository MUST 对 enrollment 到期/消费、Device ownership/status/revision、installation 冲突、幂等与事务回滚具有相同语义。PostgreSQL SHALL 通过表、外键、唯一约束与原子更新保证单次消费和 Device 事实，readiness SHALL 在结构缺失时失败。HTTP SHALL 将 validation、ownership、expired、used、proof、recent-auth 与 idempotency 失败映射为稳定 typed error。Append-only audit SHALL 记录 begin/create/revoke 的 actor、Device 或 enrollment 非敏感 ID、结果、request/trace correlation 和时间，MUST NOT 记录 nonce、nonce digest、signature、Authorization、Token 或私钥。

#### Scenario: PostgreSQL 写入中途失败

- **WHEN** enrollment 消费、Device、receipt 或审计写入中的任一步失败
- **THEN** A SHALL 回滚整个事务
- **AND** MUST NOT 留下已消费 enrollment 却无 Device、无审计 Device 或部分成功响应。

#### Scenario: 服务和数据库重启

- **WHEN** A 或 PostgreSQL 在成功创建设备后重启
- **THEN** User、enrollment 消费状态、Device、revision、Agent 失效关系、receipt 与审计 SHALL 从数据库恢复
- **AND** 进程内缓存 MUST NOT 成为权威事实。

#### Scenario: 动态 Ed25519 fixture 测试通过

- **WHEN** 进程内动态 Ed25519 key、canonical bytes、错误签名、过期与重放测试通过
- **THEN** 该结果 SHALL 仅作为离线 Device 合同证据
- **AND** MUST NOT 被报告为真实 Desktop 私钥存储、Keycloak 登录或端到端 Device enrollment 已验证。
