# A 专用 ECS：loopback 预发布与服务器 conformance

本目录为新 A ECS 上 `@sciforge/collaboration-server` 的最小 Docker Compose 预发布层。默认仍是 core-only；只有显式叠加 `compose.provider-zulip.yml` 时才启用 Zulip Provider。两种模式都只暴露 ECS loopback，供 A 通过 SSH tunnel 验证服务器、数据库、公开协议和 Provider 边界。

这不是面向 SciForge 的产品入口，也不能证明公网链路已经切换。产品唯一入口必须保持为 `https://chat.sciforge.cn/collaboration`，并由该 HTTPS 路径反向代理到新 A 服务；完整链路是“Zulip → A 云端协同服务 → 本地最新版 SciForge”，结果按相反方向返回。当前 loopback 部署只能作为切换前的 conformance 环境，不能让本地 SciForge 改用 HTTP tunnel 绕过 HTTPS 要求。

| 层面 | 本目录能证明 | 本目录不能单独证明 |
| --- | --- | --- |
| 新 A 服务器 | 固定发布物、数据库、loopback API/WSS、Provider 和重启恢复行为 | canonical HTTPS 已反代到新 A |
| 自动化验收 | HTTP/WSS 与 Zulip API 的协议级闭环 | 真实最新版 SciForge/AgentRuntime 已完成端到端闭环 |
| 产品开放 | loopback 控制台、API 与预发布门禁已经具备 | 正式 HTTPS 切换和成员业务验收已经完成 |

## 重要边界

- 运行镜像只安装固定 commit 生成的三个 npm tarball：contracts、Zulip provider 和 server。默认发布仍只接受已进入 `origin/gui` 历史的获批 commit；未合并 feature commit 只能使用下述显式 `private-test` 或 `team-private-acceptance` 模式。Docker build context 受 `.dockerignore` 限制，不复制或编译 SciForge 源码。
- 默认是 **core-only**：`compose.yml` 不注入 Provider 配置或 secret。`deploy-provider-zulip.sh` 才会显式加载只作用于 app 的 overlay；migrate 始终看不到 Provider 配置和 secret。
- 原生入口是 `POST /v1/commands`、WebSocket `/v1/events` 和 A-only 网页控制台 `/console/`；没有 `/v1/meta`，也没有旧实验服务的 `/v1/ws`。
- 应用在容器内监听 `0.0.0.0:8787`，但 Docker 只向 ECS `127.0.0.1:${SCIFORGE_COLLAB_HOST_PORT}` 发布。PostgreSQL 不发布宿主机端口。
- 本目录当前不使用 Nginx，也不开放 80/443；这是预发布隔离边界，不是最终产品网络形态。阿里云安全组继续只允许受限来源访问 SSH 22，正式开放必须另外完成 canonical HTTPS 到新 A 的受控切换。
- 最新版 SciForge 的本地协作领域只经 A 的 HTTPS/WSS 公共接口连接云端；Zulip adapter 运行在 A 云端服务侧，本地 SciForge 不直接调用 Zulip。A 不应另造一套成员侧聊天、Agent runtime 或临时 HTTP 产品入口。
- app 与一次性 migrate 容器固定使用非登录 UID/GID `10001:10001`；Provider secret 由宿主机 `root:10001`、文件 `0640`、目录 `0750` 提供，other 无任何权限。Provider 部署门禁还会拒绝 `sciforge-admin` 或任一可登录宿主机账号把数值 GID `10001` 作为主组或附加组；宿主机没有对应的 NSS group 条目是允许的，容器仍可按数值 GID 读取只读挂载。

## 1. 在可信构建机生成 release bundle

先确认工作树干净且 commit 是获批的 `origin/gui` commit，再测试并调用仓库内的 bundle builder。以下 `release_commit` 必须是完整 40 位 SHA：

```bash
test -z "$(git status --porcelain)"
release_commit="$(git rev-parse HEAD)"
test "$release_commit" = "$(git rev-parse origin/gui)"

npm ci
artifact_dir="$(mktemp -d)"
npm run collaboration:typecheck
npm run collaboration:test
npm run collaboration:bundle -- \
  --commit "$release_commit" \
  --output "$artifact_dir/release"
```

默认模式不会接受仅存在于 feature branch 的 HEAD，manifest 会记录 `releaseMode: "origin-gui"`，且原有 `git merge-base --is-ancestor <HEAD> origin/gui` 生产检查不会被放宽。

### 仅 A 私有 ECS 的 feature 测试发布

如果必须在合并前验证当前 feature commit，只能显式传入 `--private-test-release`。构建前先更新远端基线、提交全部预期变更并保证工作树 clean；builder 会再次要求 `--commit` 等于完整 HEAD SHA，并验证当前完整 `origin/gui` commit 是 HEAD 的 ancestor：

```bash
git fetch origin gui
test -z "$(git status --porcelain)"
release_commit="$(git rev-parse HEAD)"
base_commit="$(git rev-parse origin/gui)"
git merge-base --is-ancestor "$base_commit" "$release_commit"

npm ci
artifact_dir="$(mktemp -d)"
npm run collaboration:typecheck
npm run collaboration:test
npm run collaboration:bundle -- \
  --private-test-release \
  --commit "$release_commit" \
  --output "$artifact_dir/release"
```

该模式不会成为默认值。manifest 必须同时记录 `releaseMode: "private-test"`、feature `contractCommit` 和完整 `baseCommit`；构建日志会明确显示 `TEST-ONLY PRIVATE RELEASE`。这种 artifact 只允许部署到本 A 专用 ECS 的现有 loopback-only Compose，通过 SSH tunnel 验证；不得开放公网、接入域名/TLS/反向代理、推送为共享生产 artifact、交给 B–E 联调或冒充 `origin-gui` 正式发布。feature 合并后必须重新用默认模式构建正式 bundle，不能给 private-test artifact 改名继续使用。

### 团队私有验收 bundle

需要让团队通过同一台 A ECS 做合并前验收时，必须使用名称明确、不可隐式启用的 `--team-private-acceptance` 模式。它与 `--private-test-release` 互斥，仍要求工作树 clean、`--commit` 等于完整 HEAD，并验证完整 `origin/gui` 是 HEAD 的 ancestor：

```bash
git fetch origin gui
test -z "$(git status --porcelain)"
release_commit="$(git rev-parse HEAD)"
base_commit="$(git rev-parse origin/gui)"
git merge-base --is-ancestor "$base_commit" "$release_commit"

npm run collaboration:bundle -- \
  --team-private-acceptance \
  --commit "$release_commit" \
  --output "$artifact_dir/release"
```

manifest 会记录 `releaseMode: "team-private-acceptance"`、完整 `baseCommit`、完整 `contractCommit` 和 `deploymentBoundary: "loopback-ssh-tunnel-only"`。这不会放宽默认 `origin-gui` 发布规则；artifact 不得绑定公网地址、反向代理或域名，也不得当作正式发布。

将 `artifact_dir/release/` 的完整 bundle 复制到本目录的 `bundle/`：三个 `.tgz`、`package.json`、`package-lock.json`、`CONTRACT_COMMIT`、`RELEASE_MANIFEST.json` 和 `SHA256SUMS`，共八个文件。除 `SHA256SUMS` 自身外的七项发布输入都必须由它覆盖；部署还会检查 manifest 的 commit、artifact 类型和三个包文件名。bundle 只能包含这些文件以及部署目录自带的 `.gitignore`，任何额外文件、目录或 symlink 都会被拒绝。`bundle/.gitignore` 会阻止发布产物被提交到 Git。

SHA-256 全部通过后，部署脚本直接读取已校验 server tarball 内的 `package/migrations/NNNN_<name>.sql`，要求 migration 从 `0001` 连续、每项为非空 regular file，并以严格格式解析全部 `CREATE TABLE [IF NOT EXISTS] sciforge_collaboration.<name>`。最高 migration 编号和完整排序表集由 release 自动推导；验收不读取源码目录，也不接受 env 自报 schema version/table list。新增 migration 必须保持连续文件名，无法安全解析的 `CREATE TABLE` 或空表集合会在操作数据库前失败。

服务器不需要也不应 clone SciForge 仓库。向 ECS 传输本部署目录和上述 bundle 即可；不要传输 `node_modules`、源码、`.git` 或开发 `.env`。

## 2. 创建服务器环境文件

生产 env 固定放在 release 目录之外，避免切换或清理 release 时误删 secret：

```bash
sudo install -d -o root -g root -m 0700 /srv/sciforge-collaboration/secrets
sudo install -o root -g root -m 0600 /dev/null \
  /srv/sciforge-collaboration/secrets/collaboration.env
sudoedit /srv/sciforge-collaboration/secrets/collaboration.env
```

参考 `.env.example` 填写全部变量。分别运行两次 `openssl rand -hex 32`，为 `sciforge_admin` 初始化管理员和 `sciforge_collab` 应用角色生成不同密码。应用角色是数据库 owner，但显式为 `NOSUPERUSER NOCREATEDB NOCREATEROLE`；app/migrate 容器只获得应用密码，管理员密码只进入 PostgreSQL 容器。不要把密码放进命令参数、聊天、Git、日志或截图。初始化数据库后不要只修改 env 来“轮换”密码；PostgreSQL 角色和连接串必须在维护窗口内同步变更。

脚本只接受 regular、非 symlink、无 group/other 权限的 env 文件，并用受限 literal parser 读取必要字段；不会 `source` env 文件，也不会打印 secret。

首次启动必须使用新的 `collaboration-db` named volume：官方 PostgreSQL entrypoint 只会在空数据目录执行 `postgres-init/`，从而创建独立管理员和最小权限应用角色。如果检测到旧 volume 缺少 `sciforge_admin` 或应用角色仍有超级用户权限，健康检查/验收会失败；先保全备份并做显式迁移，不得通过删除唯一 volume 绕过检查。

### 可选 Zulip Provider 文件

core-only 不需要下列文件。启用 Zulip 前，在宿主机为容器的数值 GID `10001` 准备只读 config 和 secret；如果该 GID 已属于其他用途，先停止，不要复用：

```bash
getent group 10001
sudo install -d -o root -g 10001 -m 0750 \
  /srv/sciforge-collaboration/provider \
  /srv/sciforge-collaboration/provider/secrets
sudo install -o root -g 10001 -m 0640 \
  deploy/collaboration-private/provider-config.example.json \
  /srv/sciforge-collaboration/provider/providers.json
sudo install -o root -g 10001 -m 0640 /dev/null \
  /srv/sciforge-collaboration/provider/secrets/zulip-api-key
sudoedit /srv/sciforge-collaboration/provider/providers.json
sudoedit /srv/sciforge-collaboration/provider/secrets/zulip-api-key
```

`providers.json` 只放 `realmUrl`、Bot email、secret 文件名和 assurance，不放 API key。实际 env 继续为 `0600`，并填写示例中的 `SCIFORGE_COLLAB_PROVIDER_CONFIG_FILE` 与 `SCIFORGE_COLLAB_PROVIDER_SECRET_DIR`。脚本只接受固定 `/srv/sciforge-collaboration/provider` 路径、`root:10001`、config/secret 文件 `0640`、secret 目录 `0750`、无 symlink 且单个 secret 不超过 64 KiB。

## 3. 部署

```bash
sudo deploy/collaboration-private/scripts/deploy.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

部署脚本执行以下固定顺序：

1. 验证 bundle 精确文件集合、commit、tarball 结构、全部 SHA-256，并从 server tarball 推导 migration/table truth；
2. 生成带固定 `org.opencontainers.image.revision` 的 runtime image；
3. 在任何可能重建或启动 PostgreSQL 的操作前先停止旧 app；
4. 启动并等待 PostgreSQL healthy，创建发布前 custom-format 备份；
5. 使用同一 runtime image 显式执行一次 `migrate`；
6. 启动 app 并等待 `/readyz`；
7. 执行 loopback、与 release migration 完全一致的 schema version/table set、image revision、core-only provider 拒绝和认证边界验证。

迁移失败时 app 保持停止，不能跳过迁移强行启动。数据库 volume 不随 app image 更新而删除。

### 显式启用 Zulip Provider

```bash
sudo deploy/collaboration-private/scripts/deploy-provider-zulip.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

这个入口额外加载 `compose.provider-zulip.yml`。overlay 只修改 app，并以只读 bind mount 注入 config 和 secret；migrate 不获得这两个环境变量或 mount。启动时 runtime 会调用 `diagnose()` 并将统一脱敏后的结果写入 `provider_diagnostics`。Provider 状态不改变 `/readyz` 的数据库就绪语义，但 `verify-provider-zulip.sh` 会作为单独发布门禁，要求 catalog 恰好只有 `zulip`，且数据库中存在晚于本次 app 容器启动、十分钟内的 `healthy` 诊断。验证过程不打印 secret、配置正文或诊断私有细节。若 app 启动或门禁验证失败，部署 trap 会停止本次未获验证的 app，并保留 PostgreSQL、named volume、失败容器日志、备份与 release 现场供诊断；它不会删除数据、自动声称回滚成功或继续对团队开放失败版本。

### A 两用户服务器 conformance 驱动

从同一固定 commit 的本地工作树运行 `scripts/collaboration-a-two-user-e2e.test.mjs`，经 SSH Tunnel 访问 `http://127.0.0.1:<LOCAL_PORT>`。该驱动是 A 可选的自动化服务器验收工具，不是最新版 SciForge 端到端驱动，也不是服务运行或成员接入的前置条件。

只有运行这项自动化验收时，才需要以下测试拓扑：A 服务 loopback URL、`https://chat.sciforge.cn` realm、Bot email、一个私有 Project stream、Owner/Member email、两个彼此独立且不同于 Project stream 的私有 pairing stream。每个 pairing stream 的订阅者必须精确为对应测试用户与新 A Bot；Project stream 的订阅者必须精确为 Owner、Member 与该 Bot。驱动会通过 Zulip API 核对稳定 user ID，出现任何额外订阅者都拒绝运行。两个测试用户的 Zulip API key 只能通过各自 `0600` 的 `..._API_KEY_FILE` 提供，不能放在命令行或普通 env 值中。

Owner/Member API key 与三个私有 stream 仅服务于上述自动化测试夹具。正常产品运行不要求这三个固定 stream；普通成员也无需向 A 提供个人 Zulip API key。A 服务运行时只持有专用 Bot 的受限凭据，成员通过正式 Zulip 身份、pairing 和最新版 SciForge 协作能力接入。

`SCIFORGE_COLLAB_ZULIP_SECRET_OUTPUT_DIR` 必须是运行用户拥有、非 symlink、权限 `0700` 的仓库外目录。驱动会把一次性 User/Agent 凭据原子写成独立 `0600` 文件，最后只生成包含 User/Endpoint/Agent ID 与凭据文件 basename 的脱敏 manifest。驱动拒绝预置 A/B 应用身份，必须在本次执行中完成正式 pairing；凭据撤销测试后会重新 pairing 并轮换原 Agent credential，确保留下的测试拓扑仍可运营。

```bash
SCIFORGE_COLLAB_A_E2E=1 npm run collaboration:acceptance:test
```

该驱动只使用公开 HTTP/WSS 与 Zulip API，不导入 Service/Repository，也不写数据库。通过条件包括实时 WSS 唤醒、处理后 ACK、在 WSS 已断开时产生 `task.offered` 与 `task.cancelled` 后按连续 sequence 从最后 cursor 补取、真实幂等复放、HumanNeeded/Answer、ResourceRef、ProjectRecord 查询与验收、同 Worker 重试、跨 Worker 改派、旧 Worker 拒绝和凭据撤销/恢复。它证明的是 A 服务公共边界的 conformance；只有 canonical HTTPS 已指向新 A，且真实最新版 SciForge 经 Zulip 完成任务接收与结果回传后，才能宣告产品端到端链路通过。

## 4. 通过 SSH Tunnel 使用

开发机建立隧道：

```bash
ssh -N -L 18080:127.0.0.1:8787 \
  -i <SSH_KEY_PATH> \
  sciforge-admin@<A_ECS_IP>
```

然后只在开发机访问：

```text
http://127.0.0.1:18080/healthz
http://127.0.0.1:18080/readyz
http://127.0.0.1:18080/v1/commands
ws://127.0.0.1:18080/v1/events
```

如确有低层协议或故障诊断需要，团队预发布验收不得共享管理员账号或一把 key。B、C、D、E 可各使用独立的 `sciforge-tunnel-b` 至 `sciforge-tunnel-e`；SSH tunnel 不是正常产品访问方式，也不替代 Zulip 与 canonical HTTPS。安装时必须提供成员字母、该成员独立的 ed25519 公钥和其真实公网出口 `/32`；key 默认 14 天到期，也可提供更早的 OpenSSH `YYYYMMDDHHMMSSZ` 时间：

```bash
sudo deploy/collaboration-private/scripts/install-tunnel-user.sh \
  b /root/member-b.pub <MEMBER_B_PUBLIC_IPV4>/32 \
  --confirm-tunnel-account-change
```

脚本同时写入并用 `sshd -t`/`sshd -T` 验证独立 `Match User`：只允许 TCP local forwarding 到 `127.0.0.1:8787`，显式设置 `AllowStreamLocalForwarding no`，拒绝 Unix-domain socket forwarding、remote forwarding、shell、PTY、SFTP/SCP、agent、X11 和 user-rc；authorized key 还包含 `from=<公网/32>`、`expiry-time`、`restrict` 和同一 `permitopen`。阿里云安全组的 22 端口仍应只允许这些已确认的 `/32`，脚本不会修改安全组。

成员使用自己的账号：

```bash
ssh -N -L 18080:127.0.0.1:8787 \
  -i <MEMBER_B_PRIVATE_KEY> \
  sciforge-tunnel-b@<A_ECS_IP>
```

独立撤销 B 不会影响 C/D/E，并会终止 B 已建立的 tunnel：

```bash
sudo deploy/collaboration-private/scripts/revoke-tunnel-user.sh \
  b --confirm-tunnel-account-change
```

`verify.sh` 会执行一次真实但受限的 core-only API smoke：provider catalog 必须为空；对未安装 provider 的匿名 `pairing.begin` 必须返回 `503 provider_unavailable`，不得返回一次性材料，也不得新增 challenge；随后确认未认证 `user.get` 和 WebSocket Upgrade 均返回 401。该 smoke 不创建 User，不能被描述为用户配对成功或 Project/Task 闭环。

可单独复核：

```bash
sudo deploy/collaboration-private/scripts/verify.sh \
  <同一完整contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

## 5. 备份与恢复门槛

```bash
sudo deploy/collaboration-private/scripts/backup.sh \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

备份路径只允许 `/srv/sciforge-collaboration/backups`，防止误配置后对 `/etc` 等路径执行 `chmod` 或过期清理。首次使用新脚本前，部署清单必须先确认该精确目录已经修正为 `root:root/0700`；脚本本身也会用 `install -d -o root -g root -m 0700` 幂等修正并以 `stat` 验证，避免部署用户删除或替换 root-owned dump/sidecar。备份脚本使用 `flock` 防止并发，调用 PostgreSQL 17 容器内的 `pg_dump` 生成 custom format，设置 `--no-owner --no-privileges`，先写临时文件、校验 `pg_restore --list`，再原子改名并创建相对文件名 SHA-256 sidecar。备份文件为 `0600`，保留 14 天。

每次发布和定期演练时，用管理员身份在同一个 PostgreSQL 实例内创建严格随机命名的隔离临时数据库，验证 sidecar、恢复、release-derived schema version/完整表集合及每张 release 表与源库的 row count；脚本的 `trap` 只删除该临时数据库，不覆盖主业务库。row count 对比要求使用刚生成的备份，并在无业务写入的维护窗口立即运行：

```bash
sudo deploy/collaboration-private/scripts/verify-backup-restore.sh \
  /srv/sciforge-collaboration/backups/collaboration-<UTC时间>.dump \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

本地备份只是第一层。每份 dump 和 sidecar 还应复制到加密的异机存储。灾难恢复仍应使用新的 volume；不得直接覆盖唯一生产 volume。

### PostgreSQL restart 验收

只在维护窗口、已经确认备份可用时运行。脚本没有交互式模糊确认，必须给出完整固定参数：

```bash
sudo deploy/collaboration-private/scripts/verify-postgres-restart.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env \
  --confirm-postgres-restart
```

它显式加载 Zulip Provider overlay，先验证运行 app 的 image ID、image/container revision label、容器内 `CONTRACT_COMMIT` 都等于传入的固定 commit，再验证 provider label、只读 config/secret mount 和 catalog 恰为 `zulip`（不依赖 app 必须在十分钟内启动），然后记录 app/PostgreSQL container ID、PID、RestartCount、commit 和 release 全表 row counts。脚本停止并原位启动 PostgreSQL，要求 `/healthz` 始终返回 `200`、数据库停机窗口内 `/readyz` 精确返回 `503`、恢复后返回 `200`，且 app container/PID/RestartCount 不变、PostgreSQL PID 改变、row counts 完全一致。`trap` 会在中断或失败时尝试恢复 PostgreSQL。

日志检查只输出三个数字，不输出命中行：必须至少有一个安全的 `postgres.pool.idle_client_error`/`57P0x` 诊断（连接池中多个 idle client 可以各自产生一条），且 unhandled、Client object、stack、`secretKey`、`connectionParameters` 和凭据模式计数都为零。

## 6. 资源与兼容性

提交或复制部署资产前，可在任意带 Bash 的可信构建机执行静态策略检查；它会对全部部署 shell 做语法检查，并确认 tunnel、Provider secret 隔离、固定 commit、精确探针状态和失败停机门禁仍存在：

```bash
deploy/collaboration-private/scripts/static-policy-test.sh
```

该部署面向当前 Alibaba Cloud Linux 4、Docker 24.0.9、Docker Compose 2.26.1、4 vCPU、7.3 GiB RAM 的 A ECS。脚本只使用 Compose 2.26.1 已支持的 `config --quiet`、`up --wait`、profiles 和健康依赖，不使用更高版本才提供的 `config --environment`。

默认运行上限：PostgreSQL 1.5 CPU/2 GiB/256 PID，app 1 CPU/768 MiB/256 PID；所有容器使用有界 `json-file` 日志。app 为只读 root filesystem、空 capability set、`no-new-privileges`，并以 Node 镜像的非 root 用户运行。

A 的简易网页控制台已经由同一 server bundle 在 `/console/` 提供，并与 API 共用同源安全边界；它在 loopback 可做 A 内部验收，但在 canonical HTTPS 完成受控反向代理切换前不向成员宣称正式可用。B–E 私有模块仍不属于 A。切换完成前，当前 Zulip 只用于显式的 loopback/SSH-tunnel 服务器 conformance，不应通过放开 8787、5432、让最新版 SciForge 使用 HTTP tunnel 或复制旧实验部署代码来绕过产品链路。
