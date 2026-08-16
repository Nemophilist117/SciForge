#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

dump_input="${1:-}"
env_input="${2:-$PRIVATE_DEPLOY_DIR/.env}"
[[ -n "$dump_input" ]] \
  || die "Usage: verify-backup-restore.sh <backup.dump> [env-file]"

for command in docker sha256sum stat awk od tr grep tar sort; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."

expected_commit="$(bundle_contract_commit)"
validate_release_bundle "$expected_commit"
expected_schema_version="$(expected_collaboration_schema_version)"
expected_tables="$(expected_collaboration_tables)"
expected_table_count="$(printf '%s\n' "$expected_tables" | awk 'END { print NR }')"
prepare_compose_environment "$expected_commit" "$env_input"
"${COMPOSE[@]}" config --quiet

backup_dir="$(backup_directory_from_env "$ENV_FILE")"
[[ -d "$backup_dir" && ! -L "$backup_dir" ]] \
  || die "Dedicated backup directory is missing or is a symlink."
backup_dir="$(cd "$backup_dir" && pwd -P)"
[[ "$backup_dir" == /srv/sciforge-collaboration/backups ]] \
  || die "Backup directory resolved outside the dedicated backup root."

dump_path="$(canonical_regular_file "$dump_input")"
dump_basename="$(basename "$dump_path")"
[[ "$(dirname "$dump_path")" == "$backup_dir" \
    && "$dump_basename" =~ ^collaboration-[0-9]{8}T[0-9]{6}Z\.dump$ ]] \
  || die "Restore verification only accepts a collaboration dump directly inside the backup root."
checksum_path="$(canonical_regular_file "$dump_path.sha256")"
[[ "$(dirname "$checksum_path")" == "$backup_dir" ]] \
  || die "Backup checksum sidecar must be inside the backup root."

checksum_lines=()
mapfile -t checksum_lines < "$checksum_path"
(( ${#checksum_lines[@]} == 1 )) || die "Backup checksum sidecar must contain exactly one entry."
read -r expected_digest expected_filename checksum_extra <<< "${checksum_lines[0]}"
expected_filename="${expected_filename#\*}"
[[ "$expected_digest" =~ ^[0-9a-f]{64}$ \
    && "$expected_filename" == "$dump_basename" \
    && -z "${checksum_extra:-}" ]] \
  || die "Backup checksum sidecar is malformed or references another file."
(cd "$backup_dir" && sha256sum --check --strict --status "$(basename "$checksum_path")") \
  || die "Backup checksum verification failed."
running_services="$("${COMPOSE[@]}" ps --status running --services)"
grep -qx postgres <<< "$running_services" || die "PostgreSQL container is not running."
validate_database_role_layout
"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$dump_path" > /dev/null \
  || die "Backup is not a readable PostgreSQL custom-format dump."
source_schema_version="$("${COMPOSE[@]}" exec -T postgres \
  psql -U sciforge_admin -d sciforge_collaboration --tuples-only --no-align \
  --command='SELECT max(version) FROM sciforge_collaboration.schema_migrations;')"
[[ "$source_schema_version" == "$expected_schema_version" ]] \
  || die "Source database schema version does not match the validated release migrations."
source_tables="$("${COMPOSE[@]}" exec -T postgres \
  psql -U sciforge_admin -d sciforge_collaboration --tuples-only --no-align \
  --command="SELECT table_name FROM information_schema.tables WHERE table_schema = 'sciforge_collaboration' AND table_type = 'BASE TABLE' ORDER BY table_name;")"
[[ "$source_tables" == "$expected_tables" ]] \
  || die "Source database table set does not match the validated release migrations."
source_row_counts="$(database_table_row_counts sciforge_collaboration sciforge_admin)"

random_hex="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$random_hex" =~ ^[0-9a-f]{24}$ ]] || die "Could not generate an isolated restore database name."
temporary_database="sciforge_restore_verify_${random_hex}"
[[ "$temporary_database" =~ ^sciforge_restore_verify_[0-9a-f]{24}$ ]] \
  || die "Generated restore database name failed its safety check."
database_created=false
cleanup() {
  local exit_status=$?
  trap - EXIT
  if [[ "$database_created" == true ]]; then
    if ! "${COMPOSE[@]}" exec -T postgres \
      dropdb -U sciforge_admin --if-exists --force "$temporary_database" > /dev/null; then
      echo "ERROR: Could not remove the isolated restore verification database." >&2
      (( exit_status != 0 )) || exit_status=1
    fi
  fi
  exit "$exit_status"
}
trap cleanup EXIT

"${COMPOSE[@]}" exec -T postgres \
  createdb -U sciforge_admin --template=template0 "$temporary_database"
database_created=true
"${COMPOSE[@]}" exec -T postgres \
  pg_restore -U sciforge_admin --dbname="$temporary_database" \
    --exit-on-error --no-owner --no-privileges < "$dump_path"

schema_version="$("${COMPOSE[@]}" exec -T postgres \
  psql -U sciforge_admin -d "$temporary_database" --tuples-only --no-align \
  --command='SELECT max(version) FROM sciforge_collaboration.schema_migrations;')"
[[ "$schema_version" == "$expected_schema_version" ]] \
  || die "Restored database schema version does not match the validated release migrations."

actual_tables="$("${COMPOSE[@]}" exec -T postgres \
  psql -U sciforge_admin -d "$temporary_database" --tuples-only --no-align \
  --command="SELECT table_name FROM information_schema.tables WHERE table_schema = 'sciforge_collaboration' AND table_type = 'BASE TABLE' ORDER BY table_name;")"
[[ "$actual_tables" == "$expected_tables" ]] \
  || die "Restored database table set does not match the validated release migrations."
restored_row_counts="$(database_table_row_counts "$temporary_database" sciforge_admin)"
[[ "$restored_row_counts" == "$source_row_counts" ]] \
  || die "Restored database row counts do not match the source database for every release table."

echo "Backup restore verification passed in an isolated temporary database (release schema v${expected_schema_version}; exact ${expected_table_count}-table set and row counts)."
