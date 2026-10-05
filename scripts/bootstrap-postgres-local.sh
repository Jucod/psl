#!/usr/bin/env bash
# Sets up Postgres + pgvector WITHOUT Docker, on a machine where the
# postgresql-16 package is already installed. Fallback for when the Docker
# daemon is not available (CI containers, remote environments).
#
# On a regular dev machine, use `docker compose up -d` instead.
set -euo pipefail

PGVECTOR_VERSION="${PGVECTOR_VERSION:-v0.8.0}"
PG_MAJOR="${PG_MAJOR:-16}"

echo "==> Cluster Postgres ${PG_MAJOR}"
if ! pg_isready -q 2>/dev/null; then
  pg_ctlcluster "${PG_MAJOR}" main start || true
  for _ in $(seq 1 20); do pg_isready -q && break; sleep 0.5; done
fi
pg_isready

echo "==> pgvector extension"
if ! ls "/usr/share/postgresql/${PG_MAJOR}/extension/" 2>/dev/null | grep -q '^vector\.control$'; then
  echo "    missing, building from source"
  command -v pg_config >/dev/null || {
    echo "    postgresql-server-dev-${PG_MAJOR} is missing" >&2
    echo "    apt-get update && apt-get install -y postgresql-server-dev-${PG_MAJOR} build-essential" >&2
    exit 1
  }
  tmp="$(mktemp -d)"
  git clone --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git "${tmp}/pgvector"
  make -C "${tmp}/pgvector" -j"$(nproc)"
  make -C "${tmp}/pgvector" install
  rm -rf "${tmp}"
fi

echo "==> Role and database"
su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='psl'\"" | grep -q 1 \
  || su postgres -c "psql -c \"CREATE ROLE psl LOGIN PASSWORD 'psl' SUPERUSER\""
su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='psl'\"" | grep -q 1 \
  || su postgres -c "createdb -O psl psl"

PGPASSWORD=psl psql -h 127.0.0.1 -U psl -d psl -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
echo "==> pgvector $(PGPASSWORD=psl psql -h 127.0.0.1 -U psl -d psl -tAc "SELECT extversion FROM pg_extension WHERE extname='vector'")"
echo "==> ready: postgres://psl:psl@127.0.0.1:5432/psl"
