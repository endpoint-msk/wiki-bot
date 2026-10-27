#!/usr/bin/env bash
# Rebuilds and restarts the container from the current checkout. The workflow updates git first:
# this script must not pull itself while bash is still reading it.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "[deploy] .env не найден в $(pwd), контейнер не поднимется" >&2
  exit 1
fi

echo "[deploy] коммит: $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"

docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null || echo "[deploy] чистка образов пропущена" >&2

docker compose ps
docker compose logs --tail 30 --no-color
