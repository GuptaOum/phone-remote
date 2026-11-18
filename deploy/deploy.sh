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
#   2. build new images WHILE the old containers keep serving traffic
#   3. recreate only the containers whose image/config changed
#      (coturn, the database and unchanged services are never touched)
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

swap() {
  docker compose build -q
  docker compose up -d --remove-orphans
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

log "deploying $(git log --oneline -1 "$NEW")  (was ${PREV:0:7})"
git merge -q --ff-only "$NEW"

if swap && healthy; then
  log "✅ healthy — $(docker ps --format '{{.Names}}: {{.Status}}' | tr '\n' ';')"
else
  log "❌ deploy failed — rolling back to ${PREV:0:7}"
  git reset -q --hard "$PREV"
  swap || true
  if healthy; then log "↩️  rolled back, site is up on ${PREV:0:7}"; else log "🔥 rollback also unhealthy — check: docker compose logs app"; fi
  exit 1
fi

log "pushing images to Docker Hub"
docker push -q oumgupta/phone-remote-app:latest   || log "⚠️  push app failed (deploy is still live)"
docker push -q oumgupta/phone-remote-nginx:latest || log "⚠️  push nginx failed (deploy is still live)"
docker image prune -f >/dev/null 2>&1 || true
log "done"
