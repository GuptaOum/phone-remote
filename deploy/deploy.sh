#!/usr/bin/env bash
# Phone Remote — zero-fuss deploy on the EC2 host.
#
# Run by GitHub Actions on every push to main (see .github/workflows/deploy.yml),
# or by hand:  ~/phone-remote/deploy/deploy.sh      (FORCE=1 to rebuild anyway)
#
# The CI SSH key is locked (authorized_keys forced command) to ~/bin/phone-remote-deploy,
# which fetches origin/main and runs THIS file from it — so the newest version of
# the script always deploys itself, even on the first run.
#
#   1. git fast-forward to origin/main
#   2. work out which services the changed files belong to (git diff):
#        client/ server/ Dockerfile → app      nginx/ → nginx
#        docker-compose.yml → everything       anything else → nothing
#      (Image IDs can't decide this: every build gets a new ID even with no
#      code change, which used to restart app + nginx on every deploy.)
#   3. build those images WHILE the old containers keep serving, then
#      recreate only those containers (coturn and the database are untouched)
#   4. health-check app + nginx; on failure roll back to the previous commit
#   5. push the new images to Docker Hub
set -euo pipefail

cd "${REPO_DIR:-$HOME/phone-remote}"
DOMAIN="${DOMAIN:-65-1-96-152.sslip.io}"

# One deploy at a time
exec 9>/tmp/phone-remote-deploy.lock
flock -n 9 || { echo "❌ another deploy is running"; exit 1; }

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

healthy() {
  # App answers inside its container…
  for _ in $(seq 1 30); do
    if docker exec phone-remote-app node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
      break
    fi
    sleep 2
  done
  # …and the public path (nginx → app) works end to end.
  for _ in $(seq 1 15); do
    if curl -fsS -o /dev/null --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Services whose inputs changed between two commits ("ALL" = let compose decide)
changed_services() {
  local files s=""
  files=$(git diff --name-only "$1" "$2")
  if grep -qx 'docker-compose.yml' <<<"$files"; then echo ALL; return; fi
  grep -qE '^(Dockerfile|\.dockerignore|client/|server/)' <<<"$files" && s="$s app"
  grep -qE '^nginx/' <<<"$files" && s="$s nginx"
  echo $s
}

swap() {
  if [ "$1" = ALL ]; then
    docker compose build -q
    docker compose up -d --remove-orphans
  else
    docker compose build -q "$@"
    docker compose up -d --no-deps "$@"
  fi
  # nginx caches the app container's IP; a graceful reload re-resolves it
  # without dropping open connections.
  docker exec phone-remote-nginx nginx -s reload >/dev/null 2>&1 || true
}

PREV=$(git rev-parse HEAD)
git fetch -q origin main
NEW=$(git rev-parse origin/main)

if [ "$PREV" = "$NEW" ] && [ "${FORCE:-0}" != 1 ]; then
  log "already at $(git log --oneline -1)"
  exit 0
fi

if [ "${FORCE:-0}" = 1 ]; then SERVICES=ALL; else SERVICES=$(changed_services "$PREV" "$NEW"); fi
log "deploying $(git log --oneline -1 "$NEW")  (was ${PREV:0:7}) → services: ${SERVICES:-none}"
git merge -q --ff-only "$NEW"

if [ -z "$SERVICES" ]; then
  log "✅ no server changes (docs / CI / Android only) — nothing restarted"
  exit 0
fi

# shellcheck disable=SC2086  # word-splitting the service list is intended
if swap $SERVICES && healthy; then
  log "✅ healthy — $(docker ps --format '{{.Names}}: {{.Status}}' | tr '\n' ';')"
else
  log "❌ deploy failed — rolling back to ${PREV:0:7}"
  git reset -q --hard "$PREV"
  swap $SERVICES || true
  if healthy; then log "↩️  rolled back, site is up on ${PREV:0:7}"; else log "🔥 rollback also unhealthy — check: docker compose logs app"; fi
  exit 1
fi

log "pushing images to Docker Hub"
[ "$SERVICES" = ALL ] && SERVICES="app nginx"
for svc in $SERVICES; do
  docker push -q "oumgupta/phone-remote-$svc:latest" || log "⚠️  push $svc failed (deploy is still live)"
done
docker image prune -f >/dev/null 2>&1 || true
log "done"
