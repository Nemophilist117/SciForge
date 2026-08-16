# A 专用 ECS：core-only 私有部署

本目录为 `@sciforge/collaboration-server` 的最小 Docker Compose 部署层。当前只完成 A 自身的 PostgreSQL 事实源、显式迁移、HTTP/WebSocket 边界、持久化、备份和故障恢复。它不需要域名或 TLS，也不包含 B–E 接口资料、网页控制台或其他成员模块。

## 重要边界

- 运行镜像只安装固定 commit 生成的三个 npm tarball：contracts、Zulip provider 和 server。默认发布仍只接受已进入 `origin/gui` 历史的获批 commit；未合并 feature commit 只能使用下述显式 `private-test` 模式。Docker build context 受 `.dockerignore` 限制，不复制或编译 SciForge 源码。
- 当前是 **core-only**：Compose 不注入 provider 配置或 provider secret。服务可以完成迁移、探针和匿名配对边界检查，但配对不能被 provider 验证，因此不能创建首个正式用户，也不能宣称完成 Project/Task 业务闭环。
- 原生入口是 `POST /v1/commands` 和 WebSocket `/v1/events`；没有 `/v1/meta`，也没有旧实验服务的 `/v1/ws`。
- 应用在容器内监听 `0.0.0.0:8787`，但 Docker 只向 ECS `127.0.0.1:${SCIFORGE_COLLAB_HOST_PORT}` 发布。PostgreSQL 不发布宿主机端口。
- 本轮不使用 Nginx，不开放 80/443。阿里云安全组继续只允许受限来源访问 SSH 22。

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

## 3. 部署

```bash
sudo deploy/collaboration-private/scripts/deploy.sh \
  <获批的完整40位contract-commit> \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

部署脚本执行以下固定顺序：

1. 验证 bundle 精确文件集合、commit、tarball 结构、全部 SHA-256，并从 server tarball 推导 migration/table truth；
2. 生成带固定 `org.opencontainers.image.revision` 的 runtime image；
3. 启动并等待 PostgreSQL healthy；
4. 停止旧 app，创建发布前 custom-format 备份；
5. 使用同一 runtime image 显式执行一次 `migrate`；
6. 启动 app 并等待 `/readyz`；
7. 执行 loopback、与 release migration 完全一致的 schema version/table set、image revision、core-only provider 拒绝和认证边界验证。

迁移失败时 app 保持停止，不能跳过迁移强行启动。数据库 volume 不随 app image 更新而删除。

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

备份路径只允许 `/srv/sciforge-collaboration/backups`，防止误配置后对 `/etc` 等路径执行 `chmod` 或过期清理。备份脚本使用 `flock` 防止并发，调用 PostgreSQL 17 容器内的 `pg_dump` 生成 custom format，设置 `--no-owner --no-privileges`，先写临时文件、校验 `pg_restore --list`，再原子改名并创建相对文件名 SHA-256 sidecar。本地目录为 `0700`、文件为 `0600`，保留 14 天。

每次发布和定期演练时，用管理员身份在同一个 PostgreSQL 实例内创建严格随机命名的隔离临时数据库，验证 sidecar、恢复、release-derived schema version/完整表集合及每张 release 表与源库的 row count；脚本的 `trap` 只删除该临时数据库，不覆盖主业务库。row count 对比要求使用刚生成的备份，并在无业务写入的维护窗口立即运行：

```bash
sudo deploy/collaboration-private/scripts/verify-backup-restore.sh \
  /srv/sciforge-collaboration/backups/collaboration-<UTC时间>.dump \
  /srv/sciforge-collaboration/secrets/collaboration.env
```

本地备份只是第一层。每份 dump 和 sidecar 还应复制到加密的异机存储。灾难恢复仍应使用新的 volume；不得直接覆盖唯一生产 volume。

## 6. 资源与兼容性

该部署面向当前 Alibaba Cloud Linux 4、Docker 24.0.9、Docker Compose 2.26.1、4 vCPU、7.3 GiB RAM 的 A ECS。脚本只使用 Compose 2.26.1 已支持的 `config --quiet`、`up --wait`、profiles 和健康依赖，不使用更高版本才提供的 `config --environment`。

默认运行上限：PostgreSQL 1.5 CPU/2 GiB/256 PID，app 1 CPU/768 MiB/256 PID；所有容器使用有界 `json-file` 日志。app 为只读 root filesystem、空 capability set、`no-new-privileges`，并以 Node 镜像的非 root 用户运行。

域名、TLS、Nginx、真实 provider、网页控制台以及 B–E 联调都是后续独立变更，不应通过放开 8787、5432 或复制旧实验部署代码来绕过。
