#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-$PRIVATE_DEPLOY_DIR/.env}"
[[ -n "$expected_commit" ]] || die "Usage: verify.sh <approved-40-character-contract-commit> [env-file]"

for command in docker curl grep stat sha256sum tar awk sort; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."
validate_release_bundle "$expected_commit"
prepare_compose_environment "$expected_commit" "$env_input"
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
expected_table_count="$(printf '%s\n' "$expected_tables" | awk 'END { print NR }')"
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
[[ "$running_image_id" == "$image_id" ]] || die "Running application container does not use the approved runtime image."
container_revision="$("${COMPOSE[@]}" exec -T app sh -c 'tr -d "\r\n" < /app/CONTRACT_COMMIT')"
[[ "$container_revision" == "$expected_commit" ]] || die "Running container revision proof mismatch."

# This deployment is intentionally core-only. Fail if provider configuration
# was accidentally injected into the production process.
"${COMPOSE[@]}" exec -T app node -e \
  "if (process.env.SCIFORGE_COLLABORATION_PROVIDER_CONFIG_FILE || process.env.SCIFORGE_COLLABORATION_SECRET_DIRECTORY || process.env.SCIFORGE_COLLAB_DB_ADMIN_PASSWORD || process.env.POSTGRES_PASSWORD) process.exit(1)"

# Real API boundary smoke. A core-only deployment must advertise no Human
# providers and must not persist an unfulfillable pairing challenge.
"${COMPOSE[@]}" exec -T app node --input-type=module - <<'NODE'
import { randomUUID } from 'node:crypto'

const fail = (message) => {
  console.error(`Core-only API smoke failed: ${message}`)
  process.exit(1)
}
const suffix = randomUUID().replaceAll('-', '').slice(0, 24)
const pgModule = await import('pg')
const Client = pgModule.Client ?? pgModule.default?.Client
if (!Client || !process.env.SCIFORGE_COLLABORATION_DATABASE_URL) {
  fail('database client is unavailable for core-only boundary verification')
}
const database = new Client({ connectionString: process.env.SCIFORGE_COLLABORATION_DATABASE_URL })
const countChallenge = async () => {
  const result = await database.query(
    'SELECT count(*)::integer AS count FROM sciforge_collaboration.human_endpoint_challenges'
  )
  return result.rows[0]?.count
}
let beforePairingCount
let afterPairingCount
try {
  await database.connect()
  beforePairingCount = await countChallenge()
} catch {
  await database.end().catch(() => undefined)
  fail('challenge persistence boundary could not be inspected')
}

const catalogResponse = await fetch('http://127.0.0.1:8787/v1/commands', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    protocolVersion: '1.0',
    requestId: `req_${suffix}`,
    type: 'endpoint.catalog.get'
  })
})
const catalog = await catalogResponse.json().catch(() => null)
if (catalogResponse.status !== 200 || catalog?.type !== 'endpoint.catalog' ||
    !Array.isArray(catalog.providers) || catalog.providers.length !== 0) {
  fail('core-only provider catalog is not empty')
}

const idempotencyKey = `idem_private_smoke_${suffix}`
const pairingResponse = await fetch('http://127.0.0.1:8787/v1/commands', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
  body: JSON.stringify({
    protocolVersion: '1.0',
    requestId: `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    type: 'pairing.begin',
    idempotencyKey,
    provider: 'core-smoke',
    realmId: 'private-ecs',
    requestedDisplayName: 'Private deployment smoke'
  })
})
const pairingFailure = await pairingResponse.json().catch(() => null)
if (pairingResponse.status !== 503 || pairingFailure?.error?.code !== 'provider_unavailable') {
  fail('pairing.begin accepted an unavailable provider')
}
if (pairingFailure?.challengeCode || pairingFailure?.pollSecret) {
  fail('unavailable provider response exposed one-time pairing material')
}
try {
  afterPairingCount = await countChallenge()
  await database.end()
} catch {
  await database.end().catch(() => undefined)
  fail('challenge persistence boundary could not be rechecked')
}
if (afterPairingCount !== beforePairingCount) {
  fail('unavailable provider request persisted a challenge')
}

const unauthenticatedResponse = await fetch('http://127.0.0.1:8787/v1/commands', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    protocolVersion: '1.0',
    requestId: `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    type: 'user.get',
    userId: 'usr_PrivateSmoke0001'
  })
})
if (unauthenticatedResponse.status !== 401) fail('unauthenticated user.get was not rejected')
await unauthenticatedResponse.arrayBuffer()
console.log('Core-only API smoke passed: no provider pairing state persisted; unauthenticated user.get rejected.')
NODE

websocket_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 --http1.1 \
  --header 'Connection: Upgrade' \
  --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' \
  --header 'Sec-WebSocket-Key: c2NpZm9yZV9wcml2YXRl' \
  "$base_url/v1/events" || true)"
[[ "$websocket_status" == "401" ]] || die "Unauthenticated WebSocket Upgrade was not rejected with HTTP 401."

echo "Verification passed: loopback-only core, least-privilege database role, release schema v${expected_schema_version}/${expected_table_count} tables, fixed image revision, probes and auth boundaries."
