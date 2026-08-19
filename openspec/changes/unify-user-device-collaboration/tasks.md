# 实施任务：统一用户、手机与 SciForge 多人协作

> 清单定位：这是 `origin/gui` 既有跨团队 umbrella change 的累计记录，`[x]` 表示相应系统能力已在该基线中形成，不表示 A 在本轮重新实现或接管了全部条目。
>
> A 本轮 release gate 仅由云端公共合同、Cloud Server/PostgreSQL、provider-neutral Human 边界、A-only 控制台、部署/恢复、公共 API/示例、机器可读协议制品和服务器自动 conformance 组成。第 5、6、7、9 节中的桌面领域、AgentRuntime、个人 Session、Coordinator/Worker 业务逻辑和客户端迁移属于既有 SciForge 或其他负责人；A 只维护其云端交换合同与确定性权限。
>
> 正式 Human Provider、Zulip 拓扑、最新版 SciForge 接线、公网入口和端到端产品链路尚未形成确认方案。本清单不得把候选“Zulip → A → 本地 SciForge → A → Zulip”写成已完成门槛；真实 E2E 保持未完成。

## 1. 合同与包边界

- [x] 1.1 在 `@sciforge/collaboration-contracts` 中定义 strict UserPrincipal、HumanEndpointBinding、AgentNode、ParticipantProfile、RemoteSessionProjection、ProjectInput、Project、Task、ProjectRecord、InboxMessage、receipt 和 typed error schema。
- [x] 1.2 为所有 REST、WebSocket、provider event、Agent inbox 和 capability input/output 建立判别联合与共享 fixtures；未知字段必须拒绝。
- [x] 1.3 建立 `@sciforge/collaboration-server`、`@sciforge/domain-collaboration` 和 provider adapter 的明确公共入口；领域包分别提供 main/renderer entrypoint。
- [x] 1.4 通过 `sciforge.domain.json` 和生成式 composition 安装领域与 adapter；增加架构测试，禁止 Host 私有导入、中央领域/provider map、provider ID 分支和重复执行/镜像路径。
- [x] 1.5 冻结 ID、revision、idempotency、状态机、错误码、credential redaction 和版本兼容规则。

## 2. 统一用户与端点身份

- [x] 2.1 实现 UserPrincipal 生命周期、登录主体和 suspended/revoked 行为，使 Project 成员、Agent owner 和 HumanNeeded 都引用稳定 userId。
- [x] 2.2 实现 Human Endpoint 短期 binding code、provider sender 验证、唯一绑定、assurance、暂停、撤销和显式转移；公共入口使用 OIDC identity REST/兼容 `pairing.begin` 状态机，旧 `endpoint.challenge.create` command 永久 fail closed 并标记为 reserved。
- [x] 2.3 实现 SciForge device registration、稳定 agentId、ownerUserId、device credential secret、心跳、撤销和凭据轮换。
- [x] 2.4 实现 ParticipantProfile，允许用户从自己拥有的端点和 Agent 中显式选择 primary，禁止最近在线或跨用户回退。
- [x] 2.5 增加身份冲突、显示名修改、重复 binding code、端点被盗、Agent 被盗、owner 转移和撤销后的安全测试。
- [x] 2.6 审计 settings、日志、诊断、二维码、测试 fixture、导出和 Git 文件，确保不存在长期 token、API key、challenge、密码或私钥。
- [x] 2.7 实现 Agent-only `credential.revoke_current`，只从认证上下文撤销当前 opaque Agent Bearer，并验证其他凭据不受影响；OIDC User Token 的登出、刷新与撤销仍由 issuer 管理。

## 3. 云端协作内核

- [x] 3.1 使用一个服务和一个 PostgreSQL schema 实现 User、Endpoint、Agent、Participant、Project、Task、ProjectRecord、Inbox 和 Receipt repository。
- [x] 3.2 实现统一 authentication context，区分 user credential、human endpoint identity 和 agent device identity，并执行 owner/member/role/assignee/assurance 授权。
- [x] 3.3 实现 Project/Task 状态机、Coordinator 唯一性、expected revision、idempotency key 和 typed conflict/error。
- [x] 3.4 在同一数据库事务中提交状态变化、审计和 InboxMessage；WebSocket 只发送 `inbox.available`，客户端通过 sequence 拉取并 ack。
- [x] 3.5 实现服务重启恢复、离线信箱、cursor、bounded retention、重复请求 reconciliation 和被撤销凭据的即时拒绝。
- [x] 3.6 实现 Project Record 访问控制与接受流程，禁止个人 transcript、凭据、本地路径或完整工具日志自动进入云端共享记忆。
- [x] 3.7 实现 `agent.capability_profile.report` 与 Project 成员可读的有期限 Agent capability directory；A 派生在线/忙碌/撤销状态，并隐藏凭据、地址、installation identity、本地路径和模块私有结构。
- [x] 3.8 实现当前 execution assignee 的结构化 Task progress，以及 succeeded 与唯一候选 `task_result` ProjectRecord 的单事务写入，复用 revision、幂等、审计和 Coordinator inbox。
- [x] 3.9 实现 provider-neutral ResourceRef 创建、查询、`available/unavailable/revoked` 转换（保留既有 `invalidated` 终态）与 Task execution fencing，严格拒绝正文、凭据、短期签名身份、非 HTTPS URL 与本地绝对路径。
- [x] 3.10 暴露 `task.retry`：同一 assignee 对 `succeeded/failed/rejected` 重做，变更 assignee 要求 Owner 直接调用或当前 Coordinator 携带动作绑定确认；单事务生成新 execution、supersede 未接受候选、处理并发与 pending HumanRequest，并拒绝旧 execution 写入；accepted 结果不能被普通 retry 撤销。
- [x] 3.11 处理 PostgreSQL idle client error，保证数据库重启不退出应用且日志不展开 Client、连接参数或 secretKey。
- [x] 3.12 提供 A-only 同源网页控制台，覆盖 Project/Task 权威查询、Owner 确认、能力目录、User Inbox、ProjectRecord 与 ResourceRef；Bearer 只保存在页面内存，不实现 B–E 私有逻辑。

## 4. Zulip 与 Human Gateway

> 本节 `[x]` 只表示 provider-neutral runtime 与可选 Zulip adapter 的代码/自动测试存在，不表示 Zulip 已被选为正式产品 Provider，也不冻结 Provider→A→最新版 SciForge 的拓扑。

- [x] 4.1 定义通用 Human Endpoint Provider 合同，覆盖身份验证、事件游标、locator、发送、topic rename/move、重试、自回声过滤和 redacted diagnostics。
- [x] 4.2 把 Zulip realm、bot、stream/topic lookup、event queue 和 send 逻辑迁入 provider adapter；通用 server core 和 Host 不出现 Zulip 分支。
- [x] 4.3 实现 locator 到稳定 personal projection 或 Project binding 的唯一解析；歧义、缺失和 revision 不一致必须失败关闭。
- [x] 4.4 实现 ProjectInput 创建、member/role 验证、provider message dedupe 和 Coordinator inbox 路由。
- [x] 4.5 实现 targetUserId HumanNeeded、primary endpoint 路由、HumanAnswer receipt、过期回答和无端点 pending 行为。
- [x] 4.6 增加通知过滤，只向手机发送个人 Session、人类问题、允许的审批、重要失败/摘要和最终结果。
- [x] 4.7 启动时运行并持久化 Provider 脱敏诊断，为 provider-enabled 发布提供独立健康门禁。

## 5. SciForge 协作领域包

> `origin/gui` 既有客户端/桌面基线，非 A 本轮实现或发布门槛。A 不修改 AgentRuntime、客户端 SDK、设备适配或桌面业务 UI。

- [x] 5.1 新建 `@sciforge/domain-collaboration`，由 main 入口拥有 Agent 注册、云端连接、durable inbox/outbox、Task 执行和 Session projection service，由 renderer 入口贡献统一协作 UI。
- [x] 5.2 只通过 domain SDK 的通用 AgentRuntime、Capability Broker、secret store、settings 和 UI contributions 接入 Host。
- [x] 5.3 实现 Participant 状态页，组合显示同一 userId 下的手机端点与 Agent，同时分别显示验证、assurance、在线和撤销状态。
- [x] 5.4 实现 Agent/primary Agent 选择、云端连接状态、Project/Task 列表、错误诊断和显式恢复操作。
- [x] 5.5 确保个人消息和协作 Task 使用同一 canonical Agent execution host 与审批路径，不增加 provider IPC、MCP 或测试旁路。

## 6. 个人 Session 投影与同步

> `origin/gui` 既有手机—桌面协作基线，非 A 本轮实现或发布门槛。A 只提供所需的云端身份、路由、Inbox 和 Provider 边界。

- [x] 6.1 实现稳定 projection persistence：云端只保存 ownerUserId、agentId、endpoint 和 provider locator，本地 Agent 单独保存 projectionId 到 runtime/thread/workspace 的唯一映射。
- [x] 6.2 实现 share/link existing Session、new Session、rename、pause/resume、close、relink 和 status；桌面焦点不得重定向 projection。
- [x] 6.3 实现每 projection durable ordered queue 和 receipt ledger，覆盖 local/remote origin、sender identity、local item/turn、remote message、hash、attempt 和终态。
- [x] 6.4 实现手机入站一次写入本地 thread、桌面 user message 镜像、最终 assistant reply 镜像、provider retry、自回声过滤和启动恢复。
- [x] 6.5 实现默认 owner-only 和显式 shared allowlist；shared UI 必须显示实际执行 Agent owner，sender 不得隐式分叉 Session。
- [x] 6.6 限制首期为 append-only 文本和最终回复；编辑、删除、reaction、流式 delta 和任意附件不改变本地历史。

## 7. 多用户 Project 协作

> 跨 B/C/A 的系统级基线。B/C 拥有 Coordinator/Worker 决策与执行流程；A 只拥有 Project/Task 权威账本、路由、revision、单执行者约束和 Owner 确认权限。

- [x] 7.1 实现 Project 创建、member user、Coordinator Agent、手动转交和 role/owner 校验。
- [x] 7.2 实现结构化 Task offer/accept/reject/progress/result/failure/needs-human 状态，按 assigneeAgentId 投递并用 revision 防止过期结果。
- [x] 7.3 在本地记录 active taskId/revision/turn，Agent 断线重连后报告实际状态，不重复执行或覆盖已改派 Task。
- [x] 7.4 实现星形协作，并分离 Coordinator 建议与 Owner 正式确认：Owner 创建正式 Task、确认改派/取消，Coordinator 可发起同 assignee 重试；Worker 只能更新自己 Task、提交 observation/result 或提出子任务建议。
- [x] 7.5 实现每 Project Task/轮次/重试预算和明确终止；Coordinator 离线时暂停并允许有权用户显式转交，不自动选主。
- [x] 7.6 实现 Project topic 作为 ProjectInput/通知投影，禁止映射为全体成员共同拥有的私人 Session。
- [x] 7.7 实现 Project Record 的 observation/proposal/decision/summary 接受路径和作者、Agent、Task、revision provenance；`observation`/`task_result` 允许 Coordinator 或 Owner 接受，`proposal`/`decision`/`summary` 仅允许 Owner 接受。

## 8. 权限与安全治理

- [x] 8.1 为 personal message、ProjectInput、Task、HumanNeeded、HumanAnswer 和 capability approval 建立 actor/target/role/assurance 权限矩阵，包括 Task 创建、同执行者重试、改派、取消和 ProjectRecord 接受的 Owner/Coordinator 边界。
- [x] 8.2 远端触发继续使用本地模型、模式、workspace policy 和 capability broker；没有显式 remote-approval policy 时手机只能查看 pending。
- [x] 8.3 增加越权测试：A 访问 B 私人 projection、A 代答 B、非成员写 Project、非 assignee 完成 Task、撤销 endpoint/Agent 后继续请求。
- [x] 8.4 对所有 API、WebSocket、provider 和日志路径执行 redaction、rate limit、bounded payload、audit 和 credential rotation 测试。

## 9. 删除旧路径与迁移

> `origin/gui` 既有客户端迁移记录，非 A 本轮服务器发布门槛；A 不为这些客户端路径建立第二套兼容实现。

- [x] 9.1 删除旧 workspace-channel binding、topic-derived config ID、`/use project` 和 `/new` 静默 retarget 行为。
- [x] 9.2 删除 Host-owned Zulip/remote-channel runtime、provider IPC、Connect Phone provider 分支、renderer duplicate mirror tracking、陈旧 settings、tests、exports 和 dependencies。
- [x] 9.3 提供一次性升级流程：验证云端用户、绑定手机 endpoint、注册 Agent、选择 primary Agent、重新链接个人 Session；不得保留 runtime compatibility facade 或双 registration。
- [x] 9.4 重新生成 composition，并验证 source 和 packaged application 中只有统一协作领域生产路径。

## 10. 验证与文档

- [x] 10.1 合同测试覆盖稳定 ID、严格 schema、中文 locator、身份冲突、revision、幂等、redaction 和状态机。
- [x] 10.2 Fake provider/server/runtime 集成测试覆盖双向 Session、ProjectInput、Task、离线恢复、重复事件、撤销和审批治理。
- [ ] 10.3 （可选跨团队 QA，非 A release gate）使用六个专用测试账号覆盖手机/Agent 绑定、两个个人 Session、一个 Project topic、两个并行 Worker、定向 HumanNeeded 和 Coordinator 转交。账号持有人自行保管凭据；A 不收集普通成员的 Zulip API key。仅调用 API/Agent Bearer 的 harness 属于服务器协议 conformance，不能冒充最新版 SciForge E2E。
- [x] 10.4 Renderer 测试覆盖 Participant 组合展示、无 Project 完成绑定、primary Agent 切换、Session 分享、Project 状态和显式错误。
- [x] 10.5 运行 package boundary、generated composition freshness、capability governance、typecheck、focused/full tests、changed-file lint 和 packaged smoke tests。
- [x] 10.6 更新中文用户及运维文档，区分 User、手机端点、Agent、个人 Session、Project topic、Task、在线依赖、权限保证和故障恢复。
- [x] 10.7 发布 A 最小公共 API 中文说明与真实请求示例，覆盖身份、Project/成员、能力、Task 路由、Owner 人工确认、进度、结果、消息和 ResourceRef。
- [x] 10.8 实现 team-private-acceptance 固定 bundle、Provider overlay、数据库重启验收和独立 tunnel-only 账号资产。
- [ ] 10.9 团队先确认正式 Human Provider、身份前置、Zulip（如采用）拓扑、最新版 SciForge 接法和公网入口，再把确认后的唯一链路写成独立部署/E2E 门槛；当前不得用候选链路替代方案决策。
- [x] 10.10 发布两份脱敏团队指南，明确当前 core-only/Tunnel 验收边界、协议制品、A/B/C/D/E 权限边界，以及 Provider/产品链路未冻结；删除任何把候选 HTTPS/Zulip 路径写成已开放事实的表述。
- [ ] 10.11 只有身份业务前置和产品链路方案通过后，才通知成员开始真实 pairing/Agent/Project 测试；Tunnel 仅按实际低层调试需要独立配置，A 不收集普通成员应用 Bearer。

## 11. B/C 交叉评审增量（A-MVP-001～012）

> 本节只勾选已有合同/服务/数据库/fixture 或部署脚本自动验证的 A 服务端能力。B Coordinator 算法、C AgentRuntime/journal、正式 Provider 和真实最新版 SciForge E2E 都不在这些 `[x]` 的含义中。

- [x] 11.1 **A-MVP-001**：增加不透明 `executionId`；create/retry 生成、同 execution 状态变化保持，Worker progress/HumanNeeded/ResourceRef/result 全部执行 fencing，并有旧 execution 拒绝测试。
- [x] 11.2 **A-MVP-002**：把 `succeeded` 定义为 execution 成功并允许未接受结果重做；自动测试已验证 accepted `task_result` 后普通 retry 被拒绝且正式记录保持不变。
- [x] 11.3 **A-MVP-003**：succeeded transition 与该 execution 唯一候选 `task_result` ProjectRecord、幂等 receipt 和 Coordinator Inbox 在单事务提交，并有响应重放/唯一性测试。
- [x] 11.4 **A-MVP-004**：实现 strict ConfirmableAction/confirmationId、Owner 直接路径与 Coordinator delegated 路径；自动测试覆盖精确匹配、错 action/execution/assignee、消费与重复使用拒绝。
- [x] 11.5 **A-MVP-005**：`human.needed.create` 同时支持 Worker task/execution 来源和 Coordinator sourceInboxMessage 来源，只有 Worker 来源改变 Task 状态，并有 actor/target/恢复测试。
- [x] 11.6 **A-MVP-006**：实现严格 `agent.capability_profile.report`、profile revision/expiry 和由 A 派生状态的 Project capability directory；自动测试覆盖 expiry 与 owner mismatch 的创建/重试拒绝。
- [x] 11.7 **A-MVP-007**：实现 ProjectCoordinationView 项目范围读取，聚合 Project/member/Task/Record/Human facts 并执行项目权限/隔离测试。
- [x] 11.8 **A-MVP-008**：生成并 freshness 校验协议 `1.0` JSON Schema、状态/权限表和正常/冲突 fixtures；制品来自固定合同源码而非手工副本。
- [x] 11.9 **A-MVP-009**：实现连续 Inbox ACK、superseded gap 与 Coordinator recipient-specific supersede/reroute；自动测试覆盖转交重投递、旧 ACK 隔离和跨 tombstone 连续确认。
- [x] 11.10 **A-MVP-010**：冻结 execution/assignee/coordinator/confirmation/resource/capability/ACK 稳定错误，所有公共错误带 requestId/traceId/retryable，并有 strict schema/API 测试。
- [x] 11.11 **A-MVP-011**：实现 ResourceRef `available/unavailable/revoked`（兼容既有 `invalidated` 终态）、安全 HTTPS 元数据、Task execution 绑定/read fencing 与失效资源拒绝测试；A 不上传正文或完整日志。
- [x] 11.12 **A-MVP-012**：自动部署校验区分 health、PostgreSQL readiness、core-only 空 catalog 和 provider-enabled 独立诊断；文档与门禁禁止用 core-only ready 冒充 pairing/E2E 已开放。
- [ ] 11.13 **真实联合 E2E（非 A-MVP-001～012 自动 conformance）**：待团队确认 Provider/Zulip/最新版 SciForge 具体方案后，由真实模块完成身份、Project、execution、Human、Resource 和结果往返；API fake/harness 不能冒充该证据。
