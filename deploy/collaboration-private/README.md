# A 专用 ECS：loopback 预发布与服务器 conformance

本目录为新 A ECS 上 `@sciforge/collaboration-server` 的最小 Docker Compose 预发布层。默认仍是 core-only；只有显式叠加 `compose.provider-zulip.yml` 时才启用 Zulip Provider。两种模式都只暴露 ECS loopback，供 A 通过 SSH tunnel 验证服务器、数据库、公开协议和 Provider 边界。

这不是面向 SciForge 的正式产品入口，也不能证明公网链路已经切换。正式成员入口、Human Provider/身份来源、本地最新版 SciForge 的接入方式以及域名、TLS、反向代理拓扑目前都尚未冻结；任何候选链路都必须另行评审并完成真实端到端验证。当前 loopback 部署只用于 A 的服务器 conformance，不得据此把 Zulip、某个域名或某条往返链路写成既定产品方案。

| 层面 | 本目录能证明 | 本目录不能单独证明 |
| --- | --- | --- |
| 新 A 服务器 | 固定发布物、数据库、loopback API/WSS、可选 Provider 和重启恢复行为 | 正式入口或反向代理已指向新 A |
| 自动化验收 | HTTP/WSS 公共边界；显式启用时可验证候选 Provider adapter | 真实最新版 SciForge/AgentRuntime 已完成端到端闭环 |
| 产品开放 | loopback 控制台、API 与预发布门禁已经具备 | 正式链路已经选定，或成员业务验收已经完成 |

## 重要边界

- 运行镜像只安装固定 commit 生成的三个 npm tarball：contracts、Zulip provider 和 server。默认发布仍只接受已进入 `origin/gui` 历史的获批 commit；未合并 feature commit 只能使用下述显式 `private-test` 或 `team-private-acceptance` 模式。Docker build context 受 `.dockerignore` 限制，不复制或编译 SciForge 源码。
- 默认是 **core-only**：`compose.yml` 不注入 Provider 配置或 secret。`deploy-provider-zulip.sh` 才会显式加载只作用于 app 的 overlay；migrate 始终看不到 Provider 配置和 secret。
- `compose.yml` 支持透传严格 OIDC 的非秘密配置，但当前正式 issuer 尚未选定。`SCIFORGE_COLLABORATION_OIDC_ISSUER` 为空时进程和数据库 readiness 正常，所有 User、Device 与 binding 入口必须 fail closed；这不是匿名身份模式，也不得恢复 opaque User bearer。Audience 固定为 `sciforge-cloud-api`，授权方固定为 `sciforge-desktop,sciforge-web-mobile`，生产不得允许非 HTTPS issuer。
- 原生入口是 `POST /v1/commands`、WebSocket `/v1/events` 和 A-only 网页控制台 `/console/`；没有 `/v1/meta`，也没有旧实验服务的 `/v1/ws`。
- 应用在容器内监听 `0.0.0.0:8787`，但 Docker 只向 ECS `127.0.0.1:${SCIFORGE_COLLAB_HOST_PORT}` 发布。PostgreSQL 不发布宿主机端口。
- 本目录当前不使用 Nginx，也不开放 80/443；这是预发布隔离边界，不是最终产品网络形态。阿里云安全组继续只允许受限来源访问 SSH 22；正式开放前必须另行批准入口、身份、Provider、TLS 与反向代理方案。
- 本目录只定义 A 的 HTTP/WSS 公共协作边界，不决定最新版 SciForge 最终从何处接入，也不决定 Zulip 是否成为正式 Human Provider。可选 Zulip adapter 只代表一个显式启用的服务器验收候选，不得外推为产品唯一链路。
- app 与一次性 migrate 容器固定使用非登录 UID/GID `10001:10001`；Provider secret 由宿主机 `root:10001`、文件 `0640`、目录 `0750` 提供，other 无任何权限。Provider 部署门禁还会拒绝 `sciforge-admin` 或任一可登录宿主机账号把数值 GID `10001` 作为主组或附加组；宿主机没有对应的 NSS group 条目是允许的，容器仍可按数值 GID 读取只读挂载。

## 1. 在可信构建机生成 release bundle

先确认工作树干净且 commit 是获批的 `origin/gui` commit，再测试并调用仓库内的 bundle builder。以下 `release_commit` 必须是完整 40 位 SHA：

```bash
test -z "$(git status --porcelain)"
release_commit="$(git rev-parse HEAD)"
test "$release_commit" = "$(git rev-parse origin/gui)"

npm ci
artifact_dir="$(mktemp -d)"
npm run collaboration:a:typecheck
npm run collaboration:a:test
npm run collaboration:bundle -- \
  --commit "$release_commit" \
  --output "$artifact_dir/release"
```

`collaboration:a:*` 是本目录发布的 A-only 门禁，只覆盖公共 contracts、Provider adapter 边界、Collaboration Server/PostgreSQL 与 A 的服务器 conformance。根级 `collaboration:typecheck`/`collaboration:test` 还包含本地 domain、projection 与跨团队客户端适配；A 不得为了让它们通过而修改 C Runtime、D 消息解析或 E UI。公共合同发生破坏性升级时，这些跨团队适配应作为明确 handoff 单独完成，不能被误算为 A 云端发布代码。

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
npm run collaboration:a:typecheck
npm run collaboration:a:test
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

core-only 与 Zulip Provider 两个部署入口共享 `/run/lock/sciforge-collaboration-private-deploy.lock` 的非阻塞独占锁，拒绝发布并发执行。迁移失败时 app 保持停止，不能跳过迁移强行启动。如果 app 启动或 core-only 门禁验证失败，部署 trap 只有在当前 app container ID 仍等于本次记录的候选 ID、且候选与当前 revision 都等于获批 commit 时，才按该不可复用的显式 container ID 停止它；不会在身份检查后再按 Compose service 名称选取容器。若人工恢复或其他操作已经替换 app，trap 只报警并拒绝误停。PostgreSQL、named volume、失败容器日志、备份与 release 现场都会保留，数据库 volume 不随 app image 更新而删除，也不会自动声称回滚成功。

### 显式启用 Zulip Provider

```bash
sudo deploy/collaboration-private/scripts/deploy-provider-zulip.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

这个入口额外加载 `compose.provider-zulip.yml`。overlay 只修改 app，并以只读 bind mount 注入 config 和 secret；migrate 不获得这两个环境变量或 mount。启动时 runtime 会调用 `diagnose()` 并将统一脱敏后的结果写入 `provider_diagnostics`。Provider 状态不改变 `/readyz` 的数据库就绪语义，但 `verify-provider-zulip.sh` 会作为单独发布门禁，要求 catalog 恰好只有 `zulip`，且数据库中存在晚于本次 app 容器启动、十分钟内的 `healthy` 诊断。验证过程不打印 secret、配置正文或诊断私有细节。若 app 启动或门禁验证失败，部署 trap 会停止本次未获验证的 app，并保留 PostgreSQL、named volume、失败容器日志、备份与 release 现场供诊断；它不会删除数据、自动声称回滚成功或继续对团队开放失败版本。

### 旧两用户 Zulip harness 的状态

仓库仍保留历史 `scripts/collaboration-a-two-user-e2e.test.mjs`，但它建立在旧匿名 pairing、opaque User credential 与固定 Zulip 流拓扑上，不属于统一 OIDC User → Device → Agent 合同的 A 发布门禁，本轮不得运行或据此宣告业务 E2E。A 不会为了兼容该 harness 恢复匿名入口，也不会要求普通成员提交个人 Zulip API key。

正式身份来源、D→A trusted binding confirm、Human Provider 与最新版 SciForge 接入方式冻结后，应由对应成员基于公开机器合同提供新的跨团队 E2E；A 只负责让云端 API、事务、审计、Inbox 与 fail-closed 边界可验证。在那之前，`collaboration:a:test`、真实 PostgreSQL v5 隔离测试和本目录的 core-only 云端门禁是 A 的权威验收，不能冒充真实 Keycloak、Desktop 或 Zulip 往返闭环。

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

如确有低层协议或故障诊断需要，团队预发布验收不得共享管理员账号或一把 key。B、C、D、E 可各使用独立的 `sciforge-tunnel-b` 至 `sciforge-tunnel-e`；SSH tunnel 不是正常产品访问方式，也不能替代后续获批的正式入口、身份或 Provider 方案。安装时必须提供成员字母、该成员独立的 ed25519 公钥和其真实公网出口 `/32`；key 默认 14 天到期，也可提供更早的 OpenSSH `YYYYMMDDHHMMSSZ` 时间：

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

`verify.sh` 会执行一次真实但受限的 core-only API smoke：provider catalog 必须为空；无 OIDC bearer 的 `pairing.begin`、JWT 形态但不可验证的 `/v1/me`、以及未配置 trusted confirm adapter 的 Zulip binding confirm 都必须返回 401，不得返回一次性材料，也不得新增 User、Device enrollment 或 binding request；随后确认未认证 `user.get` 和 WebSocket Upgrade 同样返回 401。该 smoke 不创建 User，不能被描述为身份登录、用户绑定或 Project/Task 闭环。

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

### PostgreSQL schema v6 隔离业务语义验收

固定 schema v6 bundle 传到 release 目录后、运行 `deploy.sh` 迁移生产库之前，在无业务写入的维护窗口先运行一次真实 PostgreSQL 隔离验收。脚本文件名中的 `v5` 是既有验收工具名，不代表候选数据库仍停留在 v5：

```bash
sudo deploy/collaboration-private/scripts/verify-postgres-v5-integration.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env \
  --confirm-isolated-database-test
```

脚本与 core/provider 部署共享同一个非阻塞 deploy lock，并在锁内先执行候选 release 的 `docker compose build app`；这一步只构建带固定 revision 的候选 image，不停止或替换当前 app、不启动或重启 PostgreSQL，也不迁移生产库。当前 live app 可以仍是上一固定 commit，脚本会记录它的 container ID、host PID、RestartCount、image 和 revision，并要求前后完全不变。它还要求 PostgreSQL 只连接 `internal=true` 的专用 Compose network 且没有宿主机端口，然后用候选 runtime image 中已经安装的生产 `dist`、migration 和依赖启动一次性非 root runner；不会向 ECS 复制源码、test fixture、Vitest、tsx 或开发依赖。隔离验收通过后再运行 `deploy.sh`；后者会复用候选 image build cache、备份并迁移生产库。

管理员密码不会进入 Docker Config、命令参数、URL 环境变量或日志。宿主机只在 `/run` tmpfs 创建一个 `root:10001/0440` 的 64 位十六进制单值文件，并只读挂载给 runner；runner 在内存中构造固定指向 `postgres:5432/postgres` 的管理员 URL。它创建名称严格匹配 `sciforge_identity_v5_it_<pid>_<12位hex>` 的随机临时数据库，在其中验证 v1→当前 schema v6 readiness、旧 Agent 撤销、并发 OIDC JIT、Device→Agent 生命周期和 Zulip binding 唯一性，随后在 `finally` 中终止连接并删除该库。外层 trap 只在运行前确认没有同前缀遗留库后，才会按同一严格正则清理本次异常退出的残留；绝不把 `sciforge_collaboration` 作为删除目标。

验收会以生产库当时的实际 migration versions 和实际表集为准（允许它仍是 v3/v4）。前后快照各自在独立的、受限的候选镜像容器内运行，不向 live app 容器注入代码或占用其 cgroup；容器只读挂载单值 `sciforge_collab` 密码文件，不把数据库 URL 或密码放进 Docker env/argv。每次快照使用单个 `REPEATABLE READ READ ONLY` 事务，对每张实际表声明 server-side cursor，并以 `FETCH FORWARD 512` 有界流式计算 row count 和稳定内容 SHA-256；只保留表名、计数及摘要，不输出行内容，并要求运行前后整个快照完全相同。为避免并发业务写入造成误报或掩盖边界，本步骤必须处于无业务写入的维护窗口。live app 的 container ID、host PID、RestartCount、image 和 revision 也必须完全相同。runner 原始日志先保存在 root-only tmpfs 文件中，并同时扫描实际管理员密码、应用数据库密码、认证 URL、连接参数、stack 和 `secretKey`；只有通过扫描后才输出脱敏 pass receipt。注意：`CREATE/DROP DATABASE` 必然写 PostgreSQL 集群 catalog/WAL，但所有业务 fixture 只写随机临时数据库，不写生产 `sciforge_collaboration`。

完整验收及其清理成功后，脚本以原子改名写入 `/run/sciforge-collaboration-private-postgres-v5.attestation`：文件固定为 `root:root/0600`，绑定获批 commit、候选 image ID、release manifest、bundle checksums、contract commit 文件以及 runner/verifier 脚本摘要，并记录 UTC 时间。证明最多有效 30 分钟且只能使用一次；core-only 的 `deploy.sh` 和 Provider 的 `deploy-provider-zulip.sh` 都会在停止 app、启动 PostgreSQL、备份或迁移之前，通过共享 helper 原子 claim 该文件，重新核对所有绑定值后立即消费。候选 image 重建结果、bundle 或验收脚本发生任何变化，或者证明缺失、失败、过期、来自未来，部署都会拒绝继续。每次重新运行验收都会先安全删除旧证明；若 runner、临时库、tmpfs secret/log 或容器清理失败，刚生成的证明也会被删除，因此失败的验收不能沿用之前的 pass。任何测试失败、残留库、清理失败、生产内容快照变化或 app 身份变化都会阻断部署；这项测试也不能替代正式 Provider、OIDC 或最新版 SciForge 的跨系统 E2E。

### PostgreSQL restart 验收

只在维护窗口、已经确认备份可用时运行。脚本没有交互式模糊确认，必须给出完整固定参数。正式 Provider 尚未选定、当前运行 core-only 时使用显式 `--core-only`：

```bash
sudo deploy/collaboration-private/scripts/verify-postgres-restart.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env \
  --confirm-postgres-restart \
  --core-only
```

只有 app 已经通过 `deploy-provider-zulip.sh` 显式启用 Zulip 候选 Provider 时，才使用 Provider 模式。为兼容既有运维调用，不给 mode flag 时仍默认为这一严格模式；推荐显式写出 `--provider-zulip`：

```bash
sudo deploy/collaboration-private/scripts/verify-postgres-restart.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env \
  --confirm-postgres-restart \
  --provider-zulip
```

两种模式都会先验证运行 app 的 image ID、image/container revision label、容器内 `CONTRACT_COMMIT` 都等于传入的固定 commit。core-only 模式要求 `core-only-private` label、没有 Provider env/mount 且 catalog 为空；Provider 模式仍严格要求 `zulip-provider-private` label、只读 config/secret mount 和 catalog 恰为 `zulip`（不依赖 app 必须在十分钟内启动），不会因新增 core-only 分支而放宽。随后脚本记录 app/PostgreSQL container ID、PID、RestartCount、commit 和 release 全表 row counts，停止并原位启动 PostgreSQL，要求 `/healthz` 始终返回 `200`、数据库停机窗口内 `/readyz` 精确返回 `503`、恢复后返回 `200`，且 app container/PID/RestartCount 不变、PostgreSQL PID 改变、row counts 完全一致。`trap` 会在中断或失败时尝试恢复 PostgreSQL。

日志检查只输出三个数字，不输出命中行：必须至少有一个安全的 `postgres.pool.idle_client_error`/`57P0x` 诊断（连接池中多个 idle client 可以各自产生一条），且 unhandled、Client object、stack、`secretKey`、`connectionParameters` 和凭据模式计数都为零。

## 6. 资源与兼容性

提交或复制部署资产前，可在任意带 Bash 的可信构建机执行静态策略检查；它会对全部部署 shell 做语法检查，并确认 tunnel、Provider secret 隔离、固定 commit、精确探针状态和失败停机门禁仍存在：

```bash
deploy/collaboration-private/scripts/static-policy-test.sh
```

该部署面向当前 Alibaba Cloud Linux 4、Docker 24.0.9、Docker Compose 2.26.1、4 vCPU、7.3 GiB RAM 的 A ECS。脚本只使用 Compose 2.26.1 已支持的 `config --quiet`、`up --wait`、profiles 和健康依赖，不使用更高版本才提供的 `config --environment`。

默认运行上限：PostgreSQL 1.5 CPU/2 GiB/256 PID，app 1 CPU/768 MiB/256 PID；所有容器使用有界 `json-file` 日志。app 为只读 root filesystem、空 capability set、`no-new-privileges`，并以 Node 镜像的非 root 用户运行。

A 的简易网页控制台已经由同一 server bundle 在 `/console/` 提供，并与 API 共用同源安全边界；它在 loopback 可做 A 内部验收，但在正式入口与链路完成评审和真实端到端验证前不向成员宣称正式可用。B–E 私有模块仍不属于 A。若显式选择 Zulip 做候选 conformance，它也只属于该次验收；不得通过放开 8787、5432、让最新版 SciForge 使用临时 HTTP tunnel 或复制旧实验部署代码来抢先冻结产品链路。
