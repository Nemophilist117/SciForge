# Content Space Provider Principal Fact 同步共同协议变更请求

> 状态：共同合同评审通过，批次 A/B/C 已实施并通过回归
>
> 日期：2026-08-28
>
> 实施基线：`origin/test_colab@5580666432da02bb18c1ff77af0162c8ef20957f`
>
> 提议方：Identity Access
>
> 评审方：Content Space / Capability Broker、Cloud Collaboration

## 1. 请求摘要

Identity Access 已完成 Cloud-only Human Principal 改造，并同意对现有
`sciforge.authenticated-cloud-transport` 做一次版本化、最小范围的合同演进。

本请求希望完成一个 provider-neutral 的闭环：当当前 SciForge Cloud Principal
连接某个 Content Space Provider 后，Desktop 使用现有 Cloud Collaboration 命令发布
非敏感 `ProviderDirectoryPrincipalFact`，使共享 Content Space Project 能依据现有
readiness projection 判断成员是否就绪。

本次只申请两个共同协议变化：

1. 版本化扩展现有 `AuthenticatedCloudTransport` ready status，增加当前 ACTIVE
   Cloud Device 的权威 entity revision，并允许 `sciforge.content-space` 消费该现有服务。
2. 在 Content Space 增加一个 provider-neutral、明确声明为 `external-write` 的同步
   capability。它通过现有 Host Capability Broker 获得当前 Principal lease，并在
   Content Space main process 内组织现有协议调用。

本次不新增 Cloud API、Cloud command、IPC、Host route、Publisher service、
`ContentSpaceProvider` SPI 方法或 OpenContent 专用协作协议。

## 2. 为什么需要这次变化

现有发布链路的大部分合同已经存在：

```text
ContentSpaceProvider.attestExternalBinding()
  -> 同一 pinned Provider 的 getCurrentPrincipal
  -> provider_directory_principal.list
  -> provider_directory_principal.publish
  -> AuthenticatedCloudTransport.execute()
  -> SciForge Cloud
```

当前只有两个输入缺口。

### 2.1 缺少精确 Device entity revision

现有 `providerDirectoryPrincipalFactPublishCommandSchema` 强制要求：

```text
deviceId
expectedDeviceRevision
```

`AuthenticatedCloudTransport.status()` 当前只公开 `userId` 和 `deviceId`。Identity
已经通过 `/v1/me/devices` 取得并重验证完整 ACTIVE Device，但没有通过现有内部服务
合同公开该 Device 的 entity `revision`。

以下值都不能代替 `expectedDeviceRevision`：

- `Principal.identityVersion`；
- Device 签名元数据中的 `deviceKeyRevision`；
- Desktop snapshot semantic revision；
- 常量、猜值或根据 Cloud conflict 反向试探出的值。

### 2.2 缺少带 Principal lease 的正式同步动作

`DomainMainRuntimeLifecycleContext` 不提供当前 Principal 或 Principal subscription。
现有 capability invocation 才提供 Host 捕获的：

```text
context.caller.principal
context.assertPrincipalCurrent()
```

Provider Fact 发布是 Cloud 外部写入，不能隐藏在 `read` capability、Provider status
读取或 Host lifecycle 中。因此需要一个明确声明 effect、audience、approval 和
idempotency 的 Content Space capability。

## 3. 提议一：演进现有 Authenticated Cloud Transport

### 3.1 合同变化

当前 ready status：

```ts
type ReadyAuthenticatedCloudTransportStatus = {
  state: 'ready'
  baseUrl: string
  userId: string
  deviceId: string
}
```

固定升级后的合同版本为 `3.0.0`，ready status 为：

```ts
type ReadyAuthenticatedCloudTransportStatus = {
  state: 'ready'
  baseUrl: string
  userId: string
  deviceId: string
  deviceEntityRevision: number
}
```

字段必须使用 collaboration-contracts 现有 `revisionSchema`，其语义固定为：

> Identity 最近一次成功重验证的、属于当前 OIDC User 和本机 installation 的 exact
> ACTIVE Cloud Device entity `revision`。

### 3.2 数据来源和时序

- 唯一来源是 Identity Cloud client 的现有 `/v1/me/devices` 响应。
- Identity 继续负责筛选 exact User、installation、Device ID 和 `ACTIVE` status。
- transport `status()` 只投影 Identity 已验证并缓存的非敏感 authority facts。
- `execute()` 继续在发送 Cloud command 前执行现有 Device revalidation。
- 若 status 读取后 Device revision 发生变化，Cloud CAS 可以返回 conflict；当前调用必须
  fail closed。只有新的显式同步调用才能重新取得 status、Provider 观察和 Fact snapshot，
  不能在原调用中换 revision 重试旧 payload。

### 3.3 服务 ACL

现有 internal service 保持同一个 service ID：

```text
sciforge.authenticated-cloud-transport
```

建议在版本化 descriptor 中将 `sciforge.content-space` 加入
`allowedConsumerModuleIds`。现有 Collaboration 和 Project Coordinator 消费者保留。

Content Space 只能获得经过 schema 限定的非敏感 transport status 和
`execute()`，不能获得：

- OIDC access/refresh token；
- Device 私钥或签名原语；
- Identity 私有数据库、vault 或 Cloud client；
- 任意 URL、任意 HTTP header 或原始 fetch 能力。

### 3.4 版本和迁移

- 对现有 internal service contract 从 `2.0.0` 原子升级到 `3.0.0`。
- 整个 monorepo 原子更新 service producer、descriptor、允许的消费者和测试桩。
- 不双注册旧版与新版 transport，不新增兼容 service ID，不保留 shim。
- 独立 tarball、generated composition 和 packaged app 必须使用同一闭包版本。

## 4. 提议二：Content Space Provider Principal 同步 capability

### 4.1 固定定义

capability ID：

```text
content-space.sync-provider-principal
```

Broker 元数据：

```text
audiences: [ui]
scope: global
effect: external-write
approval: confirmation
concurrency.revision: none
concurrency.idempotency: required
```

首版仅允许明确的 UI 同步/刷新动作并要求 confirmation。不得为了自动同步把 Cloud
写入伪装成 `read`。
后续只有在仓库出现通用、provider-neutral observation 机制后，才能单独评审后台触发。

### 4.2 输入边界

输入只允许：

```ts
{
  providerInstanceRef: string
}
```

`providerInstanceRef` 必须使用现有 Domain SDK schema，并且只能来自 Content Space
Provider Instance catalog。Renderer 不能提交：

- SciForge `usr_*` 或 `dev_*`；
- Provider directory `principalId`；
- Fact ID、Fact revision 或 Device revision；
- binding digest；
- Cloud command、Token、账号、邮箱或 OpenContent identity payload。

### 4.3 输出和错误

输出应复用现有 Content Space result/error envelope，并只向 Renderer 暴露可显示的
provider-neutral 同步状态。不得创建第二套 Cloud Fact DTO 或把完整 Fact、CAS revision
投影到 Renderer。

结果必须落入现有 `ContentSpaceResult`，至少区分：

- 已同步；
- 当前 Provider Connection 未授权；
- Provider 暂时不可用：`provider_unavailable`；
- SciForge Cloud identity/device 未就绪；
- Cloud 在发送前不可用：复用现有安全失败结果，不进入未知提交状态；
- publish 已发送但结果无法确认：`outcome_unknown`，不得自动重试；
- Fact CAS 并发变化：`conflict`，最多一次完整重新观察。

不得临时手写平行字符串错误协议。Provider、CAS 和不确定提交结果必须分别复用现有
`provider_unavailable`、`conflict` 和 `outcome_unknown`；其他失败也必须通过现有
Content Space result/error envelope 表达。

### 4.4 首版触发策略

首版只在以下明确动作触发：

1. 用户在 Content Space 面板选择 Provider 后点击“同步/刷新”；
2. 或用户完成 Provider connection 后，明确确认同一 Content Space 同步动作。

首版不要求：

- Keycloak 登录后自动弹出 Provider 登录；
- application startup 自动 Cloud 写入；
- Identity 到 OpenContent 的事件订阅；
- Provider status `read` 隐式发布 Fact；
- Project Coordinator 在创建 Project 时反向调用 Provider。

Cloud 中已有 Fact 会继续保留；应用重启不需要无条件重发。需要重新认证、binding
漂移或 Cloud 不可用时，UI 在下一次明确同步/刷新时收敛。

## 5. 私有 Sync Orchestrator 行为

Sync Orchestrator 是 Content Space main-process 内部实现，不贡献公共 service、IPC 或
manifest extension。

一次同步必须执行以下步骤：

1. 从 capability context 取得 Host-captured Principal，并同时要求
   `authority === 'sciforge-cloud'`、`assurance === 'cloud-authenticated'`。
2. 调用 `assertPrincipalCurrent()`。
3. 读取 transport ready status，并校验 `userId/deviceId/deviceEntityRevision`。
4. 校验 Principal `subject === status.userId` 且
   `principal.deviceId === status.deviceId`；`identityVersion` 只能作为
   `principalIdentityRevision`，不得代替 Device entity revision。
5. 从 Content Space Provider catalog 解析 exact Provider Instance。
6. 在同一 pinned Provider 和同一 Principal lease 下调用
   `ContentSpaceProvider.attestExternalBinding()`。
7. 调用同一 Provider 的现有 `getCurrentPrincipal` extended operation。
8. 使用 `ContentSpaceDirectoryUserReference.principalId` 构造现有
   `ProviderDirectoryPrincipalReference`。
9. 对 canonical、token-free binding attestation 计算 SHA-256 digest。
10. 通过现有 `provider_directory_principal.list`，以当前 `userId`、exact Provider
    Instance 和 `includeDegraded: true` 读取 Fact ID/revision，并断言该 slot 最多一条。
11. 再次调用 `assertPrincipalCurrent()`。
12. 使用 collaboration-contracts schema 构造现有
    `provider_directory_principal.publish`。
13. 通过现有 `AuthenticatedCloudTransport.execute()` 发布。
14. 每次 Provider 调用、list 和 publish 前后都校验 Principal lease；发布后发生变化时
    fail closed，不把结果用于当前 UI authority。

`attestExternalBinding().externalSubject` 是不可逆绑定摘要，不是 Provider directory
`principalId`。不得使用 externalSubject、邮箱、Renderer 输入、Project payload 或账号
字符串构造 Provider Principal。

## 6. 幂等、CAS 和失败隔离

### 6.1 幂等和冲突

- Fact 创建时 `providerPrincipalFactId` 与 `expectedFactRevision` 同时为 `null`。
- Fact 更新时二者必须同时来自最新 list 结果。
- `expectedDeviceRevision` 必须来自当前 transport status 的
  `deviceEntityRevision`。
- 同一逻辑请求及其网络重放必须复用同一 command 与 idempotency key。
- 只有完成一次新的 Provider、Principal、transport 和 Fact 全量观察并生成新 payload 后，
  才能使用新的 idempotency key。
- Fact conflict 后最多执行一次完整重新观察；不得只替换 Fact revision 后重放旧 Provider
  观察。
- Device revision conflict、Principal、Device、Provider binding 或 directory principal
  任一漂移都立即 fail closed，不得获取新 revision 后偷重试旧 payload。

### 6.2 Cloud 不可用

Cloud list/publish 失败时必须区分：

- 请求尚未发送时 Cloud 不可用：返回现有可重试的安全失败结果；
- publish 已发送但无法确认结果：返回 `outcome_unknown`，不自动重试；
- Fact CAS 冲突：返回 `conflict`，只允许前述一次完整重新观察；
- Device revision 冲突或 Principal/binding 漂移：立即 fail closed。

无论哪一种失败：

- 不删除或回滚 Provider Token；
- 不把 Provider Connection 改成 disconnected；
- 不阻断 Content Space 本地/provider-native 文件能力；
- 不影响 content mode 为 `none` 的 Project；
- 只把 Cloud Provider Principal 同步显示为待恢复或失败；
- 依赖共享 Content Space 的 Project 继续依据现有 Cloud readiness fail closed。

### 6.3 Provider 不可用

- Connector 或 Provider 只返回 provider-neutral unauthorized/unavailable observation。
- 同步不得读取、记录或上传 Token。
- 普通 Content Space operation 保持其现有错误和重试语义。
- 不支持 `getCurrentPrincipal` 的 Provider 仅不能完成 Fact 同步，不影响其他已声明能力。

## 7. 职责边界

### 7.1 Identity Access

- 拥有 OIDC Session、ACTIVE Device、Device/Agent credential custody。
- 提供版本化、token-free Authenticated Cloud Transport。
- 投影 exact Device entity revision。
- 不构造 Provider Fact，不依赖 OpenContent，不调用 Content Space Provider。

### 7.2 Content Space / Capability Broker

- 拥有 Provider Instance、Provider catalog、Principal lease 使用和同步 capability。
- 私有编排 attestation、directory reference、Fact list/publish。
- 不读取 Identity 私有存储，不接触 Token。
- 不修改 `ContentSpaceProvider` SPI 语义。

### 7.3 Cloud Collaboration

- 继续拥有 `provider_directory_principal.list/publish`、Fact CAS 和 Device 状态校验。
- 继续产生 Project Content readiness、membership 和 Task Authority projection。
- 不读取 Provider Token，不增加 OpenContent 字段。

### 7.4 OpenContent Provider Integration

- Connector 只负责 Provider 登录、Token custody、外部主体观察和 Provider 原生调用。
- Provider 只把 Connector observation 适配为 Content Space contracts。
- 不调用 Cloud，不构造 Fact，不依赖 Project Coordinator。

### 7.5 Renderer、Host 和 Project Coordinator

- Renderer 只触发同步并显示 provider-neutral 状态。
- Host 只使用现有 generated composition、internal service ACL 和 Capability Broker。
- Host 不增加 Provider/domain switch。
- Project Coordinator 只消费现有 Cloud readiness/projection，不触发同步、不调用 Provider。

## 8. 不变合同清单

本次不得修改以下语义：

- `ContentSpaceProvider.attestExternalBinding()` 输入输出；
- Content Space Provider factory/catalog composition；
- Content Space 文件、容器、transfer、portable reference 和 readiness 合同；
- OpenContent Connector 登录、Token storage、facade 和 supplier API；
- `provider_directory_principal.list`；
- `provider_directory_principal.publish`；
- Cloud Provider Fact、Project membership、Project Content readiness 和 Task Authority；
- Project Coordinator planning-ready 与执行 `eligible` 的区别；
- Host Principal fencing、Capability Broker approval 和 resource authority；
- Keycloak/OIDC、Device registration、Agent custody 与 authenticated HTTP 行为。

## 9. 对现有消费者的影响

| 消费者 | 需要的机械更新 | 运行行为变化 |
| --- | --- | --- |
| Collaboration | transport status 测试桩增加 Device revision | 无 |
| Project Coordinator | transport status 测试桩增加 Device revision | 无 |
| Content Space | 新增 transport consumer 和独立同步 capability | 仅明确同步动作新增行为 |
| OpenContent Provider | 增加同步集成回归 | 无合同变化 |
| 其他 Content Space Provider | mock/unsupported 场景回归 | 普通能力无变化 |
| SciForge Cloud | 验证现有 command 和 conflict 语义 | 无服务端变化 |
| Renderer | 新增 provider-neutral 同步触发和状态 | 不获得 authority 数据 |

由于 ready status 增加必需字段，所有 monorepo 内测试 double 必须在同一变更中更新。
这属于编译期联动，不表示 Collaboration 或 Project Coordinator 的业务行为发生变化。

## 10. 实施批次

### 批次 A：Identity contract

预计范围：

- `packages/domains/identity-access/src/authenticated-cloud-transport.ts`；
- `packages/domains/identity-access/src/main/cloud-runtime.ts`；
- Identity Device service 的私有 authority projection；
- `packages/domains/identity-access/sciforge.domain.json`；
- Identity package/version/tests；
- Collaboration、Project Coordinator transport 测试桩；
- lockfile 和 generated composition。

该批次不写 Content Space Sync Orchestrator，不改 Cloud server。

### 批次 B：Content Space capability 和私有编排

预计范围：

- Content Space capability ID、input/output schema 和 main handler；
- 私有 Provider Principal Sync Orchestrator；
- internal service acquisition；
- provider-neutral mock tests；
- Content Space renderer 的明确同步/刷新动作；
- manifest、版本和 generated capability 文档。

该批次不修改 OpenContent Connector、Provider SPI、Cloud command 或 Project Coordinator。

### 批次 C：跨域回归

- OpenContent Provider binding/current-principal 回归；
- Cloud list/publish CAS 回归；
- Project Content readiness/provisioning 回归；
- source Electron Principal/Provider credential lifecycle smoke；
- canonical packaged build；如环境缺少 Visual Studio C++ Build Tools，必须如实标记
  阻塞，不得关闭 `npmRebuild` 或使用旧产物代替。

## 11. 必须通过的验证

至少执行：

```text
domain-sdk principal tests
identity-access tests and typecheck
content-space tests and typecheck
content-space-mock-provider tests
opencontent-connector targeted lifecycle tests
opencontent-content-space-provider tests
collaboration-contracts tests
collaboration-server Provider Fact tests
project-coordinator provisioning/ports tests
domain-packages:check
domain-packages:typecheck
git diff --check
```

架构扫描必须证明：

- 没有新增 Cloud command、REST、IPC 或第二个 Publisher service；
- 没有修改 `ContentSpaceProvider` SPI；
- Host 没有 `opencontent`、Provider kind 或 domain ID 分支；
- Project Coordinator 没有导入 OpenContent Connector；
- Connector 没有导入 collaboration-contracts 或 Identity Token API；
- Renderer 没有构造 Cloud IDs、Fact、revision 或 command；
- 生产代码没有恢复 `local-selection`、`identity.local.*` 或 Local Account 路径。

## 12. 共同合同评审结论

### Content Space / Capability Broker

1. 接受独立的 provider-neutral 同步 capability，不把 Cloud 写入隐藏在 read。
2. 固定 `content-space.sync-provider-principal`、`audiences: [ui]`、`scope: global`、
   `effect: external-write`、`approval: confirmation`、revision none、idempotency required。
3. Provider catalog、Principal lease 和 `assertPrincipalCurrent()` 由 Content Space main
   handler 持有，Renderer 不参与 authority 构造。
4. 所有错误复用现有 `ContentSpaceResult`，不新增平行错误协议。

### Cloud Collaboration

1. `expectedDeviceRevision` 就是 exact Cloud Device entity `revision`。
2. 现有 `provider_directory_principal.list/publish` 足以完成创建、更新和 CAS。
3. 当前 handler 已提供 ACTIVE Device、ownership、Device revision、Fact slot/revision CAS
   与幂等提交语义，本次不修改服务端。
4. 不新增 Cloud endpoint、command、database schema 或 OpenContent 字段。

本轮只按以上结论实施批次 A、B、C。任何超出本文件的协议扩展都应另立决议，不得在
实现中顺带加入。
