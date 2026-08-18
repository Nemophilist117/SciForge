#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

expected_commit="${1:-}"
env_input="${2:-}"
confirmation="${3:-}"
[[ -n "$expected_commit" && -n "$env_input" && "$confirmation" == --confirm-isolated-database-test ]] \
  || die "Usage: verify-postgres-v5-integration.sh <approved-40-character-contract-commit> <env-file> --confirm-isolated-database-test"

for command in docker flock stat grep timeout mktemp chmod chown getent id curl \
  sha256sum tar awk sort rm cat date mv; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."

exec 8>/run/lock/sciforge-collaboration-private-deploy.lock
if ! flock -n 8; then
  die "Another collaboration deployment or PostgreSQL v5 integration run is active."
fi
exec 7>/run/lock/sciforge-collaboration-private-postgres-v5-integration.lock
if ! flock -n 7; then
  die "Another PostgreSQL v5 integration run is active."
fi

attestation_path=/run/sciforge-collaboration-private-postgres-v5.attestation
attestation_temporary=""
if [[ -e "$attestation_path" || -L "$attestation_path" ]]; then
  [[ -f "$attestation_path" && ! -L "$attestation_path" \
      && "$(stat -c '%u:%g:%a' "$attestation_path")" == 0:0:600 ]] \
    || die "The existing PostgreSQL v5 attestation path is unsafe."
  rm -f -- "$attestation_path"
fi

validate_release_bundle "$expected_commit"
expected_schema_version="$(expected_collaboration_schema_version)"
[[ "$expected_schema_version" == 5 ]] \
  || die "PostgreSQL v5 integration requires a release whose validated migration truth is exactly v5."
prepare_compose_environment "$expected_commit" "$env_input"
"${COMPOSE[@]}" config --quiet

running_services="$("${COMPOSE[@]}" ps --status running --services)"
grep -qx postgres <<< "$running_services" || die "PostgreSQL container is not running."
grep -qx app <<< "$running_services" || die "Application container is not running."
validate_database_role_layout

app_container_id="$("${COMPOSE[@]}" ps -q app)"
postgres_container_id="$("${COMPOSE[@]}" ps -q postgres)"
[[ -n "$app_container_id" && -n "$postgres_container_id" ]] \
  || die "Could not resolve the running app and PostgreSQL containers."
app_state_before_build="$(docker container inspect --format \
  '{{.Id}}|{{.State.Pid}}|{{.RestartCount}}|{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$app_container_id")"

"${COMPOSE[@]}" build app

approved_image_id="$(docker image inspect --format '{{.Id}}' \
  "sciforge-collaboration-runtime:$expected_commit")"
approved_image_revision="$(docker image inspect --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$approved_image_id")"
running_image_id="$(docker container inspect --format '{{.Image}}' "$app_container_id")"
running_image_revision="$(docker container inspect --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$app_container_id")"
[[ "$approved_image_id" =~ ^sha256:[0-9a-f]{64}$ \
    && "$approved_image_revision" == "$expected_commit" \
    && "$running_image_id" =~ ^sha256:[0-9a-f]{64}$ \
    && "$running_image_revision" =~ ^[0-9a-f]{40}$ ]] \
  || die "The fixed candidate image or current live app has invalid revision provenance."

mapfile -t postgres_networks < <(docker container inspect --format \
  '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
  "$postgres_container_id")
(( ${#postgres_networks[@]} == 1 )) \
  || die "PostgreSQL must be attached to exactly one dedicated database network."
database_network="${postgres_networks[0]}"
[[ "$database_network" == sciforge-collaboration-private_database ]] \
  || die "PostgreSQL is not attached to the fixed private database network."
[[ "$(docker network inspect --format '{{.Internal}}' "$database_network")" == true ]] \
  || die "The collaboration database network must be internal."
postgres_endpoint="$("${COMPOSE[@]}" port postgres 5432 2>/dev/null || true)"
postgres_docker_ports="$(docker port "$postgres_container_id" 2>/dev/null || true)"
[[ -z "$postgres_endpoint" && -z "$postgres_docker_ports" ]] \
  || die "PostgreSQL must not publish a host port."

base_url="http://127.0.0.1:$SCIFORGE_COLLAB_HOST_PORT"
curl --fail --silent --show-error --max-time 5 "$base_url/healthz" > /dev/null
curl --fail --silent --show-error --max-time 5 "$base_url/readyz" > /dev/null

app_runtime_state() {
  docker container inspect --format \
    '{{.Id}}|{{.State.Pid}}|{{.RestartCount}}|{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$app_container_id"
}

production_snapshot() {
  local snapshot_name
  local snapshot_image_id
  local snapshot_user
  local snapshot_network
  local snapshot_secret_mount_rw
  local snapshot_script_mount_rw
  local forbidden_snapshot_env_count
  local wait_output
  local wait_status
  local snapshot_lines=()

  ((snapshot_sequence += 1))
  snapshot_name="sciforge-postgres-v5-snapshot-${expected_commit:0:12}-$$-$snapshot_sequence"
  snapshot_container_id="$(docker create \
    --name "$snapshot_name" \
    --label "org.opencontainers.image.revision=$expected_commit" \
    --label 'cn.sciforge.test.purpose=production-read-only-snapshot' \
    --network "$database_network" \
    --user 10001:10001 \
    --read-only \
    --tmpfs /tmp:size=16m,mode=1777,nosuid,nodev,noexec \
    --init \
    --restart no \
    --stop-timeout 20 \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --cpus 0.5 \
    --memory 256m \
    --pids-limit 96 \
    --mount "type=bind,src=$runner_script,dst=/app/postgres-v5-integration.mjs,readonly" \
    --mount "type=bind,src=$snapshot_password_file,dst=/run/secrets/postgres-v5-snapshot-password,readonly" \
    --env "SCIFORGE_COLLAB_CONTRACT_COMMIT=$expected_commit" \
    --env 'SCIFORGE_POSTGRES_V5_SNAPSHOT_PASSWORD_FILE=/run/secrets/postgres-v5-snapshot-password' \
    --entrypoint node \
    "$approved_image_id" \
    /app/postgres-v5-integration.mjs --production-snapshot)"
  [[ -n "$snapshot_container_id" ]] || die "Could not create the production snapshot container."

  snapshot_image_id="$(docker container inspect --format '{{.Image}}' "$snapshot_container_id")"
  snapshot_user="$(docker container inspect --format '{{.Config.User}}' "$snapshot_container_id")"
  snapshot_network="$(docker container inspect --format '{{.HostConfig.NetworkMode}}' "$snapshot_container_id")"
  snapshot_secret_mount_rw="$(docker container inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/run/secrets/postgres-v5-snapshot-password"}}{{.RW}}{{end}}{{end}}' \
    "$snapshot_container_id")"
  snapshot_script_mount_rw="$(docker container inspect --format \
    '{{range .Mounts}}{{if eq .Destination "/app/postgres-v5-integration.mjs"}}{{.RW}}{{end}}{{end}}' \
    "$snapshot_container_id")"
  forbidden_snapshot_env_count="$(docker container inspect --format \
    '{{range .Config.Env}}{{println .}}{{end}}' "$snapshot_container_id" \
    | awk -F= '$1 == "SCIFORGE_COLLABORATION_DATABASE_URL" || $1 == "SCIFORGE_COLLAB_DB_PASSWORD" || $1 == "PGPASSWORD" { count += 1 } END { print count + 0 }')"
  [[ "$snapshot_image_id" == "$approved_image_id" \
      && "$snapshot_user" == 10001:10001 \
      && "$snapshot_network" == "$database_network" \
      && "$snapshot_secret_mount_rw" == false \
      && "$snapshot_script_mount_rw" == false \
      && "$forbidden_snapshot_env_count" == 0 ]] \
    || die "The production snapshot container violates its fixed image, identity, network, mount, or secret boundary."

  docker start "$snapshot_container_id" > /dev/null
  set +e
  wait_output="$(timeout --signal=TERM --kill-after=30s 300 \
    docker wait "$snapshot_container_id" 2>/dev/null)"
  wait_status=$?
  set -e
  if (( wait_status != 0 )); then
    docker stop -t 20 "$snapshot_container_id" > /dev/null 2>&1 || true
    die "The production snapshot container timed out or could not be observed."
  fi
  [[ "$wait_output" =~ ^[0-9]+$ ]] || die "The production snapshot container returned an invalid exit status."
  docker logs "$snapshot_container_id" > "$snapshot_log_file" 2>&1
  if grep -Fq -f "$snapshot_password_file" "$snapshot_log_file" \
      || grep -Eq 'postgres(ql)?://|SCIFORGE_COLLABORATION_DATABASE_URL|SCIFORGE_COLLAB_DB_PASSWORD|PGPASSWORD|secretKey|connectionString|stack' "$snapshot_log_file"; then
    die "The production snapshot log violated the secret redaction policy; its contents were suppressed."
  fi
  [[ "$wait_output" == 0 ]] || die "The production snapshot container failed."
  mapfile -t snapshot_lines < "$snapshot_log_file"
  (( ${#snapshot_lines[@]} == 1 )) || die "The production snapshot output was not one safe receipt."
  production_snapshot_result="${snapshot_lines[0]}"
  [[ "$production_snapshot_result" == '{"schemaVersions":['* \
      && "$production_snapshot_result" == *'"tables":['* \
      && "$production_snapshot_result" == *'"table":"schema_migrations"'* ]] \
    || die "The production snapshot receipt is incomplete."
  docker rm "$snapshot_container_id" > /dev/null
  snapshot_container_id=""
}

list_integration_databases() {
  "${COMPOSE[@]}" exec -T postgres \
    psql -U sciforge_admin -d postgres --tuples-only --no-align \
    --command="SELECT datname FROM pg_database WHERE datname ~ '^sciforge_identity_v5_it_[0-9]+_[0-9a-f]{12}$' ORDER BY datname;"
}

runner_script="$(canonical_regular_file "$SCRIPT_DIR/postgres-v5-integration.mjs")"
runner_container_id=""
runner_name="sciforge-postgres-v5-integration-${expected_commit:0:12}-$$"
password_file=""
snapshot_password_file=""
log_file=""
snapshot_log_file=""
snapshot_container_id=""
snapshot_sequence=0
production_snapshot_result=""
cleanup_integration_databases=false

cleanup() {
  local exit_status=$?
  local cleanup_failed=false
  local database
  local database_output
  local remaining_databases
  local databases=()
  trap - EXIT INT TERM

  if [[ -n "$snapshot_container_id" ]] \
      && docker container inspect "$snapshot_container_id" > /dev/null 2>&1; then
    if [[ "$(docker container inspect --format '{{.State.Running}}' "$snapshot_container_id")" == true ]]; then
      docker stop -t 20 "$snapshot_container_id" > /dev/null 2>&1 || cleanup_failed=true
    fi
    docker rm -f "$snapshot_container_id" > /dev/null 2>&1 || cleanup_failed=true
  fi

  if [[ -n "$runner_container_id" ]] \
      && docker container inspect "$runner_container_id" > /dev/null 2>&1; then
    if [[ "$(docker container inspect --format '{{.State.Running}}' "$runner_container_id")" == true ]]; then
      docker stop -t 20 "$runner_container_id" > /dev/null 2>&1 || cleanup_failed=true
    fi
    docker rm -f "$runner_container_id" > /dev/null 2>&1 || cleanup_failed=true
  fi

  if [[ "$cleanup_integration_databases" == true ]]; then
    if database_output="$(list_integration_databases)"; then
      if [[ -n "$database_output" ]]; then
        mapfile -t databases <<< "$database_output"
      fi
      for database in "${databases[@]}"; do
        [[ "$database" =~ ^sciforge_identity_v5_it_[0-9]+_[0-9a-f]{12}$ ]] \
          || { cleanup_failed=true; continue; }
        "${COMPOSE[@]}" exec -T postgres \
          dropdb -U sciforge_admin --if-exists --force "$database" > /dev/null \
          || cleanup_failed=true
      done
      if ! remaining_databases="$(list_integration_databases)"; then
        cleanup_failed=true
      elif [[ -n "$remaining_databases" ]]; then
        cleanup_failed=true
      fi
    else
      cleanup_failed=true
    fi
  fi

  if [[ -n "$password_file" ]]; then
    if [[ "$password_file" =~ ^/run/sciforge-postgres-v5-admin\.[A-Za-z0-9]+$ \
        && -f "$password_file" && ! -L "$password_file" ]]; then
      rm -f -- "$password_file" || cleanup_failed=true
    elif [[ -e "$password_file" ]]; then
      cleanup_failed=true
    fi
  fi
  if [[ -n "$snapshot_password_file" ]]; then
    if [[ "$snapshot_password_file" =~ ^/run/sciforge-postgres-v5-snapshot\.[A-Za-z0-9]+$ \
        && -f "$snapshot_password_file" && ! -L "$snapshot_password_file" ]]; then
      rm -f -- "$snapshot_password_file" || cleanup_failed=true
    elif [[ -e "$snapshot_password_file" ]]; then
      cleanup_failed=true
    fi
  fi
  if [[ -n "$log_file" ]]; then
    if [[ "$log_file" =~ ^/run/sciforge-postgres-v5-log\.[A-Za-z0-9]+$ \
        && -f "$log_file" && ! -L "$log_file" ]]; then
      rm -f -- "$log_file" || cleanup_failed=true
    elif [[ -e "$log_file" ]]; then
      cleanup_failed=true
    fi
  fi
  if [[ -n "$snapshot_log_file" ]]; then
    if [[ "$snapshot_log_file" =~ ^/run/sciforge-postgres-v5-snapshot-log\.[A-Za-z0-9]+$ \
        && -f "$snapshot_log_file" && ! -L "$snapshot_log_file" ]]; then
      rm -f -- "$snapshot_log_file" || cleanup_failed=true
    elif [[ -e "$snapshot_log_file" ]]; then
      cleanup_failed=true
    fi
  fi
  if [[ -n "$attestation_temporary" ]]; then
    if [[ "$attestation_temporary" =~ ^/run/sciforge-postgres-v5-attestation\.[A-Za-z0-9]+$ \
        && -f "$attestation_temporary" && ! -L "$attestation_temporary" ]]; then
      rm -f -- "$attestation_temporary" || cleanup_failed=true
    elif [[ -e "$attestation_temporary" ]]; then
      cleanup_failed=true
    fi
  fi

  # A pass may only survive when every runner, tmpfs secret/log, and temporary
  # database cleanup also succeeds. Otherwise deployment must remain blocked.
  if (( exit_status != 0 )) || [[ "$cleanup_failed" == true ]]; then
    if [[ -e "$attestation_path" || -L "$attestation_path" ]]; then
      if [[ -f "$attestation_path" && ! -L "$attestation_path" \
          && "$(stat -c '%u:%g:%a' "$attestation_path")" == 0:0:600 ]]; then
        rm -f -- "$attestation_path" || cleanup_failed=true
      else
        cleanup_failed=true
      fi
    fi
  fi

  if [[ "$cleanup_failed" == true ]]; then
    echo "ERROR: PostgreSQL v5 integration cleanup was incomplete; operator inspection is required." >&2
    exit_status=1
  fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

preexisting_database_output="$(list_integration_databases)"
preexisting_databases=()
if [[ -n "$preexisting_database_output" ]]; then
  mapfile -t preexisting_databases <<< "$preexisting_database_output"
fi
(( ${#preexisting_databases[@]} == 0 )) \
  || die "A stale PostgreSQL v5 integration database already exists; inspect it before a new run."
cleanup_integration_databases=true

app_state_before="$(app_runtime_state)"
[[ "$app_state_before" == "$app_state_before_build" ]] \
  || die "Building the fixed candidate image changed the live app container state."

validate_provider_secret_group_isolation
snapshot_password_file="$(mktemp /run/sciforge-postgres-v5-snapshot.XXXXXXXXXXXX)"
[[ "$snapshot_password_file" =~ ^/run/sciforge-postgres-v5-snapshot\.[A-Za-z0-9]+$ \
    && -f "$snapshot_password_file" && ! -L "$snapshot_password_file" ]] \
  || die "Could not create the constrained production snapshot password file."
dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_DB_PASSWORD > "$snapshot_password_file"
[[ "$(stat -c '%s' "$snapshot_password_file")" == 64 ]] \
  || die "The production snapshot password file has an invalid size."
grep -Eq '^[0-9A-Fa-f]{64}$' "$snapshot_password_file" \
  || die "The production snapshot password file has an invalid value."
chown root:10001 "$snapshot_password_file"
chmod 0440 "$snapshot_password_file"
[[ "$(stat -c '%u:%g:%a' "$snapshot_password_file")" == 0:10001:440 ]] \
  || die "The production snapshot password file must be root:10001 mode 0440."

snapshot_log_file="$(mktemp /run/sciforge-postgres-v5-snapshot-log.XXXXXXXXXXXX)"
[[ "$snapshot_log_file" =~ ^/run/sciforge-postgres-v5-snapshot-log\.[A-Za-z0-9]+$ \
    && -f "$snapshot_log_file" && ! -L "$snapshot_log_file" ]] \
  || die "Could not create the constrained production snapshot log file."
chmod 0600 "$snapshot_log_file"

production_snapshot
production_snapshot_before="$production_snapshot_result"

password_file="$(mktemp /run/sciforge-postgres-v5-admin.XXXXXXXXXXXX)"
[[ "$password_file" =~ ^/run/sciforge-postgres-v5-admin\.[A-Za-z0-9]+$ \
    && -f "$password_file" && ! -L "$password_file" ]] \
  || die "Could not create the constrained PostgreSQL v5 password file."
dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_DB_ADMIN_PASSWORD > "$password_file"
[[ "$(stat -c '%s' "$password_file")" == 64 ]] \
  || die "The PostgreSQL v5 password file has an invalid size."
grep -Eq '^[0-9A-Fa-f]{64}$' "$password_file" \
  || die "The PostgreSQL v5 password file has an invalid value."
chown root:10001 "$password_file"
chmod 0440 "$password_file"
[[ "$(stat -c '%u:%g:%a' "$password_file")" == 0:10001:440 ]] \
  || die "The PostgreSQL v5 password file must be root:10001 mode 0440."

log_file="$(mktemp /run/sciforge-postgres-v5-log.XXXXXXXXXXXX)"
[[ "$log_file" =~ ^/run/sciforge-postgres-v5-log\.[A-Za-z0-9]+$ \
    && -f "$log_file" && ! -L "$log_file" ]] \
  || die "Could not create the constrained PostgreSQL v5 log file."
chmod 0600 "$log_file"

runner_container_id="$(docker create \
  --name "$runner_name" \
  --label "org.opencontainers.image.revision=$expected_commit" \
  --label 'cn.sciforge.test.purpose=postgres-v5-integration' \
  --network "$database_network" \
  --user 10001:10001 \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777,nosuid,nodev,noexec \
  --init \
  --restart no \
  --stop-timeout 20 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --cpus 1.0 \
  --memory 1g \
  --pids-limit 192 \
  --mount "type=bind,src=$runner_script,dst=/app/postgres-v5-integration.mjs,readonly" \
  --mount "type=bind,src=$password_file,dst=/run/secrets/postgres-v5-admin-password,readonly" \
  --env "SCIFORGE_COLLAB_CONTRACT_COMMIT=$expected_commit" \
  --env 'SCIFORGE_POSTGRES_V5_ADMIN_PASSWORD_FILE=/run/secrets/postgres-v5-admin-password' \
  --entrypoint node \
  "$approved_image_id" \
  /app/postgres-v5-integration.mjs)"
[[ -n "$runner_container_id" ]] || die "Could not create the PostgreSQL v5 integration runner."

runner_image_id="$(docker container inspect --format '{{.Image}}' "$runner_container_id")"
runner_user="$(docker container inspect --format '{{.Config.User}}' "$runner_container_id")"
runner_network="$(docker container inspect --format '{{.HostConfig.NetworkMode}}' "$runner_container_id")"
runner_secret_mount_rw="$(docker container inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/run/secrets/postgres-v5-admin-password"}}{{.RW}}{{end}}{{end}}' \
  "$runner_container_id")"
runner_script_mount_rw="$(docker container inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/app/postgres-v5-integration.mjs"}}{{.RW}}{{end}}{{end}}' \
  "$runner_container_id")"
forbidden_runner_env_count="$(docker container inspect --format \
  '{{range .Config.Env}}{{println .}}{{end}}' "$runner_container_id" \
  | awk -F= '$1 == "SCIFORGE_COLLAB_DB_ADMIN_PASSWORD" || $1 == "SCIFORGE_POSTGRES_V5_ADMIN_URL" || $1 == "POSTGRES_PASSWORD" { count += 1 } END { print count + 0 }')"
[[ "$runner_image_id" == "$approved_image_id" \
    && "$runner_user" == 10001:10001 \
    && "$runner_network" == "$database_network" \
    && "$runner_secret_mount_rw" == false \
    && "$runner_script_mount_rw" == false \
    && "$forbidden_runner_env_count" == 0 ]] \
  || die "The PostgreSQL v5 runner does not satisfy its fixed image, identity, network, mount, or secret boundary."

docker start "$runner_container_id" > /dev/null
set +e
wait_output="$(timeout --signal=TERM --kill-after=30s 600 \
  docker wait "$runner_container_id" 2>/dev/null)"
wait_status=$?
set -e
if (( wait_status != 0 )); then
  docker stop -t 20 "$runner_container_id" > /dev/null 2>&1 || true
  die "The PostgreSQL v5 integration runner timed out or could not be observed."
fi
[[ "$wait_output" =~ ^[0-9]+$ ]] || die "The PostgreSQL v5 runner returned an invalid exit status."
runner_exit_code="$wait_output"
docker logs "$runner_container_id" > "$log_file" 2>&1

if grep -Fq -f "$password_file" "$log_file" \
    || grep -Eq 'postgres(ql)?://|SCIFORGE_POSTGRES_V5_ADMIN_URL|SCIFORGE_COLLAB_DB_ADMIN_PASSWORD|POSTGRES_PASSWORD|secretKey|connectionString|stack' "$log_file"; then
  die "The PostgreSQL v5 runner log violated the secret redaction policy; its contents were suppressed."
fi
cat "$log_file"
[[ "$runner_exit_code" == 0 ]] || die "The PostgreSQL v5 integration runner failed."
grep -Fq '"event":"postgres.v5.integration","status":"passed"' "$log_file" \
  || die "The PostgreSQL v5 integration runner did not emit its pass receipt."
for required_check in v1_to_v5_readiness legacy_agent_revocation concurrent_oidc_jit \
  device_agent_lifecycle zulip_binding_uniqueness; do
  grep -Fq "\"$required_check\"" "$log_file" \
    || die "The PostgreSQL v5 pass receipt is missing a required check."
done

residual_database_output="$(list_integration_databases)"
residual_databases=()
if [[ -n "$residual_database_output" ]]; then
  mapfile -t residual_databases <<< "$residual_database_output"
fi
if (( ${#residual_databases[@]} != 0 )); then
  die "The standalone runner left an isolated integration database; outer cleanup will remove it."
fi

production_snapshot
production_snapshot_after="$production_snapshot_result"
app_state_after="$(app_runtime_state)"
[[ "$production_snapshot_after" == "$production_snapshot_before" ]] \
  || die "Production schema versions, actual tables, row counts, or content digests changed during the isolated v5 integration run."
[[ "$app_state_after" == "$app_state_before" ]] \
  || die "The live app container ID, host PID, RestartCount, image, or revision changed during the isolated v5 integration run."
curl --fail --silent --show-error --max-time 5 "$base_url/healthz" > /dev/null
curl --fail --silent --show-error --max-time 5 "$base_url/readyz" > /dev/null

release_manifest_digest="$(sha256sum "$BUNDLE_DIR/RELEASE_MANIFEST.json" | awk '{print $1}')"
bundle_sums_digest="$(sha256sum "$BUNDLE_DIR/SHA256SUMS" | awk '{print $1}')"
bundle_commit_digest="$(sha256sum "$BUNDLE_DIR/CONTRACT_COMMIT" | awk '{print $1}')"
runner_script_digest="$(sha256sum "$runner_script" | awk '{print $1}')"
verifier_script_digest="$(sha256sum "$SCRIPT_DIR/verify-postgres-v5-integration.sh" | awk '{print $1}')"
for digest in "$release_manifest_digest" "$bundle_sums_digest" "$bundle_commit_digest" \
  "$runner_script_digest" "$verifier_script_digest"; do
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "Could not derive a v5 attestation input digest."
done
verified_epoch="$(date -u +%s)"
verified_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ "$verified_epoch" =~ ^[0-9]{10,}$ \
    && "$verified_utc" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || die "Could not derive the v5 attestation time."
attestation_temporary="$(mktemp /run/sciforge-postgres-v5-attestation.XXXXXXXXXXXX)"
[[ "$attestation_temporary" =~ ^/run/sciforge-postgres-v5-attestation\.[A-Za-z0-9]+$ \
    && -f "$attestation_temporary" && ! -L "$attestation_temporary" ]] \
  || die "Could not create the PostgreSQL v5 attestation."
chmod 0600 "$attestation_temporary"
{
  printf 'schemaVersion=1\n'
  printf 'status=passed\n'
  printf 'contractCommit=%s\n' "$expected_commit"
  printf 'candidateImageId=%s\n' "$approved_image_id"
  printf 'releaseManifestSha256=%s\n' "$release_manifest_digest"
  printf 'bundleSumsSha256=%s\n' "$bundle_sums_digest"
  printf 'bundleCommitSha256=%s\n' "$bundle_commit_digest"
  printf 'runnerScriptSha256=%s\n' "$runner_script_digest"
  printf 'verifierScriptSha256=%s\n' "$verifier_script_digest"
  printf 'verifiedEpoch=%s\n' "$verified_epoch"
  printf 'verifiedAtUtc=%s\n' "$verified_utc"
} > "$attestation_temporary"
[[ "$(stat -c '%u:%g:%a' "$attestation_temporary")" == 0:0:600 ]] \
  || die "The PostgreSQL v5 attestation must be root:root mode 0600."
mv -f -- "$attestation_temporary" "$attestation_path"
attestation_temporary=""

echo "PostgreSQL v5 integration passed in a random isolated database; the production consistency snapshot and live app state were unchanged, and a one-time deployment attestation was written."
