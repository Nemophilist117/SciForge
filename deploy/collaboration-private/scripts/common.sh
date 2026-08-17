#!/usr/bin/env bash

set -euo pipefail

COMMON_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PRIVATE_DEPLOY_DIR="$(cd "$COMMON_SCRIPT_DIR/.." && pwd -P)"
COMPOSE_FILE="$PRIVATE_DEPLOY_DIR/compose.yml"
PROVIDER_COMPOSE_FILE="$PRIVATE_DEPLOY_DIR/compose.provider-zulip.yml"
BUNDLE_DIR="$PRIVATE_DEPLOY_DIR/bundle"
RELEASE_EXPECTED_SCHEMA_VERSION=""
RELEASE_EXPECTED_TABLES=""

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"
}

canonical_regular_file() {
  local input="$1"
  local candidate
  if [[ "$input" = /* ]]; then
    candidate="$input"
  else
    candidate="$PWD/$input"
  fi
  [[ -f "$candidate" && ! -L "$candidate" ]] || die "Expected a regular, non-symlink file: $candidate"
  printf '%s/%s\n' "$(cd "$(dirname "$candidate")" && pwd -P)" "$(basename "$candidate")"
}

canonical_directory() {
  local input="$1"
  local candidate
  if [[ "$input" = /* ]]; then
    candidate="$input"
  else
    candidate="$PWD/$input"
  fi
  [[ -d "$candidate" && ! -L "$candidate" ]] || die "Expected a directory, not a symlink: $candidate"
  (cd "$candidate" && pwd -P)
}

validate_private_env_file() {
  local file="$1"
  local permissions
  permissions="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
  [[ "$permissions" =~ ^[0-7]{3,4}$ ]] || die "Could not determine env-file permissions."
  (( (8#$permissions & 077) == 0 )) || die "Env file must be mode 0600 (no group/other access)."
}

dotenv_value() {
  local file="$1"
  local key="$2"
  local required="${3:-required}"
  local matches=()
  local value
  mapfile -t matches < <(awk -v prefix="${key}=" 'index($0, prefix) == 1 { sub(/\r$/, ""); print }' "$file")
  (( ${#matches[@]} <= 1 )) || die "Env file contains duplicate $key entries."
  if (( ${#matches[@]} == 0 )); then
    [[ "$required" == optional ]] && return 0
    die "Env file is missing $key."
  fi
  value="${matches[0]#*=}"
  if [[ "$value" == \"*\" && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  fi
  [[ -n "$value" || "$required" == optional ]] || die "Env value $key must not be empty."
  printf '%s' "$value"
}

validate_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "A full lowercase 40-character contract commit is required."
}

bundle_contract_commit() {
  local commit_file="$BUNDLE_DIR/CONTRACT_COMMIT"
  local commit
  local commit_lines=()
  [[ -f "$commit_file" && ! -L "$commit_file" ]] || die "Bundle is missing regular CONTRACT_COMMIT."
  mapfile -t commit_lines < "$commit_file"
  (( ${#commit_lines[@]} == 1 )) || die "CONTRACT_COMMIT must contain exactly one line."
  commit="${commit_lines[0]%$'\r'}"
  validate_commit "$commit"
  printf '%s' "$commit"
}

validate_release_bundle() {
  local expected_commit="$1"
  local required_file
  local manifest_file="$BUNDLE_DIR/RELEASE_MANIFEST.json"
  local manifest_commit
  local manifest_artifact
  local manifest_schema_version
  local manifest_release_mode
  local manifest_base_commit
  local manifest_deployment_boundary
  local manifest_filename
  local manifest_filenames=()
  local bundle_entries=()
  local bundle_entry
  local tarballs=()
  local contract_packages=0
  local provider_packages=0
  local server_packages=0
  local tarball
  local basename
  local line
  local digest
  local filename
  local extra
  local line_count=0
  declare -A allowed_files=()
  declare -A allowed_bundle_files=()
  declare -A manifest_seen_files=()
  declare -A seen_files=()

  validate_commit "$expected_commit"
  [[ -d "$BUNDLE_DIR" && ! -L "$BUNDLE_DIR" ]] || die "Bundle directory is missing or is a symlink: $BUNDLE_DIR"
  for required_file in package.json package-lock.json CONTRACT_COMMIT RELEASE_MANIFEST.json SHA256SUMS; do
    [[ -f "$BUNDLE_DIR/$required_file" && ! -L "$BUNDLE_DIR/$required_file" ]] \
      || die "Bundle is missing regular $required_file."
  done
  [[ "$(bundle_contract_commit)" == "$expected_commit" ]] \
    || die "Bundle CONTRACT_COMMIT does not match the approved commit."

  shopt -s nullglob
  tarballs=("$BUNDLE_DIR"/*.tgz)
  shopt -u nullglob
  (( ${#tarballs[@]} == 3 )) || die "Bundle must contain exactly three tarballs."
  for tarball in "${tarballs[@]}"; do
    [[ -f "$tarball" && ! -L "$tarball" ]] || die "Tarball must be a regular, non-symlink file."
    basename="$(basename "$tarball")"
    case "$basename" in
      sciforge-collaboration-contracts-*.tgz) ((contract_packages += 1)) ;;
      sciforge-collaboration-provider-zulip-*.tgz) ((provider_packages += 1)) ;;
      sciforge-collaboration-server-*.tgz) ((server_packages += 1)) ;;
      *) die "Unexpected tarball in release bundle: $basename" ;;
    esac
    tar -tzf "$tarball" | awk '$0 == "package/package.json" { found=1 } END { exit(found ? 0 : 1) }' \
      || die "Tarball does not contain package/package.json: $basename"
    allowed_files["$basename"]=1
  done
  (( contract_packages == 1 && provider_packages == 1 && server_packages == 1 )) \
    || die "Bundle must contain one contracts, one Zulip provider, and one server tarball."

  manifest_schema_version="$(awk '$1 == "\"schemaVersion\":" { gsub(/,/, "", $2); print $2 }' "$manifest_file")"
  manifest_artifact="$(awk -F'"' '$2 == "artifact" { print $4 }' "$manifest_file")"
  manifest_commit="$(awk -F'"' '$2 == "contractCommit" { print $4 }' "$manifest_file")"
  manifest_release_mode="$(awk -F'"' '$2 == "releaseMode" { print $4 }' "$manifest_file")"
  manifest_base_commit="$(awk -F'"' '$2 == "baseCommit" { print $4 }' "$manifest_file")"
  manifest_deployment_boundary="$(awk -F'"' '$2 == "deploymentBoundary" { print $4 }' "$manifest_file")"
  mapfile -t manifest_filenames < <(awk -F'"' '$2 == "filename" { print $4 }' "$manifest_file")
  [[ "$manifest_schema_version" == 1 \
      && "$manifest_artifact" == sciforge-collaboration-server-bundle \
      && "$manifest_commit" == "$expected_commit" ]] \
    || die "RELEASE_MANIFEST.json metadata does not match the approved release."
  case "$manifest_release_mode" in
    origin-gui)
      [[ -z "$manifest_base_commit" && -z "$manifest_deployment_boundary" ]] \
        || die "origin-gui manifest must not carry private-release metadata."
      ;;
    private-test)
      validate_commit "$manifest_base_commit"
      [[ -z "$manifest_deployment_boundary" ]] \
        || die "private-test manifest contains an unexpected deployment boundary."
      ;;
    team-private-acceptance)
      validate_commit "$manifest_base_commit"
      [[ "$manifest_deployment_boundary" == loopback-ssh-tunnel-only ]] \
        || die "Team private acceptance must retain the loopback/SSH-tunnel boundary."
      ;;
    *) die "RELEASE_MANIFEST.json contains an unsupported release mode." ;;
  esac
  (( ${#manifest_filenames[@]} == 3 )) \
    || die "RELEASE_MANIFEST.json must describe exactly three packages."
  for manifest_filename in "${manifest_filenames[@]}"; do
    [[ -n "${allowed_files[$manifest_filename]:-}" ]] \
      || die "RELEASE_MANIFEST.json references an unexpected package archive."
    [[ -z "${manifest_seen_files[$manifest_filename]:-}" ]] \
      || die "RELEASE_MANIFEST.json contains a duplicate package archive."
    manifest_seen_files["$manifest_filename"]=1
  done
  for tarball in "${tarballs[@]}"; do
    basename="$(basename "$tarball")"
    [[ -n "${manifest_seen_files[$basename]:-}" ]] \
      || die "RELEASE_MANIFEST.json does not describe every package archive."
  done
  allowed_files[package.json]=1
  allowed_files[package-lock.json]=1
  allowed_files[CONTRACT_COMMIT]=1
  allowed_files[RELEASE_MANIFEST.json]=1

  for filename in "${!allowed_files[@]}"; do
    allowed_bundle_files["$filename"]=1
  done
  allowed_bundle_files[SHA256SUMS]=1
  allowed_bundle_files[.gitignore]=1
  shopt -s nullglob dotglob
  bundle_entries=("$BUNDLE_DIR"/*)
  shopt -u nullglob dotglob
  for bundle_entry in "${bundle_entries[@]}"; do
    basename="$(basename "$bundle_entry")"
    [[ -f "$bundle_entry" && ! -L "$bundle_entry" ]] \
      || die "Release bundle may contain only regular, non-symlink files."
    [[ -n "${allowed_bundle_files[$basename]:-}" ]] \
      || die "Release bundle contains an unexpected file: $basename"
  done

  while IFS= read -r line || [[ -n "$line" ]]; do
    ((line_count += 1))
    read -r digest filename extra <<< "$line"
    filename="${filename#\*}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ && -n "$filename" && -z "${extra:-}" ]] \
      || die "SHA256SUMS contains an invalid line."
    [[ -n "${allowed_files[$filename]:-}" ]] || die "SHA256SUMS references an unexpected file."
    [[ -z "${seen_files[$filename]:-}" ]] || die "SHA256SUMS contains a duplicate file entry."
    seen_files["$filename"]=1
  done < "$BUNDLE_DIR/SHA256SUMS"
  (( line_count == 7 && ${#seen_files[@]} == 7 )) || die "SHA256SUMS must cover exactly all seven release inputs."
  for filename in "${!allowed_files[@]}"; do
    [[ -n "${seen_files[$filename]:-}" ]] || die "SHA256SUMS does not cover every release input."
  done
  (cd "$BUNDLE_DIR" && sha256sum --check --strict --status SHA256SUMS) \
    || die "Release bundle checksum verification failed."
  derive_release_schema_truth
}

derive_release_schema_truth() {
  local server_tarballs=()
  local server_tarball
  local archive_entries=()
  local archive_entry
  local migration_paths=()
  local migration_path
  local migration_filename
  local migration_version
  local expected_version
  local migration_index=1
  local entry_type
  local migration_sql
  local parsed_tables
  local table
  local tables=()
  declare -A seen_migration_paths=()
  declare -A seen_tables=()

  shopt -s nullglob
  server_tarballs=("$BUNDLE_DIR"/sciforge-collaboration-server-*.tgz)
  shopt -u nullglob
  (( ${#server_tarballs[@]} == 1 )) || die "Could not identify exactly one validated server tarball."
  server_tarball="${server_tarballs[0]}"

  mapfile -t archive_entries < <(tar -tzf "$server_tarball")
  (( ${#archive_entries[@]} > 0 )) || die "Server tarball is empty."
  for archive_entry in "${archive_entries[@]}"; do
    case "$archive_entry" in
      package/migrations|package/migrations/) ;;
      package/migrations/*)
        [[ "$archive_entry" =~ ^package/migrations/[0-9]{4}_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$ ]] \
          || die "Server tarball contains an invalid migration path."
        [[ -z "${seen_migration_paths[$archive_entry]:-}" ]] \
          || die "Server tarball contains a duplicate migration path."
        seen_migration_paths["$archive_entry"]=1
        migration_paths+=("$archive_entry")
        ;;
    esac
  done
  (( ${#migration_paths[@]} > 0 )) || die "Server tarball does not contain any migration SQL files."
  mapfile -t migration_paths < <(printf '%s\n' "${migration_paths[@]}" | LC_ALL=C sort)

  for migration_path in "${migration_paths[@]}"; do
    migration_filename="${migration_path##*/}"
    migration_version="${migration_filename%%_*}"
    printf -v expected_version '%04d' "$migration_index"
    [[ "$migration_version" == "$expected_version" ]] \
      || die "Server migration filenames must form a continuous sequence beginning at 0001."

    if ! entry_type="$(tar -tvzf "$server_tarball" "$migration_path" \
      | awk 'NR == 1 { print substr($1, 1, 1) } END { if (NR != 1) exit 1 }')"; then
      die "Could not inspect a server migration archive entry."
    fi
    [[ "$entry_type" == - ]] || die "Every server migration must be a regular archive file."
    if ! migration_sql="$(tar -xOzf "$server_tarball" "$migration_path")"; then
      die "Could not read a server migration from the validated tarball."
    fi
    [[ -n "${migration_sql//[[:space:]]/}" ]] || die "Server migration SQL must not be empty."
    [[ "$migration_sql" != *'/*'* && "$migration_sql" != *'*/'* ]] \
      || die "Server migration block comments are unsupported by the strict table parser."

    if ! parsed_tables="$(printf '%s\n' "$migration_sql" | awk '
      {
        line = $0
        sub(/\r$/, "", line)
        sub(/--.*/, "", line)
        sql = sql " " line
      }
      END {
        gsub(/[[:space:]]+/, " ", sql)
        remaining = sql
        while (match(toupper(remaining), /CREATE TABLE/)) {
          statement = substr(remaining, RSTART)
          if (statement !~ /^CREATE TABLE (IF NOT EXISTS )?sciforge_collaboration\.[a-z][a-z0-9_]*[[:space:]]*\(/) exit 42
          name = statement
          sub(/^CREATE TABLE (IF NOT EXISTS )?sciforge_collaboration\./, "", name)
          if (!match(name, /^[a-z][a-z0-9_]*/)) exit 42
          print substr(name, RSTART, RLENGTH)
          remaining = substr(statement, length("CREATE TABLE") + 1)
        }
      }
    ')"; then
      die "Server migration contains a CREATE TABLE statement that cannot be parsed safely."
    fi
    while IFS= read -r table; do
      [[ -n "$table" ]] || continue
      seen_tables["$table"]=1
    done <<< "$parsed_tables"
    (( migration_index += 1 ))
  done

  (( ${#seen_tables[@]} > 0 )) || die "Server migrations do not define any collaboration tables."
  [[ -n "${seen_tables[schema_migrations]:-}" ]] \
    || die "Server migrations do not define the required schema_migrations table."
  mapfile -t tables < <(printf '%s\n' "${!seen_tables[@]}" | LC_ALL=C sort)
  RELEASE_EXPECTED_SCHEMA_VERSION="$((migration_index - 1))"
  RELEASE_EXPECTED_TABLES="$(printf '%s\n' "${tables[@]}")"
}

expected_collaboration_schema_version() {
  [[ "$RELEASE_EXPECTED_SCHEMA_VERSION" =~ ^[1-9][0-9]*$ ]] \
    || die "Release-derived migration truth has not been initialized."
  printf '%s' "$RELEASE_EXPECTED_SCHEMA_VERSION"
}

prepare_compose_environment() {
  local expected_commit="$1"
  local env_input="$2"
  local admin_db_value
  local app_db_value
  local host_port

  validate_commit "$expected_commit"
  ENV_FILE="$(canonical_regular_file "$env_input")"
  validate_private_env_file "$ENV_FILE"
  admin_db_value="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_DB_ADMIN_PASSWORD)"
  [[ "$admin_db_value" =~ ^[0-9A-Fa-f]{64}$ ]] \
    || die "SCIFORGE_COLLAB_DB_ADMIN_PASSWORD must be exactly 64 hexadecimal characters."
  app_db_value="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_DB_PASSWORD)"
  [[ "$app_db_value" =~ ^[0-9A-Fa-f]{64}$ ]] \
    || die "SCIFORGE_COLLAB_DB_PASSWORD must be exactly 64 hexadecimal characters."
  [[ "$admin_db_value" != "$app_db_value" ]] \
    || die "Database admin and application passwords must be different."
  host_port="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_HOST_PORT optional)"
  host_port="${host_port:-8787}"
  [[ "$host_port" =~ ^[0-9]+$ ]] || die "SCIFORGE_COLLAB_HOST_PORT must be an integer."
  (( host_port >= 1024 && host_port <= 65535 )) || die "SCIFORGE_COLLAB_HOST_PORT must be between 1024 and 65535."

  # Export the validated values so shell variables cannot override the selected
  # env file or the approved bundle revision during Compose interpolation.
  printf -v SCIFORGE_COLLAB_DB_ADMIN_PASSWORD '%s' "$admin_db_value"
  printf -v SCIFORGE_COLLAB_DB_PASSWORD '%s' "$app_db_value"
  export SCIFORGE_COLLAB_DB_ADMIN_PASSWORD
  export SCIFORGE_COLLAB_DB_PASSWORD
  export SCIFORGE_COLLAB_HOST_PORT="$host_port"
  export SCIFORGE_COLLAB_CONTRACT_COMMIT="$expected_commit"
  COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
}

enable_zulip_provider_compose() {
  local config_input
  local secret_input
  local config_file
  local secret_directory
  local permissions
  local owner_id
  local group_id
  local secret_entries=()
  local secret_file
  local secret_name
  local secret_size

  [[ -n "${ENV_FILE:-}" ]] || die "Provider overlay requires a prepared Compose environment."
  validate_provider_secret_group_isolation
  [[ -f "$PROVIDER_COMPOSE_FILE" && ! -L "$PROVIDER_COMPOSE_FILE" ]] \
    || die "Zulip provider Compose overlay is missing."
  config_input="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_PROVIDER_CONFIG_FILE)"
  secret_input="$(dotenv_value "$ENV_FILE" SCIFORGE_COLLAB_PROVIDER_SECRET_DIR)"
  config_file="$(canonical_regular_file "$config_input")"
  secret_directory="$(canonical_directory "$secret_input")"
  [[ "$config_file" == /srv/sciforge-collaboration/provider/providers.json ]] \
    || die "Provider config must resolve to /srv/sciforge-collaboration/provider/providers.json."
  [[ "$secret_directory" == /srv/sciforge-collaboration/provider/secrets ]] \
    || die "Provider secrets must resolve to /srv/sciforge-collaboration/provider/secrets."

  permissions="$(stat -c '%a' "$config_file")"
  owner_id="$(stat -c '%u' "$config_file")"
  group_id="$(stat -c '%g' "$config_file")"
  [[ "$permissions" == 640 && "$owner_id" == 0 && "$group_id" == 10001 ]] \
    || die "Provider config must be root:10001 mode 0640."
  permissions="$(stat -c '%a' "$secret_directory")"
  owner_id="$(stat -c '%u' "$secret_directory")"
  group_id="$(stat -c '%g' "$secret_directory")"
  [[ "$permissions" == 750 && "$owner_id" == 0 && "$group_id" == 10001 ]] \
    || die "Provider secret directory must be root:10001 mode 0750."

  shopt -s nullglob dotglob
  secret_entries=("$secret_directory"/*)
  shopt -u nullglob dotglob
  (( ${#secret_entries[@]} > 0 )) || die "Provider secret directory must contain at least one secret file."
  for secret_file in "${secret_entries[@]}"; do
    [[ -f "$secret_file" && ! -L "$secret_file" ]] \
      || die "Provider secret directory may contain only regular, non-symlink files."
    secret_name="$(basename "$secret_file")"
    [[ "$secret_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
      || die "Provider secret filename is outside the runtime reference contract."
    permissions="$(stat -c '%a' "$secret_file")"
    owner_id="$(stat -c '%u' "$secret_file")"
    group_id="$(stat -c '%g' "$secret_file")"
    [[ "$permissions" == 640 && "$owner_id" == 0 && "$group_id" == 10001 ]] \
      || die "Every provider secret must be root:10001 mode 0640."
    secret_size="$(stat -c '%s' "$secret_file")"
    [[ "$secret_size" =~ ^[0-9]+$ ]] || die "Could not inspect provider secret size."
    (( secret_size > 0 && secret_size <= 65536 )) \
      || die "Every provider secret must be non-empty and no larger than 64 KiB."
  done

  export SCIFORGE_COLLAB_PROVIDER_CONFIG_FILE="$config_file"
  export SCIFORGE_COLLAB_PROVIDER_SECRET_DIR="$secret_directory"
  COMPOSE+=( -f "$PROVIDER_COMPOSE_FILE" )
}

validate_provider_secret_group_isolation() {
  local protected_gid=10001
  local account
  local account_gid
  local account_group_list

  require_command getent
  require_command id

  # The container can read numeric-GID bind mounts without a host NSS group.
  # Keep that GID completely unassigned on the host so no host service or
  # login account inherits access to provider credentials.
  if getent group "$protected_gid" > /dev/null; then
    die "Provider runtime GID $protected_gid must not be assigned to a host group."
  fi
  while IFS=: read -r account _ _ account_gid _ _ _; do
    [[ -n "$account" ]] || continue
    [[ "$account_gid" != "$protected_gid" ]] \
      || die "Host account $account must not use provider runtime GID $protected_gid."
    account_group_list="$(id -G "$account")" \
      || die "Could not resolve supplementary groups for host account $account."
    [[ ! "$account_group_list" =~ (^|[[:space:]])${protected_gid}($|[[:space:]]) ]] \
      || die "Host account $account must not belong to provider runtime GID $protected_gid."
  done < <(getent passwd)
}

backup_directory_from_env() {
  local env_file="$1"
  local backup_dir
  backup_dir="$(dotenv_value "$env_file" SCIFORGE_COLLAB_BACKUP_DIR optional)"
  backup_dir="${backup_dir:-/srv/sciforge-collaboration/backups}"
  [[ "$backup_dir" == /srv/sciforge-collaboration/backups ]] \
    || die "SCIFORGE_COLLAB_BACKUP_DIR must be /srv/sciforge-collaboration/backups."
  printf '%s' "$backup_dir"
}

validate_database_role_layout() {
  local application_role_attributes
  local database_owner

  if ! application_role_attributes="$("${COMPOSE[@]}" exec -T postgres \
    psql -U sciforge_admin -d postgres --tuples-only --no-align \
    --command="SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = 'sciforge_collab';")"; then
    die "Could not inspect the dedicated database roles. Refusing to use a legacy or partially initialized volume."
  fi
  [[ "$application_role_attributes" == "f|f|f|f|t" ]] \
    || die "Application database role does not have the required least-privilege attributes."

  if ! database_owner="$("${COMPOSE[@]}" exec -T postgres \
    psql -U sciforge_admin -d postgres --tuples-only --no-align \
    --command="SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'sciforge_collaboration';")"; then
    die "Could not inspect the collaboration database owner."
  fi
  [[ "$database_owner" == sciforge_collab ]] \
    || die "Application database is not owned by the least-privilege application role."
}

expected_collaboration_tables() {
  [[ -n "$RELEASE_EXPECTED_TABLES" ]] \
    || die "Release-derived table truth has not been initialized."
  printf '%s\n' "$RELEASE_EXPECTED_TABLES"
}

database_table_row_counts() {
  local database="$1"
  local database_user="$2"
  local table
  local count

  [[ "$database" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "Unsafe database name in row-count verification."
  [[ "$database_user" == sciforge_admin || "$database_user" == sciforge_collab ]] \
    || die "Unexpected database user in row-count verification."
  while IFS= read -r table; do
    [[ "$table" =~ ^[a-z][a-z0-9_]*$ ]] || die "Unsafe table name in row-count verification."
    if ! count="$("${COMPOSE[@]}" exec -T postgres \
      psql -U "$database_user" -d "$database" --tuples-only --no-align \
      --command="SELECT count(*) FROM sciforge_collaboration.${table};")"; then
      die "Could not count a collaboration table during restore verification."
    fi
    [[ "$count" =~ ^[0-9]+$ ]] || die "Database returned an invalid table row count."
    printf '%s=%s\n' "$table" "$count"
  done < <(expected_collaboration_tables)
}
