#!/bin/sh

set -eu

case "${SCIFORGE_COLLAB_DB_PASSWORD:-}" in
  ''|*[!0-9A-Fa-f]*)
    echo "ERROR: application database password must be 64 hexadecimal characters." >&2
    exit 1
    ;;
esac
[ "${#SCIFORGE_COLLAB_DB_PASSWORD}" -eq 64 ] || {
  echo "ERROR: application database password must be 64 hexadecimal characters." >&2
  exit 1
}

# The official PostgreSQL entrypoint invokes this only while initializing a new
# data directory. The fixed role/database identifiers are not user input, and
# the hex-only password is sent over stdin rather than exposed in process args.
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE sciforge_collab
  LOGIN
  PASSWORD '${SCIFORGE_COLLAB_DB_PASSWORD}'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;
ALTER DATABASE sciforge_collaboration OWNER TO sciforge_collab;
REVOKE ALL ON DATABASE sciforge_collaboration FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE sciforge_collaboration TO sciforge_collab;
SQL
