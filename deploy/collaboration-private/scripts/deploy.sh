#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-$PRIVATE_DEPLOY_DIR/.env}"
[[ -n "$expected_commit" ]] || die "Usage: deploy.sh <approved-40-character-contract-commit> [env-file]"

for command in docker sha256sum tar awk sort stat curl; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."

validate_release_bundle "$expected_commit"
prepare_compose_environment "$expected_commit" "$env_input"

# Quiet config validation expands secrets internally but never writes the
# rendered configuration to stdout or a file.
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" build app

image_id="$(docker image inspect --format '{{.Id}}' "sciforge-collaboration-runtime:$expected_commit")"
image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
[[ "$image_revision" == "$expected_commit" ]] || die "Runtime image revision label does not match the approved commit."

if [[ -n "$("${COMPOSE[@]}" ps -a -q app)" ]]; then
  "${COMPOSE[@]}" stop -t 20 app >/dev/null
fi
"${COMPOSE[@]}" up -d postgres --wait --wait-timeout 180
validate_database_role_layout
"$SCRIPT_DIR/backup.sh" "$ENV_FILE"
"${COMPOSE[@]}" --profile tools run --rm --no-deps migrate
"${COMPOSE[@]}" up -d --remove-orphans app --wait --wait-timeout 180
"$SCRIPT_DIR/verify.sh" "$expected_commit" "$ENV_FILE"

echo "Deployment passed for contract commit $expected_commit (core-only private mode)."
