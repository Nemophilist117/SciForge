# A 云端协同服务职责与开放就绪状态

> 状态日期：2026-08-19（Asia/Shanghai）
>
> 分工依据：《SciForge 多客户端协作 MVP 五人分工报告》2026-08-16 对齐结论
>
> 文档状态：A 内部收口基线；未宣告身份驱动业务测试或正式产品链路已开放

## 📋 结论

A 的交付物是协作控制面，而不是另一套 Agent、Coordinator、手机端或内容 Provider。A 负责在云端保存唯一权威状态、提供最小公共接口、维护安全路由和完成总集成；B–E 各自保留模块内部决策与实现。

当前新 A ECS 已能以 loopback 模式运行固定版本，数据库和核心 API 可用。新分支已冻结 User 登录为单 issuer OIDC、Device 持钥注册、Agent→Device 关联及 User↔Zulip identity binding；D→A confirm 的最终 service-auth 形式、正式服务入口以及完整产品消息路线仍未冻结。因此，可以继续完成 A 的离线身份实现、provider-neutral 协作合同和服务器 conformance，但尚不能把 core-only 实例描述为已开放的身份驱动业务环境。

## 🌐 已冻结核心与待定产品接线

本轮不画端到端消息时序，因为那会暗示 Human 入口、Provider、最新版 SciForge 的调用方向已经确定。当前只冻结以下彼此独立的边界：

- A 通过版本化 command/query、WSS 唤醒和持久 Inbox 保存协作事实；
- B/C 只依赖 A 的公共 Task、execution、能力、确认、消息和结果合同；
- User 通过严格 OIDC Access Token 进入 A，先创建 Device，再让 Agent 关联 ACTIVE Device；Zulip `/bind` 只把外部 identity 绑定到既有 User；
- D 如何向 A 证明已验证的 Zulip event、正式客户端如何连接 A、结果如何返回 Human，仍待团队冻结接线方案；
- 未来方案无论选择哪种 Transport 或 Provider，都不能建立第二套 Project、Task 或 ACK 权威状态。

已经冻结的是 A 的协议 `1.0`、OIDC→Device→Agent 身份链、User↔Zulip binding 状态和“HTTP command/query + WSS 唤醒 + PostgreSQL Inbox 重放”语义。尚未冻结的是正式域名、反向代理路径、D→A confirm 认证以及用户消息是否必须经某个 IM 发起。Zulip identity binding 不等于冻结所有产品消息都必须经 Zulip。`47.76.230.118` 上的 `127.0.0.1:8787` 和 SSH tunnel 只用于新 A 的预发布验证，不代表最终产品入口。

`origin/gui` 中的桌面协作领域、AgentRuntime、个人 Session 投影与六用户场景是既有跨团队 baseline，用于最终系统验收；它们不是 A 本轮重新实现或生成机器合同的前置条件。A-only gate 覆盖云端合同、server、A 简易控制台、部署/恢复和公共 API；Provider 与正式入口选定后再增加相应接线门禁。六用户 API-key harness 若运行，只能使用专用 QA 账号，不收普通成员密钥，也不代表最新版 SciForge E2E。

## 🎯 A 负责什么

| A 的责任 | 最小交付 |
| --- | --- |
| 云端权威状态 | User、Human—设备绑定、Project、成员、Task、消息、进度、能力目录、人工确认、ResourceRef、路由和结果状态 |
| 公共接口 | 版本化 HTTP command/query、WSS 新事件通知、Inbox 补取/ACK、统一错误、幂等和 revision |
| 身份与权限 | 单 issuer OIDC User、Device enrollment/Ed25519 持钥证明、Agent→Device、User↔Zulip binding、凭据撤销、审计和最小权限校验 |
| Task 执行授权 | 同一 Task 同时只有一个执行节点；人工确认后改派；旧节点不能继续提交 |
| 持久化与可靠性 | PostgreSQL migration、事务、并发约束、审计、备份、恢复和数据库重启降级 |
| A 网页控制台 | 项目创建、成员选择、任务/进度/消息查看和人工确认入口；只调用 A 的公共接口 |
| 合同与总集成 | 最小公共合同、版本和变更记录，以及节点注册、能力上报、Task 路由、状态和结果回传的可运行示例 |
| 云端部署 | 新 ECS 资源、安全边界、固定发布、Provider-neutral 运行边界和开放门禁；正式入口与 Provider 方案另行确认 |

## 🚫 A 不负责什么

| 模块 | 模块负责人拥有 | A 只提供的边界 |
| --- | --- | --- |
| B 项目协调工作流 | 目标理解、Task 拆分、执行者推荐、结果业务判断、总结和真人确认流程 | 保存权威状态并执行已经确认的 command；不在云端运行 Coordinator |
| C 节点接入与执行 | 节点协议/SDK、桌面与机构服务器适配、Task 领取和本地执行 | 公共 Agent、能力、Inbox、状态与结果接口；不访问本地文件、VPN、GPU 或 Slurm |
| D Computer Use 与稳定性 | CDP、UIA、isolated desktop、跨端稳定性和复杂环境验证 | 可观测的消息、身份、撤销、重放和权限边界；不复制 Computer Use 或手机端实现 |
| E OpenContent | 逐用户账号连接、附件/Shared Document Provider、正文和安全写入 | 只保存必要 ResourceRef 元数据；不保存正文、附件、OpenContent 凭据或 Provider 私有状态 |

A 也不为各板块增加专用状态机、中央枚举分支或第二套消息路径，不代替项目负责人作最终结论、重新分派或取消决定。

## 📊 当前真实状态

以下是 2026-08-19 对固定 release `6241dd0132d3378673e454addd3d7927094bba59` 的部署与恢复核验快照。这里的“已验证”只覆盖 A core-only，不扩张为正式身份或产品链路证据。

| 项目 | 当前事实 | 含义 |
| --- | --- | --- |
| 新 A ECS | `47.76.230.118`；app 固定在 commit `6241dd0132d3378673e454addd3d7927094bba59` | A core-only 固定 release 已部署；未开放身份驱动业务 |
| 新 A 网络 | app 仅发布到 `127.0.0.1:8787`；PostgreSQL 不发布；公网仅受限 SSH | 隔离边界正确，但不是产品入口 |
| 新 A 探针 | `/healthz` 与 `/readyz` 返回 200；schema v5 / 32 张表及关键约束通过 | app、数据库与固定 schema 当前可用 |
| 新 A Provider | core-only，Provider catalog 为 `[]`，Provider diagnostics 为 0 | 正式 Human Provider 尚未选定或接入 |
| 新 A 业务数据 | User、Agent、Project、Task 均为 0 | 尚未完成真实 OIDC 登录、Device/Agent 注册、Zulip binding 与业务闭环 |
| 数据库重启 | 停库时 health=200/ready=503；恢复后 app 容器、PID、RestartCount 均未变化；恰有脱敏 57P0x 诊断且敏感日志匹配为 0 | 服务器可靠性门禁已有实机证据 |
| 真实 PostgreSQL 隔离验收 | PostgreSQL 17.6 上从 v1 升至 v5，并发 OIDC JIT、Device→Agent、legacy revoke 与 Zulip binding 唯一性全部通过；生产库前后内容摘要一致 | 不把 SQL mock 冒充真实数据库证据 |
| 备份恢复 | 重启后备份 `collaboration-20260818T171903Z.dump` 已在隔离数据库恢复；schema v5、32 张表和逐表行数一致 | 具备本次固定 release 的恢复证据 |
| 公共 API | 合同、PostgreSQL、HTTP/WSS、Inbox、幂等、审计、能力查询与任务路由已存在 | 可继续做 A 的 conformance，不等于产品 E2E |
| 自动化驱动 | A-only 合同、HTTP/WSS、事务与离线身份 fixtures 已通过；旧两用户 Zulip harness 不兼容新的 OIDC/Device-first 身份合同，已退出发布门禁 | fixtures 不是成员接入前置，也不冒充真实 Keycloak、D Bot 或最新版 SciForge |
| 网页控制台 | `/console/` 已随固定 release 同源部署 | 仅用于 A 低层控制面调试，不代表身份已开放 |
| 真人确认门禁 | Owner 直接动作与 Coordinator 绑定不可变 confirmation 的委托动作已由服务端强制 | 公共治理合同已具备；真实 Human/Provider 链路尚未接入 |
| 正式入口 / Human Provider | 尚未选定，不把 legacy URL、Zulip 方向或其他 Provider 路线写成冻结合同 | 不能声称正式身份接入已经开放 |
| 本分支统一身份 | 动态 OIDC/JWKS、RS256、Ed25519 与 binding fixtures 可做离线验证 | fixtures 不是 Keycloak、Desktop、D Bot 或 Zulip E2E |
| 真实产品 E2E | 尚无“已选 Human 入口 → 新 A → 本地最新版 SciForge → 新 A → 已选 Human 入口”的完整证据 | 身份驱动业务测试尚未开放 |

## ✅ 分层验收门槛

### 第一层：机器合同与 core-only conformance

这一层不依赖真实 Keycloak、Desktop、D Bot、Zulip 或正式域名，可以现在完成并提供给 B/C 做离线合同适配；动态 fixtures 只提供离线证据，不提供真实 User Access Token，也不允许宣称 Agent 注册或 Project/Task 云端闭环成功：

- [x] 从同一固定 commit 生成协议 `1.0` 的 command、response、Inbox、entity、error JSON Schema。
- [x] 发布状态/actor 表和正常、重复、乱序、revision、idempotency、旧 execution、确认失效 fixtures；manifest 中记录每个文件的 SHA-256。
- [x] `npm run collaboration:contracts:check` 与生成物测试通过，固定发布时把完整 commit 注入 manifest。
- [x] core-only 的 Tunnel、`healthz`、`readyz`、空 catalog、未配置 OIDC 时 User API fail-closed、无 confirm adapter 时 confirm fail-closed、数据库重启、备份恢复和敏感日志扫描通过。
- [x] 明确标记真实 OIDC→Device→Agent、User↔Zulip binding、Project/Task 业务闭环和产品 E2E 为“未证明”。

### 第二层：身份驱动业务测试

只有以下事项同时通过，A 才通知 B–E 使用真实身份调用云端业务接口：

- [x] 为新 A 发布新的固定 commit、release manifest 和可回退备份，工作树与发布物一致。
- [ ] 正式入口和 Human Provider 方案已书面选定；对应 TLS、HTTP、WSS、base path、身份验证和回退方式一致。
- [ ] 测试/生产唯一 OIDC issuer、Discovery/JWKS、`acr/amr/auth_time` Mapper 和专用测试账号均已配置；A 逐字符校验 issuer，并固定 audience 与 Desktop/Web `azp` allowlist。
- [ ] D→A confirm service-auth 已冻结并注入；普通 User Token、匿名请求和未验证 Zulip payload 都不能调用 confirm。
- [ ] 正式 OIDC 登录以 `(issuer, sub)` JIT User；同 email 不合并；Zulip binding 只关联既有 User，不通过 SQL seed、隐藏后门或共享个人 API key 建立身份。
- [ ] Project Owner 可使用自己的 OIDC Access Token 直接执行首次分派、换 assignee 主动改派、取消和最终结论；当前 Coordinator 只有持有该 Owner 对同一不可变动作生成的有效 `confirmationId` 才可代执行。Coordinator 无需确认即可对 `succeeded/failed/rejected` Task 发起同 assignee 重试。
- [ ] A 的简易网页控制台能完成项目创建、成员选择、任务/进度/消息查看和人工确认。
- [ ] 最新版 SciForge 只经已选正式公共入口完成“OIDC User → Ed25519 Device → Agent”注册、能力上报、Task 领取、状态更新和结果回传；Device 摘要与 Agent 节点 capabilities 保持分离。
- [ ] 一条真实云端闭环覆盖“OIDC 登录 → Device → Agent → 项目创建 → 能力查询 → Task 分派 → 节点领取 → 结果回传 → 人工查看”，另有一条真实 User↔Zulip binding 验证。
- [ ] 断线重放、幂等、Owner 对非终态 Task 主动改派、并发改派、旧节点拒绝、待回答 HumanRequest 过期、凭据撤销、PostgreSQL 重启、备份恢复和敏感日志扫描通过。
- [ ] 8787 与 PostgreSQL 仍不对公网开放；所有成员只使用公开协议，不访问 A 数据库。
- [ ] 接口说明、真实调用示例、协议版本、固定 commit 和已知问题一致。

## 🔐 A 基础设施侧仍需要的输入

A 无需等待 B–E 的模块方案即可完成机器合同和 core-only 服务器收口。真实身份验收还需要协调下列基础设施权限和非聊天 secret 注入：

1. 已选正式入口的反向代理维护权限、切换窗口、回退负责人和旧服务隔离策略。
2. 当前环境唯一 OIDC issuer、JWKS 可达性、所需 Mapper 与专用测试账号；Token、密码和私钥不发聊天或写仓库。
3. D 使用的非敏感 service client 标识，以及最终冻结的 confirm 认证接线；Bot API key 等 secret 只能通过受限 secret 注入。
4. 用于 A 自验的真实 OIDC 与 Zulip 测试身份。个人 Provider 凭据只在运行相应自动化驱动时由持有人放进本机 `0600` 文件，不是 core-only 运行条件。
5. 新 A 固定发布物、数据库和正式入口的备份、监控与故障联系窗口。

## 👥 B–E 何时需要提供什么

在 A 尚未满足开放门槛时，B–E 不需要提交私钥、API key、Bearer、数据库访问、模块源码或内部数据结构；他们可以独立完成各自模块。A 也不应把可选的两用户自动化测试拓扑变成团队前置任务。

正式入口开放并发布版本后，每位成员只需提供真实公共边界上的最小信息：

| 成员 | 开放后给 A 的最小信息 | 不应给 A 的内容 |
| --- | --- | --- |
| B | 一组真实 Task 提议/推荐、真人确认、结果判断的公开请求与响应；必要缺失字段 | Coordinator prompt、模型凭据、内部工作流状态 |
| C | 一组真实 Agent 注册、能力、领取、状态和结果 payload；节点类型与允许公开的能力摘要 | 本地路径、完整日志、VPN/GPU/Slurm 凭据或 AgentRuntime 内部对象 |
| D | `/bind CODE` 的验证事件字段、冻结后的 service-auth 合同，以及跨端绑定/撤销/重放的公开复现结果 | Bot secret、完整消息、Computer Use 实现、桌面控制凭据或个人 API key |
| E | 一组真实 ResourceRef 元数据、状态变化和失效样例；必要缺失字段 | 附件/正文、OpenContent token 或逐用户 Provider 私有状态 |

若某成员确需预发布低层 tunnel 诊断，再单独提供其 SSH 公钥和当前公网出口 `/32`；这是可撤销的临时诊断权限，不是正常成员登录方式。

## 📍 A 接下来的顺序

1. 先生成并校验 A-only 机器合同、fixtures、状态/actor 表和 core-only 验收清单。
2. 在新 A loopback 环境完成动态 OIDC/JWKS、Ed25519、binding fixtures、PostgreSQL 与服务器 conformance，只报告离线通过。
3. 正式 OIDC、D→A confirm、Human Provider 和产品入口方案确定后，再配置相应 adapter、健康门禁和回退窗口。
4. 发布新的固定版本并备份，用最新版 SciForge 和真实身份完成 OIDC→Device→Agent 与 User↔Zulip 产品链路验收。
5. 第二层门槛通过后再向 B–E 发布真实入口、账号有效期、测试 Project、回滚窗口和问题报告格式。

相关运行记录：

- [新 A loopback 预发布说明](../deploy/collaboration-private/README.md)
- [既有 47.243 ECS legacy 运行记录](operations/zulip-aliyun-deployment.zh-CN.md)
