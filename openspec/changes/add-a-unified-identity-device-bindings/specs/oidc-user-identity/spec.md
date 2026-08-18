# OIDC 用户身份需求

## ADDED Requirements

### Requirement: 部署实例只信任一个精确配置的 OIDC issuer

A SHALL 为每个部署实例配置且只配置一个 OIDC issuer、预期 audience `sciforge-cloud-api` 和普通 User client allowlist。A MUST 只从该 issuer 的 Discovery 地址取得元数据，并只使用该元数据声明的 `jwks_uri` 获取验签公钥；Token、请求参数或未经信任的 claims MUST NOT 改写 Discovery 或 JWKS 地址。Discovery 返回的 issuer SHALL 与配置值逐字符相等，A MUST NOT 自动增加、删除或归一化结尾 `/`。

#### Scenario: 精确 issuer 的 Discovery 可用

- **WHEN** 部署配置了一个 issuer，且该 issuer 的 Discovery 文档返回完全相同的 issuer 与可用 `jwks_uri`
- **THEN** A SHALL 建立有界缓存的 Discovery/JWKS 验证边界
- **AND** SHALL 仅把该边界用于当前部署的 OIDC Token 验证。

#### Scenario: issuer 仅结尾斜杠不同

- **WHEN** Token 或 Discovery 文档中的 issuer 与配置值相比只多出或缺少一个结尾 `/`
- **THEN** A MUST 拒绝该身份
- **AND** MUST NOT 通过 URL 归一化使其通过验证。

#### Scenario: Discovery 或 JWKS 不可用

- **WHEN** 配置的 Discovery/JWKS 无法取得、响应无效或返回不匹配的 issuer
- **THEN** A SHALL 以稳定的认证依赖不可用错误失败关闭
- **AND** MUST NOT 使用请求提供的公钥、任意备用 issuer 或旧 User opaque credential 回退认证。

### Requirement: User Access Token 必须经过严格 RS256 与 claims 验证

A MUST 在解析 User Actor 前验证 JWT Header `alg` 恰为 `RS256`，按非空 `kid` 从受信 JWKS 选择 RSA 公钥并验证签名。A SHALL 验证 `iss` 精确匹配、`aud` 字符串或数组包含 `sciforge-cloud-api`、`azp` 恰为 `sciforge-desktop` 或 `sciforge-web-mobile`，并验证 `exp`、`nbf`、`iat`、`auth_time` 是具有合法时间语义的 NumericDate，`sub` 是非空字符串。任何一步失败 MUST 在建立 User Actor 之前终止请求。

#### Scenario: 有效 Desktop Access Token

- **WHEN** Access Token 使用 JWKS 中 `kid` 对应的 RSA key 以 RS256 签名，且 issuer、audience、authorized party、时间和 subject 全部合法
- **THEN** A SHALL 解析一个经过验证的 User 身份输入
- **AND** SHALL 把经过验证的 `auth_time` 放入本次请求的临时认证上下文。

#### Scenario: 算法或签名不受信

- **WHEN** JWT 声明 `alg` 不是 `RS256`、缺少 `kid`、使用未知 `kid`，或签名不能由对应 JWKS key 验证
- **THEN** A MUST 返回认证失败
- **AND** MUST NOT 接受算法降级、同名非 RSA key、unsigned Token 或来自其他 key 的签名。

#### Scenario: audience 或 authorized party 不合法

- **WHEN** `aud` 不包含 `sciforge-cloud-api`，或 `azp` 不是 `sciforge-desktop` 与 `sciforge-web-mobile` 之一
- **THEN** A MUST 拒绝 User Actor
- **AND** MUST NOT 把 service client、其他 realm client 或缺失 `azp` 的 Token 当作普通 User Token。

#### Scenario: 时间或 subject claims 不合法

- **WHEN** Token 已过期、`nbf` 位于未来、`iat` 或 `auth_time` 位于未来、任一时间 claim 类型错误，或 `sub` 缺失、为空或类型错误
- **THEN** A MUST 拒绝该 Token
- **AND** SHALL NOT 执行 JIT User 查询或创建。

### Requirement: JWKS 缓存必须支持受控 key rotation

A SHALL 缓存 Discovery/JWKS 结果以限制 Provider 请求，并 SHALL 在遇到当前缓存未知的 `kid` 时对配置 issuer 的 JWKS 执行一次受控刷新。刷新后仍未知的 key、错误签名或不合法 JWK MUST 被拒绝；刷新逻辑 MUST NOT 接受 Token 指定的 URL，也 MUST NOT 无限重试。

#### Scenario: Provider 轮换到新 kid

- **WHEN** 合法 Token 使用 Provider 新发布但当前缓存尚未包含的 `kid`
- **THEN** A SHALL 从已配置 issuer 的受信 `jwks_uri` 刷新 JWKS
- **AND** SHALL 在新 key 通过全部 RS256 与 claims 校验后接受 Token。

#### Scenario: 刷新后 kid 仍不存在

- **WHEN** A 刷新受信 JWKS 后仍找不到 Token 的 `kid`
- **THEN** A MUST 返回认证失败
- **AND** MUST NOT 从其他 issuer、磁盘任意文件或请求正文寻找公钥。

#### Scenario: 轮换期间旧 key 仍由 Provider 发布

- **WHEN** Provider 的受信 JWKS 同时发布新旧有效 key，且旧 Token 尚未过期
- **THEN** A SHALL 按 Token 的 `kid` 验证对应 key
- **AND** SHALL 对新旧 Token 应用完全相同的 issuer、audience、client 与时间校验。

### Requirement: OIDC 身份必须并发安全地 JIT 映射为稳定 User

A SHALL 以 `(issuer, subject)` 作为 OIDC 身份唯一键，并 MUST 在一个事务中创建 SciForge User 与 `oidc_identities` 记录。PostgreSQL 唯一约束和 repository 逻辑 SHALL 使同一身份的重复或并发首次登录收敛到一个稳定 `userId`；email 只可保存为 `email_at_link_time` 元数据，MUST NOT 用作唯一键、查找合并键或迁移猜测依据。

#### Scenario: 首次有效登录

- **WHEN** 经过验证的 `(issuer, sub)` 尚无本地 OIDC identity
- **THEN** A SHALL 在一个事务中创建一个 User 和一个指向该 User 的 OIDC identity
- **AND** SHALL 只在两项写入与审计均成功后返回稳定 `userId`。

#### Scenario: 两个首次登录并发

- **WHEN** 两个有效请求并发解析同一 `(issuer, sub)`，且开始时数据库尚无该 identity
- **THEN** 数据库唯一约束 SHALL 允许最多一个 OIDC identity 被创建
- **AND** 两个成功请求 SHALL 最终解析到同一个 `userId`
- **AND** 竞争失败的事务 MUST NOT 留下孤立 User、部分 identity 或重复审计事实。

#### Scenario: 相同 email 对应不同 subject

- **WHEN** 两个有效 Token 具有相同 email 但 `(issuer, sub)` 不同
- **THEN** A SHALL 创建或解析两个不同的 User identity
- **AND** MUST NOT 因 email 相等自动合并、转移所有权或复用 `userId`。

#### Scenario: 已存在身份再次访问

- **WHEN** 同一 `(issuer, sub)` 在后续请求中再次通过 Token 验证
- **THEN** A SHALL 返回原有稳定 `userId`
- **AND** SHALL NOT 创建第二个 User 或以变化的 email 改写身份主键。

### Requirement: 只有 ACTIVE 本地身份可以形成 User Actor

A SHALL 在每次请求中验证 OIDC identity 与关联 User 的当前状态，只有 ACTIVE User 才能形成 User Actor。suspended、revoked 或不存在一致关联的本地状态 MUST 被拒绝；认证成功不能绕过本地撤销。数据迁移 MUST NOT 直接 SQL seed 新 User，也 MUST NOT 在没有明确 `(issuer, sub)` 对应表时按 email 回填身份。

#### Scenario: 本地 User 已 suspended 或 revoked

- **WHEN** Token 在密码学和 claims 层面有效，但其本地 User 不再是 ACTIVE
- **THEN** A MUST 拒绝请求
- **AND** MUST NOT JIT 创建替代 User 或恢复旧 User credential。

#### Scenario: identity 与 User 关系不一致

- **WHEN** repository 发现 OIDC identity 指向缺失 User、重复 User 或不满足唯一约束的状态
- **THEN** A SHALL 失败关闭并报告不含敏感身份值的结构错误
- **AND** MUST NOT 猜测 email、显示名或最近 User 作为替代。

### Requirement: 所有 User HTTP 与 command 路径共享同一认证解析器

`GET /v1/me` 与需要 User Actor 的 `/v1/commands` SHALL 使用同一 OIDC verifier、JIT resolver 和本地状态检查。权威 `actorUserId` MUST 来自认证上下文；请求体中的 `userId`、`ownerUserId` 或其他主体字段 MUST NOT 建立身份，若为过渡兼容保留则 SHALL 与认证 User 完全一致。JWT 验证失败 MUST NOT 回退到旧 User opaque bearer。

#### Scenario: GET me 与 command 使用同一 Token

- **WHEN** 同一有效 Access Token 依次调用 `GET /v1/me` 和一个 User command
- **THEN** 两条路径 SHALL 解析到同一个稳定 `userId`
- **AND** SHALL 执行相同的 issuer、claims 与本地 ACTIVE 状态验证。

#### Scenario: 请求体冒充另一个 User

- **WHEN** 已认证 User 的 command 请求体自报另一个 `actorUserId`、`userId` 或 `ownerUserId`
- **THEN** A MUST 拒绝该请求或忽略非权威字段并使用认证 User，具体行为 SHALL 由该 strict contract 固定
- **AND** MUST NOT 以请求体身份执行任何写入。

#### Scenario: 旧 User opaque bearer 调用新身份路径

- **WHEN** 请求未携带有效 OIDC Access Token而仅携带旧 User opaque credential
- **THEN** `GET /v1/me`、Device、binding 和新的 User command 路径 MUST 返回认证失败
- **AND** MUST NOT 为兼容而匿名创建或恢复 User Actor。

### Requirement: User Token 与 binding confirm service actor 必须隔离

用于 Zulip binding confirm 的 service identity SHALL 由独立、可注入的 service-auth adapter 解析，并 MUST 只在 confirm 边界形成 service actor。`sciforge-zulip-bot` 或后续冻结的 service client MUST NOT 加入普通 User `azp` allowlist，MUST NOT 触发 JIT User，普通 Desktop/Web User Token也 MUST NOT 被提升为 service actor。

#### Scenario: service Token 调用普通 User API

- **WHEN** service-auth adapter 识别的 binding-confirm credential 被用于 `GET /v1/me`、Device API 或普通 User command
- **THEN** A MUST 拒绝该请求
- **AND** MUST NOT 为其创建 User 或 OIDC identity。

#### Scenario: 普通 User Token 调用 confirm

- **WHEN** `sciforge-desktop` 或 `sciforge-web-mobile` User Token 调用 binding confirm
- **THEN** A MUST 拒绝该请求
- **AND** MUST NOT 把普通 User Actor 转换为受信 service actor。

### Requirement: OIDC 持久化、错误和审计必须脱敏且可恢复

A MUST NOT 持久化或记录原始 JWT、Authorization header、Access Token、Refresh Token 或完整 claims。`oidc_identities` SHALL 只保存稳定 identity ID、User、issuer、subject、可选 link-time email、状态与时间戳；append-only 审计 SHALL 记录 JIT、解析结果、状态拒绝和管理动作的非敏感主体 ID、结果、request/trace correlation 与时间。Fake 与 PostgreSQL repository MUST 具有相同状态、唯一性、事务和错误语义，PostgreSQL readiness SHALL 验证所需表与唯一约束存在。

#### Scenario: Token 验证失败写入诊断

- **WHEN** A 因 issuer、audience、client、key、签名、时间或 subject 拒绝 Token
- **THEN** 日志与 Trace SHALL 只记录稳定的失败类别和 correlation ID
- **AND** MUST NOT 包含 Token、Authorization、完整 claims、签名或可还原 credential 的片段。

#### Scenario: 数据库事务失败

- **WHEN** JIT User、identity 或审计写入中的任一步失败
- **THEN** A SHALL 回滚整个事务并返回稳定的服务错误
- **AND** 重试 SHALL 能依据数据库唯一事实安全收敛，不得依赖进程内猜测状态。

#### Scenario: 离线 OIDC fixture 测试通过

- **WHEN** 动态本地 Discovery/JWKS、RS256 Token 和 key rotation 测试全部通过
- **THEN** 该结果 SHALL 仅证明 A 的离线合同与 Provider 边界
- **AND** MUST NOT 被报告为真实 Keycloak、Desktop 或公网身份 E2E 已通过。
