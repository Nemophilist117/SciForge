#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-$PRIVATE_DEPLOY_DIR/.env}"
[[ -n "$expected_commit" ]] \
  || die "Usage: deploy-provider-zulip.sh <approved-40-character-contract-commit> [env-file]"

for command in docker sha256sum tar awk sort stat curl; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."

validate_release_bundle "$expected_commit"
prepare_compose_environment "$expected_commit" "$env_input"
enable_zulip_provider_compose
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" build app

image_id="$(docker image inspect --format '{{.Id}}' "sciforge-collaboration-runtime:$expected_commit")"
image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
[[ "$image_revision" == "$expected_commit" ]] \
  || die "Runtime image revision label does not match the approved commit."

deployment_complete=false
app_launch_attempted=false
stop_unverified_app() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ "$deployment_complete" == true ]]; then
    exit "$exit_code"
  fi
  if [[ "$deployment_complete" != true && "$app_launch_attempted" == true ]]; then
    if [[ -n "$("${COMPOSE[@]}" ps -a -q app 2>/dev/null || true)" ]]; then
      if ! "${COMPOSE[@]}" stop -t 20 app > /dev/null 2>&1; then
        echo "ERROR: Provider verification failed and the unverified app could not be stopped; operator intervention is required." >&2
        exit_code=1
      else
        echo "ERROR: Provider deployment did not pass verification; the unverified app was stopped. PostgreSQL, volumes, container logs, and release evidence were preserved for diagnosis." >&2
      fi
    fi
  fi
  (( exit_code != 0 )) || exit_code=1
  exit "$exit_code"
}
trap stop_unverified_app EXIT
trap 'exit 130' INT TERM

if [[ -n "$("${COMPOSE[@]}" ps -a -q app)" ]]; then
  "${COMPOSE[@]}" stop -t 20 app >/dev/null
fi
"${COMPOSE[@]}" up -d postgres --wait --wait-timeout 180
validate_database_role_layout
"$SCRIPT_DIR/backup.sh" "$ENV_FILE"

# The provider overlay defines only app. The one-shot migration container
# therefore receives neither provider environment variables nor secret mounts.
"${COMPOSE[@]}" --profile tools run --rm --no-deps migrate
app_launch_attempted=true
"${COMPOSE[@]}" up -d --remove-orphans app --wait --wait-timeout 180
"$SCRIPT_DIR/verify-provider-zulip.sh" "$expected_commit" "$ENV_FILE"

deployment_complete=true
echo "Deployment passed for contract commit $expected_commit (Zulip provider, loopback-only private mode)."
