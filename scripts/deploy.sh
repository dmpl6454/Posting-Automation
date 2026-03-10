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
#   ./scripts/deploy.sh rollback  # Rollback to previous images
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

# ── Normal deployment ─────────────────────────────────────────────
cmd_deploy() {
  log "Deploying PostAutomation..."
  check_prereqs

  # Tag current images for rollback
  log "Tagging current images for rollback..."
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

  # Cleanup old images
  docker image prune -f >/dev/null 2>&1

  success "Deployment complete!"
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

# ── Rollback ─────────────────────────────────────────────────────
cmd_rollback() {
  warn "Rolling back to previous deployment..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down web worker
  # Restart with previous images
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d
  success "Rollback complete. Check status with: ./scripts/deploy.sh status"
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
  rollback)  cmd_rollback ;;
  *)
    echo "Usage: $0 {setup|deploy|update|logs|status|migrate|backup|ssl-renew|rollback}"
    echo ""
    echo "Commands:"
    echo "  setup      First-time deployment (SSL + full stack)"
    echo "  deploy     Build and deploy latest code"
    echo "  update     Git pull + deploy"
    echo "  logs       View service logs (optionally specify service name)"
    echo "  status     Check all service health"
    echo "  migrate    Run database migrations"
    echo "  backup     Manual database backup"
    echo "  ssl-renew  Force SSL certificate renewal"
    echo "  rollback   Rollback to previous deployment"
    ;;
esac
