#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-}"
confirmation="${3:-}"
[[ -n "$expected_commit" && -n "$env_input" && "$confirmation" == --confirm-postgres-restart ]] \
  || die "Usage: verify-postgres-restart.sh <approved-40-character-contract-commit> <env-file> --confirm-postgres-restart"

for command in docker curl grep stat sha256sum tar awk sort date mktemp chmod rm sleep; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."
validate_release_bundle "$expected_commit"
prepare_compose_environment "$expected_commit" "$env_input"
enable_zulip_provider_compose
"${COMPOSE[@]}" config --quiet

running_services="$("${COMPOSE[@]}" ps --status running --services)"
grep -qx postgres <<< "$running_services" || die "PostgreSQL must be running before restart acceptance."
grep -qx app <<< "$running_services" || die "Application must be running before restart acceptance."

base_url="http://127.0.0.1:$SCIFORGE_COLLAB_HOST_PORT"
curl --fail --silent --show-error --max-time 5 "$base_url/healthz" > /dev/null
curl --fail --silent --show-error --max-time 5 "$base_url/readyz" > /dev/null

app_container_before="$("${COMPOSE[@]}" ps -q app)"
postgres_container_before="$("${COMPOSE[@]}" ps -q postgres)"
approved_image_id="$(docker image inspect --format '{{.Id}}' "sciforge-collaboration-runtime:$expected_commit")"
approved_image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$approved_image_id")"
running_image_id="$(docker container inspect --format '{{.Image}}' "$app_container_before")"
running_image_revision="$(docker container inspect --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$app_container_before")"
running_contract_commit="$("${COMPOSE[@]}" exec -T app sh -c 'tr -d "\r\n" < /app/CONTRACT_COMMIT')"
[[ "$approved_image_revision" == "$expected_commit" \
    && "$running_image_id" == "$approved_image_id" \
    && "$running_image_revision" == "$expected_commit" \
    && "$running_contract_commit" == "$expected_commit" ]] \
  || die "Running application does not match the approved restart-acceptance commit."
provider_mode="$(docker container inspect --format \
  '{{index .Config.Labels "cn.sciforge.deployment.mode"}}' "$app_container_before")"
[[ "$provider_mode" == zulip-provider-private ]] \
  || die "PostgreSQL restart acceptance requires the explicit Zulip provider deployment."
config_mount_rw="$(docker container inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/run/sciforge-provider/config/providers.json"}}{{.RW}}{{end}}{{end}}' \
  "$app_container_before")"
secret_mount_rw="$(docker container inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/run/sciforge-provider/secrets"}}{{.RW}}{{end}}{{end}}' \
  "$app_container_before")"
[[ "$config_mount_rw" == false && "$secret_mount_rw" == false ]] \
  || die "Provider config and secret mounts must both be present and read-only."

# This checks the public catalog only. It deliberately does not read or print
# provider configuration, secrets, or diagnostic details.
"${COMPOSE[@]}" exec -T app node --input-type=module - <<'NODE'
import { randomUUID } from 'node:crypto'

const response = await fetch('http://127.0.0.1:8787/v1/commands', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    protocolVersion: '1.0',
    requestId: `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    type: 'endpoint.catalog.get'
  })
})
const body = await response.json().catch(() => null)
if (response.status !== 200 || body?.type !== 'endpoint.catalog' ||
    !Array.isArray(body.providers) || body.providers.length !== 1 ||
    body.providers[0]?.provider !== 'zulip') {
  console.error('Provider catalog verification failed.')
  process.exit(1)
}
console.log('Provider catalog verification passed: exactly zulip.')
NODE

app_pid_before="$(docker container inspect --format '{{.State.Pid}}' "$app_container_before")"
postgres_pid_before="$(docker container inspect --format '{{.State.Pid}}' "$postgres_container_before")"
app_restarts_before="$(docker container inspect --format '{{.RestartCount}}' "$app_container_before")"
postgres_restarts_before="$(docker container inspect --format '{{.RestartCount}}' "$postgres_container_before")"
rows_before="$(database_table_row_counts sciforge_collaboration sciforge_collab)"

printf 'before app_container=%s app_pid=%s app_restarts=%s\n' \
  "$app_container_before" "$app_pid_before" "$app_restarts_before"
printf 'before approved_commit=%s image_id=%s\n' "$expected_commit" "$approved_image_id"
printf 'before postgres_container=%s postgres_pid=%s postgres_restarts=%s\n' \
  "$postgres_container_before" "$postgres_pid_before" "$postgres_restarts_before"
printf 'before_rows:\n%s\n' "$rows_before"

log_since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log_capture="$(mktemp /tmp/sciforge-pg-restart-logs.XXXXXX)"
chmod 0600 "$log_capture"
postgres_requires_restore=false

restore_postgres() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ "$postgres_requires_restore" == true ]]; then
    if ! "${COMPOSE[@]}" up -d postgres --wait --wait-timeout 180 > /dev/null 2>&1; then
      echo "ERROR: trap could not restore PostgreSQL; operator intervention is required." >&2
      exit_code=1
    fi
  fi
  rm -f -- "$log_capture"
  exit "$exit_code"
}
trap restore_postgres EXIT
trap 'exit 130' INT TERM

postgres_requires_restore=true
"${COMPOSE[@]}" stop -t 30 postgres > /dev/null

health_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
  "$base_url/healthz" || true)"
[[ "$health_status" == 200 ]] || die "Liveness must remain available while PostgreSQL is stopped."

ready_status=200
for _ in {1..60}; do
  ready_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
    "$base_url/readyz" || true)"
  [[ "$ready_status" != 200 ]] && break
  sleep 1
done
[[ "$ready_status" == 503 ]] \
  || die "Readiness must return exactly HTTP 503 while PostgreSQL is stopped."
health_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
  "$base_url/healthz" || true)"
[[ "$health_status" == 200 ]] \
  || die "Liveness must remain HTTP 200 after readiness reports the database outage."
printf 'database_stopped health_status=%s ready_status=%s\n' "$health_status" "$ready_status"

"${COMPOSE[@]}" up -d postgres --wait --wait-timeout 180 > /dev/null
postgres_requires_restore=false

ready_status=000
for _ in {1..120}; do
  ready_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
    "$base_url/readyz" || true)"
  [[ "$ready_status" == 200 ]] && break
  sleep 1
done
[[ "$ready_status" == 200 ]] || die "Readiness did not recover after PostgreSQL restarted."
curl --fail --silent --show-error --max-time 5 "$base_url/healthz" > /dev/null

app_container_after="$("${COMPOSE[@]}" ps -q app)"
postgres_container_after="$("${COMPOSE[@]}" ps -q postgres)"
app_pid_after="$(docker container inspect --format '{{.State.Pid}}' "$app_container_after")"
postgres_pid_after="$(docker container inspect --format '{{.State.Pid}}' "$postgres_container_after")"
app_restarts_after="$(docker container inspect --format '{{.RestartCount}}' "$app_container_after")"
postgres_restarts_after="$(docker container inspect --format '{{.RestartCount}}' "$postgres_container_after")"
rows_after="$(database_table_row_counts sciforge_collaboration sciforge_collab)"

printf 'after app_container=%s app_pid=%s app_restarts=%s\n' \
  "$app_container_after" "$app_pid_after" "$app_restarts_after"
printf 'after postgres_container=%s postgres_pid=%s postgres_restarts=%s\n' \
  "$postgres_container_after" "$postgres_pid_after" "$postgres_restarts_after"
printf 'after_rows:\n%s\n' "$rows_after"
[[ "$app_container_after" == "$app_container_before" ]] \
  || die "Application container identity changed during a database-only restart."
[[ "$app_pid_after" == "$app_pid_before" ]] \
  || die "Application process restarted during the PostgreSQL-only restart."
[[ "$app_restarts_after" == "$app_restarts_before" ]] \
  || die "Application RestartCount changed during the PostgreSQL-only restart."
[[ "$postgres_container_after" == "$postgres_container_before" ]] \
  || die "PostgreSQL container identity changed instead of restarting in place."
[[ "$postgres_pid_after" != "$postgres_pid_before" ]] \
  || die "PostgreSQL process identity did not change across the restart."
[[ "$rows_after" == "$rows_before" ]] || die "Collaboration table row counts changed across PostgreSQL restart."

"${COMPOSE[@]}" logs --no-color --since "$log_since" app postgres > "$log_capture" 2>&1
safe_pool_diagnostic_count="$(grep -Ec \
  '"event":"postgres\.pool\.idle_client_error".*"postgresCode":"57P0[1-3]".*"retryable":true' \
  "$log_capture" || true)"
unsafe_runtime_detail_count="$(grep -Eic \
  'unhandled|client[[:space:]_-]*object|stack[[:space:]]*[:=]|secretKey|connectionParameters' \
  "$log_capture" || true)"
sensitive_log_pattern_count="$(grep -Eic \
  '(Bearer|Basic)[[:space:]]+[A-Za-z0-9._~+/=-]{6,}|(password|token|secret|signature|database_url)[[:space:]]*[:=][^[:space:]]+|postgres(ql)?://[^[:space:]]+:[^@[:space:]]+@' \
  "$log_capture" || true)"
[[ "$safe_pool_diagnostic_count" =~ ^[0-9]+$ \
    && "$unsafe_runtime_detail_count" =~ ^[0-9]+$ \
    && "$sensitive_log_pattern_count" =~ ^[0-9]+$ ]] \
  || die "Could not count restart diagnostic patterns."
printf 'safe_pool_57P0x_diagnostic_count=%s\n' "$safe_pool_diagnostic_count"
printf 'unsafe_runtime_detail_count=%s\n' "$unsafe_runtime_detail_count"
printf 'sensitive_log_pattern_count=%s\n' "$sensitive_log_pattern_count"
(( safe_pool_diagnostic_count >= 1 )) \
  || die "Expected at least one safe postgres.pool.idle_client_error 57P0x diagnostic; matching log content is intentionally suppressed."
(( unsafe_runtime_detail_count == 0 )) \
  || die "Unhandled/client/stack/internal-detail log patterns were detected; matching log content is intentionally suppressed."
(( sensitive_log_pattern_count == 0 )) \
  || die "Sensitive log patterns were detected; matching log content is intentionally suppressed."

echo "PostgreSQL restart acceptance passed: the Zulip provider boundary remained active, app PID/RestartCount stayed fixed, liveness stayed up, readiness failed then recovered, rows matched, and safe 57P0x diagnostics were counted without printing log lines."
