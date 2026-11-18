#!/usr/bin/env bash
# Phone Remote — zero-downtime (blue-green) deploy on the EC2 host.
#
# Run by GitHub Actions on every push to main (see .github/workflows/deploy.yml),
# or by hand:  ~/phone-remote/deploy/deploy.sh
#   FORCE=1      redeploy everything even if nothing changed
#   FORCE=app    blue-green the app only      FORCE=nginx   recreate nginx only
#
# The CI SSH key is locked (authorized_keys forced command) to ~/bin/phone-remote-deploy,
# which fetches origin/main and runs THIS file from it — so the newest version of
# the script always deploys itself, even on the first run.
#
#   1. git fast-forward to origin/main
#   2. work out what the changed files touch (git diff):
#        client/ server/ Dockerfile → app      nginx/ → nginx
#        docker-compose.yml → everything       anything else → nothing
#      (Image IDs can't decide this: every build gets a new ID even with no
#      code change.)
#   3. app, blue-green:
#        build the image while the live colour keeps serving
#        start the OTHER colour with it and health-check it directly
#          → unhealthy: remove it; the live site was never touched
#        point nginx at it with a graceful reload (no dropped requests)
#        public health check → failure: point nginx back, the old colour
#          is still running
#        stop the old colour (it closes its sockets with 1012, clients
#          reconnect to the new one within a second or two)
#   4. push the new images to Docker Hub
#
# nginx itself can't be blue-greened (it owns ports 80/443); an nginx/ change
# recreates it (fast stop + start, about a second). Those changes are rare.
set -euo pipefail

cd "${REPO_DIR:-$HOME/phone-remote}"
DOMAIN="${DOMAIN:-65-1-96-152.sslip.io}"
APP_IMAGE=oumgupta/phone-remote-app:latest
STATE_DIR=.deploy                       # mounted into nginx at /etc/nginx/live
UPSTREAM="$STATE_DIR/app-upstream.conf"
mkdir -p "$STATE_DIR"

# One deploy at a time
exec 9>/tmp/phone-remote-deploy.lock
flock -n 9 || { echo "❌ another deploy is running"; exit 1; }

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

# The app answers inside the given container
container_ok() {
  for _ in $(seq 1 30); do
    if docker exec "$1" node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# The public path (nginx → live app) works end to end
public_ok() {
  for _ in $(seq 1 15); do
    if curl -fsS -o /dev/null --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

live_color() {
  [ -f "$UPSTREAM" ] || return 0
  sed -n 's/.*app-\(blue\|green\):3000.*/\1/p' "$UPSTREAM" | head -1
}

point_nginx() {
  printf 'set $app_upstream http://app-%s:3000;\n' "$1" > "$UPSTREAM.tmp"
  mv "$UPSTREAM.tmp" "$UPSTREAM"
}

# nginx's default stop (SIGQUIT) is graceful: it waits for every open
# WebSocket and always runs into Docker's 10 s timeout. A fast stop (SIGTERM)
# right before recreating it keeps the gap to about a second.
recreate_nginx() {
  docker stop -s TERM -t 3 phone-remote-nginx >/dev/null 2>&1 || true
  docker compose up -d --no-deps --no-build nginx
}

reload_nginx() {
  docker exec phone-remote-nginx nginx -t -q && docker exec phone-remote-nginx nginx -s reload
}

# Compare against the last commit that deployed successfully, not HEAD, so a
# run that dies half-way can't hide its changes from the next one.
DEPLOYED_FILE="$STATE_DIR/deployed"
PREV=$(cat "$DEPLOYED_FILE" 2>/dev/null || true)
git cat-file -e "${PREV:-none}^{commit}" 2>/dev/null || PREV=$(git rev-parse HEAD)
git fetch -q origin main
NEW=$(git rev-parse origin/main)

FORCE="${FORCE:-0}"
if [ "$PREV" = "$NEW" ] && [ "$FORCE" = 0 ]; then
  log "already at $(git log --oneline -1)"
  exit 0
fi

APP=0 NGINX=0 INFRA=0
if [ "$FORCE" = 1 ]; then
  APP=1 NGINX=1 INFRA=1
elif [ "$FORCE" = app ]; then
  APP=1
elif [ "$FORCE" = nginx ]; then
  NGINX=1
else
  FILES=$(git diff --name-only "$PREV" "$NEW")
  if grep -qx 'docker-compose.yml' <<<"$FILES"; then APP=1 NGINX=1 INFRA=1; fi
  if grep -qE '^(Dockerfile|\.dockerignore|client/|server/)' <<<"$FILES"; then APP=1; fi
  if grep -qE '^nginx/' <<<"$FILES"; then NGINX=1; fi
fi
WHAT=""
[ $APP = 1 ] && WHAT="$WHAT app"
[ $NGINX = 1 ] && WHAT="$WHAT nginx"
[ $INFRA = 1 ] && WHAT="$WHAT turn"
WHAT="${WHAT# }"
log "deploying $(git log --oneline -1 "$NEW")  (was ${PREV:0:7}) → ${WHAT:-nothing}"
git merge -q --ff-only "$NEW"

if [ -z "$WHAT" ]; then
  echo "$NEW" > "$DEPLOYED_FILE"
  log "✅ no server changes (docs / CI / Android only) — nothing restarted"
  exit 0
fi

# Which colour serves now. "legacy" = the pre-blue-green single `app` container.
LIVE=$(live_color)
if [ -z "$LIVE" ]; then
  if docker ps -q -f name='^phone-remote-app$' | grep -q .; then LIVE=legacy
  elif docker ps -q -f name='^phone-remote-app-green$' | grep -q .; then LIVE=green
  else LIVE=blue; fi
fi
if [ "$LIVE" = blue ]; then IDLE=green; else IDLE=blue; fi
TARGET=$LIVE
OLD_IMG=$(docker image inspect -f '{{.Id}}' "$APP_IMAGE" 2>/dev/null || true)
log "live: $LIVE"

rollback() {
  log "❌ $1 — rolling back to ${PREV:0:7}"
  git reset -q --hard "$PREV"
  echo "$PREV" > "$DEPLOYED_FILE"
  if [ $APP = 1 ] && [ -n "$OLD_IMG" ]; then docker tag "$OLD_IMG" "$APP_IMAGE" || true; fi
  if [ $NGINX = 1 ]; then
    [ "$LIVE" != legacy ] && point_nginx "$LIVE"
    { docker compose build -q nginx && recreate_nginx; } || true
  elif [ "$LIVE" != legacy ]; then
    point_nginx "$LIVE"; reload_nginx || true
  fi
  if [ $INFRA = 1 ]; then docker compose up -d --no-deps --no-build turn-init coturn || true; fi
  if [ $APP = 1 ]; then docker rm -f "phone-remote-app-$IDLE" >/dev/null 2>&1 || true; fi
  if public_ok; then log "↩️  rolled back, site is up on ${PREV:0:7}"; else log "🔥 rollback also unhealthy — check: docker compose logs"; fi
  exit 1
}

# ── app: start the idle colour next to the live one ─────────────────────────
if [ $APP = 1 ]; then
  docker compose build -q app-blue            # both colours share $APP_IMAGE
  docker compose up -d --no-deps --no-build --force-recreate "app-$IDLE"
  container_ok "phone-remote-app-$IDLE" \
    || rollback "new app ($IDLE) failed its health check — live site was untouched"
  TARGET=$IDLE
  log "app-$IDLE is healthy"
fi

# ── switch traffic ───────────────────────────────────────────────────────────
[ "$TARGET" != legacy ] && point_nginx "$TARGET"
if [ $NGINX = 1 ]; then
  docker compose build -q nginx
  recreate_nginx || rollback "nginx failed to start"
elif [ $APP = 1 ]; then
  reload_nginx || rollback "nginx rejected the switch"
fi
if [ $INFRA = 1 ]; then
  docker compose up -d --no-deps --no-build turn-init coturn || rollback "TURN failed to start"
fi
public_ok || rollback "public health check failed after the switch"
log "traffic → app-$TARGET"

# ── retire the old colour (its sockets reconnect to the new one) ─────────────
if [ $APP = 1 ]; then
  if [ "$LIVE" = legacy ]; then
    docker stop -t 15 phone-remote-app >/dev/null && docker rm phone-remote-app >/dev/null
  else
    # Kept (stopped) so `docker start` can bring it back by hand if ever needed.
    docker stop -t 15 "phone-remote-app-$LIVE" >/dev/null 2>&1 || true
  fi
fi
[ $INFRA = 1 ] && docker compose up -d --no-deps --no-build --remove-orphans nginx >/dev/null 2>&1 || true
echo "$NEW" > "$DEPLOYED_FILE"
log "✅ healthy —$(docker ps --format '{{.Names}}: {{.Status}}' | tr '\n' ';')"

log "pushing images to Docker Hub"
PUSH=""
[ $APP = 1 ] && PUSH="$PUSH app"
[ $NGINX = 1 ] && PUSH="$PUSH nginx"
for svc in $PUSH; do
  docker push -q "oumgupta/phone-remote-$svc:latest" >/dev/null || log "⚠️  push $svc failed (deploy is still live)"
done
docker image prune -f >/dev/null 2>&1 || true
log "done"
