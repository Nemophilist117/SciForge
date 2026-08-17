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

for script in "$SCRIPT_DIR"/*.sh; do
  bash -n "$script"
done

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

assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'trap stop_unverified_app EXIT'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'app_launch_attempted=true'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'the unverified app was stopped'
assert_contains "$SCRIPT_DIR/deploy-provider-zulip.sh" 'deployment_complete=true'

assert_contains "$DEPLOY_DIR/README.md" 'AllowStreamLocalForwarding no'
assert_contains "$DEPLOY_DIR/README.md" '精确返回 `503`'
assert_contains "$DEPLOY_DIR/README.md" '未获验证的 app'

echo "Static deployment policy verification passed."
