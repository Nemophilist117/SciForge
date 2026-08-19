# 设计方案：以用户为中心的 Human 入口、SciForge 与云端协作（Umbrella 候选）

> 本文是 `origin/gui` 既有的跨团队 umbrella 架构，用于说明各模块的预期边界，不是 A 本轮的独占实现范围。A 只拥有云端合同、Collaboration Server/PostgreSQL、provider-neutral Human 边界、A-only 控制台、部署/API 和服务器协议 conformance；桌面协作领域、AgentRuntime、个人 Session、Coordinator 决策、Computer Use 与 OpenContent 分别保留在既有 SciForge 或 B–E 模块中。
>
> B/C 交叉评审当前只冻结 A↔Coordinator/Worker 的公共协议。正式 Human Provider、Zulip 接线、最新版 SciForge 接入、公网入口和端到端产品链路尚未形成经确认的具体方案，因此本文不得把“Zulip → A → 本地 SciForge → A → Zulip”写成已实现或本轮唯一发布门槛。本文中的手机、六用户和桌面/UI 场景均是待后续方案确认的跨团队目标，不是 A 服务端本轮完成事实。

## 1. 设计原则

本方案先确定协作中最重要的边界，再展开具体功能。所有后续实现都应遵守以下原则。

### 1.1 人是协作主体，设备只是入口

协作系统中的基本个体是一名用户，而不是一部手机、一个聊天账号或一台电脑。

同一名用户可以从手机进入，也可以让自己的 SciForge 执行任务。手机和 SciForge 在产品逻辑上属于同一个人，但仍是两个独立端点：它们有不同的凭据、在线状态和权限强度。

### 1.2 沟通、协调和执行各司其职

- 若产品选择 Human Provider，该 Provider 负责其信任域内的人类身份、消息、通知和展示历史；Zulip 只是候选实现之一。
- 云端协作服务负责用户身份、Project、Task、消息路由、共享记录和离线信箱。
- SciForge 负责模型推理、工具使用、本地文件访问和任务执行。

这些边界不能互相冒充。Human Provider 不是项目数据库，云端协作服务不是 Agent，SciForge 也不是多人共享状态的唯一存储；各边界之间的正式调用方向仍待产品方案确认。

### 1.3 每类事实只有一个权威来源

- 个人 Session 的上下文和完整对话，以所属 SciForge 的本地 Session 为准。
- Project、Task、成员、Coordinator 和共享结论，以云端协作服务为准。
- 已选 Human Provider 的消息和远端展示历史，以该 Provider 为准。

其他位置只能保存投影、引用或缓存，不能建立第二套可以独立修改的事实。

### 1.4 所有路由都必须明确，不能猜测

系统必须能够明确回答：谁发出了消息、代表哪个用户、目标是哪个 Project 或 Session、应由哪台 SciForge 执行。

系统不得根据当前桌面焦点、最近在线机器、Topic 文本、显示名或默认工作区猜测执行目标。无法唯一确定目标时，应停止并提示修复绑定。

### 1.5 身份相同不等于权限相同

手机和机器可以代表同一个用户，但普通聊天登录不自动获得本机高风险权限。文件写入、命令执行、外部发布、凭据使用等操作，仍由执行任务的 SciForge 按本地安全策略决定是否需要批准。

### 1.6 Project 面向多人，Session 面向具体执行上下文

Project 是多个用户及其 Agent 共同参与的协作空间；Session 是某台 SciForge 上连续的 Agent 上下文。

Project 可以包含多个 Session 和多个 Task。共享 Project Topic 不应被伪装成所有人共同拥有的某个私人 Session。

### 1.7 离线、重试和重启是正常状态

Human 客户端、桌面、Agent、已选 Provider 或云端都可能短暂离线。系统应保存未完成消息和任务，恢复后按顺序继续，并确保同一项工作不会因为重试而被执行两次。

### 1.8 人只接收真正需要关注的内容

手机应显示个人对话、需要本人回答的问题、重要异常、关键摘要和最终结果。机器心跳、普通进度、工具日志和 Agent 内部协作不应持续打扰用户。

### 1.9 首期保持简单

首期采用一个云端协作服务、一个独立的协作数据库和一个实时通知入口。暂不引入微服务、消息队列集群、自动选主、任意 Agent 群聊或复杂资源市场。

## 2. 总体结构

系统由五类参与者组成。

| 参与者 | 主要职责 | 不负责的内容 |
| --- | --- | --- |
| 用户 | 提出目标、查看状态、作出决定和批准 | 不手工转发所有机器状态 |
| Human 客户端（待选） | 在方案允许时提交人类输入、接收通知和回答问题 | 不运行完整 Agent，不直接持有本机工具权限 |
| Human Provider（待选） | 若被采用，负责其信任域内的登录、消息、历史和通知 | 不管理 Agent、Project、Task 或执行权限 |
| 云端协作服务 | 统一身份、路由、Project、Task、共享记录和离线信箱 | 不运行模型，不访问用户本地文件 |
| SciForge | 运行 Agent、访问本地资源、执行 Task 和提交结果 | 不独自决定整个多人 Project 的共同状态 |

下面两种路径只是 umbrella 目标能力，不是已批准拓扑。正式方案可以选择不同入口和方向，但仍须使用 A 的同一权威合同。

第一种目标能力是个人远程操作：若产品选择 Human 客户端和 Provider，用户输入可经已验证边界进入 A，再路由到明确的 SciForge Session；返回路径由后续方案单独冻结。

第二种目标能力是多人 Project 协作：用户经最终选定入口向 Project 提交目标、问题或意见，A 把公共输入交给明确的 Coordinator。Coordinator 形成 Task 和执行者建议，Project Owner 确认后，A 才创建正式 Task 并路由给对应 Agent。

## 3. 协作个体的定义

### 3.1 一个协作个体由三部分组成

一个完整的协作个体包括：

1. 一个稳定的用户身份，用来表达“这个人是谁”。
2. 一个主要 Human Endpoint，用来表达“如何通过已选 Human Provider 找到这个人”（若该产品方案采用 Provider）。
3. 一个主要 SciForge Agent，用来表达“默认由哪台机器代表这个人工作”。

这三者组成同一个参与者档案。系统在成员列表中应把它们组合展示，而不是把手机账号和 Agent 节点显示成两个互不相关的成员。

### 3.2 用户身份保持稳定

用户修改显示名、Provider 昵称或邮箱后，仍然是同一个用户。内部身份不能由这些可变字段生成。

Project 成员、真人问题、审计记录和 Agent 所有权都引用稳定用户身份。

### 3.3 Human Endpoint 必须验证

若最终方案采用 Human Provider，系统通过一次性验证流程确认用户确实控制目标 Provider 身份。验证结果绑定 Provider、realm/组织和其中的稳定用户身份，而不是只相信昵称或用户填写的邮箱。具体 Provider 与验证交互尚未冻结。

同一个 Provider 身份在同一 realm/组织内不能同时属于两个活跃用户。如需转移，必须先由有权用户解除旧绑定。

### 3.4 SciForge 必须有明确所有者

每台参与协作的 SciForge 都注册为独立 Agent，并记录其所有者、名称、节点类型、能力和在线状态。

SciForge 重启后应恢复原 Agent 身份，不能每次重启都产生一台“新机器”。Agent 所有权变更必须显式进行，并同时轮换设备凭据。

Agent 注册、所有权转移和 User suspend/revoke 共享目标 User 的串行化边界：注册与转移提交时重新确认目标 User active；User 在仍拥有 active Agent 时不能进入非 active 状态，必须先 revoke 或 transfer Agent。owner transfer 与 Project/Task 写仍保持 `Project → target User → Agent → Task` 的固定锁序，User lifecycle 不反向取得 Project 锁。

### 3.5 主要 Agent 由用户选择

首期允许同一用户注册多台 SciForge，但必须明确选择一台主要 Agent，作为手机创建个人 Session 时的默认目标。

主要 Agent 离线时，系统应显示离线并等待、取消或让用户显式选择另一台机器。不得自动把工作交给最近在线机器，更不能交给另一个用户的机器。

## 4. 两种候选消息空间（非冻结产品拓扑）

本节描述 umbrella 目标中的一种远端交互模型。只有团队选定 Human Provider、客户端和消息方向后，相关 locator/Topic 才能成为产品合同；A-MVP-001~012 不依赖本节落地。

个人 Session 和多人 Project 的语义不同，必须使用不同的路由规则。

### 4.1 个人 Session 远端位置

若最终方案支持个人 Session 的远端投影，可为某个本地 Session 建立一个 Provider locator。

它固定绑定：

- Session 的所有者；
- 执行该 Session 的 SciForge；
- 本地 Session；
- 一个经过验证的 Human Endpoint；
- 已选 Provider 中的具体 locator（例如其支持的 Topic）。

绑定建立后，切换桌面焦点、打开其他 Project 或修改 locator 的显示名称，都不会改变它所指向的 Session。

个人 Session 默认只有所有者可以发送可执行消息。用户可以显式邀请其他成员进入共享 Session，但界面必须清楚显示：“该 Session 由谁的 SciForge 执行”。其他成员加入后不会自动改用自己的机器，也不会为每个人暗中创建新的 Session。

### 4.2 Project 远端位置

若最终方案提供 Project 的远端沟通入口，该位置不是某个人的私人 Session。

成员在其中发送的内容，先作为带有真实发送者身份的 Project 输入保存到云端。Coordinator 可以：

- 回答问题；
- 请求澄清；
- 建议创建、重试、改派或取消 Task；
- 把内容记录为候选观察；
- 拒绝越权或与 Project 无关的指令。

远端 Project 输入不会直接广播给所有 Agent。Worker 只有收到明确分配给自己的 Task 才会执行。

### 4.3 为什么必须区分两者

如果 Project 远端位置直接对应某个人的私人 Session，就会出现以下问题：

- 其他成员的消息都由该人的机器执行；
- 其他人的 Agent 无法形成清晰的任务边界；
- Project 状态隐藏在一个本地对话中；
- 机器离线后整个 Project 失去共同状态；
- 成员容易误以为自己的本地权限正在被使用。

因此，这一候选模型用个人 Session 远端位置表达“我从 Human 入口继续自己的工作”，用 Project 远端位置表达“多人如何围绕共同目标协作”。是否采用该模型仍待产品方案确认。

## 5. 候选个人 Session 交互流程（非 A 本轮门槛）

### 5.1 Human 客户端发起消息

以下仅适用于未来选择了支持该流程的 Human Provider：

1. 用户在个人 Session 的远端位置发送消息。
2. 已选 Provider 将验证后的消息事件交给 A 的 Human Gateway。
3. 云端确认发送者属于哪个用户，并确认该用户有权访问目标 Session。
4. 云端根据稳定的 Session 映射，把消息投递给指定的 SciForge。
5. SciForge 在原本地 Session 中记录消息并运行 Agent。
6. SciForge 将最终回复交回云端。
7. A 按未来冻结的返回策略，把最终回复投递到原 Provider locator。

整个过程中，本地 Session 是 Agent 上下文的权威来源。A 和已选 Provider 只保存各自完成投递及远端展示所需的最小信息。

### 5.2 桌面发起消息

1. 用户在桌面 Session 中提交消息。
2. SciForge 先把消息写入本地 Session。
3. 若最终方案启用远端投影，已绑定的 Provider locator 收到同一条用户消息。
4. Agent 完成回复后，最终回复按已选返回策略显示在桌面和 Human 客户端。

首期只同步完整文本消息和最终回复，不同步逐字生成过程。

### 5.3 消息顺序

同一个 Session 在任意时刻只执行一条用户消息。如果 Human 客户端和桌面同时发来消息，后到的消息排队等待。

不同 Session 可以并行运行，因此一个 Project 中的多个独立工作不会互相阻塞。

### 5.4 消息去重

系统为每条入站和出站消息保留投递记录。即使已选 Provider 重发事件、网络请求超时、SciForge 重启或云端重新连接，同一条逻辑消息也只能创建一个本地 Agent 回合。

如果无法确认消息是否已成功发送，系统先对账，再决定是否重试，不能简单发送第二份。

## 6. 多人 Project 的协作方式

### 6.1 Project 以用户为成员

Project 成员列表记录参与的用户，而不是只记录机器。界面把每名用户的手机状态和 Agent 状态组合展示，例如：

- 用户在线，Agent 在线；
- 用户可通过手机联系，Agent 离线；
- Agent 正在执行，用户暂时不可联系；
- 手机端点或 Agent 已撤销。

### 6.2 每个 Project 有一个 Coordinator

每个 Project 同时只有一台 SciForge 担任 Coordinator。Coordinator 负责：

- 理解 Project 目标；
- 维护正式计划；
- 提议 Task、执行者、重试、改派和取消；
- 检查 Worker 返回的结果；
- 接受 `observation` 和 `task_result` Project 记录；
- 把无法自动解决的问题交给目标用户；
- 起草最终总结，交由 Project Owner 确认。

Coordinator 是一种 Project 角色，不是一种特殊版本的 SciForge。同一台 SciForge 可以在自己的 Project 中担任 Coordinator，也可以在其他 Project 中担任 Worker。

Project Owner 负责首次任务分配、变更执行者的改派、取消，以及 `proposal`、`decision`、`summary` 等正式 Project 结论。Owner 以自己的 User credential 直接发起受管动作时，该调用本身就是 Owner 的确认，不要求先制造第二个确认对象；当前 Coordinator Agent 代为执行时，必须提交绑定不可变动作的 `confirmationId`。同一执行者的重试适用于 `succeeded`、`failed` 或 `rejected`，可由 Owner 或当前 Coordinator 发起；换执行者的改派也通过 `task.retry`，由 Owner 直接发起或由持有匹配确认的当前 Coordinator 发起。`succeeded` 只表示 Worker execution 完成；若候选 `task_result` 已被接受为正式记录，则普通 retry/改派不得静默撤销它。云端只校验并保存这些已确认事实，不实现 Coordinator 的任务拆分、推荐或科研验收算法。

### 6.3 Worker 只处理明确 Task

Worker 收到的每个 Task 都明确包含目标、执行者、当前版本、完成条件和状态。

Worker 可以接受、拒绝、执行、报告失败、提交结果或请求真人帮助，但不能直接修改全局计划，也不能向其他 Worker 广播新的执行指令。如果需要其他能力，Worker 向 Coordinator 提出建议；Coordinator 可以形成新 Task 建议，Project Owner 确认后才由云端创建正式 Task。

### 6.4 使用星形协作而不是自由群聊

所有正式任务都先由 Coordinator 提议，再由 Project Owner 确认并通过云端分配；Worker 把结果返回 Coordinator。这种结构能避免：

- 多个 Agent 重复执行同一工作；
- Worker 相互创建无界任务；
- 多台机器同时改写 Project 计划；
- 无法判断哪个结果已经被正式接受。

不同 Worker 可以并行执行互不依赖的 Task。

### 6.5 Coordinator 转交

Coordinator 离线时，首期 Project 暂停创建新 Task。具有权限的用户可以显式把 Coordinator 转交给另一台 Agent。

转交完成后，旧 Coordinator 不能继续写入计划。首期不进行自动选主，以免两台机器同时认为自己是 Coordinator。

## 7. 云端协作服务的职责

### 7.1 身份与设备目录

云端保存用户、已验证手机端点、Agent 所有权、主要 Agent 和在线状态。这一目录负责回答“这个手机账号是谁”和“这个用户的工作由哪台机器执行”。

### 7.2 Project 与 Task 账本

云端保存 Project 目标、成员、Coordinator、Task、执行者、状态和版本。任何越权或过期修改都会被拒绝。

### 7.3 持久信箱

每个用户和 Agent 都有持久信箱。实时连接只负责通知“有新消息”，真正的消息在数据库中保存。

Agent 离线时，Task 不会丢失；重新连接后从上次确认的位置继续读取。

### 7.4 Project 共享记录

云端只保存对 Project 有共同价值的正式信息：

- 已确认的观察；
- 已接受的 Task 结果摘要；
- 正式决定；
- 阶段总结和最终总结。

Worker 可以提交候选内容。`observation` 和 `task_result` 可由 Coordinator 或 Project Owner 接受；`proposal`、`decision` 和 `summary` 只能由 Project Owner 接受。

### 7.5 人类消息入口

若产品采用 Human Provider，A 的 Human Gateway 负责通过所选适配器验证远端用户身份、解析稳定 locator、过滤重复事件，并按已冻结的返回策略投递回复。具体 Provider、locator 类型和调用方向尚未确定。

Provider 专有逻辑应封装在独立适配器中。更换 Provider 时，不应修改 SciForge Host 或云端核心的业务分支。

### 7.6 云端明确不做什么

云端协作服务不运行模型，不调用用户本地工具，不保存完整私人对话，不读取本地工作区，也不持有用户的 SSH、VPN 或模型凭据。

### 7.7 Task execution 与候选结果

Task 是稳定工作目标，`revision` 是实体并发版本，`executionId` 是一次实际执行授权，三者不能互相替代。

- `task.create` 生成第一个不透明 `executionId`；`task.retry` 每次生成新的 `executionId`。
- 同一次 execution 从 offered 经 accepted、running、needs_human、恢复 running 到终态时保持同一 `executionId`，但每次写入仍递增 revision。
- Worker 的 transition、progress、HumanNeeded、Task-scoped ResourceRef 和结果写入必须同时匹配 `taskId + executionId + assigneeAgentId + expectedRevision`。
- 旧 execution 的迟到写入使用稳定 `execution_conflict` 拒绝，并只返回当前 revision/execution 等安全冲突事实。

Worker 的 `succeeded` 表示 Runtime execution 已完成，不等于结果已被 Coordinator 接受。成功 transition 必须携带结构化摘要、按 criterion ID 组织的 evidence、ResourceRef IDs 和可选有界 log summary。A 在一个数据库事务中把 Task 置为 `succeeded`、创建该 execution 唯一的候选 `task_result` ProjectRecord、保存幂等回执并向当前 Coordinator 投递通知。协议中的候选状态使用 `proposed`（语义上对应 B/C 评审中的 submitted）。

对 `succeeded`、`failed`、`rejected` 执行 retry 时，A 生成新 execution；上一 execution 尚未接受的候选结果原子进入 `superseded`。已经接受的 ProjectRecord 是正式 Project 事实，普通 retry 必须失败，不能静默撤销。

### 7.8 Owner 直接决定与不可变动作确认

受管动作包括首次 `tasks.create`、变更 assignee 的 `task.retry_reassign`、`task.cancel` 和 `project.complete`。A 支持两条不重叠的授权路径：

1. Project Owner 使用自己的 User credential 直接调用；该调用本身表达 Owner 的当前决定。
2. 当前 Coordinator Agent 代为调用；必须携带 Owner 通过 HumanAnswer 产生的 `confirmationId`。

批准型 HumanRequest 保存不可变 `ConfirmableAction`。每类动作都显式绑定 `projectId`，并按动作绑定 proposal digest、Task/from execution/new assignee、Task execution 或 final record digest。A 在创建请求和消费确认时都校验 target Owner、当前 Coordinator、Project、Task 归属、动作 digest、有效期、状态和是否已 superseded，确认不能跨 Project 或跨 Owner 复用。通信 revision 的普通变化不自动让确认失效，但任何与获批动作冲突的业务事实都会导致 `confirmation_mismatch`。同一幂等请求重放返回原回执；不同动作不能复用已消费确认。

冲突事实提交时，A 会在同一事务中把相关、仍为 `approved` 的确认持久化为 `superseded`；确认过期也会被权威清理流程物化为 `superseded`。因此 `confirmation.get` 不会在改派、取消、Task 终态、正式结果接受、Coordinator 转交或 Project 终态之后继续把已经失效的授权显示为 approved；`consumed` 保持终态且不会被后续清理改写。

### 7.9 Coordinator 与 Worker 都可创建定向 HumanNeeded

`human.needed.create` 有两个严格来源：

- Worker 来源绑定当前 `taskId + executionId + expectedTaskRevision`，且 actor 必须是当前 assignee；只有这种来源会把 active Task 推入 `needs_human`。
- Coordinator 来源绑定 `projectId + sourceInboxMessageId`，且 actor 必须是当前 Coordinator；这种项目确认、结果追问或资源问题不得改变 Worker execution 状态。

两者都必须指定 `targetUserId`。HumanAnswer 持久化回答者、端点、assurance、请求与相关 revision，并回到原请求 Agent 的 Inbox。取消、过期或被新 execution 取代的请求不能改变当前状态。

### 7.10 能力快照与 Project 协调读取

C 可通过 `agent.capability_profile.report` 上报有期限的严格快照，heartbeat 只维护可达性。快照包含 Agent/owner、节点类型、OS/架构、runtime IDs、稳定 capability IDs 与证据等级、最小 GPU 摘要、VPN access IDs、Slurm cluster IDs、可访问 ResourceRef IDs、结果回传策略和 reported/expires 时间。VPN/Slurm 字段只允许不透明公共 ID，不得包含凭据、地址、队列私有结构或本地路径。online/busy/revoked 状态由 A 根据心跳、当前 execution 和撤销事实派生，不由 C 自报；过期、owner 不匹配或已撤销 profile 不进入新分派目录。

B 可通过已知 `projectId` 读取 `ProjectCoordinationView`，在同一权限与一致读取边界中获得 Project、成员、当前 Coordinator、Tasks、ProjectRecords、HumanRequests 和 HumanAnswers。该投影不建立第二份权威实体，不包含私人 Session、附件正文、完整日志或其他 Project 数据。A 不基于能力自动选 Worker，也不实现 B 的任务拆分、排序、追问或科研验收逻辑；C 仍拥有本地执行 journal 与 AgentRuntime。

### 7.11 连续 Inbox ACK 与 Coordinator 转交

同一 recipient Inbox 的所有 Coordinator/Worker 消息共享单调 sequence。客户端可以并行处理，但只能提交已连续完成的最高 sequence，`inbox.ack` 可按明确消息/sequence 或连续位置确认，并返回服务器实际提交的 ack sequence。任何未完成的 active 消息都会形成 ACK gap；只有被 A 明确标为 `superseded` 的消息可安全跨越。

公共 InboxMessage 只发布可由权威状态证明的 `pending | acknowledged | superseded`：active 消息是否 acknowledged 由该 recipient 的持久 `ackedSequence` 派生，不虚构逐消息确认时间；未确认消息过期时先持久化为 `superseded` tombstone 并保留原 sequence，只有已连续确认的过期消息才可物理清理。A 不发布当前存储无法证明的 delivered、expired 或 dead-letter 状态。

Coordinator 转交时，A 在同一事务中使旧 Coordinator 尚未处理的 Coordinator 类消息 supersede，并为新 Coordinator 生成新的 recipient-specific 投递。新消息可保存 reroute provenance，但不得复用旧 recipient 的 sequence、ACK 或 message identity。Worker 专属 offer 不因 Coordinator 转交被错误改派。

### 7.12 稳定错误与 ResourceRef 执行围栏

公共错误统一包含 `requestId`、`traceId`、稳定 `code` 和 `retryable`。冲突可返回调用者已获权查看的 current revision、current execution 或 confirmation ID，但不能泄漏其他 Project、凭据或 provider 响应正文。B/C 增量至少冻结 `execution_conflict`、`assignee_mismatch`、`coordinator_mismatch`、`confirmation_required`、`confirmation_mismatch`、`resource_unavailable`、`capability_profile_expired` 和 `inbox_ack_gap`。

ResourceRef 使用稳定 ID 与安全 HTTPS 元数据；长期 secret、短期签名 URL、本地绝对路径、正文和 provider credential 均不得成为稳定引用内容。引用支持 `available | unavailable | revoked`，并保留既有 `invalidated` 终态。Task-scoped 引用绑定当前 execution；Worker 只有在当前 Task 显式引用且仍为 assignee 时才能创建或读取。失效资源不能进入成功结果。文件正文或完整日志的跨信任域传输仍需要范围匹配的人类确认和 C/本机批准，不由 A 自动上传。

### 7.13 协议制品

协议 `1.0` 的 strict Zod 合同必须从固定源码生成并提交机器可读制品：command/response/error/Inbox/entity JSON Schema、状态转换表、actor 权限表和正常、重复、乱序、revision conflict、idempotency conflict、旧 execution、确认失效 fixtures。freshness 测试必须证明生成结果与当前合同一致；B/C 可以使用这些制品验证 adapter，而无需获得 A 数据库访问权或猜测字段。

### 7.14 Core readiness 与未决身份方案

`/healthz` 只说明进程存活，`/readyz` 只说明 canonical PostgreSQL 可用。Provider catalog、启动诊断和身份/pairing 是否可用必须作为独立业务前置检查，不得由 `/readyz=200` 推断。

在 core-only 模式下，预期 Provider catalog 为空，只能验收 Tunnel、health/readiness、匿名协议错误和不依赖身份的合同面；不得宣称真实 pairing、Agent 注册或 Project 闭环已经开放。正式 Human Provider、Zulip 与最新版 SciForge 的连接方式、身份前置、测试组织和开放时间仍待团队方案确认，A 的内核合同不得提前把其中任一条候选链路冻结为唯一生产拓扑。

## 8. 候选 Zulip Provider 的职责与边界

本节只约束“团队后续选择 Zulip 作为正式 Human Provider”时必须遵守的边界，不代表该接线方案已经冻结或部署。Zulip 可提供手机和网页聊天体验，包括用户登录、组织、Stream、Topic、历史、未读状态和通知。

Zulip 不理解以下 SciForge 概念：

- 一名用户拥有哪些 Agent；
- 哪台 Agent 是主要执行机器；
- Project 当前由谁协调；
- Task 分配给谁以及执行到哪一步；
- 某个 Task 是否已经执行过；
- 哪条结果已经成为正式 Project 结论。

因此，Zulip Topic 名只是显示和定位信息，不是稳定业务身份。修改 Topic 名不能创建新 Session 或改变 Project。

云端协作服务只能通过 Zulip 的公开 API 和事件接口交互，不能直接读写 Zulip 的内部数据库。

## 9. SciForge 客户端的职责

每台 SciForge 负责：

- 保存本机 Agent 身份和设备凭据；
- 维护与云端的连接和信箱位置；
- 保存个人 Session 与本地工作区之间的关系；
- 接收个人远端消息和 Project Task；
- 通过现有 AgentRuntime 执行；
- 通过现有权限系统处理文件、命令和外部写入；
- 回传状态、结果摘要和允许共享的产物引用；
- 在断线重连后恢复真实执行状态。

个人远端消息和多人 Task 必须复用现有 AgentRuntime 与权限路径，不能新增一套只服务于 Zulip 或云端的模型、工具或审批旁路。

## 10. 真人问题与通知

### 10.1 问题必须指定目标用户

Agent 需要真人决定时，必须明确问题要交给哪名用户。云端只向该用户已验证的手机端点发送。

如果目标用户没有可用手机端点，问题保留在该用户信箱，并在其桌面显示。系统不能因为其他成员在线，就把问题转给其他人。

### 10.2 回答必须可追溯

系统记录谁回答、从哪个端点回答、关联哪个 Project 和 Task、回答时间以及当时请求的版本。

已经取消、完成或被新版本取代的问题不能再改变当前 Task。

### 10.3 控制通知噪声

手机通知包括：

- 个人 Session 新消息和最终回复；
- 需要本人回答的问题；
- 策略允许从手机处理的批准；
- 重要失败或阻塞；
- 阶段摘要和最终结果。

以下内容默认只在桌面或 Project 状态页显示：

- Agent 心跳；
- 普通 Task 进度；
- 工具调用日志；
- Agent 内部推理；
- 机器之间的协调消息。

## 11. 权限与安全

### 11.1 四个问题分别判断

每次操作都要分别回答：

1. 发起者是谁？
2. 使用了哪个手机或 Agent 端点？
3. 发起者在目标 Project 或 Session 中有什么角色？
4. 当前操作需要多高的批准强度？

四项全部满足后，操作才能继续。

### 11.2 手机不自动成为本机管理员

用户可以从手机向自己的 Session 发出任务，但任务执行时仍受本机权限约束。

如果某项操作要求桌面批准，手机只能看到“等待桌面批准”。只有未来某项具体能力明确支持远程批准，并且手机端点达到所需安全等级时，手机批准才有效。

### 11.3 凭据分开保存

- 已选 Provider 的服务凭据保存在其适配器运行环境的受限密钥位置；若未选择 Provider，则不存在这项运行前置。
- Agent 设备凭据保存在对应 SciForge 的本地密钥存储中。
- 模型密钥、SSH 私钥、VPN 凭据和工具凭据留在本地或机构信任域。
- 普通设置、日志、诊断、二维码、文档和 Git 文件中不得出现长期凭据。

### 11.4 数据最小化

| 数据 | 保存位置 |
| --- | --- |
| 用户、手机绑定、Agent 所有权和在线状态 | 云端协作数据库 |
| Project、Task、共享记录、信箱和投递状态 | 云端协作数据库 |
| 已选 Provider 的消息和展示历史 | 该 Provider 的信任域 |
| 本地 Session、完整对话和工作区关系 | 所属 SciForge |
| 本地文件、原始数据、模型与工具凭据 | 用户机器或机构信任域 |

云端只保存完成协作所需的最小信息，不自动上传完整对话、工作区或原始数据。

## 12. 可靠性与故障处理

### 12.1 Human 客户端离线

若已选 Provider 支持消息和未读状态，则由它维护自己的展示事实；无论 Provider 能力如何，需要用户处理的问题继续保存在 A 的用户信箱中。

### 12.2 Agent 离线

个人 Session 消息和 Task 保持等待状态。超过可接受时间后，系统提示用户确认是否继续，而不是在机器重新上线时一次性执行大量陈旧指令。

### 12.3 云端重启

Project、Task、绑定、信箱和投递状态从协作数据库恢复。实时连接恢复后从最后确认位置继续，不重复执行。

### 12.4 Provider 重复投递

相同远端消息只被接受一次。适配器必须过滤自身发送后又收到的回声事件；具体去重键由所选 Provider 的稳定身份映射决定。

### 12.5 Topic 改名或移动

系统更新远端位置和显示名称，但保持原 Session 或 Project 身份。如果无法唯一确认新位置，绑定进入错误状态，等待人工修复。

### 12.6 Coordinator 离线

正在执行且已获得授权的 Task 可以按本地策略继续；新的计划变更和 Task 分配暂停，直到原 Coordinator 恢复或有权用户显式转交。

### 12.7 设备撤销

手机或 Agent 被撤销后，旧凭据立即不能创建新消息或状态变化。未完成工作进入可见的待处理状态，不自动改派并重复执行。

## 13. 用户界面

### 13.1 参与者页面

每名用户显示为一张统一参与者卡片，包括：

- 用户名称；
- 手机端点及最后验证时间；
- 主要 Agent 及在线状态；
- 当前 Project 角色；
- 重新验证、切换主要 Agent 和撤销入口。

界面不应要求用户从两个无关列表中猜测哪个手机属于哪台机器。

### 13.2 个人 Session 页面

用户可以选择一个本地 Session 分享到手机，并看到：

- 对应 Topic；
- 实际执行 Agent 和所有者；
- 最近同步状态；
- 排队消息；
- 失败和重试；
- 暂停、恢复、重命名和关闭。

切换桌面当前 Session 不会自动重绑远端 Topic。

### 13.3 Project 页面

Project 页面集中展示：

- 目标和当前状态；
- 成员及各自手机、Agent 状态；
- 当前 Coordinator；
- Task、执行者和依赖；
- 等待 Project Owner 确认的任务分配、改派、取消或正式结论；
- 需要真人处理的问题；
- 已接受的观察、决定和总结。

用户应能一眼分辨“这是团队 Project 状态”还是“这是某个人的本地 Session”。

## 14. 软件边界

系统按职责分为四个可独立拥有和发布的部分。

### 14.1 共享合同

统一描述用户、端点、Agent、Project、Task、消息、状态、错误和权限规则。它不包含数据库、网络、界面或 Agent 执行逻辑。

### 14.2 云端协作服务

独立部署并拥有协作数据库，负责身份、账本、信箱、路由和确定性授权。

### 14.3 SciForge 协作领域

同一个领域包同时拥有桌面后端和界面，负责 Agent 注册、Session 投影、本地队列、Task 接入和协作页面。它通过标准领域清单安装，不修改 Host 中央功能表。

这是 `origin/gui` 既有的桌面生产能力及 C/客户端责任边界。A 只维护它所调用的云端公共合同，不在云端重写该领域、AgentRuntime、SDK 或设备适配。

### 14.4 IM Provider 适配器

封装所选 Provider 的认证、用户身份、事件、locator、发送和重试。Zulip adapter 是可选实现之一；在产品方案冻结前，A 只承诺 provider-neutral 合同，不承诺特定 Provider、Topic 拓扑或本地 SciForge 接法。以后支持其他 IM 时，实现同一适配合同即可，不在 Host 或云端核心增加特殊分支。

每项能力只有一条生产路径。旧的远端频道绑定、Host 内置 Zulip 运行时和重复消息镜像路径在迁移完成后删除。

## 15. 部署关系

若最终选择 Zulip，Zulip Server 和云端协作服务可以部署在同一台阿里云 ECS 上，也可以分开部署；无论拓扑如何，它们逻辑上必须是两个独立服务。本段是部署约束，不是当前已批准拓扑。

它们使用独立进程、独立配置、独立权限边界和独立数据库。云端协作服务只能使用 Zulip 的公开接口，不能直接修改 Zulip 数据库。

服务地址、Provider 和内部连接都由配置管理，不写死在 SciForge Host 或 A 核心合同中。

## 16. 迁移原则

这是一次目标语义替换，不长期保留旧逻辑。

升级时用户依次完成：

1. 登录或创建统一用户身份。
2. 若最终方案采用 Human Provider，重新验证所选 Provider 的 Human Endpoint。
3. 注册自己的 SciForge Agent。
4. 选择主要 Agent。
5. 若最终方案支持远端个人 Session，重新建立需要的受控投影。
6. 加入或创建多人 Project。
7. 按最终冻结的产品方向分别验证 Human 输入、SciForge 执行、结果返回和多人 Task 流程。

旧的工作区—频道绑定、由 Topic 名生成身份、Topic 静默切换 Session、Host 内置 provider 分支和两套同步路径全部删除，不增加长期兼容层。

## 17. 分阶段落地

以下阶段描述整个 umbrella 方案的跨团队形成过程。阶段三的桌面/个人 Session、阶段四的 Coordinator/Worker 业务流程和阶段六的多用户最终试用不属于 A 本轮需要重新实现的内容；A 本轮只收口相应的云端公共边界、服务器自动 conformance 和可生成协议制品。真实 Provider/SciForge 接线要等具体方案确认后另列验收任务。

### 阶段一：统一身份

实现用户、手机端点、Agent 所有权、主要 Agent 和撤销流程。此阶段先回答清楚“谁是谁、哪台机器属于谁”。

### 阶段二：只读连接

手机和桌面可以查看身份、Agent、Project 和 Session 映射状态，但手机消息暂不触发执行。先验证路由正确性。

### 阶段三：个人 Session 双向同步

实现手机与桌面共享同一 Session、顺序队列、去重、离线恢复和最终回复同步。

### 阶段四：多人 Project 与 Task

实现成员、Coordinator、Worker、Owner 确认后的 Task、Project 记录、并行执行和手动 Coordinator 转交。

### 阶段五：真人问题与 Project Topic

实现定向问题、回答、重要通知以及 Project Topic 到 Project 输入的稳定映射。

### 阶段六：删除旧路径并正式验收

删除旧实现，完成源代码和打包应用验证，并用六名专用 QA 用户进行可选的跨团队端到端测试。该自动化 harness 只能使用测试负责人控制的专用账号和受限 secret 文件，不得收集普通团队成员的 Zulip API key，也不能以 API/Agent Bearer 模拟结果替代最新版 SciForge 的真实执行证据。

阶段用于安排开发顺序，不用于保留两套长期生产逻辑。

## 18. 最终验收标准

以下是 umbrella 方案的跨团队最终验收标准，不是 A 本轮发布门槛，也不说明产品链路已选定。A 的独立完成标准是云端协议与服务端自动 conformance；真实 Provider、最新版 SciForge 和六用户测试在具体接线方案及各模块正式就绪后由团队另行执行。

方案完成后，应满足以下可观察结果：

1. 六名用户分别绑定自己的手机和 SciForge，系统显示为六个协作个体。
2. 用户 A 从个人 Topic 发消息，只进入 A 明确选择的 Agent 和固定 Session。
3. 用户 B 的 Agent 不会因为在线或处于同一 Stream 而收到 A 的个人任务。
4. 桌面和手机看到同一个个人 Session 中相同顺序的用户消息与最终回复，且没有重复。
5. Project Topic 中 A、B、C 的消息保留各自身份，进入云端 Project，而不是任意一个人的私人 Session。
6. Coordinator 可以提出两个独立 Task 和执行者建议；Project Owner 确认后，云端把它们分配给不同用户的 Agent 并行执行，Coordinator 收集结果。
7. 用户 B 的 Task 需要决定时，只通知 B；无权成员不能代答。
8. 手机触发的高风险操作仍遵守本地权限策略。
9. Agent、云端或最终选定的 Provider 短暂断线后可以恢复，不重复执行消息或 Task。
10. 修改中文 Topic 名不会改变 Session 或 Project 的稳定身份。

当这十项同时成立时，才能认为“一个用户的手机和机器是同一个逻辑个体”以及“多个逻辑个体可以安全协作”已经真正实现。
