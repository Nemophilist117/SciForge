#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

env_input="${1:-$PRIVATE_DEPLOY_DIR/.env}"
expected_commit="$(bundle_contract_commit)"

for command in docker flock sha256sum stat awk mktemp install chmod find date mv; do
  require_command "$command"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is unavailable."
prepare_compose_environment "$expected_commit" "$env_input"
"${COMPOSE[@]}" config --quiet

backup_dir="$(backup_directory_from_env "$ENV_FILE")"
backup_parent="$(dirname "$backup_dir")"
[[ -d "$backup_parent" && ! -L "$backup_parent" \
    && "$(cd "$backup_parent" && pwd -P)" == /srv/sciforge-collaboration ]] \
  || die "Backup parent must be the real /srv/sciforge-collaboration directory."
[[ ! -L "$backup_dir" ]] || die "Backup directory must not be a symlink."
umask 077
install -d -m 0700 -- "$backup_dir"
backup_dir="$(cd "$backup_dir" && pwd -P)"
[[ "$backup_dir" == /srv/sciforge-collaboration/backups ]] \
  || die "Backup directory resolved outside the dedicated backup root."
chmod 0700 -- "$backup_dir"

exec 9>"$backup_dir/.backup.lock"
if ! flock -n 9; then
  die "Another backup is already running; callers must retry before migration or release work."
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="$backup_dir/collaboration-$timestamp.dump"
checksum_path="$backup_path.sha256"
[[ ! -e "$backup_path" && ! -e "$checksum_path" ]] || die "A backup with this timestamp already exists."
temporary_path="$(mktemp "$backup_dir/.collaboration-$timestamp.XXXXXX.partial")"
temporary_checksum="$(mktemp "$backup_dir/.collaboration-$timestamp.XXXXXX.sha256.partial")"
cleanup() {
  rm -f -- "$temporary_path" "$temporary_checksum"
}
trap cleanup EXIT

"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U sciforge_collab --format=custom --no-owner --no-privileges sciforge_collaboration \
  > "$temporary_path"
[[ -s "$temporary_path" ]] || die "pg_dump produced an empty backup."
"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$temporary_path" > /dev/null

digest="$(sha256sum "$temporary_path" | awk '{print $1}')"
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "Could not calculate backup checksum."
printf '%s  %s\n' "$digest" "$(basename "$backup_path")" > "$temporary_checksum"
chmod 0600 -- "$temporary_path" "$temporary_checksum"
mv -- "$temporary_path" "$backup_path"
mv -- "$temporary_checksum" "$checksum_path"
trap - EXIT

find "$backup_dir" -xdev -maxdepth 1 -type f \
  \( -name 'collaboration-*.dump' -o -name 'collaboration-*.dump.sha256' \) \
  -mtime +14 -delete

echo "Backup completed: $(basename "$backup_path") (SHA-256 sidecar created; 14-day local retention)."
