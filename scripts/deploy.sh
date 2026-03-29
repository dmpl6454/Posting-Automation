#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# PostAutomation — Deployment Script
# Usage:
#   ./scripts/deploy.sh setup     # First-time SSL + deploy
#   ./scripts/deploy.sh deploy    # Normal deployment (build & restart)
#   ./scripts/deploy.sh update    # Pull latest code and redeploy
#   ./scripts/deploy.sh logs      # View logs
#   ./scripts/deploy.sh status    # Check service health
#   ./scripts/deploy.sh migrate   # Run database migrations
#   ./scripts/deploy.sh backup    # Run manual database backup
#   ./scripts/deploy.sh ssl-renew # Force SSL certificate renewal
#   ./scripts/deploy.sh rollback  # Rollback to previous deployment
#   ./scripts/deploy.sh rollback <hash>  # Rollback to specific commit
#   ./scripts/deploy.sh versions  # List all deployment versions
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

DOMAIN="postautomation.co.in"
EMAIL="admin@postautomation.co.in"
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.production"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[deploy]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── Check prerequisites ──────────────────────────────────────────
check_prereqs() {
  command -v docker >/dev/null 2>&1 || error "Docker not installed"
  docker compose version >/dev/null 2>&1 || error "Docker Compose not installed"
  [ -f "$COMPOSE_FILE" ] || error "${COMPOSE_FILE} not found. Run from project root."
  [ -f "$ENV_FILE" ] || error "${ENV_FILE} not found. Copy from .env.production.example"
}

# ── First-time setup (SSL + initial deploy) ──────────────────────
cmd_setup() {
  log "Starting first-time setup for ${DOMAIN}..."
  check_prereqs

  # Step 1: Use initial nginx config (no SSL)
  log "Step 1: Starting services with HTTP-only nginx..."
  cp docker/nginx/nginx-initial.conf docker/nginx/nginx.conf.bak
  cp docker/nginx/nginx-initial.conf docker/nginx/nginx-active.conf

  # Temporarily use the initial config
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build web worker

  # Start with initial config (modify nginx volume temporarily)
  NGINX_CONF="./docker/nginx/nginx-initial.conf"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d postgres redis minio
  log "Waiting for databases to be healthy..."
  sleep 10

  # Run migrations
  log "Step 2: Running database migrations..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile migration run --rm migrate
  success "Migrations complete"

  # Start web with initial nginx
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d web worker

  # Start nginx with initial config
  docker run -d --name nginx-init \
    --network postautomation_internal \
    -p 80:80 \
    -v "$(pwd)/docker/nginx/nginx-initial.conf:/etc/nginx/nginx.conf:ro" \
    -v postautomation_certbot_www:/var/www/certbot \
    nginx:1.27-alpine

  sleep 5

  # Step 2: Get SSL certificate
  log "Step 3: Obtaining SSL certificate from Let's Encrypt..."
  docker run --rm \
    -v postautomation_certbot_www:/var/www/certbot \
    -v postautomation_certbot_certs:/etc/letsencrypt \
    certbot/certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email "${EMAIL}" \
    --agree-tos \
    --no-eff-email \
    -d "${DOMAIN}" \
    -d "www.${DOMAIN}"

  success "SSL certificate obtained"

  # Step 3: Stop temporary nginx and start full stack
  log "Step 4: Switching to full HTTPS nginx config..."
  docker stop nginx-init && docker rm nginx-init

  # Restore the production nginx.conf
  cp docker/nginx/nginx.conf.bak docker/nginx/nginx.conf 2>/dev/null || true

  # Start everything
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d
  success "All services started with HTTPS!"

  echo ""
  success "═══════════════════════════════════════════════════"
  success "  Deployment complete!"
  success "  Visit: https://${DOMAIN}"
  success "═══════════════════════════════════════════════════"
}

# ── Generate version info ────────────────────────────────────────
get_version_info() {
  COMMIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  COMMIT_MSG=$(git log -1 --format=%s 2>/dev/null || echo "manual deploy")
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  COMMIT_COUNT=$(git rev-list --count HEAD 2>/dev/null || echo "0")
  APP_VERSION="1.0.${COMMIT_COUNT}"
  # Changelog: commits since last deploy tag
  LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  if [ -n "$LAST_TAG" ]; then
    CHANGELOG=$(git log "${LAST_TAG}..HEAD" --oneline 2>/dev/null || echo "")
  else
    CHANGELOG=$(git log --oneline -10 2>/dev/null || echo "")
  fi
}

# ── Tag deployment in git ────────────────────────────────────────
tag_deployment() {
  local tag="deploy-v${APP_VERSION}-$(date +%Y%m%d%H%M%S)"
  git tag "$tag" 2>/dev/null || true
  log "Tagged deployment: $tag"
}

# ── Save version file for rollback ───────────────────────────────
save_version() {
  local version_dir=".deployments"
  mkdir -p "$version_dir"
  local version_file="${version_dir}/v${APP_VERSION}-${COMMIT_HASH}.json"
  cat > "$version_file" <<VEOF
{
  "version": "${APP_VERSION}",
  "commitHash": "${COMMIT_HASH}",
  "commitMsg": $(echo "$COMMIT_MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo "\"${COMMIT_MSG}\""),
  "branch": "${BRANCH}",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "changelog": $(echo "$CHANGELOG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo "\"\"")
}
VEOF
  # Keep pointer to current version
  echo "${version_file}" > "${version_dir}/current"
  # Keep pointer to previous version for quick rollback
  if [ -f "${version_dir}/current.prev" ]; then
    cp "${version_dir}/current.prev" "${version_dir}/current.prev2"
  fi
  if [ -f "${version_dir}/current" ]; then
    cp "${version_dir}/current" "${version_dir}/current.prev"
  fi
  success "Version v${APP_VERSION} (${COMMIT_HASH}) saved"
}

# ── Normal deployment ─────────────────────────────────────────────
cmd_deploy() {
  log "Deploying PostAutomation..."
  check_prereqs
  get_version_info

  log "Deploying version v${APP_VERSION} (${COMMIT_HASH})..."
  log "Commit: ${COMMIT_MSG}"

  # Tag current images for rollback
  log "Saving current state for rollback..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    images --format json 2>/dev/null | jq -r '.[].Tag' > .last-deploy-tags 2>/dev/null || true

  # Build new images
  log "Building Docker images..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build web worker

  # Run migrations
  log "Running database migrations..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile migration run --rm migrate

  # Rolling restart — zero downtime
  log "Restarting services..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps web
  sleep 5
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps worker
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps nginx

  # Save version info + tag in git
  save_version
  tag_deployment

  # Register deployment in the database via API
  log "Registering deployment in database..."
  DEPLOY_SECRET=$(grep DEPLOY_SECRET "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
  APP_URL=$(grep APP_URL "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "http://localhost:3000")
  if [ -n "$DEPLOY_SECRET" ]; then
    curl -sf -X POST "${APP_URL}/api/deploy/register" \
      -H "Content-Type: application/json" \
      -H "x-deploy-secret: ${DEPLOY_SECRET}" \
      -d "{\"version\":\"${APP_VERSION}\",\"commitHash\":\"${COMMIT_HASH}\",\"commitMsg\":$(echo "$COMMIT_MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo "\"${COMMIT_MSG}\""),\"branch\":\"${BRANCH}\",\"changelog\":$(echo "$CHANGELOG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo "\"\"")}" \
      >/dev/null 2>&1 && success "Deployment registered in database" || warn "Could not register deployment (API may not be ready)"
  else
    warn "DEPLOY_SECRET not set — skipping database registration"
  fi

  # Cleanup old images
  docker image prune -f >/dev/null 2>&1

  echo ""
  success "═══════════════════════════════════════════════════"
  success "  Deployed v${APP_VERSION} (${COMMIT_HASH})"
  success "  ${COMMIT_MSG}"
  success "═══════════════════════════════════════════════════"
  cmd_status
}

# ── Pull latest code and deploy ──────────────────────────────────
cmd_update() {
  log "Pulling latest code..."
  git pull origin main
  cmd_deploy
}

# ── View logs ────────────────────────────────────────────────────
cmd_logs() {
  local service="${2:-}"
  if [ -n "$service" ]; then
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs -f "$service"
  else
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs -f --tail=100
  fi
}

# ── Check service status ─────────────────────────────────────────
cmd_status() {
  echo ""
  log "Service Status:"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
  echo ""

  # Health check
  log "Health Check:"
  if curl -sf "https://${DOMAIN}/api/health" >/dev/null 2>&1; then
    success "Website is UP at https://${DOMAIN}"
  elif curl -sf "http://localhost:3000/api/health" >/dev/null 2>&1; then
    warn "App is running but HTTPS may not be configured"
  else
    error "Website appears DOWN"
  fi

  # Disk usage
  echo ""
  log "Disk Usage:"
  docker system df
}

# ── Run database migration ───────────────────────────────────────
cmd_migrate() {
  log "Running database migrations..."
  check_prereqs
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile migration run --rm migrate
  success "Migrations complete"
}

# ── Manual backup ────────────────────────────────────────────────
cmd_backup() {
  log "Running manual database backup..."
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec postgres \
    pg_dump -U "${POSTGRES_USER:-postautomation}" -Fc "${POSTGRES_DB:-postautomation}" \
    > "backup_${TIMESTAMP}.dump"
  success "Backup saved to backup_${TIMESTAMP}.dump"
}

# ── Force SSL renewal ────────────────────────────────────────────
cmd_ssl_renew() {
  log "Forcing SSL certificate renewal..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    exec certbot certbot renew --force-renewal
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    exec nginx nginx -s reload
  success "SSL certificate renewed and nginx reloaded"
}

# ── List versions ────────────────────────────────────────────────
cmd_versions() {
  local version_dir=".deployments"
  if [ ! -d "$version_dir" ]; then
    warn "No deployment history found"
    return
  fi

  echo ""
  log "Deployment History:"
  echo ""
  printf "  %-12s %-10s %-22s %s\n" "VERSION" "COMMIT" "DATE" "MESSAGE"
  printf "  %-12s %-10s %-22s %s\n" "-------" "------" "----" "-------"

  local current_file=""
  [ -f "${version_dir}/current" ] && current_file=$(cat "${version_dir}/current")

  for f in $(ls -t "${version_dir}"/v*.json 2>/dev/null); do
    local ver=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('version','?'))" 2>/dev/null || echo "?")
    local hash=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('commitHash','?'))" 2>/dev/null || echo "?")
    local date=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('deployedAt','?')[:19])" 2>/dev/null || echo "?")
    local msg=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('commitMsg','?')[:50])" 2>/dev/null || echo "?")
    local marker="  "
    [ "$f" = "$current_file" ] && marker="${GREEN}▸ ${NC}"
    printf "  ${marker}%-12s %-10s %-22s %s\n" "v${ver}" "${hash}" "${date}" "${msg}"
  done
  echo ""
}

# ── Rollback ─────────────────────────────────────────────────────
cmd_rollback() {
  check_prereqs
  local target_commit="${2:-}"
  local version_dir=".deployments"

  if [ -z "$target_commit" ]; then
    # Rollback to previous version
    if [ -f "${version_dir}/current.prev" ]; then
      local prev_file=$(cat "${version_dir}/current.prev")
      if [ -f "$prev_file" ]; then
        target_commit=$(python3 -c "import json; d=json.load(open('$prev_file')); print(d['commitHash'])" 2>/dev/null)
        local target_ver=$(python3 -c "import json; d=json.load(open('$prev_file')); print(d['version'])" 2>/dev/null)
        warn "Rolling back to previous version v${target_ver} (${target_commit})..."
      fi
    fi
  fi

  if [ -z "$target_commit" ]; then
    error "No previous version found. Specify a commit hash: ./scripts/deploy.sh rollback <commit-hash>"
  fi

  warn "Rolling back to commit ${target_commit}..."

  # Checkout the target commit
  git fetch origin 2>/dev/null || true
  git checkout "$target_commit" 2>/dev/null || {
    error "Could not checkout commit ${target_commit}"
  }

  # Rebuild and deploy
  log "Rebuilding from ${target_commit}..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build web worker
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile migration run --rm migrate

  log "Restarting services..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps web
  sleep 5
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps worker
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps nginx

  # Go back to main branch
  git checkout main 2>/dev/null || true

  success "Rollback complete to ${target_commit}. Check status with: ./scripts/deploy.sh status"
}

# ── Main ─────────────────────────────────────────────────────────
case "${1:-help}" in
  setup)     cmd_setup ;;
  deploy)    cmd_deploy ;;
  update)    cmd_update ;;
  logs)      cmd_logs "$@" ;;
  status)    cmd_status ;;
  migrate)   cmd_migrate ;;
  backup)    cmd_backup ;;
  ssl-renew) cmd_ssl_renew ;;
  rollback)  cmd_rollback "$@" ;;
  versions)  cmd_versions ;;
  *)
    echo "Usage: $0 {setup|deploy|update|logs|status|migrate|backup|ssl-renew|rollback|versions}"
    echo ""
    echo "Commands:"
    echo "  setup      First-time deployment (SSL + full stack)"
    echo "  deploy     Build and deploy latest code (auto-versions)"
    echo "  update     Git pull + deploy"
    echo "  logs       View service logs (optionally specify service name)"
    echo "  status     Check all service health"
    echo "  migrate    Run database migrations"
    echo "  backup     Manual database backup"
    echo "  ssl-renew  Force SSL certificate renewal"
    echo "  rollback   Rollback to previous deployment (or specify commit hash)"
    echo "  versions   List all deployment versions"
    ;;
esac
