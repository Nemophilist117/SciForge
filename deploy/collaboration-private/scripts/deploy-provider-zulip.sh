#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-$PRIVATE_DEPLOY_DIR/.env}"
[[ -n "$expected_commit" ]] \
  || die "Usage: deploy-provider-zulip.sh <approved-40-character-contract-commit> [env-file]"

for command in docker sha256sum tar awk sort stat curl flock date mv rm; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."

exec 8>/run/lock/sciforge-collaboration-private-deploy.lock
if ! flock -n 8; then
  die "Another collaboration deployment is already running; retry after it completes."
fi

validate_release_bundle "$expected_commit"
prepare_compose_environment "$expected_commit" "$env_input"
enable_zulip_provider_compose
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" build app

image_id="$(docker image inspect --format '{{.Id}}' "sciforge-collaboration-runtime:$expected_commit")"
image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
[[ "$image_revision" == "$expected_commit" ]] \
  || die "Runtime image revision label does not match the approved commit."

# Image construction has no app/PostgreSQL side effect. Claim the same
# one-time isolated-v5 proof as core-only before any live service mutation.
consume_postgres_v5_attestation "$image_id" "$expected_commit"

deployment_complete=false
app_launch_attempted=false
candidate_app_container_id=""
candidate_app_revision=""
stop_unverified_app() {
  local exit_code=$?
  local current_app_container_id=""
  local current_app_revision=""
  trap - EXIT INT TERM
  if [[ "$deployment_complete" == true ]]; then
    exit "$exit_code"
  fi
  if [[ "$app_launch_attempted" == true ]]; then
    current_app_container_id="$("${COMPOSE[@]}" ps -a -q app 2>/dev/null || true)"
    if [[ -n "$current_app_container_id" ]]; then
      current_app_revision="$(docker container inspect --format \
        '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
        "$current_app_container_id" 2>/dev/null || true)"
    fi
    if [[ -n "$candidate_app_container_id" \
        && "$current_app_container_id" == "$candidate_app_container_id" \
        && "$candidate_app_revision" == "$expected_commit" \
        && "$current_app_revision" == "$expected_commit" ]]; then
      if ! docker stop -t 20 "$candidate_app_container_id" > /dev/null 2>&1; then
        echo "ERROR: Provider verification failed and the unverified app could not be stopped; operator intervention is required." >&2
        exit_code=1
      else
        echo "ERROR: Provider deployment did not pass verification; the unverified app was stopped. PostgreSQL, volumes, container logs, and release evidence were preserved for diagnosis." >&2
      fi
    else
      echo "ERROR: Provider deployment did not pass verification, but the current app identity or revision no longer matches this deployment candidate. Refusing to stop it; operator inspection is required." >&2
      exit_code=1
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
if ! "${COMPOSE[@]}" up -d --remove-orphans app --wait --wait-timeout 180; then
  candidate_app_container_id="$("${COMPOSE[@]}" ps -a -q app 2>/dev/null || true)"
  if [[ -n "$candidate_app_container_id" ]]; then
    candidate_app_revision="$(docker container inspect --format \
      '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "$candidate_app_container_id" 2>/dev/null || true)"
  fi
  exit 1
fi
candidate_app_container_id="$("${COMPOSE[@]}" ps -q app)"
[[ -n "$candidate_app_container_id" ]] \
  || die "Could not record the Provider deployment candidate container."
candidate_app_revision="$(docker container inspect --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$candidate_app_container_id")"
[[ "$candidate_app_revision" == "$expected_commit" ]] \
  || die "Provider deployment candidate revision does not match the approved commit."
"$SCRIPT_DIR/verify-provider-zulip.sh" "$expected_commit" "$ENV_FILE"

deployment_complete=true
echo "Deployment passed for contract commit $expected_commit (Zulip provider, loopback-only private mode)."
