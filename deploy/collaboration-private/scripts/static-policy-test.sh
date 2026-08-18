#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file" \
    || die "Static deployment policy is missing from $(basename "$file"): $expected"
}

assert_not_contains() {
  local file="$1"
  local forbidden="$2"
  if grep -Fq -- "$forbidden" "$file"; then
    die "Static deployment policy contains forbidden text in $(basename "$file"): $forbidden"
  fi
}

for script in "$SCRIPT_DIR"/*.sh; do
  bash -n "$script"
done
node --check "$SCRIPT_DIR/postgres-v5-integration.mjs"

assert_contains "$SCRIPT_DIR/install-tunnel-user.sh" 'AllowStreamLocalForwarding no'
assert_contains "$SCRIPT_DIR/install-tunnel-user.sh" 'allowstreamlocalforwarding no'
assert_contains "$SCRIPT_DIR/install-tunnel-user.sh" 'PermitOpen 127.0.0.1:8787'

assert_contains "$SCRIPT_DIR/common.sh" 'validate_provider_secret_group_isolation'
assert_contains "$SCRIPT_DIR/common.sh" 'must not be assigned to a host group'
assert_contains "$SCRIPT_DIR/common.sh" 'Host account $account must not use provider runtime GID'
assert_contains "$SCRIPT_DIR/common.sh" 'id -G "$account"'
assert_contains "$SCRIPT_DIR/common.sh" 'Host account $account must not belong to provider runtime GID'

assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ "$ready_status" == 503 ]]'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'running_contract_commit'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'running_image_id'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'approved_image_revision'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '--core-only'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '--provider-zulip'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ "$provider_mode" == core-only-private ]]'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'body.providers.length !== 0'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '{{range .Config.Env}}{{println .}}{{end}}'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'provider_env_key_count'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '{{range .Mounts}}{{println .Destination}}{{end}}'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'provider_mount_violation_count'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'index(target, $0 "/") == 1'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ "$provider_mode" == zulip-provider-private ]]'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'body.providers.length !== 1'
assert_contains "$SCRIPT_DIR/verify-postgres-restart.sh" "body.providers[0]?.provider !== 'zulip'"
assert_not_contains "$SCRIPT_DIR/verify-postgres-restart.sh" 'process.env.SCIFORGE_COLLABORATION_PROVIDER_CONFIG_FILE'
assert_not_contains "$SCRIPT_DIR/verify-postgres-restart.sh" '[[ -z "$config_mount_rw" && -z "$secret_mount_rw" ]]'

assert_contains "$SCRIPT_DIR/deploy.sh" 'flock -n 8'
assert_contains "$SCRIPT_DIR/deploy.sh" '/run/lock/sciforge-collaboration-private-deploy.lock'
assert_contains "$SCRIPT_DIR/deploy.sh" 'trap stop_unverified_app EXIT'
assert_contains "$SCRIPT_DIR/deploy.sh" 'app_launch_attempted=true'
assert_contains "$SCRIPT_DIR/deploy.sh" 'candidate_app_container_id'
assert_contains "$SCRIPT_DIR/deploy.sh" 'current_app_container_id" == "$candidate_app_container_id'
assert_contains "$SCRIPT_DIR/deploy.sh" 'candidate_app_revision" == "$expected_commit'
assert_contains "$SCRIPT_DIR/deploy.sh" 'current_app_revision" == "$expected_commit'
assert_contains "$SCRIPT_DIR/deploy.sh" 'docker stop -t 20 "$candidate_app_container_id"'
assert_contains "$SCRIPT_DIR/deploy.sh" 'the unverified app was stopped'
assert_contains "$SCRIPT_DIR/deploy.sh" 'Refusing to stop it; operator inspection is required.'
assert_contains "$SCRIPT_DIR/deploy.sh" 'PostgreSQL, volumes, container logs, backups, and release evidence were preserved'
assert_contains "$SCRIPT_DIR/deploy.sh" 'deployment_complete=true'
assert_not_contains "$SCRIPT_DIR/deploy.sh" '/run/lock/sciforge-collaboration-private.deploy.lock'

assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'flock -n 8'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '/run/lock/sciforge-collaboration-private-deploy.lock'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '--confirm-isolated-database-test'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '"${COMPOSE[@]}" build app'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'approved_image_revision'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'running_image_revision" =~ ^[0-9a-f]{40}$'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'app_state_before" == "$app_state_before_build'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" "'{{.Internal}}'"
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" "awk 'NF { print }'"
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'docker port "$postgres_container_id"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'chmod 0440 "$password_file"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'root:10001 mode 0440'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'dst=/run/secrets/postgres-v5-admin-password,readonly'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'dst=/app/postgres-v5-integration.mjs,readonly'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '"$approved_image_id"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'forbidden_runner_env_count'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '--production-snapshot'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'cn.sciforge.test.purpose=production-read-only-snapshot'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'dst=/run/secrets/postgres-v5-snapshot-password,readonly'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'forbidden_snapshot_env_count'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'production_snapshot_after" == "$production_snapshot_before"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'app_state_after" == "$app_state_before'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '^sciforge_identity_v5_it_[0-9]+_[0-9a-f]{12}$'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'dropdb -U sciforge_admin --if-exists --force "$database"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'grep -Fq -f "$password_file" "$log_file"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" '/run/sciforge-collaboration-private-postgres-v5.attestation'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'candidateImageId=%s'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'releaseManifestSha256=%s'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'runnerScriptSha256=%s'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'chmod 0600 "$attestation_temporary"'
assert_contains "$SCRIPT_DIR/verify-postgres-v5-integration.sh" 'mv -f -- "$attestation_temporary" "$attestation_path"'

assert_contains "$SCRIPT_DIR/deploy.sh" 'consume_postgres_v5_attestation "$image_id" "$expected_commit"'
assert_contains "$SCRIPT_DIR/common.sh" 'mv -- "$attestation_path" "$claimed_path"'
assert_contains "$SCRIPT_DIR/common.sh" 'candidateImageId=$candidate_image_id'
assert_contains "$SCRIPT_DIR/common.sh" 'runner_script_digest'
assert_contains "$SCRIPT_DIR/common.sh" 'now_epoch - verified_epoch <= 1800'

assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" '/app/node_modules/@sciforge/collaboration-server/dist/index.js'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'CREATE DATABASE ${quotedDatabaseIdentifier(databaseName)}'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'DROP DATABASE ${quotedDatabaseIdentifier(databaseName)}'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" '--production-snapshot'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'DECLARE "${cursor}" NO SCROLL CURSOR'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'FETCH FORWARD 512'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" "createHash('sha256')"
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'to_jsonb(row_value)::text'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'secretBuffer.fill(0)'
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" "mode & 0o777, 0o440"
assert_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'status: '\''passed'\'''
assert_not_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'SCIFORGE_POSTGRES_V5_ADMIN_URL'
assert_not_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'vitest'
assert_not_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'tsx'
assert_not_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" 'test-fixtures'
assert_not_contains "$SCRIPT_DIR/postgres-v5-integration.mjs" '/src/'

assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'flock -n 8'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" '/run/lock/sciforge-collaboration-private-deploy.lock'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'trap stop_unverified_app EXIT'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'app_launch_attempted=true'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'consume_postgres_v5_attestation "$image_id" "$expected_commit"'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'docker stop -t 20 "$candidate_app_container_id"'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'current_app_container_id" == "$candidate_app_container_id"'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'the unverified app was stopped'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'deployment_complete=true'

assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_ISSUER: ${SCIFORGE_COLLABORATION_OIDC_ISSUER:-}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_AUDIENCE: ${SCIFORGE_COLLABORATION_OIDC_AUDIENCE:-sciforge-cloud-api}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES: ${SCIFORGE_COLLABORATION_OIDC_AUTHORIZED_PARTIES:-sciforge-desktop,sciforge-web-mobile}'
assert_contains "$DEPLOY_DIR/compose.yml" 'SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK: ${SCIFORGE_COLLABORATION_OIDC_ALLOW_INSECURE_LOOPBACK:-false}'
assert_contains "$SCRIPT_DIR/verify.sh" 'zulip_binding_requests'
assert_contains "$SCRIPT_DIR/verify.sh" "pairingResponse.status !== 401"
assert_contains "$SCRIPT_DIR/verify.sh" "meResponse.status !== 401"
assert_contains "$SCRIPT_DIR/verify.sh" "confirmResponse.status !== 401"

assert_contains "$DEPLOY_DIR/README.md" 'AllowStreamLocalForwarding no'
assert_contains "$DEPLOY_DIR/README.md" '精确返回 `503`'
assert_contains "$DEPLOY_DIR/README.md" '未获验证的 app'
assert_contains "$DEPLOY_DIR/README.md" 'verify-postgres-v5-integration.sh'
assert_contains "$DEPLOY_DIR/README.md" 'CREATE/DROP DATABASE'

echo "Static deployment policy verification passed."
