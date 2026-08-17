#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-$PRIVATE_DEPLOY_DIR/.env}"
[[ -n "$expected_commit" ]] \
  || die "Usage: verify-provider-zulip.sh <approved-40-character-contract-commit> [env-file]"

for command in docker curl grep stat sha256sum tar awk sort date; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."
validate_release_bundle "$expected_commit"
prepare_compose_environment "$expected_commit" "$env_input"
enable_zulip_provider_compose
"${COMPOSE[@]}" config --quiet

running_services="$("${COMPOSE[@]}" ps --status running --services)"
grep -qx postgres <<< "$running_services" || die "PostgreSQL container is not running."
grep -qx app <<< "$running_services" || die "Application container is not running."

published_endpoint="$("${COMPOSE[@]}" port app 8787)"
[[ "$published_endpoint" == "127.0.0.1:$SCIFORGE_COLLAB_HOST_PORT" ]] \
  || die "Application port is not restricted to the expected loopback endpoint."
postgres_endpoint="$("${COMPOSE[@]}" port postgres 5432 2>/dev/null || true)"
[[ -z "$postgres_endpoint" ]] || die "PostgreSQL must not publish a host port."

base_url="http://127.0.0.1:$SCIFORGE_COLLAB_HOST_PORT"
curl --fail --silent --show-error --max-time 5 "$base_url/healthz" > /dev/null
curl --fail --silent --show-error --max-time 5 "$base_url/readyz" > /dev/null

schema_version="$("${COMPOSE[@]}" exec -T --user postgres postgres \
  psql -U sciforge_collab -d sciforge_collaboration --tuples-only --no-align \
  --command='SELECT max(version) FROM sciforge_collaboration.schema_migrations;')"
expected_schema_version="$(expected_collaboration_schema_version)"
[[ "$schema_version" == "$expected_schema_version" ]] \
  || die "Live database schema version does not match the validated release migrations."
expected_tables="$(expected_collaboration_tables)"
actual_tables="$("${COMPOSE[@]}" exec -T --user postgres postgres \
  psql -U sciforge_collab -d sciforge_collaboration --tuples-only --no-align \
  --command="SELECT table_name FROM information_schema.tables WHERE table_schema = 'sciforge_collaboration' AND table_type = 'BASE TABLE' ORDER BY table_name;")"
[[ "$actual_tables" == "$expected_tables" ]] \
  || die "Live database table set does not match the validated release migrations."
validate_database_role_layout

image_id="$(docker image inspect --format '{{.Id}}' "sciforge-collaboration-runtime:$expected_commit")"
image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
[[ "$image_revision" == "$expected_commit" ]] || die "Runtime image revision label mismatch."
app_container_id="$("${COMPOSE[@]}" ps -q app)"
running_image_id="$(docker container inspect --format '{{.Image}}' "$app_container_id")"
[[ "$running_image_id" == "$image_id" ]] \
  || die "Running application container does not use the approved runtime image."
runtime_identity="$("${COMPOSE[@]}" exec -T app node -e \
  'process.stdout.write(`${process.getuid()}:${process.getgid()}`)')"
[[ "$runtime_identity" == 10001:10001 ]] \
  || die "Application runtime must use the fixed non-login UID/GID 10001."

config_mount_rw="$(docker container inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/run/sciforge-provider/config/providers.json"}}{{.RW}}{{end}}{{end}}' \
  "$app_container_id")"
secret_mount_rw="$(docker container inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/run/sciforge-provider/secrets"}}{{.RW}}{{end}}{{end}}' \
  "$app_container_id")"
[[ "$config_mount_rw" == false && "$secret_mount_rw" == false ]] \
  || die "Provider config and secret mounts must both be present and read-only."

# Query only the public provider catalog. No credential or provider config is
# printed, and exact cardinality prevents an unintended adapter from joining.
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

app_started_at="$(docker container inspect --format '{{.State.StartedAt}}' "$app_container_id")"
[[ "$app_started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$ ]] \
  || die "Application container returned an invalid startup timestamp."
app_started_epoch="$(date -u -d "$app_started_at" +%s)"
[[ "$app_started_epoch" =~ ^[0-9]+$ ]] || die "Could not normalize application startup time."
healthy_diagnostic_count="$("${COMPOSE[@]}" exec -T --user postgres postgres \
  psql -U sciforge_collab -d sciforge_collaboration --tuples-only --no-align \
  --command="SELECT count(*) FROM sciforge_collaboration.provider_diagnostics WHERE provider = 'zulip' AND status = 'healthy' AND checked_at >= to_timestamp($app_started_epoch) AND checked_at >= now() - interval '10 minutes';")"
[[ "$healthy_diagnostic_count" == 1 ]] \
  || die "Zulip must have one recent healthy diagnostic recorded after this app startup."

echo "Verification passed: loopback-only Zulip catalog, startup-fresh healthy diagnostic, read-only provider mounts, fixed UID/GID, release schema and probes."
