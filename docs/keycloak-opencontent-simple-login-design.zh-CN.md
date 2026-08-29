# SciForge Keycloak、Content Space 与 OpenContent 简化登录改造方案

> 状态：阶段零至阶段三已实施并通过相关回归；阶段四与阶段五待实施
>
> 日期：2026-08-28
>
> 适用范围：SciForge Desktop、SciForge Cloud Collaboration、Content Space、OpenContent Provider Integration

当前工作树的实施边界（2026-08-28）：

- 已完成协议决议、消费者迁移清单和 Cloud-only Human Principal 原子切换。
- signed-out 时发布 `principal: null`；只有 Keycloak/OIDC 用户与 `ACTIVE` Device 同时成立时才发布 `cloud-authenticated` Principal。
- 已删除 Local Account capability、Renderer 入口、持久化生产路径和 `local-selection` schema；旧 Identity Account 行执行破坏性清理，旧 Provider credential 不迁移且在 cloud-only Principal 合同下不可寻址，不提供兼容 shim 或枚举 API。
- 当前 Content Space Provider 为 OpenContent 时，Connector 的连接管理准入已收紧到完整的当前 Cloud Principal；现有 Token custody、Provider Instance 隔离和 Provider SPI 未改变。现有 enrollment contribution 显示 `OpenContent · 未登录/已登录`。
- Keycloak 登录不会打开 Provider enrollment；未选择 Content Space Provider 时不会读取或渲染 enrollment。Keycloak 退出后 Host capability 立即 fail closed，UI 在下一次现有 Content Space access read 时收敛，不增加 Identity 到 OpenContent 的直连事件或 IPC。
- 同一 Cloud 用户和 Device 以新 `identityVersion` 恢复后只静默复验已有 Token，不重新提交账号密码；OpenContent 仍可通过现有 `unbind` 独立退出。
- 阶段三已通过共同合同评审并实施：`AuthenticatedCloudTransport` 原子升级到 `3.0.0`，ready status 提供 exact ACTIVE Device entity revision；Content Space 新增唯一显式、需确认的 `content-space.sync-provider-principal` capability。同步不会在登录、启动、bind/status/unbind 或 read capability 中自动发生。
- 同步只复用同一 pinned Provider 的 `attestExternalBinding()` 与现有 `getCurrentPrincipal`，并通过现有 `provider_directory_principal.list/publish` 和 `AuthenticatedCloudTransport.execute()` 发布 `ready` Fact；没有新增 Cloud command、REST、IPC、Publisher service、Provider SPI 或 Host provider 分支。
- 除已批准的 Content Space 同步 capability 和 Identity transport 版本演进外，OpenContent Provider、Collaboration、Project Coordinator 的能力合同、readiness/admission 和 Task Authority 语义保持不变。
- 27 个 domain 全量 typecheck、capability governance、publishable version audit、核心 domain 回归和源码 Electron Provider 凭据四阶段 smoke 已通过。changed-path architecture gate 的 4 个 Host composition 基线项不在本轮 diff，未通过修改 Host 绕过。
- 正式 packaged smoke 尚未完成：canonical `npmRebuild: true` 打包在本机因缺少 Visual Studio C++ Build Tools 而停止。不得用跳过 native rebuild 的诊断包或旧 `dist-latest` 代替该证据。

## 1. 决策摘要

本方案采用最小且清晰的双状态模型：

- 删除 Local Account，不再创建、选择、重命名或退出本地账号。
- 未登录时不产生 Human Principal，本地聊天、Workspace、模型和本地文件仍可使用。
- Keycloak 是 SciForge 唯一的人类身份认证入口。
- Content Space 是统一的、provider-neutral 的内容能力与业务边界。
- OpenContent 只是一个 Content Space Provider Integration，不是 Content Space 本身。
- OpenContent Connection 是当前 Keycloak 用户在当前设备上的 Provider 连接，不是第二种 SciForge 身份。
- SciForge Cloud 与 Content Space 分别显示状态，Content Space 状态中明确显示当前 Provider 为 OpenContent 及其独立登录状态。
- Keycloak 登录成功后不自动弹出 OpenContent 登录窗口。
- 用户必须主动点击“登录 OpenContent”。
- OpenContent 只允许在 Keycloak 用户和 ACTIVE Device 已建立后登录。
- OpenContent 密码和 Session Token 永不上传 SciForge Cloud。
- 当前 Content Space Provider 为 OpenContent 时，用户连接该 Provider 后，Desktop 通过 provider-neutral 路径向 Cloud 发布 Provider Directory Principal Fact。

目标用户流程：

```text
启动 SciForge
  -> 无本地账号，本地功能立即可用
  -> 用户主动登录 SciForge Cloud（Keycloak）
  -> Content Space 显示已安装的 Provider 和连接状态
  -> 页面显示 OpenContent Provider 的独立登录入口
  -> 用户主动登录 OpenContent Provider
  -> 本机加密保存 OpenContent Session Token
  -> Content Space 观察并规范化 Provider 外部主体
  -> 云端记录非敏感的 Provider Directory Principal Fact
  -> 共享文件 Project 根据 Content Space readiness 判定是否可创建
```

## 2. 改造前问题与剩余缺口

### 2.1 Local Account 不是安全账号

现有 Local Account 只提供一个安装内的显示名称和 UUID。它不隔离：

- Workspace；
- 聊天记录；
- 本地文件；
- 模型设置；
- API Key；
- 工具配置；
- 其他安装级数据。

因此 Local Account 不能作为同一台电脑上不同人员之间的安全边界。真正的本地安全边界仍然是操作系统用户账号。

### 2.2 改造前 Keycloak 依赖 Local Account

当前实现要求先选择 Local Account，才能点击 Cloud 登录。OIDC 登录完成后，云端 `usr_*` 和 `dev_*` 也被写入当前 Local Account 行。

当前 Principal 有两种身份形态：

```text
Local Account selected
  -> authority = sciforge.identity-access
  -> subject = Local Account UUID
  -> assurance = local-selection
  -> deviceId = installation ID

Keycloak User + ACTIVE Device
  -> authority = sciforge-cloud
  -> subject = usr_*
  -> assurance = cloud-authenticated
  -> deviceId = dev_*
```

这使 Local Account 成为 Keycloak 登录前不必要的中间层。

### 2.3 改造前 OpenContent 绑定双形态 Current Principal

OpenContent Session Token 的凭据位置由以下内容共同决定：

```text
executionNodeId
Principal authority
Principal subject
Principal assurance
Principal deviceId
providerInstanceRef
connectionId
```

因此，同一个人可能产生两个不同的 OpenContent 凭据槽：

```text
Local Account Principal -> 一份 OpenContent Token
Cloud Principal         -> 另一份 OpenContent Token
```

切换 Local Account、登录 Keycloak、退出 Keycloak，都可能让 OpenContent 看起来突然“未连接”。这是当前账号关系最主要的混乱来源。

### 2.4 云端事实发布链路未闭合

当前 Cloud 协议和服务端已经支持：

```text
provider_directory_principal.publish
```

当前 Desktop 已提供 provider-neutral 的显式同步动作：用户选中 Content Space Provider 并确认后，Desktop 完整观察当前 binding 与目录主体，再发布对应 Fact。Provider Connection 建立本身不会隐藏触发 Cloud 写入；尚未显式同步时，Cloud 仍可能认为该成员没有对应 Provider Instance 的 Content Space 能力。

## 3. 目标与非目标

### 3.1 目标

1. 删除产品和运行时中的 Local Account 身份模型。
2. 保证未登录状态下本地功能正常使用。
3. 让 Keycloak 成为唯一 SciForge 用户身份来源。
4. 保持 Content Space 为统一的 provider-neutral 产品和代码边界。
5. 为 OpenContent Provider 提供独立、明确、可操作的登录状态。
6. 不自动弹出 OpenContent 登录窗口。
7. 将 OpenContent Token 严格隔离到当前云用户和当前设备。
8. 通过公共 Content Space Provider SPI 显式同步非敏感 Provider Principal Fact。
9. 在 Project 创建前给出明确的 Content Space 成员就绪状态。
10. 删除双 Principal、双凭据槽和隐式账号关联。

### 3.2 非目标

本次不实现：

- Keycloak 与 OpenContent 的真正单点登录；
- 使用 Keycloak 密码登录 OpenContent；
- 根据邮箱或显示名称自动合并账号；
- OpenContent Token 云端同步；
- OpenContent Token 跨设备同步；
- 未登录 Keycloak 时使用 OpenContent；
- 本地多用户和本地数据隔离；
- 多个 OpenContent 账号同时绑定同一用户和同一 Provider Instance；
- 把 OpenContent 固化成唯一 Content Space Provider；
- 在 Host、Project 或 Cloud 公共协议中增加 OpenContent 专用分支。

如果未来需要真正的一次登录，需要 OpenContent 原生支持 OIDC，并把 OpenContent 配置为 Keycloak Client 或受信任身份联合方。这属于另一项服务端集成，不在本方案范围内。

## 4. 账号与权限边界

| 概念 | 唯一标识 | 权威方 | 本机保存 | 云端保存 | 能否授权 SciForge Cloud |
| --- | --- | --- | --- | --- | --- |
| SciForge User | `usr_*` | SciForge Cloud | 非敏感投影 | 完整业务用户 | 可以 |
| Keycloak Identity | `issuer + subject` | Keycloak | 加密 OIDC Session | OIDC 绑定 | 用于证明 SciForge User 身份 |
| Desktop Device | `dev_*` | SciForge Cloud | Device 私钥和状态 | Device 状态 | ACTIVE 时可以 |
| Content Space | 无单一账号 ID | SciForge Content Space domain | Provider-neutral references 和本地运行状态 | Project Content binding 与事实 | 不授予 User/Task 权限 |
| ContentSpaceProvider | `providerInstanceRef` | 对应 Provider Integration | Provider adapter 状态 | Provider-neutral Instance 引用 | 不授予 SciForge Cloud 权限 |
| OpenContent Provider Integration | OpenContent Provider Instance | OpenContent integration package | Connector、Provider adapter 和 enrollment UI | 无 Provider 密钥 | 只实现 ContentSpaceProvider SPI |
| OpenContent Account | Provider 外部主体 | OpenContent | 不保存原始身份凭据 | 不上传原始账号 | 不可以 |
| OpenContent Connection | `usr_* + dev_* + Provider Instance` | SciForge Desktop Connector | 加密 Session Token | 仅非敏感事实 | 只能证明连接就绪，不能授予 Project 权限 |

必须遵守以下边界：

- Keycloak 只证明“当前是谁”。
- SciForge Cloud 决定 Project、Task、Agent 和成员权限。
- Content Space 定义目录、文件、共享 Content Container、Provider readiness、portable reference 和操作语义。
- `ContentSpaceProvider` SPI 是 Content Space 使用 Provider 的唯一公共接口。
- OpenContent integration 通过该 SPI 实现一个 Provider，不能成为 Host 或 Project 的直接依赖。
- OpenContent Connector 只拥有 OpenContent endpoint、登录、Session Token、会话验证和传输。
- OpenContent 决定外部目录、文件和 Team 的原生权限。
- Provider Directory Principal Fact 是 provider-neutral 事实，不是 OpenContent ACL，也不是 Task Authority。
- 邮箱、用户名和显示名称不得作为跨系统账号绑定依据。

### 4.1 协议兼容性检查表

本次必须复用的现有协议：

| 现有协议或扩展点 | 当前所有者 | 本次用途 | 处理方式 |
| --- | --- | --- | --- |
| `principalSnapshotSchema` | `@sciforge/domain-sdk` | 表达当前 Human Principal | 协调式删除 `local-selection`，保留 `cloud-authenticated` |
| Capability Broker | Host SDK/Core | 注入当前 Principal、audience 和调用边界 | 原样复用，不增加旁路 IPC |
| `ContentSpaceProvider` SPI | Content Space | 解析 Provider Instance、观察外部绑定、执行内容操作 | 原样复用 |
| `ContentSpaceProvider.attestExternalBinding()` | Content Space | 取得 provider-authenticated、token-free binding attestation | 原样复用 |
| Content Space extended operation `getCurrentPrincipal` | Content Space | 取得同一已验证 Provider Session 的 provider-owned `ContentSpaceDirectoryUserReference` | 原样复用，不新增 SPI 或 capability ID |
| Content Space Provider factory/catalog contribution | Domain SDK + Content Space | 通过 manifest/generated composition 发现 Provider | 原样复用，不硬编码 `opencontent` |
| `ContentSpaceProviderEnrollmentView` | Content Space Renderer contract | 显示 Provider 自有连接界面和 access state | 原样复用，OpenContent 继续作为一个 contribution |
| `DomainMainProviderCredentialStoreHost` | Domain SDK + Host | 保存 Principal/Device/Provider Instance 绑定的 Token | 原样复用 |
| `providerDirectoryPrincipalReferenceSchema` | collaboration-contracts | 表达 provider-neutral 外部目录主体 | 原样复用 |
| `providerDirectoryPrincipalFactPublishCommandSchema` | collaboration-contracts | 构造 Provider Principal Fact 发布命令 | 原样复用 |
| `provider_directory_principal.publish` | Cloud Collaboration | 创建或更新当前 User + Provider Instance Fact | 原样复用 |
| `sciforge.authenticated-cloud-transport` | Identity Access | 执行 token-free Cloud command | 原样复用 |
| Project Content readiness/projection | Cloud Collaboration | Project 创建、成员和 Task 文件能力判断 | 原样复用 |
| `sciforge.domain.json` + generated composition | Domain package architecture | 组合 Identity、Content Space、Provider 和 Collaboration | 原样复用 |

本次明确不新增：

| 禁止新增项 | 结论 |
| --- | --- |
| 新 Cloud command | 不新增 |
| 新 REST API | 不新增 |
| OpenContent 专用 Cloud endpoint | 不新增 |
| 新 Provider Fact Publisher 公共服务 | 不新增 |
| 新 Publisher manifest internal service | 不新增 |
| 新 Provider Fact IPC | 不新增 |
| Renderer 到 Cloud 的直接请求 | 不新增 |
| OpenContent Connector 到 Cloud 的直接请求 | 不新增 |
| Project Coordinator 到 OpenContent Connector 的直接调用 | 不新增 |
| Host 中的 Provider/domain switch | 不新增 |
| `local-selection` 兼容 shim 或双注册 | 不新增 |

唯一允许的 Cloud 写入路径保持为：

```text
Content Space Sync Orchestrator
  -> ContentSpaceProvider.attestExternalBinding()
  -> 同一 pinned ContentSpaceProvider 的现有 getCurrentPrincipal operation
  -> ContentSpaceDirectoryUserReference 映射为现有 ProviderDirectoryPrincipalReference
  -> collaboration-contracts 现有 command schema
  -> AuthenticatedCloudTransport.execute()
  -> SciForge Cloud 现有 provider_directory_principal.publish handler
```

### 4.2 包职责检查表

| 包或边界 | 本次职责 | 明确禁止 |
| --- | --- | --- |
| `@sciforge/domain-sdk` | Principal schema、Capability Broker contract、Provider credential store contract、通用 contribution contract | Provider 专用字段、OpenContent 分支、Cloud 业务命令实现 |
| `identity-access` | 当前 cloud-authenticated Principal、OIDC Session、ACTIVE Device、Device/Agent custody、现有 AuthenticatedCloudTransport | OpenContent 登录、Provider Fact 业务编排、Project/Task 权限 |
| `content-space` | Provider Instance、ContentSpaceProvider SPI、binding attestation、resource reference、readiness/admission | OpenContent Token、Project membership、Task Authority、Provider 专用分支 |
| Content Space Sync Orchestrator | 使用当前 Provider attestation 和现有 `getCurrentPrincipal` 结果组织 Fact 同步，处理 Fact/device revision 和幂等 | 持有 Token、成为新公共协议、直接访问 OIDC Token/Device 私钥、硬编码 OpenContent |
| `opencontent-connector` | OpenContent 登录、Token custody、当前外部主体观察、Provider 原生 API | OIDC Token、Device 私钥、Cloud HTTP、Fact command、Project membership、Task Authority |
| `opencontent-content-space-provider` | 把 OpenContent Connector 适配为 `ContentSpaceProvider` 和 provider-owned enrollment contribution | Cloud command、Project 权限、Host 私有依赖 |
| Cloud Collaboration | 现有 Provider Fact、Project membership、Task Authority、Project Content readiness | Provider Token、OpenContent 原生 API、Local Account |
| `project-coordinator` | 消费 Cloud/Content Space provider-neutral readiness 和 projection，编排 Project/Plan/Task | 直接调用 OpenContent Connector、选择或借用 Connection、构造 Provider credential |
| Renderer | 触发登录、断开、刷新等用户动作并显示状态 | 构造 `usr_*`、`dev_*`、Fact revision、Cloud command、Provider credential |
| Host Core | manifest/generated composition、Capability Broker、通用 SDK contract | `if provider === 'opencontent'`、domain ID switch、双注册、兼容 shim |

## 5. 最终用户界面

### 5.1 顶部状态卡

协同中心顶部保留 Cloud 和 Content Space 两个独立状态。Content Space 卡片必须显示具体 Provider 及其连接状态：

```text
+----------------------+  +----------------------------+
| SciForge Cloud       |  | Content Space              |
| 已登录               |  | Provider：OpenContent      |
| 王学文               |  | OpenContent：未登录 [登录] |
+----------------------+  +----------------------------+
```

未登录 Keycloak 时：

```text
SciForge Cloud：未登录 [登录]
Content Space：OpenContent · 需先登录 SciForge
```

登录 Keycloak 后：

```text
SciForge Cloud：已登录
Content Space：OpenContent · 未登录 [登录]
```

登录 OpenContent 后：

```text
SciForge Cloud：已登录
Content Space：OpenContent · 已登录 [重新验证] [退出]
```

这里的 `Content Space` 是稳定的产品概念；`OpenContent` 是由已安装 Provider contribution 提供的名称。未来增加其他 Provider 时，Cloud、Project 和 Host 不需要增加新的 Provider 专用状态卡或分支。

### 5.2 明确禁止自动弹窗

Keycloak 登录成功后只能执行以下动作：

1. 恢复 `cloud-authenticated` Principal。
2. 静默检查当前用户和设备是否已有 OpenContent Token。
3. 更新 Content Space 中 OpenContent Provider 的连接状态。

Keycloak 登录成功后不得：

- 自动打开 OpenContent 登录窗口；
- 自动聚焦 OpenContent 密码输入框；
- 自动要求用户输入 OpenContent 密码；
- 因 OpenContent 未登录而阻止普通云协作。

只有以下显式操作可以打开 OpenContent 登录界面：

- 用户点击 Content Space 中 OpenContent Provider 的“登录”；
- 用户在启用 Content Space 共享内容的 Project 表单里点击“连接当前 Provider（OpenContent）”；
- 用户在“登录已过期”状态下点击“重新登录”。

### 5.3 状态定义

OpenContent Provider Connection 对用户显示以下状态：

| UI 状态 | 来源 | 可执行动作 |
| --- | --- | --- |
| `需先登录 SciForge` | Cloud Principal 不存在 | 登录 SciForge |
| `检查中` | 正在验证本机 Token | 等待或取消 |
| `未登录` | 当前 `usr_* + dev_*` 没有 Token | 登录 OpenContent |
| `登录中` | 正在交换 OpenContent Session Token | 取消 |
| `已登录` | Token 有效且外部主体验证成功 | 重新验证、退出 |
| `登录已过期` | Token 缺失、无效或 Provider 拒绝 | 重新登录、退出 |
| `暂时不可用` | Provider 或网络不可用 | 重试 |

`检查中` 和 `登录中` 是 Renderer 瞬时状态，不需要新增持久化状态。现有 Connector 的 `disconnected`、`connected` 和 `reauthentication_required` 可以继续作为主进程公开状态。

## 6. Canonical 登录流程

### 6.1 应用启动

```text
Desktop 启动
  -> Principal = null
  -> 不显示 Local Account 首次创建界面
  -> 本地功能立即可用
  -> 尝试恢复已有 OIDC Session
      -> 无 Session：保持未登录
      -> 有 Session：调用 /v1/me
          -> 恢复 canonical usr_*
          -> 重新验证 dev_* 为 ACTIVE
          -> 发布 cloud-authenticated Principal
          -> Content Space 静默检查该 usr_* + dev_* 的 OpenContent Provider 状态
```

恢复 OIDC Session 不得依赖 Local Account 数据库中的账号行或云端链接字段。

### 6.2 Keycloak 登录

```text
用户点击“登录 SciForge”
  -> 系统浏览器 OIDC Authorization Code + PKCE
  -> Desktop 验证 issuer、JWKS、签名、audience、azp、subject 和时间声明
  -> Desktop 调用 SciForge Cloud /v1/me
  -> Cloud 使用 issuer + subject 查找或 JIT 创建 usr_*
  -> Desktop 注册或重新验证 dev_*
  -> 仅当 dev_* 为 ACTIVE 时发布 cloud-authenticated Principal
  -> Content Space 中的 OpenContent Provider 状态变为“检查中”
  -> 静默验证当前用户和设备的 Token
  -> 显示“已登录”“未登录”或“登录已过期”
```

整个流程不得弹出 OpenContent 登录窗口。

### 6.3 OpenContent 登录

```text
用户点击“登录 OpenContent”
  -> Content Space 解析选中的 Provider Instance
  -> Content Space 通过已安装 contribution 选中 OpenContent ContentSpaceProvider
  -> Broker 要求当前 Principal 为 cloud-authenticated
  -> Broker 确认当前 Device 为 ACTIVE
  -> OpenContent provider-owned enrollment view 收集 account + password
  -> 一次性发送到 OpenContent Connector main
  -> Connector 向固定 HTTPS Provider Instance 认证
  -> Provider 返回 Session Token
  -> Connector 使用 Token 查询当前外部主体
  -> Connector 生成 token-free binding attestation
  -> OpenContent Content Space Provider 将证明适配为公共 Content Space contract
  -> account 和 password 立即清除
  -> Session Token 通过 Electron safeStorage 加密保存
  -> provider-neutral sync orchestrator 发布 Provider Principal Fact readiness=ready
  -> Content Space UI 显示“OpenContent 已登录”
```

如果本机 Token 保存成功但 Cloud Fact 发布失败：

- 不回滚或泄露 Token；
- UI 显示“已登录，云端状态同步失败”；
- 提供“重试同步”；
- 启用 Content Space 共享内容的 Project 暂时视为未就绪；
- 重试必须幂等，不得重复创建事实槽。

### 6.4 应用重启与静默恢复

同一个 Keycloak 用户和同一 ACTIVE Device 恢复后：

1. 读取当前 Principal 对应的加密 OpenContent Token。
2. 调用 OpenContent Token 验证接口。
3. 再次观察实际外部主体。
4. 比较新的 binding attestation 与云端当前事实。
5. 相同则保持 `ready`；不同则发布新 revision。
6. Token 无效则显示“登录已过期”并发布 `degraded/provider_unauthorized`。

静默恢复只验证已有 Token，不得自动使用账号密码重新登录。

### 6.5 退出 SciForge Cloud

```text
用户点击“退出 SciForge”
  -> 取消所有绑定旧 Principal 的在途操作
  -> 清除或撤销 OIDC Session
  -> 清除 ACTIVE Device 的当前运行时引用
  -> identityVersion 递增
  -> Principal = null
  -> OpenContent Token 保持加密存储，但立即不可访问
  -> OpenContent UI 显示“需先登录 SciForge”
```

退出 SciForge 不等于退出 OpenContent。这样用户再次登录同一个云账号时，可以静默验证并恢复连接。

### 6.6 退出 OpenContent

```text
用户点击“退出 OpenContent”
  -> 再次确认当前 cloud-authenticated Principal
  -> 删除当前 usr_* + dev_* + Provider Instance 的 Token
  -> 取消该连接的在途 Provider 操作
  -> 发布 degraded/provider_unauthorized
  -> UI 显示“OpenContent 未登录”
```

当前 OpenContent API 不保证远端 Session 撤销，因此 UI 必须准确表达：本操作删除 SciForge 本机连接，不删除 OpenContent 账号或远端文件。

### 6.7 切换 Keycloak 用户

```text
usr_A + dev_1 -> OpenContent Token A
usr_B + dev_1 -> OpenContent Token B
```

切换到 `usr_B` 后：

- 不得读取、验证、显示或使用 Token A；
- 只能检查 Token B 的槽位；
- 所有使用 Token A 的在途操作必须因 Principal 变化而失败；
- UI 不得泄露 `usr_A` 是否连接过 OpenContent。

## 7. 目标 Principal 模型

删除 `local-selection` 后，Host Human Principal 只有两种状态：

```ts
type CurrentHumanPrincipal =
  | null
  | Readonly<{
      authority: 'sciforge-cloud'
      subject: `usr_${string}`
      assurance: 'cloud-authenticated'
      deviceId: `dev_${string}`
      identityVersion: number
    }>
```

Principal 发布条件：

```text
有效 OIDC Session
AND canonical /v1/me User
AND 当前 Device 状态为 ACTIVE
```

任一条件消失时必须发布 `null`，不得回退成安装 ID、Local Account UUID、邮箱或临时用户。

`identityVersion` 在以下事件发生时递增：

- Keycloak 登录；
- Keycloak 退出；
- 当前 canonical User 变化；
- ACTIVE Device 变化；
- Device 被撤销；
- OIDC Session 失效；
- Cloud 身份恢复失败并清除当前 Principal。

每次敏感凭据使用都必须比较完整 Principal，包括 `identityVersion`，从而中止身份变化前捕获的操作。

## 8. OpenContent 凭据模型

### 8.1 稳定凭据槽

OpenContent 凭据槽继续使用通用 package secret store，但稳定身份只能来自 Cloud Principal：

```text
executionNodeId
authority = sciforge-cloud
subject = usr_*
assurance = cloud-authenticated
deviceId = dev_*
providerInstanceRef
connectionId = opencontent-session
```

`identityVersion` 不进入稳定存储键，否则每次重新登录都会孤立同一用户和设备的 Token；但每次读取和使用时必须用完整 Principal 重新校验 `identityVersion`。

### 8.2 敏感数据

允许持久化：

- 加密后的 OpenContent Session Token；
- 非敏感连接状态；
- Provider Instance 引用；
- token-free binding attestation 或其摘要；
- 最后验证时间。

禁止持久化或上传：

- OpenContent 密码；
- 明文 Session Token；
- Keycloak 密码；
- Keycloak Access Token 或 Refresh Token 到 OpenContent 包；
- 原始 OpenContent 内部账号 DTO；
- 可重放的 Provider Authorization Header。

### 8.3 进程边界

- Renderer 只能提交一次性账号和密码，并接收非敏感状态。
- Connector main 独占 Session Token。
- Agent、Task、Project、prompt 和普通 capability input 不能选择或借用 Connection。
- Cloud Collaboration 不能读取 Token。
- 日志、错误、Telemetry 和诊断快照必须对账号、密码、Token 和授权头进行删除或脱敏。

## 9. Content Space Provider Principal Fact 同步

### 9.1 发布内容

同步入口只接受 Content Space 的 provider-neutral `ContentSpaceProvider` 和精确 Provider Instance。Sync Orchestrator 必须从同一个 pinned Provider、同一个完整 Principal lease 中取得两个彼此独立的事实：

1. `ContentSpaceProvider.attestExternalBinding()` 返回 token-free binding attestation，用于计算 `providerBindingAttestationDigest` 和检测 Connection 漂移。
2. 现有 Content Space extended operation `getCurrentPrincipal` 返回 provider-owned `ContentSpaceDirectoryUserReference`，用于构造 `providerPrincipal`。

`externalSubject` 是绑定证明中的 64 位不可逆摘要，不是 Provider directory `principalId`，不得把它直接写入 Provider Principal Fact。当前 OpenContent 成员操作要求 Connector 重验证会话后观察到的真实 `identityId`；现有 `getCurrentPrincipal` 已将该值规范化为 provider-neutral directory user reference，不需要新增 SPI、capability ID 或 OpenContent 专用 DTO。

两项观察都成功且 Provider Instance、Principal 与 binding expectation 完全一致后，Sync Orchestrator 才规范化为：

```text
providerPrincipal:
  schemaVersion: 1
  type: provider_directory_principal_reference
  providerInstance:
    schemaVersion: 1
    type: provider_instance_reference
    providerInstanceRef: <fixed provider instance>
  principalKind: user
  principalId: <ContentSpaceDirectoryUserReference.principalId>

principalIdentityRevision: <current identityVersion>
providerBindingAttestationDigest: sha256(canonical binding attestation)
publishedByDeviceId: <current dev_*>
readiness: ready | degraded
readinessReason: null | provider_binding_changed | provider_unavailable | provider_unauthorized
observedAt: <timestamp>
```

外部主体必须来自当前 `ContentSpaceProvider` 的权威会话观察，不能来自 Renderer、Project payload、binding hash 或用户输入的账号字符串。当前 `providerKind` 为 `opencontent` 时，OpenContent Connector 验证当前 Session 并观察真实 `identityId`，OpenContent Content Space Provider 通过现有 `getCurrentPrincipal` operation 将其适配为公共 Content Space directory user reference。

### 9.2 发布触发点

| 事件 | 当前行为 |
| --- | --- |
| 用户在选中的 Content Space Provider 上显式点击同步并确认 | 完整重观察后发布或更新一个 `ready` Fact |
| Keycloak 登录、应用启动、Provider bind/status/unbind | 不触发隐藏 Cloud 写入 |
| Provider credential 无效、Provider 不可用或目录主体观察失败 | 返回既有 `ContentSpaceResult` 失败，不发布 Fact |
| 当前 Provider binding 或 Principal 在观察期间变化 | `unauthorized`/`conflict` 失败关闭，不发布旧观察 |
| Device revision 在同步期间变化 | 依靠 exact Device CAS 失败关闭，不用其他 revision 代替 |
| Cloud 写入结果无法确认 | `outcome_unknown`，不得自动重试 |

OpenContent bind、status 和 unbind 只管理当前 Provider Connection，不进入 Cloud command 或 Project contract。现有 Collaboration 协议支持 `degraded` Fact，但本阶段的显式同步 capability 只在完整观察成功时发布 `ready`，不会把失败猜测成新的 Cloud 事实。

### 9.3 最小实现边界

不新增第二套 Publisher 公共服务、manifest service、REST API、IPC 或 Cloud command。完成必要的既有合同演进决议后，唯一允许的同步链路仍为：

```text
Content Space Sync Orchestrator
  -> ContentSpaceProvider.attestExternalBinding()
  -> 同一 pinned Provider 的现有 getCurrentPrincipal operation
  -> 映射 ContentSpaceDirectoryUserReference
  -> collaboration-contracts 构造现有 provider_directory_principal.publish command
  -> AuthenticatedCloudTransport.execute()
  -> SciForge Cloud
```

职责和实现约束：

- Sync Orchestrator 是 provider-neutral 的内部 main-process 编排实现，不是新的公共协议或传输服务。
- Sync Orchestrator 通过 Content Space Provider Catalog 解析精确 Provider Instance，并调用既有 `ContentSpaceProvider.attestExternalBinding()`。
- Sync Orchestrator 只使用同一 pinned Provider 的现有 `getCurrentPrincipal` extended operation 取得 `ContentSpaceDirectoryUserReference`；不得扩展 `ContentSpaceProvider` SPI，不得新增第二个 current-principal capability，也不得调用 Connector 私有 API。
- Sync Orchestrator 要求 attestation、directory user reference 和当前完整 Principal 属于同一 Provider Instance 与同一未漂移 lease；任一观察失败或不一致都不得发布 `ready` Fact。
- Sync Orchestrator 使用 `collaboration-contracts` 的现有 schema 构造 `provider_directory_principal.publish`，不复制 DTO 或手写 JSON shape。
- Sync Orchestrator 使用 Identity Access 已公开的 `sciforge.authenticated-cloud-transport` 执行命令，不直接读取 OIDC Token、Device 私钥或 Cloud HTTP 配置。
- Sync Orchestrator 负责读取当前 Fact ID、Fact revision 和精确 Cloud Device entity revision，并处理幂等与冲突；revision 必须来自被架构所有者批准的权威既有合同演进，不能使用 `Principal.identityVersion`、`deviceKeyRevision`、本地语义 revision 或常量代替。
- OpenContent Connector 不调用 Cloud、不构造 Fact、不依赖 collaboration-contracts，只负责登录、Token、会话验证、外部主体观察和 Provider 原生调用。
- OpenContent Content Space Provider 只把 Connector observation 适配为 `ContentSpaceProvider` contract，不调用 Cloud。
- Renderer 只能触发“连接、断开、刷新同步”等用户动作和显示结果，不能构造 `usr_*`、`dev_*`、Cloud command、Fact ID 或 revision。
- Host 只执行 manifest/generated composition 和 Capability Broker，不包含 `if provider === 'opencontent'`、Provider ID switch 或 domain hardcode。

Sync Orchestrator 是 Content Space main package 的私有运行时组件，只在显式同步 capability 被调用时惰性获取现有 transport；普通启动、Provider 列表和读取不会获取 transport 或写 Cloud。它不贡献第二个 Cloud transport service、Publisher service 或 Provider 专用 IPC，唯一 Cloud 出口是现有 `AuthenticatedCloudTransport.execute()`。

### 9.4 协议输入审计与批准演进

阶段三开始前的仓库审计确认两个相互独立的输入缺口：

1. **缺少精确 `expectedDeviceRevision` 来源。** 现有 `providerDirectoryPrincipalFactPublishCommandSchema` 强制要求 Cloud Device entity revision；`AuthenticatedCloudTransport.status()` 只公开 `userId` 和 `deviceId`，`desktopDeviceSummarySchema` 也刻意不公开 entity revision。`DeviceFactAttestationSigningService` 返回的是签名元数据中的 `deviceKeyRevision`，其合同语义不是发布命令要求的 Device CAS revision。现有 `/v1/me/devices` 由 Identity 私有 Cloud client 使用，并不在 token-free `AuthenticatedCloudTransport.execute()` 的封闭命令合同中。
2. **缺少不新增通道时的同步触发上下文。** `DomainMainRuntimeLifecycleContext` 没有当前 Principal 或 Principal subscription；带 `context.caller.principal` 与 `assertPrincipalCurrent()` 的 Host-captured lease 只存在于现有 capability invocation。当前 Content Space capability、system grant 和 Provider enrollment contract 中没有 Provider Principal Fact 同步动作，不能把 Cloud 写入偷偷塞进 read capability，也不能让 Renderer、Connector、Identity、Project Coordinator 或 Host 代为发布。

共同合同评审只批准了两个最小、provider-neutral 的演进，并已原子实施：

1. `sciforge.authenticated-cloud-transport` 从 `2.0.0` 升到 `3.0.0`；ready status 增加必需的 `deviceEntityRevision`，值只来自当前 ACTIVE Cloud Device entity 的 exact revision，并把 `sciforge.content-space` 加入既有服务 ACL。
2. 新增 `content-space.sync-provider-principal` 显式 capability，固定为 `audiences: [ui]`、`scope: global`、`effect: external-write`、`approval: confirmation`、revision none、idempotency required。Host capability invocation 提供当前 Principal lease，输入严格只有 `providerInstanceRef`。

其余部分原样复用：`provider_directory_principal.list` 取得当前 Fact ID/revision；`attestExternalBinding()` 与同一 pinned Provider 的 `getCurrentPrincipal` 取得 binding proof 与 provider-owned directory reference；`AuthenticatedCloudTransport.execute()` 是唯一 Cloud 出口。

明确禁止以下伪方案：

- 把 `Principal.identityVersion`、`deviceKeyRevision`、本地 snapshot revision 或常量 `1` 当成 `expectedDeviceRevision`；
- 先发送错误 revision，再根据 Cloud conflict 猜测当前 revision；
- 让 Content Space、OpenContent Connector 或 Renderer 读取 Identity 私有数据库、Token 或 `/v1/me/devices`；
- 扩展 `AuthenticatedCloudTransport`、Identity capability、Host lifecycle context、IPC、REST、Cloud command、ContentSpaceProvider SPI，或新增 Publisher/manifest service，而没有先完成共同协议决议；
- 把同步编排塞进 Identity Access、OpenContent Provider/Connector、Project Coordinator，或增加 Host 的 Provider 特化分支；
- 让现有 `read` capability 在未声明外部写效果的情况下发布 Cloud Fact。

上述禁止项继续有效。实现没有扩展 Cloud command/server、REST、IPC、Provider SPI、Host lifecycle context 或 Connector 合同，也没有创建 OpenContent 专用路径。

### 9.5 幂等和并发

- 同一逻辑 invocation 与同一规范化 payload 使用同一个确定性 idempotency key；网络重放不能换 key。
- 只有完成一次完整重观察并生成不同 payload 后才生成不同 key。
- 创建事实时 `providerPrincipalFactId` 和 `expectedFactRevision` 同时为空。
- 更新事实时二者必须同时存在。
- list 固定当前 `userId`、exact Provider Instance、`includeDegraded: true`，并断言 Cloud 最多返回一个 Fact slot。
- Fact revision 冲突最多执行一次完整重观察；只有 slot 确实变化且 Device、Principal、binding 均未漂移时才再次发布。
- Principal 或 Device revision 在发布过程中变化时立即失败，不得用旧身份重试。
- publish dispatch 后的异常、非绑定 response 或 Principal lease 变化统一映射为 `outcome_unknown`，不得自动重试。
- 同一个 `usr_* + Provider Instance` 在 Cloud 只有一个当前事实槽。

## 10. Project 创建和成员就绪检查

### 10.1 不使用 Content Space 共享内容的 Project

如果 Project 不启用共享 Content Container 或其他 Content Space 能力：

- 不要求 Owner 建立任何 Content Space Provider Connection；
- 不要求成员具备 Provider Directory Principal Fact；
- 可以正常创建 Project、生成 Plan 和分发不依赖 Provider 文件的 Task。

### 10.2 使用 Content Space 共享内容的 Project

Project 先选择 provider-neutral Content Space Mode 和精确 Provider Instance，再检查 Owner 和目标成员的最新 Provider Directory Principal Fact。当前 Provider contribution 的 `providerKind` 为 `opencontent` 时，界面可以显示 Provider 名称，但 Project contract 不能出现 OpenContent 专用字段：

```text
Content Space Provider：OpenContent
王学文    Content Space 已就绪
成员 A    Provider Connection 未建立
成员 B    Provider Connection 需要重新认证
成员 C    Content Space Provider 暂时不可用
```

只有满足以下条件时才能提交启用 Content Space 共享内容的创建命令：

- 所有要求访问共享内容的 User 都有相同 Provider Instance 的 Fact；
- Fact readiness 为 `ready`；
- 发布 Device 仍有效；
- Fact revision 与创建命令快照一致；
- 不存在跨 User、跨 Provider 或过期快照。

失败时必须返回具体成员和可操作原因。远端基线 `57a2f5b3` 已将 `project-coordinator.plan-draft.generate` 升级为 `2.0.0`，并通过以下现有结果合同表达 Plan 生成失败：

```text
{ status: "failed", reason: "runtime_unavailable" | "runtime_execution_failed" | "invalid_structured_output" }
```

本次不得修改或复制这套 Plan 错误协议。成员 Content Space readiness 错误属于 Project 创建、成员和 provisioning 事实校验，应在各自现有结果/投影中映射为可操作文案，不能重新压成通用 `Handler failed`，也不能塞进 Plan generation failure reason。

推荐错误文案：

```text
成员“李四”尚未建立当前 Content Space Provider（OpenContent）的连接，
无法创建共享 Content Container。请该成员在自己的 ACTIVE Device 上完成连接后刷新状态。
```

Owner 不能替成员输入任何 Provider 凭据，也不能把自己的 Provider Connection 借给成员。Plan 和 Task 只能消费 Project Content binding、portable references 和 Content Space readiness，不能携带 OpenContent Token、原生账号或 Connection selector。

## 11. 具体代码修改

### 11.1 ADR、Context Map 与 Identity 公共契约

在修改运行时代码前先完成协议决议：

- 新增 ADR，正式决定删除 Local Account 和 `local-selection`；
- 标记 ADR-0014、ADR-0019 和 ADR-0026 被新决议取代；
- 更新 `CONTEXT-MAP.md`，把 Human Principal 改为 `null | cloud-authenticated`；
- 更新 Identity Access README，删除 Local Account 作为当前能力的描述；
- 更新 Identity contract 目标形态，删除 `identity.local.*`、`LocalAccount` 和 `LocalCloudIdentityLink`；
- 记录 `@sciforge/domain-sdk/principal` 是协议级破坏性变更；
- 列出所有 Principal producer、Capability Broker consumer、Provider credential test fixture 和 domain test 的迁移范围。

不得在文档仍描述双身份模型时先合入新的 cloud-only 生产路径。

### 11.2 `packages/domain-sdk`

- 从 `principalSnapshotSchema` 的 assurance 中删除 `local-selection`。
- 保留 `cloud-authenticated` 及完整 `authority/subject/deviceId/identityVersion` 校验。
- 审计所有需要 Human Principal 的 capability。
- 本地无身份功能必须显式允许 `principal = null`，不得制造 anonymous Principal。
- 云端、Provider credential 和跨用户敏感能力继续要求 `cloud-authenticated`。
- 同一 merge unit 内更新所有编译消费者和测试 fixture，不保留兼容 enum、alias 或 fallback parser。

### 11.3 `packages/domains/identity-access`

删除：

- `identity.local.inspect`；
- `identity.local.list-accounts`；
- `identity.local.create-account`；
- `identity.local.select-account`；
- `identity.local.rename-account`；
- `identity.local.exit-account`；
- `identity.local.dismiss-first-prompt`；
- `identity.local.backup-and-reset`；
- `LocalAccount`、`LocalCloudIdentityLink` 和相关 schema；
- Local Account 首次创建、列表、重命名、退出和重置 UI；
- Keycloak 登录对 `localAccountSelected` 的依赖；
- `LocalCloudIdentityLinkService`；
- `accounts` 和 `identity_state` 作为当前 Principal 来源的逻辑；
- `local-selection` Principal 回退。

替换：

- 用 Cloud Principal Controller 直接维护当前 `usr_*`、`dev_*` 和 `identityVersion`；
- OIDC 恢复后直接通过 `/v1/me` 和 Device revalidation 重建 Principal；
- 将原账户 Overlay 改为只显示 SciForge Cloud 登录状态和退出动作；
- Signed-out 状态发布 `principal: null`。

优先检查文件：

- `src/contract.ts`；
- `src/main/store.ts`；
- `src/main/service.ts`；
- `src/main/cloud-link-service.ts`；
- `src/main/cloud-runtime.ts`；
- `src/main/index.ts`；
- `src/renderer/IdentityAccountOverlay.tsx`；
- `src/renderer/CloudIdentitySection.tsx`；
- `src/renderer/messages.ts`。

Identity Access 继续拥有并只拥有：

- OIDC Session 与 `/v1/me`；
- 当前 canonical User；
- ACTIVE Device 和 Device/Agent credential custody；
- Principal 发布和 identityVersion fencing；
- 现有 `sciforge.authenticated-cloud-transport`。

Identity Access 不构造 Provider Principal Fact，不依赖 OpenContent，也不成为 Provider Fact Publisher。

### 11.4 `packages/domains/content-space`

- 保持 Content Space 为所有外部内容空间能力的 provider-neutral 入口。
- 复用现有 Provider Instance directory、Provider factory/catalog 和 `ContentSpaceProvider` SPI。
- 复用 `ContentSpaceProvider.attestExternalBinding()` 和 `contentSpaceExternalBindingAttestationSchema`。
- 复用现有 extended operation `getCurrentPrincipal` 和 `ContentSpaceDirectoryUserReference`；不修改 Provider SPI、capability ID、readiness 或 admission 语义。
- Content Space readiness、admission、resource reference 和 Content Container 语义不得出现 OpenContent 专用字段。
- Content Space Renderer 继续通过 `ContentSpaceProviderEnrollmentView` contribution 显示 Provider 自有连接 UI。
- 增加架构测试，使用 mock Provider 证明同步和 Project readiness 不依赖 `providerKind='opencontent'`。

不得为 Fact 同步新增平行 Provider catalog、第二套 attestation API 或 OpenContent 专用 Content Space capability。

### 11.5 `packages/domains/opencontent-connector`

- `connection-capabilities.ts` 只接受 `cloud-authenticated`。
- 删除“connection belongs to current Local Account”文案。
- 改为“此连接属于当前 SciForge Cloud 用户和当前设备”。
- 保留现有 `disconnected | connected | reauthentication_required` 主状态。
- Keycloak 未登录时，Renderer 派生“需先登录 SciForge”，不调用 Connector status capability。
- 保留 Session Token 仅 main-process 可见的边界。
- 每次 Provider 调用继续通过 `expectedPrincipal` 重新验证完整 Principal。
- 继续只负责 OpenContent 登录、Token 保存、外部主体观察和 Provider 原生调用。
- 不导入 collaboration-contracts 的 Cloud command，不获取 AuthenticatedCloudTransport，不读取 Project/Task 状态。

优先检查文件：

- `src/contract.ts`；
- `src/main/connection-capabilities.ts`；
- `src/main/connection-service.ts`；
- `src/main/provider-credential-runtime.ts`；
- `src/renderer/OpenContentEnrollment.tsx`；
- `README.md`。

### 11.6 `packages/domains/opencontent-content-space-provider`

- 继续通过 manifest contribution 提供 `ContentSpaceProvider` factory 和 `ContentSpaceProviderEnrollmentView`。
- 把 OpenContent Connector 的当前会话观察适配为公共 Content Space binding attestation。
- 保留现有 `getCurrentPrincipal` operation：由 Connector 重验证当前 Session，返回真实 OpenContent `identityId` 对应的 provider-neutral directory user reference；不得返回 Token 或原始账号 DTO。
- 将 Connector 状态映射为 `ready | human_action_required | unavailable` 的 provider-neutral access state。
- `providerKind='opencontent'` 只能存在于该 Provider integration 自己的定义、manifest 和 provider-owned UI 中。
- 不调用 Cloud、不构造 Provider Fact、不读取 Project membership 或 Task Authority。

### 11.7 Content Space Sync Orchestrator

Sync Orchestrator 是 provider-neutral 的内部编排组件，不是新公共服务。实现前必须先确认它可以通过当前 generated composition 获得：

- Content Space 当前 Provider Instance 和既有 Provider catalog；
- `ContentSpaceProvider.attestExternalBinding()`；
- 同一 pinned Provider 的现有 `getCurrentPrincipal` extended operation；
- Identity Access 现有 `sciforge.authenticated-cloud-transport`；
- collaboration-contracts 的现有 command/response schema。

它的实现必须严格保持：

```text
attestExternalBinding
  -> existing getCurrentPrincipal
  -> map ContentSpaceDirectoryUserReference
  -> existing provider_directory_principal.publish schema
  -> existing AuthenticatedCloudTransport.execute
```

不得新增 Publisher manifest service、Cloud command、REST、IPC 或 Host route。若 Orchestrator 所属 module 需要消费现有 authenticated transport，只允许更新现有 service 的 `allowedConsumerModuleIds` 并通过 manifest/generated composition 校验，不能复制 transport 或绕过 allowlist。

Orchestrator 不持有 Token，不导入 OpenContent Connector 私有 API，不接受 Renderer 提供的 User ID、Device ID、Fact ID 或 revision。

### 11.8 `src/main/domain-package-storage.ts`

- 保留通用 provider credential store。
- 确认稳定键只使用 Cloud Principal 的稳定身份字段。
- 保留完整 Principal 和 `identityVersion` 的每次使用检查。
- 增加身份变化、Device 撤销和取消信号的覆盖测试。
- 不增加凭据 list/export API。

### 11.9 Cloud Collaboration

- 复用现有 `provider_directory_principal.publish` command。
- 确认部署版本包含 command schema、API handler 和 service handler。
- 继续拥有 Provider Fact、Project membership、Task Authority 和 Project Content readiness。
- 不增加 OpenContent 专用字段、endpoint 或 server handler。
- 不修改 Keycloak 配置。
- 不要求 OpenContent 服务端增加 SciForge 专用 API。

优先检查文件：

- `packages/collaboration-contracts/src/cloud-state-protocol.ts`；
- `packages/collaboration-contracts/src/project-content.ts`；
- `packages/collaboration-server/src/api.ts`；
- `packages/collaboration-server/src/service.ts`。

### 11.10 `packages/domains/project-coordinator`

- 在启用 Content Space 共享内容时显示成员 provider-neutral readiness。
- 内容无关 Project 不读取或要求 Provider Fact。
- Content Space 模式只允许选择同一 Provider Instance 下的 `ready` Facts。
- 将 Cloud/Provider 结构化错误映射为成员级可操作文案。
- Plan Draft 生成失败时保留原始结构化错误码，不再统一压成 Handler failed。
- 保留 `plan-draft.generate@2.0.0` 的 structured output 合同和 `DomainMainAgentExecutionHost.outputSchema`，不新增登录或 Provider 专用错误结果。
- 保留 planning-ready 与实际 Task `eligible` 的区别：`draft/paused + project_paused` 只可作为 Plan 构建证据，Offer/claim/execution 仍必须要求 Cloud `eligible`。
- 只消费 Cloud projection、Provider Principal Fact、Project Content readiness 和 Content Space references。
- 不导入或调用 OpenContent Connector，也不在 contract 中出现 `providerKind='opencontent'` 分支。

### 11.11 Renderer 与 Host

- Renderer 只触发登录、断开、重新验证和刷新状态等用户动作。
- Renderer 不构造 `usr_*`、`dev_*`、Provider Fact command、Fact revision 或 Provider credential。
- Host 继续只做 manifest/generated composition 和 Capability Broker。
- Host Core 不新增 Provider/domain switch、OpenContent import、平行 IPC、兼容 shim 或双注册。
- 删除仍把 Local Account 描述为当前产品能力的文档、generated capability 和测试断言。

## 12. 旧数据处理

本方案针对当前测试阶段采用直接迁移，不保留双路径兼容。

### 12.1 保留的数据

- Workspace；
- 聊天记录；
- 本地文件；
- 模型设置；
- API Key 和工具配置；
- 合法的 OIDC Session Store；
- Device 私钥和可重新验证的 Device 注册信息。

这些数据本来就不由 Local Account 隔离。

### 12.2 删除的数据

- Local Account 行；
- 当前 Local Account 选择；
- Local Account 首次提示状态；
- Local Account 与云用户的链接投影；
- 使用 `local-selection` Principal 保存的 OpenContent Token；
- 已无消费者的 identity local capability 状态。

### 12.3 OpenContent 凭据策略

最简单且最安全的发布策略是：新版首次使用要求重新登录一次 OpenContent。

不得把旧 Local Account Token 自动迁移到 `usr_*`，因为 Local Account 不是经过认证的用户身份。

当前实施采用现有存储边界内的“删除身份来源并使旧槽不可达”策略：

1. Identity schema migration 删除旧 Account 行和 selection state。
2. `principalSnapshotSchema` 只接受 `cloud-authenticated`，旧 Principal 不能进入 Provider credential access。
3. Provider credential 稳定键包含 Principal authority、subject、assurance、Device 和 Provider binding；Cloud Principal 不会命中旧槽。
4. 不复制、不重命名、不猜测归属，也不向 Renderer 或 Connector 增加 credential 枚举/导出能力。
5. 旧加密槽只能随既有的整包 secret reset/应用数据清理边界被删除；正常运行时保持不可寻址。
6. 用户登录 Keycloak 后重新登录一次 OpenContent，生成新的 Cloud Principal 绑定。

该策略不保留兼容登录路径，也不会把旧 Token 借给新的 Cloud Principal。

## 13. 安全要求

| 风险 | 必须采取的控制 |
| --- | --- |
| Keycloak 用户切换后误用旧 Token | 凭据键包含 `usr_* + dev_*`，每次使用比较完整 Principal |
| 退出后在途操作继续执行 | identityVersion 递增、AbortSignal 取消、回调内再次检查 Principal |
| Renderer 获取 Token | Token 只存在于 Connector main 和 bounded callback |
| 密码落盘或进入日志 | 密码只存在于一次性 form/request，完成后清除并统一脱敏 |
| 按邮箱绑定错误账号 | 只使用 Keycloak `issuer + subject` 和当前 ContentSpaceProvider 的实际主体观察 |
| 云端泄露 Provider 凭据 | Cloud 只接收 opaque principal、digest、readiness 和 revision |
| Cloud Fact 已就绪但 Token 已失效 | 启动、恢复和执行前复验，失败发布 degraded |
| 被撤销 Device 继续发布 | Cloud 校验 ACTIVE Device 和 expected Device revision |
| Owner 借用自己的连接给成员 | Connection 由执行节点当前 Principal 固定选择，payload 不接受 connection selector |
| 同一 Windows 用户被多人共享 | 明确以操作系统账号作为本地安全边界 |

## 14. 错误与恢复

| 场景 | UI 状态 | Cloud Fact | 用户动作 |
| --- | --- | --- | --- |
| Keycloak 未登录 | 需先登录 SciForge | 不发布 | 登录 SciForge |
| Device 未 ACTIVE | Cloud 设备不可用 | 不发布 | 恢复或重新注册 Device |
| OpenContent 凭据错误 | 登录失败 | 不发布 ready | 检查账号密码 |
| Token 过期 | 登录已过期 | degraded/unauthorized | 重新登录 |
| Provider 离线 | 暂时不可用 | degraded/unavailable | 稍后重试 |
| 外部账号发生变化 | 需要确认账号变化 | degraded/binding_changed | 重新确认登录 |
| Secure Storage 不可用 | 无法安全保存 | 不发布 ready | 修复系统安全存储 |
| Fact 发布冲突 | 已登录，状态同步失败 | 保留当前 Fact | 读取最新 revision 后重试 |
| Fact 发布网络失败 | 已登录，状态同步失败 | 未更新 | 重试同步 |

Provider Connection 建立成功和 Cloud Fact 发布成功是两个可恢复步骤。当前 Provider 为 OpenContent 时，不得因为网络同步失败而重新提交 OpenContent 密码。

## 15. 实施顺序

### 阶段零：协议决议和消费者清单

先完成并评审：

1. 新 ADR：删除 Local Account 和 `local-selection`。
2. 更新 `CONTEXT-MAP.md`：Human Principal 只有 `null | cloud-authenticated`。
3. 更新 Identity README 和 target contract。
4. 确认 `principalSnapshotSchema` 的破坏性变更范围。
5. 使用全仓检索列出所有 `local-selection`、`identity.local.*`、`LocalAccount` 和 `LocalCloudIdentityLink` 消费者。
6. 确认没有生产数据兼容要求，不设计 shim、alias 或双注册。

阶段零只确定最终协议和原子切换范围，不增加第二条运行时路径。

### 阶段一：Cloud-only Identity 原子切换

阶段一必须作为一个可独立通过 composition、typecheck 和 tests 的 merge unit 完成：

1. 添加不依赖 Local Account 的 Cloud Principal Controller。
2. 让 Keycloak 登录按钮始终可用。
3. 让 OIDC `/v1/me` 和 Device ACTIVE 直接产生 Principal。
4. Signed-out 状态改为 `null`。
5. 删除 Local Account UI、capability 和 store 依赖。
6. 删除 `local-selection` 生产引用和测试。

阶段一完成后，应用必须能在没有本地账号的情况下启动、登录和退出 Keycloak；signed-out 时 Principal 为 `null`，不依赖 Human Principal 的本地能力继续可用，依赖 Principal 的 Provider/Cloud 能力按合同 fail closed。

不得先保留旧 Local Principal producer，再并行增加 cloud-only producer；不得让 schema 同时接受新旧两套 assurance 作为过渡。

### 15.1 阶段一最小 diff 范围

协议和生产实现：

- `docs/adr/<new-remove-local-account-adr>.md`；
- `CONTEXT-MAP.md`；
- `packages/domain-sdk/src/principal.ts`；
- `packages/domains/identity-access/README.md`；
- `packages/domains/identity-access/src/contract.ts`；
- `packages/domains/identity-access/src/main/service.ts`；
- `packages/domains/identity-access/src/main/store.ts`，删除 Local Account store 或缩减为真正仍需的 cloud-only 状态；
- `packages/domains/identity-access/src/main/cloud-link-service.ts`，删除 Local Account link owner；
- `packages/domains/identity-access/src/main/cloud-runtime.ts`；
- `packages/domains/identity-access/src/main/index.ts`；
- `packages/domains/identity-access/src/renderer/CloudIdentitySection.tsx`；
- `packages/domains/identity-access/src/renderer/IdentityAccountOverlay.tsx`，替换为 cloud-only account surface 或删除旧 contribution；
- `packages/domains/identity-access/src/renderer/projection.ts`；
- `packages/domains/identity-access/src/renderer/messages.ts`；
- `packages/domains/identity-access/sciforge.domain.json`，只调整现有 contribution，不双注册；
- `packages/domains/opencontent-connector/src/main/connection-capabilities.ts`，删除 `local-selection` 授权分支。

必须同步更新的测试和 fixture 范围：

- `packages/domain-sdk/src/principal.test.ts`、`package-storage.test.ts`、`portable-resource-references.test.ts`；
- `packages/domains/identity-access/src/main/*.test.ts` 和 `src/renderer/*.test.tsx`；
- Content Space 及 mock Provider 中使用 `local-selection` fixture 的 tests；
- OpenContent Connector 和 OpenContent Content Space Provider 中使用 `local-selection` fixture 的 tests；
- Host Principal、Capability Broker、provider credential storage 和 provider credential acceptance tests；
- biology-room、browser-preview、change-inspector、remote-ssh 等仅把 `local-selection` 当 Principal fixture 的 tests。

`opencontent-client.ts` 中 Provider API 的 `currentAccount` 是 OpenContent 原生“当前外部账号”语义，不是 SciForge Local Account，不能因字符串相似而删除。

### 15.2 阶段一验证门槛

至少运行：

```bash
npm run domain-packages:generate
npm run domain-packages:check
npm run domain-sdk:typecheck
npm run domain-sdk:test
npm --workspace @sciforge/domain-identity-access run typecheck
npm --workspace @sciforge/domain-identity-access run test
npm --workspace @sciforge/domain-project-coordinator run typecheck
npm --workspace @sciforge/domain-project-coordinator run test
npm run identity:keycloak:check
npm run architecture-principles:test
npm run typecheck
npm test
```

并执行静态审计：

```bash
rg -n "local-selection|identity\.local\.|LocalAccount|LocalCloudIdentityLink" packages src
rg -n "if .*opencontent|provider.*===.*opencontent" src packages/domains/content-space packages/domains/project-coordinator
```

第一条在生产路径必须无结果；允许历史 ADR 明确标注已被取代。第二条只允许 OpenContent integration 自己的 Provider 定义或测试断言，不允许 Host、Content Space core 或 Project Coordinator 出现 Provider 硬编码路由。

Project Coordinator 回归还必须证明 `plan-draft.generate@2.0.0`、`DomainMainAgentExecutionHost.outputSchema`、planning-ready 与实际 `eligible` Task Authority 语义未被登录改动改变。

### 阶段二：Content Space Provider Connection 状态

1. OpenContent capability 改为只接受 Cloud Principal，保持其为 Provider implementation。
2. Content Space 状态卡通过现有 enrollment contribution 显示 `OpenContent · 未登录/已登录`。
3. 禁止 Keycloak 登录后自动弹窗。
4. 完成 Keycloak 退出锁定、重新登录静默验证、OpenContent 单独退出。
5. 清理旧 Local Account 凭据。
6. 使用 mock Provider 验证 Content Space core 不依赖 OpenContent。

阶段二验证至少包括对应 Content Space、OpenContent Connector、OpenContent Content Space Provider tests，以及 `domain-packages:check` 和 `domain-packages:typecheck`。

当前实施结果：

- `OpenContent` 仍只在 Connector/Provider Integration 内出现，Content Space core 继续按 `providerKind` 和既有 enrollment contract 组合任意 Provider。
- Provider-owned enrollment 已显示 `OpenContent · 未登录`、`OpenContent · 已登录` 和 `OpenContent · 登录已过期`，未修改 Content Space 公共 view contract。
- Identity renderer 启动只加载 Cloud projection，不调用 global overlay；Content Space 在用户选择 Provider 或打开显式 Provider 资源前不读取、不渲染 enrollment。
- Host/Broker 集成回归证明 signed-out 时 OpenContent status 在读取 credential 或发起 Provider HTTP 前失败；同一 Cloud 主体和 Device 以新 `identityVersion` 恢复后只调用 Token validation/current-account observation，不再次调用 `UserLogin`。
- 现有 `opencontent.connection.unbind` 独立删除当前 Cloud Principal、Device 和 Provider Instance 的本机 Token，随后 status 为 `disconnected`。
- Identity Account 行已由 schema migration 删除；旧 `local-selection` credential 无迁移、alias、fallback 或枚举路径，在当前合同下不可寻址。
- `content-space-mock-provider` 通过同一 SPI 完成 create/list/observe/upload/download 回归，证明 Content Space core 不依赖 OpenContent。
- 验证结果：Content Space `241/241`、mock Provider `10/10`、OpenContent Provider `213/213`、阶段二 Host lifecycle `9/9`、Connector enrollment UI `13/13`；`domain-packages:check` 与 `domain-packages:typecheck` 通过。Connector 全量为 `299/304`，其余 5 项仍是既有 Windows 路径分隔符/环境断言，不属于身份或 Provider contract 回归。

### 阶段三：Content Space Provider Fact 同步（已实施）

共同合同评审已按 9.4 批准并实施两个最小演进：Transport 3.0.0 暴露 exact ACTIVE Device entity revision，显式 UI capability 提供 Host-captured Principal lease。没有新增 Cloud command、server endpoint、REST、IPC、Provider SPI、Publisher service 或 Host Provider 分支。

已完成实现：

1. 完成 provider-neutral 共同合同演进，同时解决精确 Device entity revision 和 Principal lease 触发上下文。
2. 实现 Content Space 私有 Sync Orchestrator，不新增第二套 Publisher public service。
3. 通过 `ContentSpaceProvider.attestExternalBinding()` 获取证明。
4. 通过同一 pinned Provider 的现有 `getCurrentPrincipal` 取得 `ContentSpaceDirectoryUserReference`；禁止使用 `externalSubject` hash、邮箱、Renderer input 或 Project payload 作为 `principalId`。
5. 将 directory user reference 映射到现有 `ProviderDirectoryPrincipalReference`，不修改 Content Space SPI 语义。
6. 使用现有 collaboration-contracts 构造 `provider_directory_principal.publish`。
7. 只通过现有 `AuthenticatedCloudTransport.execute()` 写入 Cloud。
8. 实现确定性幂等、一次完整 Fact CAS 重观察、Device/binding/Principal 漂移失败关闭和 `outcome_unknown` 分流。
9. Renderer 仅以 confirmation 调用选中的 Provider Instance；未选择、enrollment ready、Keycloak 登录和启动均不自动同步。
10. 验证现有 Cloud API，不新增 endpoint。

阶段三验证结果：Content Space 15/15 files、255/255 tests；Identity 18/18 files、128/128 tests；Collaboration 111/111；Project Coordinator 110/110；Mock Provider 10/10；OpenContent Provider 213/213；Connector 本轮身份/凭据路径 116/116。27 个 domain 全量 typecheck、composition check、capability governance 和 publishable version audit 通过。架构扫描没有发现 OpenContent 专用 Publisher、REST、IPC、Host route 或平行 Cloud command。

### 阶段四：Project Content Space 就绪体验

1. 显示 Owner 和成员的 Content Space readiness，并附当前 Provider 显示名称。
2. 只对启用 Content Space 共享内容的模式执行 Provider 预检。
3. 使用现有 Project/Content readiness 结果映射结构化成员错误；保持 Plan generation v2 的失败结果独立不变。
4. 完成真实双用户、双设备协同测试。

Project Coordinator tests 必须使用 provider-neutral Facts 和 references；除 Provider integration UI 文案外，不得以 `opencontent` 作为业务分支条件。

### 阶段五：Source 与 Packaged 安全验证

涉及 Token 和 safeStorage 的最终改动必须验证两条路径：

```bash
npm run smoke:provider-credentials:source
npm run smoke:provider-credentials:packaged:build
npm run smoke:electron:source:cloud
npm run smoke:electron:packaged:build
```

同时检查 packaged composition、DPAPI/safeStorage、身份切换 fencing、旧凭据清理和日志脱敏。

## 16. 测试矩阵

### 16.1 Identity

- 全新安装无需创建本地账号即可进入应用。
- 无网络、无账号时本地 Workspace 和聊天可用。
- Keycloak 登录不要求 Local Account。
- `/v1/me` 成功但 Device 非 ACTIVE 时 Principal 仍为 `null`。
- Keycloak 退出后 Principal 变为 `null`。
- 代码库中不存在生产 `local-selection` 分支。
- 代码库中不存在 `identity.local.*` capability 注册。

### 16.2 Content Space 与 OpenContent Provider

- Keycloak 未登录时不能调用 bind/status/unbind 敏感路径。
- Keycloak 登录后不自动打开 OpenContent 登录界面。
- 用户点击按钮后可以完成 OpenContent 登录。
- Content Space 通过 `ContentSpaceProviderEnrollmentView` contribution 显示 OpenContent 连接状态。
- Content Space core、Host 和 Project Coordinator 不直接导入 OpenContent Connector。
- mock Provider 可以通过同一 ContentSpaceProvider SPI 完成 access/readiness 测试。
- 密码和 Token 不出现在日志、Renderer state、错误或 Cloud 请求中。
- 同一用户同一设备重启后可以静默恢复。
- 同一用户换设备后必须重新登录 OpenContent。
- 同一设备切换用户后不能访问前一用户 Token。
- Keycloak 退出后 Token 被锁定。
- OpenContent 退出后 Token 被删除。
- identityVersion 变化会中止在途 Provider 操作。

### 16.3 Provider-neutral Cloud Fact

- 当前 Content Space Provider Connection 和 binding attestation 验证成功后发布 `ready`。
- 当前 Provider credential 过期后发布 `degraded/provider_unauthorized`。
- 当前 Content Space Provider 不可用时发布 `degraded/provider_unavailable`。
- Provider 外部主体变化后发布 `degraded/provider_binding_changed`。
- 重复发布具有幂等结果。
- 错误 revision 不覆盖较新的 Fact。
- 非 ACTIVE Device 无法发布。
- Cloud 存储和日志中不存在 Token、密码和原始授权头。
- 同步只调用现有 `provider_directory_principal.publish` 和 `AuthenticatedCloudTransport.execute()`。
- 生产 manifest 中不存在第二个 Publisher/Cloud transport service。

### 16.4 Project

- 不使用 Content Space 共享内容的 Project 不要求任何 Provider Connection。
- 使用 Content Space 共享内容的 Project 在 Owner 未就绪时给出 Owner 级错误。
- 成员未就绪时列出准确成员。
- 所有成员就绪后可以创建 Project。
- Project 创建快照准确的 Fact ID 和 revision。
- Fact stale、degraded、跨 User 或跨 Provider 时服务端 fail closed。
- Project/Plan/Task contracts 只携带 provider-neutral readiness、binding 和 portable references。
- Project Coordinator 中不存在 OpenContent Connector 调用或 `providerKind='opencontent'` 业务分支。

### 16.5 打包验证

- Source 模式登录和连接正常。
- Windows packaged 应用可以使用 DPAPI/safeStorage。
- 安装升级后不再出现 Local Account 页面。
- 旧 Local Account OpenContent Token 被删除或不可访问。
- 打包产物中不包含已删除的 Local Account Renderer contribution。

## 17. 验收标准

本方案只有在以下条件全部满足时才算完成：

1. 用户首次启动不再看到 Local Account。
2. 离线本地功能不要求任何账号。
3. Keycloak 可以直接登录。
4. Keycloak 登录后不自动弹出 OpenContent 登录窗口。
5. Cloud 和 Content Space 有两个独立状态区域。
6. Content Space 明确显示当前 Provider 为 OpenContent 及其独立登录状态。
7. OpenContent 必须由用户主动点击登录。
8. OpenContent Token 只属于当前 `usr_* + dev_*`。
9. 切换 Keycloak 用户不会串用 OpenContent Token。
10. 当前 ContentSpaceProvider 的连接证明能够通过现有 Cloud 协议同步为 provider-neutral Fact。
11. 共享文件 Project 能根据 Content Space readiness 准确显示每位成员状态。
12. 不使用 Content Space 的 Project 不被 Provider 未连接阻止。
13. 密码和 Token 不进入 Renderer、Agent、日志或 Cloud。
14. 生产代码中不再存在 Local Account 和 `local-selection` 路径。
15. Content Space core、Cloud Collaboration、Project Coordinator 和 Host 不包含 OpenContent 专用分支。
16. 没有新增 Cloud command、REST、IPC、Publisher service 或平行 transport。

## 18. 最终产品规则

最终对用户只需要解释五句话：

1. 不登录账号也可以使用 SciForge 的本地功能。
2. Keycloak 登录用于 SciForge Cloud 和多人协作。
3. Content Space 是 SciForge 使用外部内容空间的统一入口。
4. OpenContent 是当前安装的一个 Content Space Provider，有独立登录状态，需要用户主动连接。
5. OpenContent 登录信息只保存在当前设备，Cloud 只接收 provider-neutral 非敏感事实。

这是本次改造必须保持的最简单产品模型。
